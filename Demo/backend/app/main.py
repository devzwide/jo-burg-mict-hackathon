from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import ssl
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.httpsredirect import HTTPSRedirectMiddleware
from pydantic import BaseModel, ConfigDict, Field

try:
    import paho.mqtt.client as mqtt
except ImportError:  # pragma: no cover - handled at runtime when deps are missing
    mqtt = None

BASE_DIR = Path(__file__).resolve().parents[2]
load_dotenv(BASE_DIR / '.env')

logging.basicConfig(level=os.getenv('LOG_LEVEL', 'INFO').upper())
logger = logging.getLogger('smart-drainage-comm')

SENSOR_REGISTRY: dict[str, dict[str, Any]] = {
    'S-14': {'name': 'North Inlet', 'zone': 'North', 'gps': [25.2854, 51.5310]},
    'S-08': {'name': 'East Junction', 'zone': 'East', 'gps': [25.2826, 51.5346]},
    'S-22': {'name': 'Central Basin', 'zone': 'Central', 'gps': [25.2811, 51.5268]},
    'S-03': {'name': 'West Outlet', 'zone': 'West', 'gps': [25.2794, 51.5239]},
}
NODE_ORDER = list(SENSOR_REGISTRY.keys())

TOPIC_CONTRACT = {
    'status': {
        'topic': 'city/drainage/{node_id}/status',
        'purpose': 'LWT/heartbeat channel for online-offline node monitoring',
        'qos': 1,
        'retain': True,
    },
    'water_level': {
        'topic': 'city/drainage/{node_id}/telemetry/water-level',
        'purpose': 'Telemetry stream for level, percentage, flow, battery, and RSSI',
        'qos': 1,
        'retain': False,
    },
    'edge_ai_alerts': {
        'topic': 'city/drainage/{node_id}/alerts/edge-ai',
        'purpose': 'Edge AI blockage detection and waste classification summaries',
        'qos': 1,
        'retain': False,
    },
    'websocket_dashboard': {
        'endpoint': '/ws/telemetry',
        'purpose': 'Real-time digital twin push updates for the 3D dashboard',
    },
    'https_alert_ingest': {
        'endpoint': '/api/v1/edge-alerts',
        'purpose': 'HTTPS REST endpoint for urgent edge-originated alerts',
    },
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat()


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


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


def create_mqtt_client(*, client_id: str) -> Any:
    callback_api = getattr(mqtt, 'CallbackAPIVersion', None) if mqtt is not None else None
    callback_api_version = getattr(callback_api, 'VERSION2', None)
    if callback_api_version is not None:
        return mqtt.Client(callback_api_version=callback_api_version, client_id=client_id, protocol=mqtt.MQTTv311)
    return mqtt.Client(client_id=client_id, protocol=mqtt.MQTTv311)


class WaterLevelData(BaseModel):
    model_config = ConfigDict(extra='ignore')

    schema_version: str = '1.0.0'
    city: str = Field(default='smart-city', examples=['cape-town'])
    node_id: str = Field(..., examples=['S-14'])
    timestamp: datetime = Field(default_factory=utc_now)
    water_level_mm: int = Field(..., ge=0, le=4000)
    water_level_pct: float = Field(..., ge=0, le=100)
    flow_rate_lps: float = Field(default=0, ge=0)
    battery_pct: float | None = Field(default=None, ge=0, le=100)
    signal_rssi_dbm: int | None = Field(default=None, ge=-120, le=0)


class WasteClassification(BaseModel):
    model_config = ConfigDict(extra='ignore')

    label: str = Field(..., examples=['plastic'])
    confidence: float = Field(..., ge=0, le=1)
    count: int = Field(default=1, ge=1)


class EdgeAIAlert(BaseModel):
    model_config = ConfigDict(extra='ignore')

    schema_version: str = '1.0.0'
    city: str = Field(default='smart-city')
    node_id: str = Field(..., examples=['S-22'])
    timestamp: datetime = Field(default_factory=utc_now)
    blockage_detected: bool
    severity: Literal['low', 'medium', 'high', 'critical'] = 'medium'
    waste_classification: list[WasteClassification] = Field(default_factory=list)
    notes: str | None = Field(
        default='Operational metadata only. Do not send raw camera frames or personal data.',
        max_length=240,
    )


class NodeStatusMessage(BaseModel):
    model_config = ConfigDict(extra='ignore')

    schema_version: str = '1.0.0'
    node_id: str
    timestamp: datetime = Field(default_factory=utc_now)
    status: Literal['online', 'offline', 'degraded'] = 'online'
    gateway_id: str | None = None
    reason: str = 'heartbeat'


class ConnectionManager:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()

    @property
    def count(self) -> int:
        return len(self._clients)

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self._clients.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self._clients.discard(websocket)

    async def broadcast(self, message: dict[str, Any]) -> None:
        stale_clients: list[WebSocket] = []

        for client in tuple(self._clients):
            try:
                await client.send_json(message)
            except Exception:
                stale_clients.append(client)

        for client in stale_clients:
            self.disconnect(client)


connection_manager = ConnectionManager()
node_state: dict[str, dict[str, Any]] = {node_id: {} for node_id in SENSOR_REGISTRY}
recent_alerts: list[dict[str, Any]] = []


def ensure_node_state(node_id: str) -> dict[str, Any]:
    if node_id not in node_state:
        node_state[node_id] = {}
    return node_state[node_id]


def build_dashboard_payload(event_type: str = 'snapshot', source: str = 'fastapi') -> dict[str, Any]:
    sensors: list[dict[str, Any]] = []
    battery_samples: list[float] = []
    updated_candidates: list[datetime] = []

    ordered_node_ids = [*NODE_ORDER, *sorted(set(node_state) - set(NODE_ORDER))]

    for node_id in ordered_node_ids:
        snapshot = node_state.get(node_id, {})
        water: WaterLevelData | None = snapshot.get('water')
        alert: EdgeAIAlert | None = snapshot.get('alert')
        status: NodeStatusMessage | None = snapshot.get('status')
        meta = SENSOR_REGISTRY.get(
            node_id,
            {'name': node_id, 'zone': 'Unmapped', 'gps': [0.0, 0.0]},
        )

        if water and water.battery_pct is not None:
            battery_samples.append(water.battery_pct)
            updated_candidates.append(water.timestamp)
        if alert:
            updated_candidates.append(alert.timestamp)
        if status:
            updated_candidates.append(status.timestamp)

        sensors.append(
            {
                'id': node_id,
                'name': meta['name'],
                'zone': meta['zone'],
                'gps': meta['gps'],
                'waterLevel': round(water.water_level_pct) if water else 0,
                'waterLevelMm': water.water_level_mm if water else 0,
                'flowRate': round(water.flow_rate_lps) if water else 0,
                'blockageDetected': bool(alert and alert.blockage_detected),
                'status': status.status if status else 'unknown',
                'wasteClassification': [item.model_dump(mode='json') for item in alert.waste_classification]
                if alert
                else [],
            }
        )

    max_level = max((sensor['waterLevel'] for sensor in sensors), default=0)
    alert_nodes = [sensor['name'] for sensor in sensors if sensor['blockageDetected']]
    last_update = max(updated_candidates, default=utc_now())

    return {
        'type': event_type,
        'source': source,
        'contractVersion': '1.0.0',
        'transport': {
            'mqttTlsPort': 8883,
            'dashboard': 'websocket',
            'alerts': 'https-rest',
            'mqttConnected': mqtt_bridge.connected,
        },
        'updatedAt': last_update.isoformat(),
        'health': round(sum(battery_samples) / len(battery_samples)) if battery_samples else 96,
        'waterLevel': max_level,
        'waterLevelMm': max((sensor['waterLevelMm'] for sensor in sensors), default=0),
        'floodRisk': round(clamp(max_level * 0.78 + (15 if alert_nodes else 6), 0, 100)),
        'pressure': round(clamp(76 - max_level * 0.2 - (10 if alert_nodes else 0), 38, 80)),
        'blockageDetected': bool(alert_nodes),
        'blockedSegment': alert_nodes[0] if alert_nodes else 'All pipe segments clear',
        'alerts': recent_alerts[:5],
        'sensors': sensors,
    }


async def process_water_telemetry(payload: WaterLevelData | dict[str, Any], source: str = 'mqtt') -> None:
    data = payload if isinstance(payload, WaterLevelData) else WaterLevelData.model_validate(payload)
    snapshot = ensure_node_state(data.node_id)
    snapshot['water'] = data
    await connection_manager.broadcast(build_dashboard_payload(event_type='telemetry', source=source))


async def process_edge_alert(payload: EdgeAIAlert | dict[str, Any], source: str = 'mqtt') -> None:
    data = payload if isinstance(payload, EdgeAIAlert) else EdgeAIAlert.model_validate(payload)
    snapshot = ensure_node_state(data.node_id)
    snapshot['alert'] = data

    recent_alerts.insert(
        0,
        {
            'nodeId': data.node_id,
            'severity': data.severity,
            'blockageDetected': data.blockage_detected,
            'wasteClassification': [item.model_dump(mode='json') for item in data.waste_classification],
            'timestamp': data.timestamp.isoformat(),
        },
    )
    del recent_alerts[5:]

    await connection_manager.broadcast(build_dashboard_payload(event_type='alert', source=source))


async def process_status_message(node_id: str, payload: dict[str, Any], source: str = 'mqtt') -> None:
    data = NodeStatusMessage.model_validate({'node_id': node_id, **payload})
    snapshot = ensure_node_state(node_id)
    snapshot['status'] = data
    await connection_manager.broadcast(build_dashboard_payload(event_type='status', source=source))


async def handle_incoming_message(topic: str, payload: dict[str, Any]) -> None:
    parts = topic.split('/')
    if len(parts) < 4 or parts[0] != 'city' or parts[1] != 'drainage':
        logger.warning('Ignoring topic outside contract: %s', topic)
        return

    node_id = parts[2]
    suffix = '/'.join(parts[3:])

    if suffix == 'telemetry/water-level':
        await process_water_telemetry(payload, source='mqtt')
    elif suffix == 'alerts/edge-ai':
        await process_edge_alert(payload, source='mqtt')
    elif suffix == 'status':
        await process_status_message(node_id, payload, source='mqtt')
    else:
        logger.info('Unhandled MQTT topic: %s', topic)


class MQTTBridge:
    def __init__(self) -> None:
        self.client: Any | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.enabled = bool(normalize_mqtt_host(os.getenv('MQTT_HOST')))
        self.connected = False

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop

        if mqtt is None:
            logger.warning('paho-mqtt is not installed. Starting WebSocket/REST bridge without MQTT.')
            return

        host = normalize_mqtt_host(os.getenv('MQTT_HOST'))
        if not host:
            logger.info('MQTT_HOST is not configured. Running in local simulator mode.')
            return

        client = create_mqtt_client(client_id=os.getenv('MQTT_CLIENT_ID', 'smart-drainage-cloud-bridge'))

        username = os.getenv('MQTT_BRIDGE_USERNAME') or os.getenv('MQTT_USERNAME')
        password = os.getenv('MQTT_BRIDGE_PASSWORD') or os.getenv('MQTT_PASSWORD')
        if username:
            client.username_pw_set(username, password)

        client.tls_set(
            ca_certs=resolve_optional_path(os.getenv('MQTT_CA_CERT')),
            certfile=resolve_optional_path(os.getenv('MQTT_CLIENT_CERT')),
            keyfile=resolve_optional_path(os.getenv('MQTT_CLIENT_KEY')),
            tls_version=ssl.PROTOCOL_TLS_CLIENT,
        )
        client.tls_insecure_set(os.getenv('MQTT_TLS_INSECURE', 'false').lower() == 'true')
        client.on_connect = self._on_connect
        client.on_disconnect = self._on_disconnect
        client.on_message = self._on_message
        client.connect_async(host, int(os.getenv('MQTT_PORT', '8883')), keepalive=45)
        client.loop_start()
        self.client = client

    def stop(self) -> None:
        if self.client is not None:
            with suppress(Exception):
                self.client.loop_stop()
                self.client.disconnect()

    def _on_connect(self, client: Any, userdata: Any, flags: Any, reason_code: Any, properties: Any = None) -> None:
        code = getattr(reason_code, 'value', reason_code)
        self.connected = code == 0

        if self.connected:
            logger.info('Connected to MQTT broker over TLS on port %s', os.getenv('MQTT_PORT', '8883'))
            client.subscribe('city/drainage/+/telemetry/+', qos=1)
            client.subscribe('city/drainage/+/alerts/+', qos=1)
            client.subscribe('city/drainage/+/status', qos=1)
        else:
            logger.error('MQTT broker connection failed with code %s', code)

    def _on_disconnect(self, client: Any, userdata: Any, reason_code: Any, properties: Any = None) -> None:
        self.connected = False
        logger.warning('MQTT bridge disconnected with code %s', getattr(reason_code, 'value', reason_code))

    def _on_message(self, client: Any, userdata: Any, msg: Any) -> None:
        if self.loop is None:
            return

        try:
            payload = json.loads(msg.payload.decode('utf-8') or '{}')
        except json.JSONDecodeError:
            logger.warning('Dropped invalid JSON on topic %s', msg.topic)
            return

        future = asyncio.run_coroutine_threadsafe(handle_incoming_message(msg.topic, payload), self.loop)

        def _log_failure(task: Any) -> None:
            exc = task.exception()
            if exc:
                logger.exception('Failed to process MQTT message: %s', exc)

        future.add_done_callback(_log_failure)


mqtt_bridge = MQTTBridge()

app = FastAPI(
    title='Smart Drainage Communication Layer',
    summary='FastAPI cloud-side bridge for MQTT, WebSockets, and HTTPS alerts.',
    version='1.0.0',
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv('CORS_ALLOW_ORIGINS', '*').split(','),
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

if os.getenv('FORCE_HTTPS', 'false').lower() == 'true':
    app.add_middleware(HTTPSRedirectMiddleware)


@app.on_event('startup')
async def on_startup() -> None:
    mqtt_bridge.start(asyncio.get_running_loop())

    demo_requested = os.getenv('ENABLE_DEMO_SIMULATOR', 'true').lower() == 'true'
    app.state.demo_simulator_enabled = demo_requested and not mqtt_bridge.enabled

    if app.state.demo_simulator_enabled:
        app.state.demo_task = asyncio.create_task(demo_simulator())
    elif demo_requested and mqtt_bridge.enabled:
        logger.info('Real MQTT broker configured; demo simulator suppressed for production-style flow.')


@app.on_event('shutdown')
async def on_shutdown() -> None:
    mqtt_bridge.stop()
    demo_task = getattr(app.state, 'demo_task', None)
    if demo_task:
        demo_task.cancel()
        with suppress(asyncio.CancelledError):
            await demo_task


@app.get('/')
async def root() -> dict[str, Any]:
    return {
        'service': 'smart-drainage-communication-layer',
        'status': 'ok',
        'docs': ['/health', '/api/v1/contracts', '/api/v1/edge-alerts', '/ws/telemetry'],
    }


@app.get('/health')
async def health() -> dict[str, Any]:
    return {
        'status': 'ok',
        'mode': 'mqtt-bridge' if mqtt_bridge.enabled else 'demo-simulator',
        'mqttEnabled': mqtt_bridge.enabled,
        'mqttConnected': mqtt_bridge.connected,
        'websocketClients': connection_manager.count,
        'demoSimulatorEnabled': getattr(app.state, 'demo_simulator_enabled', False),
    }


@app.get('/api/v1/contracts')
async def get_contracts() -> dict[str, Any]:
    return {
        'topicHierarchy': TOPIC_CONTRACT,
        'security': {
            'mqttTlsPort': 8883,
            'secretsPolicy': 'Credentials and certificates must come from environment variables or a secret vault.',
            'popia': 'Publish operational metadata only; avoid raw images, faces, or personal identifiers.',
        },
        'schemas': {
            'waterLevel': WaterLevelData.model_json_schema(),
            'edgeAlert': EdgeAIAlert.model_json_schema(),
            'status': NodeStatusMessage.model_json_schema(),
        },
    }


@app.post('/api/v1/edge-alerts', status_code=202)
async def ingest_edge_alert(alert: EdgeAIAlert) -> dict[str, Any]:
    await process_edge_alert(alert, source='https-rest')
    return {
        'accepted': True,
        'topicMirror': f'city/drainage/{alert.node_id}/alerts/edge-ai',
        'receivedAt': iso_now(),
    }


@app.websocket('/ws/telemetry')
async def telemetry_websocket(websocket: WebSocket) -> None:
    await connection_manager.connect(websocket)
    await websocket.send_json(build_dashboard_payload())

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        connection_manager.disconnect(websocket)


async def demo_simulator() -> None:
    city = os.getenv('CITY_NAMESPACE', 'smart-city')
    tick = 0

    while True:
        tick += 1

        for index, node_id in enumerate(NODE_ORDER):
            wave_bias = ((tick * 7) + (index * 11)) % 24 - 11
            water_pct = clamp(42 + (index - 1.5) * 7 + wave_bias, 8, 96)
            if node_id == 'S-22' and tick % 5 == 0:
                water_pct = clamp(water_pct + 16, 8, 98)

            water_payload = {
                'city': city,
                'node_id': node_id,
                'timestamp': iso_now(),
                'water_level_mm': int(round(water_pct * 11.5)),
                'water_level_pct': round(water_pct, 1),
                'flow_rate_lps': round(clamp(78 - water_pct * 0.35 + random.uniform(-3, 3), 18, 92), 1),
                'battery_pct': round(clamp(98 - (tick % 12) * 0.4 - index, 85, 99), 1),
                'signal_rssi_dbm': -50 - (index * 4),
            }
            await process_water_telemetry(water_payload, source='demo-simulator')

            blockage = water_pct > 72 or (node_id == 'S-22' and tick % 4 == 0)
            waste = []
            severity = 'low'
            if blockage:
                severity = 'high' if water_pct > 80 else 'medium'
                waste = [
                    {
                        'label': 'plastic',
                        'confidence': 0.92,
                        'count': 3,
                    },
                    {
                        'label': 'leaves',
                        'confidence': 0.81,
                        'count': 6,
                    },
                ]

            await process_edge_alert(
                {
                    'city': city,
                    'node_id': node_id,
                    'timestamp': iso_now(),
                    'blockage_detected': blockage,
                    'severity': severity,
                    'waste_classification': waste,
                },
                source='demo-simulator',
            )

            await process_status_message(
                node_id,
                {
                    'timestamp': iso_now(),
                    'status': 'online',
                    'reason': 'demo heartbeat',
                },
                source='demo-simulator',
            )

        await asyncio.sleep(2)
