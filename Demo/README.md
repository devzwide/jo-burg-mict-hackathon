# Smart Drainage CPS Demo

This workspace contains the **Layer 3 communication stack** for a smart drainage cyber-physical system:

- **MQTT over TLS (`8883`)** for telemetry and edge AI alerts
- **FastAPI WebSockets** for the live 3D dashboard
- **HTTP(S) REST** for urgent edge alert ingestion

## Simple real MQTT setup — no Docker required

### 1. Create or use an existing MQTT broker

Use any broker that supports:
- **TLS on port `8883`**
- username/password authentication
- topic-based publish/subscribe

Examples include your school/campus broker or any managed MQTT service.

### 2. Copy the environment template

```powershell
cd C:\Users\22303096\Project\Demo
Copy-Item .env.example .env
```

Fill in your real broker host and credentials in `.env`.

### 3. Start the backend and dashboard

```powershell
C:\Users\22303096\Project\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --app-dir C:\Users\22303096\Project\Demo --host 127.0.0.1 --port 8000
npm run dev
```

### 4. Send real MQTT traffic

You can use either the edge gateway:

```powershell
C:\Users\22303096\Project\.venv\Scripts\python.exe edge\raspberry_pi_gateway.py
```

or the smoke-test publisher:

```powershell
C:\Users\22303096\Project\.venv\Scripts\python.exe scripts\test_mqtt_publish.py
```
## Layer 2 edge AI runtime

The repository now also includes `edge/layer2_edge_runtime.py`, which provides:

- **OpenCV + TensorFlow Lite** waste/debris detection from the camera feed
- **moving-average filtering** for noisy water-level readings
- **local GPIO valve actuation** when the threshold is exceeded
- **multi-threaded execution** for CV, sensor monitoring, and MQTT publishing
- **offline resilience** via local queueing when the network is unavailable

### Install dependencies

Base runtime:

```powershell
C:\Users\22303096\Project\.venv\Scripts\python.exe -m pip install -r edge\requirements.txt
```

Optional full AI inference stack (large download; use only if you have enough disk space):

```powershell
C:\Users\22303096\Project\.venv\Scripts\python.exe -m pip install -r edge\requirements-ai-optional.txt
```

### Run the Layer 2 runtime

```powershell
C:\Users\22303096\Project\.venv\Scripts\python.exe edge\layer2_edge_runtime.py
```

For a short local smoke test without hardware, keep `USE_MOCK_GPIO=true` and run:

```powershell
$env:EDGE_RUN_SECONDS=10
$env:MQTT_HOST=''
C:\Users\22303096\Project\.venv\Scripts\python.exe edge\layer2_edge_runtime.py
```
## Verification

Open these after startup:
- `http://127.0.0.1:8000/health`
- `http://127.0.0.1:8000/api/v1/contracts`
- `http://localhost:5173/`

When the broker is configured correctly, `/health` should show:
- `"mode": "mqtt-bridge"`
- `"mqttEnabled": true`
- `"mqttConnected": true`

## Optional local Mosquitto path

If you still want a local broker, the repo includes Mosquitto config under `infrastructure/mosquitto/`, but it is **optional**.
