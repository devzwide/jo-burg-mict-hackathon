import { useEffect, useMemo, useState } from 'react'

const SENSOR_ANCHORS = [
  { id: 'S-14', name: 'North Inlet', zone: 'North', gps: [25.2854, 51.531] },
  { id: 'S-08', name: 'East Junction', zone: 'East', gps: [25.2826, 51.5346] },
  { id: 'S-22', name: 'Central Basin', zone: 'Central', gps: [25.2811, 51.5268] },
  { id: 'S-03', name: 'West Outlet', zone: 'West', gps: [25.2794, 51.5239] },
]

const GPS_ORIGIN = { lat: 25.2814, lon: 51.5292 }
const WS_URL = import.meta.env.VITE_TELEMETRY_WS_URL ?? 'ws://localhost:8000/ws/telemetry'

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const toScenePosition = ([lat, lon]) => [
  Number(((lon - GPS_ORIGIN.lon) * 420).toFixed(2)),
  0.45,
  Number(((GPS_ORIGIN.lat - lat) * 620).toFixed(2)),
]

const buildSensors = (waterLevel, blockageDetected, blockedIndex) =>
  SENSOR_ANCHORS.map((sensor, index) => {
    const sensorLevel = clamp(
      waterLevel + (index - 1.5) * 7 + Math.round((Math.random() - 0.5) * 10),
      5,
      100,
    )

    return {
      ...sensor,
      position: toScenePosition(sensor.gps),
      waterLevel: sensorLevel,
      waterLevelMm: Math.round(sensorLevel * 11.2),
      flowRate: clamp(
        78 - Math.round(sensorLevel * 0.35) + Math.round((Math.random() - 0.5) * 8),
        18,
        92,
      ),
      blockageDetected: blockageDetected && index === blockedIndex,
    }
  })

const buildFallbackTelemetry = (current) => {
  const nextWaterLevel = clamp(
    current.waterLevel + Math.round((Math.random() - 0.28) * 14),
    8,
    96,
  )
  const blockageDetected = nextWaterLevel > 72 || Math.random() > 0.82
  const blockedIndex = blockageDetected ? Math.floor(Math.random() * SENSOR_ANCHORS.length) : -1

  return {
    ...current,
    health: clamp(current.health + (Math.random() > 0.86 ? -1 : 0), 91, 99),
    waterLevel: nextWaterLevel,
    waterLevelMm: Math.round(nextWaterLevel * 11.2),
    floodRisk: clamp(Math.round(nextWaterLevel * 0.78 + Math.random() * 12), 18, 97),
    pressure: clamp(
      74 - Math.round(nextWaterLevel * 0.18) - (blockageDetected ? 10 : 0) + Math.round((Math.random() - 0.5) * 6),
      42,
      80,
    ),
    blockageDetected,
    blockedSegment: blockageDetected ? SENSOR_ANCHORS[blockedIndex].name : 'All pipe segments clear',
    sensors: buildSensors(nextWaterLevel, blockageDetected, blockedIndex),
    updatedAt: new Date(),
  }
}

const normalizeTelemetry = (payload, fallback) => {
  const sensors = Array.isArray(payload?.sensors) && payload.sensors.length
    ? payload.sensors.map((sensor, index) => {
        const anchor = SENSOR_ANCHORS.find((item) => item.id === sensor.id) ?? SENSOR_ANCHORS[index % SENSOR_ANCHORS.length]

        return {
          ...anchor,
          ...sensor,
          gps: sensor.gps ?? anchor.gps,
          position: sensor.position ?? toScenePosition(sensor.gps ?? anchor.gps),
          waterLevel: clamp(sensor.waterLevel ?? payload.waterLevel ?? fallback.waterLevel, 0, 100),
          waterLevelMm: Math.round(sensor.waterLevelMm ?? (sensor.waterLevel ?? payload.waterLevel ?? fallback.waterLevel) * 11.2),
          flowRate: sensor.flowRate ?? 0,
          blockageDetected: Boolean(sensor.blockageDetected),
        }
      })
    : buildSensors(payload?.waterLevel ?? fallback.waterLevel, Boolean(payload?.blockageDetected), 2)

  return {
    ...fallback,
    ...payload,
    waterLevel: clamp(payload?.waterLevel ?? fallback.waterLevel, 0, 100),
    waterLevelMm: Math.round(payload?.waterLevelMm ?? payload?.waterLevelMm ?? (payload?.waterLevel ?? fallback.waterLevel) * 11.2),
    blockedSegment: payload?.blockedSegment ?? fallback.blockedSegment,
    sensors,
    updatedAt: new Date(payload?.updatedAt ?? new Date().toISOString()),
  }
}

export function useSensorData() {
  const [telemetry, setTelemetry] = useState(() => ({
    health: 96,
    waterLevel: 42,
    waterLevelMm: 470,
    floodRisk: 63,
    pressure: 68,
    blockageDetected: true,
    blockedSegment: 'Central Basin',
    updatedAt: new Date(),
    sensors: buildSensors(42, true, 2),
  }))
  const [connection, setConnection] = useState({
    mode: 'simulation',
    status: 'connecting',
    endpoint: WS_URL,
  })

  useEffect(() => {
    let socket
    let reconnectTimer
    let simulationInterval
    let reconnectAttempts = 0
    let shouldReconnect = true

    const stopSimulation = () => {
      if (simulationInterval) {
        window.clearInterval(simulationInterval)
        simulationInterval = undefined
      }
    }

    const startSimulation = () => {
      if (simulationInterval) {
        return
      }

      setConnection({
        mode: 'simulation',
        status: reconnectAttempts > 0 ? 'reconnecting' : 'fallback',
        endpoint: WS_URL,
      })

      simulationInterval = window.setInterval(() => {
        setTelemetry((current) => buildFallbackTelemetry(current))
      }, 2000)
    }

    const connect = () => {
      stopSimulation()
      setConnection({ mode: 'websocket', status: 'connecting', endpoint: WS_URL })

      try {
        socket = new window.WebSocket(WS_URL)
      } catch {
        startSimulation()
        return
      }

      socket.onopen = () => {
        reconnectAttempts = 0
        stopSimulation()
        setConnection({ mode: 'websocket', status: 'live', endpoint: WS_URL })
      }

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data)
          setTelemetry((current) => normalizeTelemetry(payload, current))
        } catch (error) {
          console.warn('Invalid telemetry payload received from WebSocket bridge.', error)
        }
      }

      socket.onerror = () => {
        socket.close()
      }

      socket.onclose = () => {
        if (!shouldReconnect) {
          return
        }

        reconnectAttempts += 1
        startSimulation()
        reconnectTimer = window.setTimeout(connect, Math.min(30000, 1000 * 2 ** (reconnectAttempts - 1)))
      }
    }

    if (typeof window !== 'undefined' && 'WebSocket' in window) {
      connect()
    } else {
      startSimulation()
    }

    return () => {
      shouldReconnect = false
      stopSimulation()

      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer)
      }

      if (socket && socket.readyState <= 1) {
        socket.close()
      }
    }
  }, [])

  const zoneDepths = useMemo(
    () =>
      telemetry.sensors.map((sensor) => ({
        zone: sensor.zone,
        depth: Number((sensor.waterLevel / 40).toFixed(1)),
      })),
    [telemetry.sensors],
  )

  return { telemetry, zoneDepths, connection }
}
