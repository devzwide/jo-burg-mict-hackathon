from __future__ import annotations

import json
import logging
import os
import random
import socket
import ssl
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, request

import paho.mqtt.client as mqtt
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BASE_DIR / '.env')

logging.basicConfig(level=os.getenv('LOG_LEVEL', 'INFO').upper())
logger = logging.getLogger('smart-drainage-edge-gateway')

WASTE_TYPES = ('plastic', 'leaves', 'sediment', 'paper')


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def create_mqtt_client(*, client_id: str) -> mqtt.Client:
    callback_api_version = getattr(getattr(mqtt, 'CallbackAPIVersion', None), 'VERSION2', None)
    if callback_api_version is not None:
        return mqtt.Client(callback_api_version=callback_api_version, client_id=client_id, protocol=mqtt.MQTTv311)
    return mqtt.Client(client_id=client_id, protocol=mqtt.MQTTv311)


@dataclass(slots=True)
class GatewayConfig:
    city: str = os.getenv('CITY_NAMESPACE', 'smart-city')
    gateway_id: str = os.getenv('EDGE_GATEWAY_ID', f'rpi-gateway-{socket.gethostname()}')
    node_ids: tuple[str, ...] = tuple(
        node.strip()
        for node in os.getenv('EDGE_GATEWAY_NODE_IDS', 'S-14,S-08,S-22,S-03').split(',')
        if node.strip()
    )
    mqtt_host: str = normalize_mqtt_host(os.getenv('MQTT_HOST', ''))
    mqtt_port: int = int(os.getenv('MQTT_PORT', '8883'))
    mqtt_username: str | None = os.getenv('MQTT_EDGE_USERNAME') or os.getenv('MQTT_USERNAME') or None
    mqtt_password: str | None = os.getenv('MQTT_EDGE_PASSWORD') or os.getenv('MQTT_PASSWORD') or None
    mqtt_ca_cert: str | None = resolve_optional_path(os.getenv('MQTT_CA_CERT'))
    mqtt_client_cert: str | None = resolve_optional_path(os.getenv('MQTT_CLIENT_CERT'))
    mqtt_client_key: str | None = resolve_optional_path(os.getenv('MQTT_CLIENT_KEY'))
    alert_api_url: str | None = os.getenv('EDGE_ALERT_API_URL') or None
    telemetry_delta_mm: int = int(os.getenv('TELEMETRY_DELTA_MM', '25'))
    telemetry_delta_pct: float = float(os.getenv('TELEMETRY_DELTA_PCT', '5'))
    heartbeat_seconds: int = int(os.getenv('HEARTBEAT_SECONDS', '60'))
    publish_interval_seconds: int = int(os.getenv('PUBLISH_INTERVAL_SECONDS', '5'))
    initial_backoff_seconds: int = int(os.getenv('MQTT_INITIAL_BACKOFF_SECONDS', '1'))
    max_backoff_seconds: int = int(os.getenv('MQTT_MAX_BACKOFF_SECONDS', '32'))


class DummySensorSuite:
    def __init__(self) -> None:
        self.tick = 0

    def read_node(self, node_id: str, city: str) -> tuple[dict[str, Any], dict[str, Any]]:
        self.tick += 1
        index = sum(ord(char) for char in node_id) % 4
        wave_bias = ((self.tick * 5) + (index * 7)) % 22 - 10
        water_pct = clamp(38 + index * 8 + wave_bias, 7, 97)
        if node_id == 'S-22' and self.tick % 4 == 0:
            water_pct = clamp(water_pct + 18, 7, 98)

        blockage = water_pct > 72 or (node_id == 'S-22' and self.tick % 5 == 0)
        severity = 'high' if water_pct > 82 else 'medium' if blockage else 'low'
        waste_classification = []
        if blockage:
            waste_classification = [
                {
                    'label': random.choice(WASTE_TYPES),
                    'confidence': round(random.uniform(0.8, 0.97), 2),
                    'count': random.randint(1, 6),
                }
            ]

        water_payload = {
            'schema_version': '1.0.0',
            'city': city,
            'node_id': node_id,
            'timestamp': iso_now(),
            'water_level_mm': int(round(water_pct * 11.2)),
            'water_level_pct': round(water_pct, 1),
            'flow_rate_lps': round(clamp(76 - water_pct * 0.32 + random.uniform(-2.5, 2.5), 16, 90), 1),
            'battery_pct': round(clamp(97 - (self.tick % 10) * 0.5 - index, 84, 99), 1),
            'signal_rssi_dbm': -48 - (index * 5),
        }
        alert_payload = {
            'schema_version': '1.0.0',
            'city': city,
            'node_id': node_id,
            'timestamp': iso_now(),
            'blockage_detected': blockage,
            'severity': severity,
            'waste_classification': waste_classification,
            'notes': 'POPIA-safe metadata only. No raw images are transmitted.',
        }
        return water_payload, alert_payload


class SmartDrainageEdgeGateway:
    def __init__(self, config: GatewayConfig) -> None:
        self.config = config
        self.client = create_mqtt_client(client_id=config.gateway_id)
        self.sensor_suite = DummySensorSuite()
        self.connected = False
        self.last_published: dict[str, dict[str, Any]] = {}
        self.last_sent_at: dict[str, float] = {}
        self.last_status_at: dict[str, float] = {}
        self.loop_started = False
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
        self.client.tls_insecure_set(os.getenv('MQTT_TLS_INSECURE', 'false').lower() == 'true')

        will_payload = json.dumps(
            {
                'schema_version': '1.0.0',
                'node_id': self.config.gateway_id,
                'timestamp': iso_now(),
                'status': 'offline',
                'gateway_id': self.config.gateway_id,
                'reason': 'LWT: unexpected disconnect',
            }
        )
        self.client.will_set(
            f'city/drainage/{self.config.gateway_id}/status',
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
            logger.info('Connected to MQTT broker %s:%s over TLS', self.config.mqtt_host, self.config.mqtt_port)
            self.publish_gateway_status('online', 'gateway connected')
            for node_id in self.config.node_ids:
                self.publish_node_status(node_id, 'online', 'initial heartbeat')
        else:
            logger.error('MQTT connection failed with code %s', code)

    def _on_disconnect(self, client: mqtt.Client, userdata: Any, reason_code: Any, properties: Any = None) -> None:
        self.connected = False
        logger.warning('Disconnected from MQTT broker with code %s', getattr(reason_code, 'value', reason_code))

    def topic_for(self, node_id: str, suffix: str) -> str:
        return f'city/drainage/{node_id}/{suffix}'

    def publish_json(self, topic: str, payload: dict[str, Any], *, qos: int = 1, retain: bool = False) -> None:
        self.client.publish(topic, json.dumps(payload), qos=qos, retain=retain)

    def publish_gateway_status(self, status: str, reason: str) -> None:
        self.publish_json(
            self.topic_for(self.config.gateway_id, 'status'),
            {
                'schema_version': '1.0.0',
                'node_id': self.config.gateway_id,
                'timestamp': iso_now(),
                'status': status,
                'gateway_id': self.config.gateway_id,
                'reason': reason,
            },
            retain=True,
        )

    def publish_node_status(self, node_id: str, status: str, reason: str) -> None:
        self.publish_json(
            self.topic_for(node_id, 'status'),
            {
                'schema_version': '1.0.0',
                'node_id': node_id,
                'timestamp': iso_now(),
                'status': status,
                'gateway_id': self.config.gateway_id,
                'reason': reason,
            },
            retain=True,
        )
        self.last_status_at[node_id] = time.monotonic()

    def should_publish(self, node_id: str, telemetry: dict[str, Any], alert: dict[str, Any]) -> bool:
        previous = self.last_published.get(node_id)
        last_sent = self.last_sent_at.get(node_id, 0.0)
        heartbeat_due = (time.monotonic() - last_sent) >= self.config.heartbeat_seconds

        if previous is None:
            return True

        mm_delta = abs(telemetry['water_level_mm'] - previous['water_level_mm'])
        pct_delta = abs(telemetry['water_level_pct'] - previous['water_level_pct'])
        return (
            mm_delta >= self.config.telemetry_delta_mm
            or pct_delta >= self.config.telemetry_delta_pct
            or alert['blockage_detected']
            or heartbeat_due
        )

    def forward_alert_to_rest(self, alert_payload: dict[str, Any]) -> None:
        if not self.config.alert_api_url or not alert_payload['blockage_detected']:
            return

        body = json.dumps(alert_payload).encode('utf-8')
        rest_request = request.Request(
            self.config.alert_api_url,
            data=body,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )

        try:
            with request.urlopen(rest_request, timeout=5) as response:
                logger.info('Forwarded alert for %s over HTTP(S) REST (%s)', alert_payload['node_id'], response.status)
        except error.URLError as exc:
            logger.warning('HTTPS alert forward failed for %s: %s', alert_payload['node_id'], exc)

    def connect_with_backoff(self) -> None:
        if not self.config.mqtt_host:
            raise RuntimeError('Set MQTT_HOST in the environment before running the gateway.')

        delay = self.config.initial_backoff_seconds
        if not self.loop_started:
            self.client.loop_start()
            self.loop_started = True

        while not self.connected:
            try:
                logger.info('Attempting MQTT TLS connection to %s:%s', self.config.mqtt_host, self.config.mqtt_port)
                self.client.connect(self.config.mqtt_host, self.config.mqtt_port, keepalive=45)
                time.sleep(1)
                if not self.connected:
                    raise ConnectionError('Broker did not acknowledge the TLS session.')
            except Exception as exc:  # noqa: BLE001 - hardware resilience loop
                logger.warning('MQTT connection failed: %s. Retrying in %ss', exc, delay)
                time.sleep(delay)
                delay = min(delay * 2, self.config.max_backoff_seconds)
            else:
                delay = self.config.initial_backoff_seconds

    def run(self) -> None:
        self.connect_with_backoff()
        logger.info('Gateway started for nodes: %s', ', '.join(self.config.node_ids))

        try:
            while True:
                if not self.connected:
                    self.connect_with_backoff()

                for node_id in self.config.node_ids:
                    telemetry, alert = self.sensor_suite.read_node(node_id, self.config.city)

                    if self.should_publish(node_id, telemetry, alert):
                        self.publish_json(self.topic_for(node_id, 'telemetry/water-level'), telemetry)
                        self.last_published[node_id] = telemetry
                        self.last_sent_at[node_id] = time.monotonic()
                        logger.info(
                            'Published %s water level %s mm (%s%%)',
                            node_id,
                            telemetry['water_level_mm'],
                            telemetry['water_level_pct'],
                        )

                    if alert['blockage_detected']:
                        self.publish_json(self.topic_for(node_id, 'alerts/edge-ai'), alert)
                        self.forward_alert_to_rest(alert)
                        logger.warning('Alert published for %s with severity %s', node_id, alert['severity'])

                    if (time.monotonic() - self.last_status_at.get(node_id, 0.0)) >= self.config.heartbeat_seconds:
                        self.publish_node_status(node_id, 'online', 'periodic heartbeat')

                time.sleep(self.config.publish_interval_seconds)
        finally:
            self.publish_gateway_status('offline', 'graceful shutdown')
            if self.loop_started:
                self.client.loop_stop()
                self.loop_started = False
            self.client.disconnect()


if __name__ == '__main__':
    SmartDrainageEdgeGateway(GatewayConfig()).run()
