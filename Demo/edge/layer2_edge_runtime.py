from __future__ import annotations

import importlib
import json
import logging
import math
import os
import queue
import random
import socket
import ssl
import threading
import time
from collections import deque
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import paho.mqtt.client as mqtt
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BASE_DIR / '.env')

logging.basicConfig(level=os.getenv('LOG_LEVEL', 'INFO').upper())
logger = logging.getLogger('smart-drainage-layer2')

WASTE_LABEL_HINTS = {
    'plastic',
    'bottle',
    'bag',
    'trash',
    'debris',
    'waste',
    'leaves',
    'paper',
    'sediment',
    'can',
}
DEFAULT_WASTE_LABELS = ['plastic', 'leaves', 'sediment', 'paper', 'bottle', 'bag', 'trash']


def optional_import(module_name: str) -> Any | None:
    try:
        return importlib.import_module(module_name)
    except ImportError:
        return None


cv2 = optional_import('cv2')
np = optional_import('numpy')
_tflite_module = optional_import('tflite_runtime.interpreter')
_tensorflow_module = optional_import('tensorflow') if _tflite_module is None else None
TFLiteInterpreter = None

if _tflite_module is not None:
    TFLiteInterpreter = getattr(_tflite_module, 'Interpreter', None)
elif _tensorflow_module is not None:
    TFLiteInterpreter = getattr(getattr(_tensorflow_module, 'lite', None), 'Interpreter', None)


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def env_flag(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {'1', 'true', 'yes', 'on'}


def normalize_mqtt_host(value: str | None) -> str:
    host = (value or '').strip()
    if host.lower() in {'', 'your-broker-hostname', 'broker.example.com', 'broker.example'}:
        return ''
    return host


def resolve_optional_path(value: str | None) -> str | None:
    if not value:
        return None

    path = Path(value)
    if path.is_absolute():
        return str(path)

    return str((BASE_DIR / path).resolve())


def create_mqtt_client(*, client_id: str) -> mqtt.Client:
    callback_api_version = getattr(getattr(mqtt, 'CallbackAPIVersion', None), 'VERSION2', None)
    if callback_api_version is not None:
        return mqtt.Client(callback_api_version=callback_api_version, client_id=client_id, protocol=mqtt.MQTTv311)
    return mqtt.Client(client_id=client_id, protocol=mqtt.MQTTv311)


@dataclass(slots=True)
class EdgeConfig:
    city: str = os.getenv('CITY_NAMESPACE', 'smart-city')
    node_id: str = os.getenv('EDGE_NODE_ID', 'S-22')
    gateway_id: str = os.getenv('EDGE_GATEWAY_ID', f'edge-node-{socket.gethostname()}')
    mqtt_host: str = normalize_mqtt_host(os.getenv('MQTT_HOST', ''))
    mqtt_port: int = int(os.getenv('MQTT_PORT', '8883'))
    mqtt_username: str | None = os.getenv('MQTT_EDGE_USERNAME') or os.getenv('MQTT_USERNAME') or None
    mqtt_password: str | None = os.getenv('MQTT_EDGE_PASSWORD') or os.getenv('MQTT_PASSWORD') or None
    mqtt_ca_cert: str | None = resolve_optional_path(os.getenv('MQTT_CA_CERT'))
    mqtt_client_cert: str | None = resolve_optional_path(os.getenv('MQTT_CLIENT_CERT'))
    mqtt_client_key: str | None = resolve_optional_path(os.getenv('MQTT_CLIENT_KEY'))
    mqtt_tls_insecure: bool = env_flag('MQTT_TLS_INSECURE', False)
    alert_api_url: str | None = os.getenv('EDGE_ALERT_API_URL') or None
    heartbeat_seconds: int = int(os.getenv('HEARTBEAT_SECONDS', '60'))
    initial_backoff_seconds: int = int(os.getenv('MQTT_INITIAL_BACKOFF_SECONDS', '1'))
    max_backoff_seconds: int = int(os.getenv('MQTT_MAX_BACKOFF_SECONDS', '32'))
    significant_delta_mm: int = int(os.getenv('TELEMETRY_DELTA_MM', '25'))
    significant_delta_pct: float = float(os.getenv('TELEMETRY_DELTA_PCT', '5'))
    telemetry_holdoff_seconds: float = float(os.getenv('TELEMETRY_HOLDOFF_SECONDS', '15'))
    sensor_sample_seconds: float = float(os.getenv('SENSOR_SAMPLE_SECONDS', '0.5'))
    moving_average_window: int = int(os.getenv('MOVING_AVERAGE_WINDOW', '5'))
    water_level_threshold_mm: int = int(os.getenv('WATER_LEVEL_THRESHOLD_MM', '780'))
    water_level_reset_mm: int = int(os.getenv('WATER_LEVEL_RESET_MM', '640'))
    water_sensor_max_mm: int = int(os.getenv('WATER_LEVEL_SENSOR_MAX_MM', '1200'))
    water_level_adc_pin: str | None = os.getenv('WATER_LEVEL_ADC_PIN') or None
    valve_gpio_pin: int = int(os.getenv('VALVE_GPIO_PIN', '17'))
    valve_active_high: bool = env_flag('VALVE_ACTIVE_HIGH', True)
    use_mock_gpio: bool = env_flag('USE_MOCK_GPIO', True)
    camera_source: str = os.getenv('CAMERA_SOURCE', os.getenv('CAMERA_INDEX', '0'))
    camera_frame_width: int = int(os.getenv('CAMERA_FRAME_WIDTH', '640'))
    camera_frame_height: int = int(os.getenv('CAMERA_FRAME_HEIGHT', '480'))
    cv_confidence_threshold: float = float(os.getenv('CV_CONFIDENCE_THRESHOLD', '0.55'))
    cv_inference_interval_seconds: float = float(os.getenv('CV_INFERENCE_INTERVAL_SECONDS', '1.0'))
    blockage_refresh_seconds: float = float(os.getenv('BLOCKAGE_REFRESH_SECONDS', '20'))
    tflite_model_path: str | None = resolve_optional_path(
        os.getenv('TFLITE_MODEL_PATH') or './edge/models/waste_yolov5n_int8.tflite'
    )
    labels_path: str | None = resolve_optional_path(os.getenv('LABELS_PATH') or './edge/models/waste_labels.txt')
    offline_queue_path: str = resolve_optional_path(
        os.getenv('EDGE_QUEUE_PATH') or './edge/data/offline_queue.jsonl'
    ) or str((BASE_DIR / 'edge/data/offline_queue.jsonl').resolve())
    run_seconds: int = int(os.getenv('EDGE_RUN_SECONDS', '0'))


@dataclass(slots=True)
class SharedEdgeState:
    water_level_mm: float = 0.0
    water_level_pct: float = 0.0
    valve_open: bool = False
    blockage_detected: bool = False
    waste_classification: list[dict[str, Any]] = field(default_factory=list)
    last_water_timestamp: str = field(default_factory=iso_now)
    last_vision_timestamp: str = field(default_factory=iso_now)


class SharedStateStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state = SharedEdgeState()

    def update(self, **values: Any) -> None:
        with self._lock:
            for key, value in values.items():
                setattr(self._state, key, value)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                'water_level_mm': self._state.water_level_mm,
                'water_level_pct': self._state.water_level_pct,
                'valve_open': self._state.valve_open,
                'blockage_detected': self._state.blockage_detected,
                'waste_classification': list(self._state.waste_classification),
                'last_water_timestamp': self._state.last_water_timestamp,
                'last_vision_timestamp': self._state.last_vision_timestamp,
            }


class MovingAverageFilter:
    def __init__(self, window_size: int) -> None:
        self._values: deque[float] = deque(maxlen=max(1, window_size))

    def update(self, value: float) -> float:
        self._values.append(float(value))
        return sum(self._values) / len(self._values)


class MockGPIO:
    BCM = 'BCM'
    OUT = 'OUT'
    HIGH = 1
    LOW = 0

    def setwarnings(self, _value: bool) -> None:
        return

    def setmode(self, _mode: str) -> None:
        return

    def setup(self, pin: int, mode: str, initial: int = 0) -> None:
        logger.info('Mock GPIO configured pin=%s mode=%s initial=%s', pin, mode, initial)

    def output(self, pin: int, value: int) -> None:
        logger.info('Mock GPIO output pin=%s value=%s', pin, value)

    def cleanup(self) -> None:
        logger.info('Mock GPIO cleanup complete')


class ValveController:
    def __init__(self, config: EdgeConfig) -> None:
        self.config = config
        self._lock = threading.Lock()
        self._is_open = False
        self._gpio = self._load_gpio_backend()
        self._gpio.setwarnings(False)
        self._gpio.setmode(self._gpio.BCM)
        self._gpio.setup(self.config.valve_gpio_pin, self._gpio.OUT, initial=self._gpio_value(False))

    def _load_gpio_backend(self) -> Any:
        if self.config.use_mock_gpio:
            return MockGPIO()

        gpio_module = optional_import('RPi.GPIO')
        if gpio_module is None:
            logger.warning('RPi.GPIO not found. Falling back to mock GPIO backend.')
            return MockGPIO()

        return gpio_module

    def _gpio_value(self, should_open: bool) -> int:
        if should_open:
            return self._gpio.HIGH if self.config.valve_active_high else self._gpio.LOW
        return self._gpio.LOW if self.config.valve_active_high else self._gpio.HIGH

    @property
    def is_open(self) -> bool:
        with self._lock:
            return self._is_open

    def set_open(self, should_open: bool, reason: str) -> bool:
        with self._lock:
            if self._is_open == should_open:
                return False

            self._is_open = should_open
            self._gpio.output(self.config.valve_gpio_pin, self._gpio_value(should_open))
            logger.warning(
                'Local actuation -> valve %s on GPIO %s (%s)',
                'OPEN' if should_open else 'CLOSED',
                self.config.valve_gpio_pin,
                reason,
            )
            return True

    def cleanup(self) -> None:
        with suppress(Exception):
            self._gpio.cleanup()


class WaterLevelSensor:
    def __init__(self, config: EdgeConfig) -> None:
        self.config = config
        self._tick = 0
        self._adc = None
        machine = optional_import('machine')

        if machine is not None and self.config.water_level_adc_pin:
            try:
                pin = machine.Pin(int(self.config.water_level_adc_pin))
                self._adc = machine.ADC(pin)
                if hasattr(self._adc, 'atten') and hasattr(machine.ADC, 'ATTN_11DB'):
                    self._adc.atten(machine.ADC.ATTN_11DB)
            except Exception as exc:  # noqa: BLE001 - hardware init can vary by board
                logger.warning('ADC initialization failed, using dummy water-level feed instead: %s', exc)
                self._adc = None

    def read_mm(self) -> float:
        self._tick += 1

        if self._adc is not None:
            raw = self._adc.read_u16() if hasattr(self._adc, 'read_u16') else self._adc.read()
            max_raw = 65535 if hasattr(self._adc, 'read_u16') else 4095
            return clamp((raw / max_raw) * self.config.water_sensor_max_mm, 0, self.config.water_sensor_max_mm)

        base_mm = float(os.getenv('SIMULATED_WATER_BASE_MM', '520'))
        amplitude_mm = float(os.getenv('SIMULATED_WATER_AMPLITUDE_MM', '185'))
        surge_mm = 140 if self._tick % 28 == 0 else 0
        noise_mm = random.uniform(-28, 28)
        synthetic = base_mm + math.sin(self._tick / 4.2) * amplitude_mm + surge_mm + noise_mm
        return clamp(synthetic, 0, self.config.water_sensor_max_mm)


class EdgeMQTTPublisher:
    def __init__(self, config: EdgeConfig, stop_event: threading.Event) -> None:
        self.config = config
        self.stop_event = stop_event
        self.client = create_mqtt_client(client_id=f'{config.gateway_id}-{config.node_id}')
        self.connected = False
        self.loop_started = False
        self._queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=256)
        self._offline_file = Path(config.offline_queue_path)
        self._offline_file.parent.mkdir(parents=True, exist_ok=True)
        self._last_heartbeat_at = 0.0
        self._configure_client()

    def _configure_client(self) -> None:
        if self.config.mqtt_username:
            self.client.username_pw_set(self.config.mqtt_username, self.config.mqtt_password)

        self.client.tls_set(
            ca_certs=self.config.mqtt_ca_cert or None,
            certfile=self.config.mqtt_client_cert or None,
            keyfile=self.config.mqtt_client_key or None,
            tls_version=ssl.PROTOCOL_TLS_CLIENT,
        )
        self.client.tls_insecure_set(self.config.mqtt_tls_insecure)

        will_payload = json.dumps(
            {
                'schema_version': '1.0.0',
                'node_id': self.config.node_id,
                'timestamp': iso_now(),
                'status': 'offline',
                'gateway_id': self.config.gateway_id,
                'reason': 'LWT: unexpected disconnect',
            }
        )
        self.client.will_set(
            f'city/drainage/{self.config.node_id}/status',
            payload=will_payload,
            qos=1,
            retain=True,
        )
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect

    def _on_connect(self, client: mqtt.Client, userdata: Any, flags: Any, reason_code: Any, properties: Any = None) -> None:
        code = getattr(reason_code, 'value', reason_code)
        self.connected = code == 0
        if self.connected:
            logger.info('MQTT connected to %s:%s', self.config.mqtt_host, self.config.mqtt_port)
            self.publish_status('online', 'edge runtime connected')
        else:
            logger.error('MQTT connection failed with reason code %s', code)

    def _on_disconnect(self, client: mqtt.Client, userdata: Any, reason_code: Any, properties: Any = None) -> None:
        self.connected = False
        logger.warning('MQTT disconnected with reason code %s', getattr(reason_code, 'value', reason_code))

    def queue_message(self, topic_suffix: str, payload: dict[str, Any], *, retain: bool = False) -> None:
        record = {
            'topic': f'city/drainage/{self.config.node_id}/{topic_suffix}',
            'payload': payload,
            'retain': retain,
            'qos': 1,
        }
        try:
            self._queue.put_nowait(record)
        except queue.Full:
            logger.warning('Outgoing MQTT queue full. Persisting record to the offline queue file.')
            self._persist_offline(record)

    def publish_status(self, status: str, reason: str) -> None:
        payload = {
            'schema_version': '1.0.0',
            'node_id': self.config.node_id,
            'timestamp': iso_now(),
            'status': status,
            'gateway_id': self.config.gateway_id,
            'reason': reason,
        }
        if self.connected:
            self._publish_record(
                {
                    'topic': f'city/drainage/{self.config.node_id}/status',
                    'payload': payload,
                    'retain': True,
                    'qos': 1,
                }
            )
        else:
            self._persist_offline(
                {
                    'topic': f'city/drainage/{self.config.node_id}/status',
                    'payload': payload,
                    'retain': True,
                    'qos': 1,
                }
            )

    def _persist_offline(self, record: dict[str, Any]) -> None:
        with self._offline_file.open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(record) + '\n')

    def _flush_offline_records(self) -> None:
        if not self.connected or not self._offline_file.exists() or self._offline_file.stat().st_size == 0:
            return

        pending_lines = self._offline_file.read_text(encoding='utf-8').splitlines()
        if not pending_lines:
            return

        logger.info('Flushing %s cached MQTT record(s) after reconnect.', len(pending_lines))
        for line in pending_lines:
            with suppress(json.JSONDecodeError):
                record = json.loads(line)
                self._publish_record(record)

        self._offline_file.write_text('', encoding='utf-8')

    def _publish_record(self, record: dict[str, Any]) -> bool:
        try:
            message = self.client.publish(
                record['topic'],
                json.dumps(record['payload']),
                qos=record.get('qos', 1),
                retain=record.get('retain', False),
            )
            message.wait_for_publish(timeout=2)
            return message.rc == mqtt.MQTT_ERR_SUCCESS
        except Exception as exc:  # noqa: BLE001 - network failures must not stop local logic
            self.connected = False
            logger.warning('MQTT publish failed, retaining offline copy: %s', exc)
            self._persist_offline(record)
            return False

    def _connect_with_backoff(self) -> None:
        if not self.config.mqtt_host:
            logger.warning('MQTT_HOST not configured. Running Layer 2 in offline-only mode.')
            self.stop_event.wait(timeout=1)
            return

        if not self.loop_started:
            self.client.loop_start()
            self.loop_started = True

        delay = self.config.initial_backoff_seconds
        while not self.stop_event.is_set() and not self.connected:
            try:
                logger.info('Attempting MQTT TLS connection to %s:%s', self.config.mqtt_host, self.config.mqtt_port)
                self.client.connect(self.config.mqtt_host, self.config.mqtt_port, keepalive=45)
                time.sleep(1)
                if not self.connected:
                    raise ConnectionError('Broker did not acknowledge the MQTT session yet.')
            except Exception as exc:  # noqa: BLE001 - resilience loop by design
                logger.warning('MQTT reconnect failed: %s. Retrying in %ss', exc, delay)
                self.stop_event.wait(timeout=delay)
                delay = min(delay * 2, self.config.max_backoff_seconds)
            else:
                delay = self.config.initial_backoff_seconds

    def run(self) -> None:
        while not self.stop_event.is_set():
            if self.config.mqtt_host and not self.connected:
                self._connect_with_backoff()

            if self.connected and (time.monotonic() - self._last_heartbeat_at) >= self.config.heartbeat_seconds:
                self.publish_status('online', 'periodic heartbeat')
                self._last_heartbeat_at = time.monotonic()
                self._flush_offline_records()

            try:
                record = self._queue.get(timeout=1)
            except queue.Empty:
                continue

            if self.connected:
                self._publish_record(record)
            else:
                self._persist_offline(record)

    def stop(self) -> None:
        if self.connected:
            with suppress(Exception):
                self.publish_status('offline', 'graceful shutdown')

        if self.loop_started:
            with suppress(Exception):
                self.client.loop_stop()
            self.loop_started = False

        with suppress(Exception):
            self.client.disconnect()


class WaterLevelMonitor(threading.Thread):
    def __init__(
        self,
        config: EdgeConfig,
        stop_event: threading.Event,
        state_store: SharedStateStore,
        valve_controller: ValveController,
        publisher: EdgeMQTTPublisher,
    ) -> None:
        super().__init__(name='water-threshold-monitor', daemon=True)
        self.config = config
        self.stop_event = stop_event
        self.state_store = state_store
        self.valve_controller = valve_controller
        self.publisher = publisher
        self.sensor = WaterLevelSensor(config)
        self.filter = MovingAverageFilter(config.moving_average_window)
        self._last_sent_mm: float | None = None
        self._last_sent_pct: float | None = None
        self._last_publish_at = 0.0
        self._last_threshold_state = False

    def _should_publish(self, level_mm: float, level_pct: float, threshold_exceeded: bool) -> bool:
        if self._last_sent_mm is None or self._last_sent_pct is None:
            return True

        return (
            abs(level_mm - self._last_sent_mm) >= self.config.significant_delta_mm
            or abs(level_pct - self._last_sent_pct) >= self.config.significant_delta_pct
            or threshold_exceeded != self._last_threshold_state
            or (time.monotonic() - self._last_publish_at) >= self.config.telemetry_holdoff_seconds
        )

    def run(self) -> None:
        while not self.stop_event.is_set():
            raw_mm = self.sensor.read_mm()
            filtered_mm = round(self.filter.update(raw_mm), 1)
            level_pct = round((filtered_mm / self.config.water_sensor_max_mm) * 100, 1)
            threshold_exceeded = filtered_mm >= self.config.water_level_threshold_mm

            if threshold_exceeded:
                valve_changed = self.valve_controller.set_open(True, 'water threshold exceeded')
            elif filtered_mm <= self.config.water_level_reset_mm:
                valve_changed = self.valve_controller.set_open(False, 'water level returned to safe band')
            else:
                valve_changed = False

            snapshot = self.state_store.snapshot()
            self.state_store.update(
                water_level_mm=filtered_mm,
                water_level_pct=level_pct,
                valve_open=self.valve_controller.is_open,
                last_water_timestamp=iso_now(),
            )

            telemetry_payload = {
                'schema_version': '1.0.0',
                'city': self.config.city,
                'node_id': self.config.node_id,
                'timestamp': iso_now(),
                'water_level_mm': int(round(filtered_mm)),
                'water_level_pct': level_pct,
                'flow_rate_lps': round(clamp(80 - level_pct * 0.42 - (8 if snapshot['blockage_detected'] else 0), 10, 90), 1),
                'battery_pct': 95.0,
                'signal_rssi_dbm': -51,
                'blockage_detected': snapshot['blockage_detected'],
                'local_actuation': {
                    'valve_open': self.valve_controller.is_open,
                    'gpio_pin': self.config.valve_gpio_pin,
                    'reason': 'threshold-monitor',
                },
            }

            if self._should_publish(filtered_mm, level_pct, threshold_exceeded):
                self.publisher.queue_message('telemetry/water-level', telemetry_payload)
                self._last_sent_mm = filtered_mm
                self._last_sent_pct = level_pct
                self._last_publish_at = time.monotonic()

            if threshold_exceeded and (valve_changed or threshold_exceeded != self._last_threshold_state):
                self.publisher.queue_message(
                    'alerts/edge-ai',
                    {
                        'schema_version': '1.0.0',
                        'city': self.config.city,
                        'node_id': self.config.node_id,
                        'timestamp': iso_now(),
                        'blockage_detected': bool(snapshot['blockage_detected']),
                        'severity': 'critical',
                        'waste_classification': snapshot['waste_classification'],
                        'notes': 'Water level exceeded the safety threshold. Local valve actuation opened the drainage path immediately.',
                    },
                )

            self._last_threshold_state = threshold_exceeded
            self.stop_event.wait(timeout=self.config.sensor_sample_seconds)


class WasteDetectionThread(threading.Thread):
    def __init__(
        self,
        config: EdgeConfig,
        stop_event: threading.Event,
        state_store: SharedStateStore,
        publisher: EdgeMQTTPublisher,
    ) -> None:
        super().__init__(name='waste-detection-cv', daemon=True)
        self.config = config
        self.stop_event = stop_event
        self.state_store = state_store
        self.publisher = publisher
        self.labels = self._load_labels()
        self.interpreter = None
        self.input_details: list[dict[str, Any]] = []
        self.output_details: list[dict[str, Any]] = []
        self.capture = None
        self._frame_counter = 0
        self._last_blockage_state = False
        self._last_alert_at = 0.0
        self._load_model()
        self._open_camera()

    def _load_labels(self) -> list[str]:
        if self.config.labels_path and Path(self.config.labels_path).exists():
            return [line.strip() for line in Path(self.config.labels_path).read_text(encoding='utf-8').splitlines() if line.strip()]
        return DEFAULT_WASTE_LABELS

    def _load_model(self) -> None:
        if TFLiteInterpreter is None:
            logger.warning('TensorFlow Lite runtime not available. Waste detection will use fallback OpenCV heuristics.')
            return

        if not self.config.tflite_model_path or not Path(self.config.tflite_model_path).exists():
            logger.warning('TFLite model not found at %s. Falling back to simple OpenCV heuristics.', self.config.tflite_model_path)
            return

        try:
            self.interpreter = TFLiteInterpreter(model_path=self.config.tflite_model_path)
            self.interpreter.allocate_tensors()
            self.input_details = list(self.interpreter.get_input_details())
            self.output_details = list(self.interpreter.get_output_details())
            logger.info('Loaded quantized TFLite waste detector: %s', self.config.tflite_model_path)
        except Exception as exc:  # noqa: BLE001 - model formats vary by board
            logger.warning('Failed to load TFLite model, using fallback heuristics instead: %s', exc)
            self.interpreter = None

    def _open_camera(self) -> None:
        if cv2 is None:
            logger.warning('OpenCV is not installed. Camera capture will run in simulated mode.')
            return

        source: int | str
        source = int(self.config.camera_source) if str(self.config.camera_source).isdigit() else self.config.camera_source

        try:
            self.capture = cv2.VideoCapture(source)
            self.capture.set(cv2.CAP_PROP_FRAME_WIDTH, self.config.camera_frame_width)
            self.capture.set(cv2.CAP_PROP_FRAME_HEIGHT, self.config.camera_frame_height)
            if not self.capture.isOpened():
                logger.warning('Camera source %s could not be opened. Using simulated CV events.', self.config.camera_source)
                self.capture.release()
                self.capture = None
        except Exception as exc:  # noqa: BLE001 - camera backends vary widely
            logger.warning('Camera initialization failed. Using simulated CV events instead: %s', exc)
            self.capture = None

    def _is_waste_label(self, label: str) -> bool:
        lowered = label.strip().lower()
        return any(keyword in lowered for keyword in WASTE_LABEL_HINTS)

    def _capture_frame(self) -> Any | None:
        if self.capture is None:
            return None

        ok, frame = self.capture.read()
        if not ok:
            return None
        return frame

    def _fallback_detect(self, frame: Any | None) -> list[dict[str, Any]]:
        if cv2 is not None and np is not None and frame is not None:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            _, thresh = cv2.threshold(gray, 75, 255, cv2.THRESH_BINARY_INV)
            clutter_ratio = float(np.mean(thresh > 0))
            if clutter_ratio >= 0.18:
                return [
                    {
                        'label': 'debris',
                        'confidence': round(min(0.97, 0.58 + clutter_ratio), 2),
                        'count': max(1, int(clutter_ratio * 10)),
                    }
                ]

        synthetic_hit = self._frame_counter % 15 in {0, 1}
        if synthetic_hit:
            return [
                {
                    'label': random.choice(DEFAULT_WASTE_LABELS[:4]),
                    'confidence': round(random.uniform(0.8, 0.95), 2),
                    'count': random.randint(1, 4),
                }
            ]
        return []

    def _tflite_detect(self, frame: Any) -> list[dict[str, Any]]:
        if self.interpreter is None or cv2 is None or np is None:
            return self._fallback_detect(frame)

        input_detail = self.input_details[0]
        _, input_height, input_width, _ = input_detail['shape']
        resized = cv2.resize(frame, (int(input_width), int(input_height)))
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
        input_tensor = np.expand_dims(rgb, axis=0)

        if input_detail['dtype'] == np.float32:
            input_tensor = input_tensor.astype(np.float32) / 255.0
        else:
            scale, zero_point = input_detail.get('quantization', (0.0, 0))
            if scale and scale > 0:
                input_tensor = (input_tensor.astype(np.float32) / 255.0 / scale + zero_point).astype(input_detail['dtype'])
            else:
                input_tensor = input_tensor.astype(input_detail['dtype'])

        self.interpreter.set_tensor(input_detail['index'], input_tensor)
        self.interpreter.invoke()
        outputs = [self.interpreter.get_tensor(detail['index']) for detail in self.output_details]
        parsed: list[tuple[str, float]] = []

        if len(outputs) == 1 and getattr(outputs[0], 'ndim', 0) == 3 and outputs[0].shape[-1] >= 6:
            for row in outputs[0][0]:
                score = float(row[4])
                if score < self.config.cv_confidence_threshold:
                    continue
                class_id = int(row[5]) if len(row) > 5 else 0
                label = self.labels[class_id] if 0 <= class_id < len(self.labels) else f'class_{class_id}'
                if self._is_waste_label(label):
                    parsed.append((label, score))
        elif len(outputs) >= 3:
            boxes = outputs[0]
            classes = outputs[1]
            scores = outputs[2]
            count = int(outputs[3][0]) if len(outputs) > 3 else len(scores[0])
            for index in range(count):
                score = float(scores[0][index])
                if score < self.config.cv_confidence_threshold:
                    continue
                class_id = int(classes[0][index])
                label = self.labels[class_id] if 0 <= class_id < len(self.labels) else f'class_{class_id}'
                if self._is_waste_label(label):
                    parsed.append((label, score))

        if not parsed:
            return []

        summary: dict[str, dict[str, Any]] = {}
        for label, score in parsed:
            record = summary.setdefault(label, {'label': label, 'confidence': 0.0, 'count': 0})
            record['confidence'] = max(record['confidence'], round(score, 2))
            record['count'] += 1

        return sorted(summary.values(), key=lambda item: (item['count'], item['confidence']), reverse=True)

    def run(self) -> None:
        while not self.stop_event.is_set():
            self._frame_counter += 1
            frame = self._capture_frame()
            detections = self._tflite_detect(frame) if frame is not None else self._fallback_detect(frame)
            blockage_detected = bool(detections)
            max_confidence = max((item['confidence'] for item in detections), default=0.0)

            severity = 'low'
            if blockage_detected:
                severity = 'high' if max_confidence >= 0.85 or sum(item['count'] for item in detections) >= 3 else 'medium'

            self.state_store.update(
                blockage_detected=blockage_detected,
                waste_classification=detections,
                last_vision_timestamp=iso_now(),
            )

            if (
                blockage_detected
                or blockage_detected != self._last_blockage_state
                or (time.monotonic() - self._last_alert_at) >= self.config.blockage_refresh_seconds
            ):
                self.publisher.queue_message(
                    'alerts/edge-ai',
                    {
                        'schema_version': '1.0.0',
                        'city': self.config.city,
                        'node_id': self.config.node_id,
                        'timestamp': iso_now(),
                        'blockage_detected': blockage_detected,
                        'severity': severity,
                        'waste_classification': detections,
                        'notes': (
                            'Quantized TFLite CV pipeline active for waste detection.'
                            if self.interpreter is not None
                            else 'Fallback OpenCV heuristic mode active until a quantized TFLite model is provided.'
                        ),
                    },
                )
                self._last_alert_at = time.monotonic()

            self._last_blockage_state = blockage_detected
            self.stop_event.wait(timeout=self.config.cv_inference_interval_seconds)

        if self.capture is not None:
            with suppress(Exception):
                self.capture.release()


class SmartDrainageLayer2Runtime:
    def __init__(self, config: EdgeConfig | None = None) -> None:
        self.config = config or EdgeConfig()
        self.stop_event = threading.Event()
        self.state_store = SharedStateStore()
        self.valve_controller = ValveController(self.config)
        self.publisher = EdgeMQTTPublisher(self.config, self.stop_event)
        self.publisher_thread = threading.Thread(target=self.publisher.run, name='mqtt-publisher', daemon=True)
        self.water_monitor = WaterLevelMonitor(
            self.config,
            self.stop_event,
            self.state_store,
            self.valve_controller,
            self.publisher,
        )
        self.cv_thread = WasteDetectionThread(
            self.config,
            self.stop_event,
            self.state_store,
            self.publisher,
        )

    def start(self) -> None:
        logger.info('Starting Layer 2 edge runtime for node %s', self.config.node_id)
        self.publisher_thread.start()
        self.water_monitor.start()
        self.cv_thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.water_monitor.join(timeout=3)
        self.cv_thread.join(timeout=3)
        self.publisher.stop()
        self.publisher_thread.join(timeout=3)
        self.valve_controller.cleanup()
        logger.info('Layer 2 edge runtime stopped cleanly.')

    def run(self) -> int:
        self.start()
        deadline = time.monotonic() + self.config.run_seconds if self.config.run_seconds > 0 else None

        try:
            while not self.stop_event.is_set():
                if deadline is not None and time.monotonic() >= deadline:
                    logger.info('Configured EDGE_RUN_SECONDS reached. Stopping the edge runtime.')
                    break
                time.sleep(0.5)
        except KeyboardInterrupt:
            logger.info('Keyboard interrupt received. Shutting down Layer 2 runtime.')
        finally:
            self.stop()

        return 0


def main() -> int:
    runtime = SmartDrainageLayer2Runtime()
    return runtime.run()


if __name__ == '__main__':
    raise SystemExit(main())
