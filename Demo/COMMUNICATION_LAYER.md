# Layer 3 — Communication Layer Implementation

## Protocol Mapping

- **MQTT over TLS (`8883`)**: edge telemetry, node heartbeats/LWT, and AI alerts.
- **WebSockets**: FastAPI pushes live updates to the React 3D dashboard via `ws://localhost:8000/ws/telemetry`.
- **HTTPS REST**: urgent edge alerts can also be mirrored to `POST /api/v1/edge-alerts`.

## MQTT Topic Hierarchy

```text
city/drainage/{node_id}/status
city/drainage/{node_id}/telemetry/water-level
city/drainage/{node_id}/alerts/edge-ai
```

## JSON Contracts

### Water Level Telemetry

```json
{
  "schema_version": "1.0.0",
  "city": "smart-city",
  "node_id": "S-14",
  "timestamp": "2026-03-31T10:15:00Z",
  "water_level_mm": 472,
  "water_level_pct": 42.1,
  "flow_rate_lps": 61.3,
  "battery_pct": 96.0,
  "signal_rssi_dbm": -54
}
```

### Edge AI Alert

```json
{
  "schema_version": "1.0.0",
  "city": "smart-city",
  "node_id": "S-22",
  "timestamp": "2026-03-31T10:15:00Z",
  "blockage_detected": true,
  "severity": "high",
  "waste_classification": [
    { "label": "plastic", "confidence": 0.93, "count": 2 }
  ],
  "notes": "POPIA-safe metadata only. No raw images are transmitted."
}
```

## Security and POPIA Controls

- No credentials are committed; use `.env` and `edge/secrets.h` only.
- MQTT is configured for **TLS on port `8883`** and can connect to any managed or campus broker.
- Only operational metadata is transmitted; raw images and personal identifiers stay at the edge.
- Enable `FORCE_HTTPS=true` when deploying behind a TLS termination proxy.

## Real MQTT Broker Configuration

### Preferred path: existing managed broker

Use any real broker that supports:
- TLS on `8883`
- username/password authentication
- wildcard topics such as `city/drainage/+/telemetry/#`

### Startup sequence

```powershell
cd C:\Users\22303096\Project\Demo
Copy-Item .env.example .env
# set MQTT_HOST, MQTT_BRIDGE_USERNAME, MQTT_BRIDGE_PASSWORD,
# MQTT_EDGE_USERNAME, and MQTT_EDGE_PASSWORD

C:\Users\22303096\Project\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --app-dir C:\Users\22303096\Project\Demo --host 127.0.0.1 --port 8000
C:\Users\22303096\Project\.venv\Scripts\python.exe edge\raspberry_pi_gateway.py
npm run dev
```

### Quick live test

```powershell
C:\Users\22303096\Project\.venv\Scripts\python.exe scripts\test_mqtt_publish.py
```

This publishes one telemetry packet and one edge alert to verify the end-to-end path without hardware.

## Reliability Controls

- **ESP32** sketch includes **exponential backoff reconnect** and **Last Will and Testament (LWT)**.
- **Raspberry Pi gateway** publishes only on significant level changes, heartbeat windows, or active alerts to save bandwidth.
- FastAPI continues serving the dashboard using a built-in demo simulator when the MQTT broker is unavailable.

## Files Added

- `backend/app/main.py` — FastAPI MQTT/WebSocket/REST bridge.
- `edge/raspberry_pi_gateway.py` — edge aggregation and selective publish logic.
- `edge/esp32_mqtt_client.ino` — secure ESP32 MQTT client with LWT and backoff.
- `.env.example` and `edge/secrets.h.example` — secure configuration templates.
