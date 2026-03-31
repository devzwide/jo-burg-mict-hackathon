from __future__ import annotations

import json
import os
import ssl
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import paho.mqtt.client as mqtt
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BASE_DIR / '.env')

NODE_ID = os.getenv('TEST_NODE_ID', 'S-22')
CITY = os.getenv('CITY_NAMESPACE', 'smart-city')
BROKER_HOST = os.getenv('MQTT_HOST', '')
BROKER_PORT = int(os.getenv('MQTT_PORT', '8883'))
USERNAME = os.getenv('MQTT_EDGE_USERNAME') or os.getenv('MQTT_USERNAME')
PASSWORD = os.getenv('MQTT_EDGE_PASSWORD') or os.getenv('MQTT_PASSWORD')
CA_CERT = os.getenv('MQTT_CA_CERT')
TLS_INSECURE = os.getenv('MQTT_TLS_INSECURE', 'false').lower() == 'true'


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def resolve_optional_path(value: str | None) -> str | None:
    if not value:
        return None

    path = Path(value)
    return str(path if path.is_absolute() else (BASE_DIR / path).resolve())


def main() -> int:
    if not BROKER_HOST:
        print('Set MQTT_HOST in .env before running this smoke test.')
        return 1

    connected = threading.Event()
    result_code = {'value': None}

    def on_connect(client: mqtt.Client, userdata, flags, reason_code, properties=None) -> None:
        code = getattr(reason_code, 'value', reason_code)
        result_code['value'] = code
        if code == 0:
            connected.set()

    client = mqtt.Client(client_id=f'mqtt-smoke-test-{NODE_ID}', protocol=mqtt.MQTTv311)
    if USERNAME:
        client.username_pw_set(USERNAME, PASSWORD)

    client.tls_set(
        ca_certs=resolve_optional_path(CA_CERT),
        certfile=resolve_optional_path(os.getenv('MQTT_CLIENT_CERT')),
        keyfile=resolve_optional_path(os.getenv('MQTT_CLIENT_KEY')),
        tls_version=ssl.PROTOCOL_TLS_CLIENT,
    )
    client.tls_insecure_set(TLS_INSECURE)
    client.on_connect = on_connect

    client.connect(BROKER_HOST, BROKER_PORT, keepalive=30)
    client.loop_start()

    if not connected.wait(timeout=10):
        client.loop_stop()
        print(f'Connection failed or timed out. MQTT reason code: {result_code["value"]}')
        return 2

    telemetry_payload = {
        'schema_version': '1.0.0',
        'city': CITY,
        'node_id': NODE_ID,
        'timestamp': iso_now(),
        'water_level_mm': 845,
        'water_level_pct': 75.4,
        'flow_rate_lps': 31.8,
        'battery_pct': 94.7,
        'signal_rssi_dbm': -53,
    }
    alert_payload = {
        'schema_version': '1.0.0',
        'city': CITY,
        'node_id': NODE_ID,
        'timestamp': iso_now(),
        'blockage_detected': True,
        'severity': 'high',
        'waste_classification': [
            {'label': 'plastic', 'confidence': 0.95, 'count': 3},
            {'label': 'leaves', 'confidence': 0.83, 'count': 5},
        ],
        'notes': 'Smoke test publish. POPIA-safe operational metadata only.',
    }

    telemetry_topic = f'city/drainage/{NODE_ID}/telemetry/water-level'
    alert_topic = f'city/drainage/{NODE_ID}/alerts/edge-ai'

    client.publish(telemetry_topic, json.dumps(telemetry_payload), qos=1)
    client.publish(alert_topic, json.dumps(alert_payload), qos=1)
    time.sleep(1)
    client.loop_stop()
    client.disconnect()

    print('Published sample MQTT messages successfully:')
    print(f'  - {telemetry_topic}')
    print(f'  - {alert_topic}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
