#!/usr/bin/env python3
"""
Test script to simulate waste detection and publish edge AI alerts.
This demonstrates the camera-to-dashboard data flow.
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import paho.mqtt.client as mqtt
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BASE_DIR / '.env')


def create_mqtt_client(client_id: str) -> mqtt.Client:
    """Create MQTT client with version 2 callback API."""
    callback_api_version = getattr(getattr(mqtt, 'CallbackAPIVersion', None), 'VERSION2', None)
    if callback_api_version:
        return mqtt.Client(callback_api_version=callback_api_version, client_id=client_id, protocol=mqtt.MQTTv311)
    return mqtt.Client(client_id=client_id, protocol=mqtt.MQTTv311)


def publish_waste_detection(
    node_id: str = 'S-22',
    waste_labels: list[str] | None = None,
    severity: str = 'high',
) -> None:
    """Publish waste detection alert simulating camera analytics."""

    if waste_labels is None:
        waste_labels = ['plastic', 'bottle', 'debris', 'leaves']

    client = create_mqtt_client(f'test-waste-detector-{node_id}')

    mqtt_host = os.getenv('MQTT_HOST', '').strip()
    mqtt_port = int(os.getenv('MQTT_PORT', '8883'))
    mqtt_user = os.getenv('MQTT_EDGE_USERNAME') or os.getenv('MQTT_USERNAME')
    mqtt_pass = os.getenv('MQTT_EDGE_PASSWORD') or os.getenv('MQTT_PASSWORD')

    if mqtt_user:
        client.username_pw_set(mqtt_user, mqtt_pass)

    # Configure TLS
    try:
        client.tls_set(tls_version=__import__('ssl').PROTOCOL_TLS_CLIENT)
        client.tls_insecure_set(os.getenv('MQTT_TLS_INSECURE', 'false').lower() == 'true')
    except Exception:
        pass

    def on_connect(client, userdata, flags, reason_code, properties=None):
        code = getattr(reason_code, 'value', reason_code)
        if code == 0:
            print(f'✓ Connected to MQTT broker at {mqtt_host}:{mqtt_port}')
        else:
            print(f'✗ Connection failed with code {code}')
            sys.exit(1)

    def on_disconnect(client, userdata, reason_code, properties=None):
        print('Disconnected from MQTT broker')

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect

    # Connect
    try:
        print(f'Connecting to {mqtt_host}:{mqtt_port}...')
        client.connect(mqtt_host, mqtt_port, keepalive=10)
        client.loop_start()
    except Exception as e:
        print(f'✗ Failed to connect: {e}')
        print('\nRun with demo fallback (no real MQTT):')
        print('  MQTT_HOST="" python scripts/test_waste_detection.py')
        sys.exit(1)

    # Wait briefly for connection
    import time
    time.sleep(2)

    if not client.is_connected():
        print('✗ MQTT connection failed. Ensure configuration is correct.')
        sys.exit(1)

    # Build waste classification payload
    waste_classification = [
        {'label': label, 'confidence': round(0.85 + (i * 0.05), 2), 'count': i + 1}
        for i, label in enumerate(waste_labels[:3])
    ]

    # Create edge AI alert matching the schema
    alert = {
        'schema_version': '1.0.0',
        'city': os.getenv('CITY_NAMESPACE', 'smart-city'),
        'node_id': node_id,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'blockage_detected': True,
        'severity': severity,
        'waste_classification': waste_classification,
        'notes': 'Test waste detection from camera analytics—this simulates edge AI running on Raspberry Pi.',
    }

    topic = f'city/drainage/{node_id}/alerts/edge-ai'
    payload = json.dumps(alert)

    print(f'\nPublishing waste detection alert...')
    print(f'Topic: {topic}')
    print(f'Payload: {json.dumps(alert, indent=2)}')

    try:
        msg_info = client.publish(topic, payload, qos=1, retain=False)
        msg_info.wait_for_publish(timeout=5)

        if msg_info.is_published():
            print(f'\n✓ Alert published successfully!')
            print(f'  Detected items: {", ".join(waste_labels[:3])}')
            print(f'  Severity: {severity}')
        else:
            print(f'✗ Failed to publish alert')
            sys.exit(1)
    except Exception as e:
        print(f'✗ Publish error: {e}')
        sys.exit(1)

    # Keep connection alive for a moment
    time.sleep(1)
    client.loop_stop()
    client.disconnect()
    print('\nDone!')


def demo_mode() -> None:
    """Run demo without real MQTT—just log what would be sent."""
    print('🔄 Running in DEMO MODE (no real MQTT)\n')

    waste_labels = ['plastic', 'bottle', 'debris']
    alert = {
        'schema_version': '1.0.0',
        'city': 'smart-city',
        'node_id': 'S-22',
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'blockage_detected': True,
        'severity': 'high',
        'waste_classification': [
            {'label': 'plastic', 'confidence': 0.93, 'count': 2},
            {'label': 'bottle', 'confidence': 0.88, 'count': 1},
            {'label': 'debris', 'confidence': 0.85, 'count': 1},
        ],
        'notes': 'Demo: Edge AI camera analytics detected waste in the drainage system.',
    }

    print('📤 Would publish this alert to MQTT:')
    print(f'   Topic: city/drainage/S-22/alerts/edge-ai')
    print(f'   Payload:\n{json.dumps(alert, indent=2)}')
    print('\n✓ In production, this alert triggers the camera feed and displays waste in the dashboard.')
    print('  Real camera frames would stream via /api/v1/camera-stream SSE endpoint.')


if __name__ == '__main__':
    mqtt_host = os.getenv('MQTT_HOST', '').strip()

    if not mqtt_host or mqtt_host.lower() in {'your-broker-hostname', 'broker.example.com'}:
        demo_mode()
    else:
        try:
            publish_waste_detection(node_id='S-22', waste_labels=['plastic', 'bottle', 'debris'], severity='high')
        except KeyboardInterrupt:
            print('\nCancelled')
            sys.exit(0)
