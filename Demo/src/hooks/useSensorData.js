import { useEffect, useMemo, useState } from 'react'
import { isSupabaseConfigured, supabase } from '../lib/supabase'

const SENSOR_ANCHORS = [
  { id: 'S-14', name: 'North Inlet', zone: 'North', gps: [25.2854, 51.531] },
  { id: 'S-08', name: 'East Junction', zone: 'East', gps: [25.2826, 51.5346] },
  { id: 'S-22', name: 'Central Basin', zone: 'Central', gps: [25.2811, 51.5268] },
  { id: 'S-03', name: 'West Outlet', zone: 'West', gps: [25.2794, 51.5239] },
]

const SENSOR_ALIAS_MAP = {
  ESP32_AquaDivert_01: SENSOR_ANCHORS[2],
}

const GPS_ORIGIN = { lat: 25.2814, lon: 51.5292 }
const WS_URL = import.meta.env.VITE_TELEMETRY_WS_URL ?? 'ws://127.0.0.1:8000/ws/telemetry'
const MAX_WATER_LEVEL_CM = Number(import.meta.env.VITE_WATER_LEVEL_MAX_CM ?? 120)

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const safeNumber = (value, fallback = 0) => {
  const next = Number(value)
  return Number.isFinite(next) ? next : fallback
}

const toScenePosition = ([lat, lon]) => [
  Number(((lon - GPS_ORIGIN.lon) * 420).toFixed(2)),
  0.45,
  Number(((GPS_ORIGIN.lat - lat) * 620).toFixed(2)),
]

const resolveSensorMeta = (deviceId, index = 0) => {
  const directMatch = SENSOR_ANCHORS.find((sensor) => sensor.id === deviceId)
  const aliasMatch = SENSOR_ALIAS_MAP[deviceId]
  const matched = directMatch ?? aliasMatch

  if (matched) {
    return { ...matched, deviceId: deviceId || matched.id }
  }

  const fallback = SENSOR_ANCHORS[index % SENSOR_ANCHORS.length] ?? SENSOR_ANCHORS[0]
  return {
    id: deviceId || fallback.id,
    name: deviceId ? `Drain Node ${deviceId}` : fallback.name,
    zone: fallback.zone,
    gps: fallback.gps,
    deviceId: deviceId || fallback.id,
  }
}

const normalizeGps = (lat, lon, fallbackGps) => [
  safeNumber(lat, fallbackGps[0]),
  safeNumber(lon, fallbackGps[1]),
]

const cmToPct = (waterLevelCm) => clamp(Math.round((safeNumber(waterLevelCm) / MAX_WATER_LEVEL_CM) * 100), 0, 100)

const defaultTelemetry = {
  health: 0,
  waterLevel: 0,
  waterLevelMm: 0,
  floodRisk: 0,
  pressure: 0,
  blockageDetected: false,
  blockedSegment: 'Waiting for live ESP32 telemetry',
  updatedAt: new Date(),
  transport: {
    source: 'websocket',
    mqttConnected: false,
    databaseConnected: false,
  },
  sensors: [],
}

const buildSensorFromReading = (reading, index) => {
  const meta = resolveSensorMeta(reading?.device_id, index)
  const gps = normalizeGps(reading?.gps_lat, reading?.gps_lon, meta.gps)
  const waterLevelCm = safeNumber(reading?.water_level_cm, 0)
  const waterLevel = cmToPct(waterLevelCm)
  const blockageIndex = clamp(
    safeNumber(reading?.blockage_index, safeNumber(reading?.waste_area_pct, 0) / 100),
    0,
    1,
  )
  const wasteConfidence = clamp(safeNumber(reading?.waste_confidence, 0), 0, 1)

  return {
    ...meta,
    gps,
    position: toScenePosition(gps),
    waterLevel,
    waterLevelCm: Number(waterLevelCm.toFixed(1)),
    waterLevelMm: Math.round(waterLevelCm * 10),
    flowRate: clamp(92 - Math.round(blockageIndex * 22) - (reading?.valve_open ? 6 : 0), 18, 92),
    blockageIndex: Number(blockageIndex.toFixed(2)),
    blockageDetected: Boolean(reading?.waste_detected) || blockageIndex >= 0.65 || wasteConfidence >= 0.7,
    batteryLevel: clamp(safeNumber(reading?.battery_level, 96), 0, 100),
    gatePosition: clamp(Math.round(safeNumber(reading?.gate_position, 0)), 0, 100),
    routeSafe: reading?.route_safe ?? true,
    valveOpen: Boolean(reading?.valve_open),
    wasteDetected: Boolean(reading?.waste_detected),
    wasteConfidence: Number(wasteConfidence.toFixed(2)),
    wasteAreaPct: clamp(safeNumber(reading?.waste_area_pct, 0), 0, 100),
    wasteObjects: Math.max(0, Math.round(safeNumber(reading?.waste_objects, 0))),
    timestamp: reading?.timestamp ? new Date(reading.timestamp) : new Date(),
  }
}

const mergeSensorsWithAnchors = (dbSensors) => dbSensors

const buildTelemetryFromRecords = (records, fallback) => {
  const latestPerDevice = new Map()

  records.forEach((reading) => {
    const key = reading?.device_id || `unknown-${latestPerDevice.size}`
    if (!latestPerDevice.has(key)) {
      latestPerDevice.set(key, reading)
    }
  })

  const dbSensors = Array.from(latestPerDevice.values()).map((reading, index) => buildSensorFromReading(reading, index))
  const sensors = mergeSensorsWithAnchors(dbSensors, fallback.waterLevel)
  const criticalSensor =
    sensors.find((sensor) => sensor.blockageDetected) ??
    [...sensors].sort((left, right) => right.waterLevel - left.waterLevel)[0]
  const averageBattery = sensors.reduce((sum, sensor) => sum + safeNumber(sensor.batteryLevel, 0), 0) / sensors.length
  const maxWaterLevel = Math.max(...sensors.map((sensor) => sensor.waterLevel), fallback.waterLevel)
  const waterLevelMm = Math.max(...sensors.map((sensor) => sensor.waterLevelMm), fallback.waterLevelMm)
  const blockageCount = sensors.filter((sensor) => sensor.blockageDetected).length

  return {
    ...fallback,
    health: clamp(Math.round(averageBattery), 0, 100),
    waterLevel: maxWaterLevel,
    waterLevelMm,
    floodRisk: clamp(Math.round(maxWaterLevel * 0.76 + blockageCount * 11), 8, 100),
    pressure: clamp(Math.round(76 - maxWaterLevel * 0.24 - blockageCount * 7), 35, 80),
    blockageDetected: blockageCount > 0,
    blockedSegment: blockageCount > 0 ? criticalSensor?.name ?? fallback.blockedSegment : 'All pipe segments clear',
    transport: {
      source: 'supabase',
      mqttConnected: false,
      databaseConnected: true,
    },
    sensors,
    updatedAt: criticalSensor?.timestamp ?? new Date(),
  }
}

const buildAlertsFromSensors = (sensors) => {
  const hotspotSensors = sensors.filter((sensor) => sensor.blockageDetected || sensor.wasteDetected).slice(0, 3)

  if (!hotspotSensors.length) {
    return [
      {
        id: 'FA-BASELINE',
        zone: 'Network overview',
        issue: 'All monitored drainage routes are currently reporting safe passage.',
        coordinates: '25.2814, 51.5292',
        severity: 'Low',
        eta: 'Standby',
        status: 'Monitoring',
      },
    ]
  }

  return hotspotSensors.map((sensor, index) => ({
    id: `FA-${sensor.id}-${index + 1}`,
    zone: `${sensor.zone} / ${sensor.name}`,
    issue: sensor.wasteDetected
      ? `Waste detected with ${Math.round(sensor.wasteConfidence * 100)}% confidence.`
      : 'Elevated blockage index requires manual inspection.',
    coordinates: `${sensor.gps[0].toFixed(4)}, ${sensor.gps[1].toFixed(4)}`,
    severity: sensor.waterLevel >= 75 || sensor.wasteConfidence >= 0.85 ? 'High' : 'Medium',
    eta: sensor.waterLevel >= 75 ? '6 min' : '12 min',
    status: 'Pending',
  }))
}

const buildAlertsFromRecords = (records, sensors) => {
  if (!records.length) {
    return buildAlertsFromSensors(sensors)
  }

  return records.slice(0, 6).map((alert, index) => {
    const linkedSensor =
      sensors.find((sensor) => sensor.deviceId === alert.device_id || sensor.id === alert.device_id) ??
      resolveSensorMeta(alert.device_id, index)
    const waterLevelCm = safeNumber(alert.water_level_cm, linkedSensor.waterLevelCm ?? 0)
    const wasteConfidence = clamp(safeNumber(alert.waste_confidence, linkedSensor.wasteConfidence ?? 0), 0, 1)
    const severity =
      waterLevelCm >= 90 || wasteConfidence >= 0.85
        ? 'High'
        : waterLevelCm >= 55 || wasteConfidence >= 0.5
          ? 'Medium'
          : 'Low'

    return {
      id: `FA-${alert.id}`,
      zone: `${linkedSensor.zone} / ${linkedSensor.name}`,
      issue:
        alert.notes?.trim() ||
        (alert.alert_type
          ? `${alert.alert_type.replace(/_/g, ' ')} reported from ${linkedSensor.name}.`
          : 'Flood alert triggered from sensor telemetry.'),
      coordinates: `${linkedSensor.gps[0].toFixed(4)}, ${linkedSensor.gps[1].toFixed(4)}`,
      severity,
      eta: severity === 'High' ? '6 min' : severity === 'Medium' ? '12 min' : 'Monitor',
      status: alert.resolved_at ? 'Resolved' : 'Pending',
    }
  })
}

const buildValvesFromSensors = (sensors) => {
  const valveSensors = sensors.filter((sensor) => sensor.deviceId || sensor.id)

  return valveSensors.map((sensor, index) => ({
    id: `V-${String(index + 1).padStart(2, '0')}`,
    nodeId: sensor.deviceId ?? sensor.id,
    location: sensor.name,
    state: sensor.valveOpen ? 'Open' : 'Closed',
    flow: `${clamp(Math.round(sensor.gatePosition || sensor.waterLevel), 0, 100)}%`,
  }))
}

const normalizeTelemetry = (payload, fallback) => {
  const sensors = Array.isArray(payload?.sensors) && payload.sensors.length
    ? payload.sensors.map((sensor, index) => {
        const meta = resolveSensorMeta(sensor?.id, index)
        const gps = sensor?.gps ?? meta.gps

        return {
          ...meta,
          ...sensor,
          gps,
          position: sensor?.position ?? toScenePosition(gps),
          waterLevel: clamp(sensor?.waterLevel ?? payload?.waterLevel ?? fallback.waterLevel, 0, 100),
          waterLevelCm: Number((((sensor?.waterLevel ?? payload?.waterLevel ?? fallback.waterLevel) / 100) * MAX_WATER_LEVEL_CM).toFixed(1)),
          waterLevelMm: Math.round(
            sensor?.waterLevelMm ?? (((sensor?.waterLevel ?? payload?.waterLevel ?? fallback.waterLevel) / 100) * MAX_WATER_LEVEL_CM * 10),
          ),
          flowRate: sensor?.flowRate ?? 0,
          blockageDetected: Boolean(sensor?.blockageDetected),
          batteryLevel: safeNumber(sensor?.batteryLevel, 96),
          gatePosition: clamp(Math.round(safeNumber(sensor?.gatePosition, sensor?.waterLevel ?? 0)), 0, 100),
          routeSafe: sensor?.routeSafe ?? !sensor?.blockageDetected,
          valveOpen: sensor?.valveOpen ?? false,
          wasteDetected: sensor?.wasteDetected ?? Boolean(sensor?.blockageDetected),
          wasteConfidence: clamp(safeNumber(sensor?.wasteConfidence, 0), 0, 1),
          wasteAreaPct: clamp(safeNumber(sensor?.wasteAreaPct, 0), 0, 100),
          wasteObjects: Math.max(0, Math.round(safeNumber(sensor?.wasteObjects, 0))),
          timestamp: new Date(payload?.updatedAt ?? new Date().toISOString()),
        }
      })
    : fallback.sensors.map((sensor) => ({ ...sensor }))

  return {
    ...fallback,
    ...payload,
    waterLevel: clamp(payload?.waterLevel ?? fallback.waterLevel, 0, 100),
    waterLevelMm: Math.round(
      payload?.waterLevelMm ?? (((payload?.waterLevel ?? fallback.waterLevel) / 100) * MAX_WATER_LEVEL_CM * 10),
    ),
    blockedSegment: payload?.blockedSegment ?? fallback.blockedSegment,
    transport: {
      source: payload?.transport?.databaseConnected ? 'supabase' : 'websocket',
      mqttConnected: Boolean(payload?.transport?.mqttConnected),
      databaseConnected: Boolean(payload?.transport?.databaseConnected),
    },
    sensors,
    updatedAt: new Date(payload?.updatedAt ?? new Date().toISOString()),
  }
}

export function useSensorData() {
  const [telemetry, setTelemetry] = useState(() => defaultTelemetry)
  const [alerts, setAlerts] = useState(() => buildAlertsFromSensors(defaultTelemetry.sensors))
  const [valves, setValves] = useState(() => buildValvesFromSensors(defaultTelemetry.sensors))
  const [connection, setConnection] = useState({
    mode: isSupabaseConfigured ? 'supabase' : 'websocket',
    status: 'connecting',
    endpoint: isSupabaseConfigured ? 'public.sensor_readings + public.flood_alerts' : WS_URL,
  })

  useEffect(() => {
    let socket
    let reconnectTimer
    let pollTimer
    let realtimeChannel
    let reconnectAttempts = 0
    let shouldReconnect = true

    const markBridgeUnavailable = (status = 'waiting') => {
      setConnection({
        mode: 'websocket',
        status,
        endpoint: WS_URL,
      })
    }

    const connectWebSocket = () => {
      setConnection({ mode: 'websocket', status: 'connecting', endpoint: WS_URL })

      try {
        socket = new window.WebSocket(WS_URL)
      } catch {
        markBridgeUnavailable('error')
        reconnectTimer = window.setTimeout(connectWebSocket, Math.min(30000, 1000 * 2 ** reconnectAttempts))
        reconnectAttempts += 1
        return
      }

      socket.onopen = () => {
        reconnectAttempts = 0
        setConnection({ mode: 'websocket', status: 'live', endpoint: WS_URL })
      }

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data)
          setTelemetry((current) => {
            const nextTelemetry = normalizeTelemetry(payload, current)
            setAlerts(buildAlertsFromSensors(nextTelemetry.sensors))
            setValves(buildValvesFromSensors(nextTelemetry.sensors))
            return nextTelemetry
          })
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
        markBridgeUnavailable(reconnectAttempts > 1 ? 'reconnecting' : 'waiting')
        reconnectTimer = window.setTimeout(connectWebSocket, Math.min(30000, 1000 * 2 ** (reconnectAttempts - 1)))
      }
    }

    const connectSupabase = async () => {
      if (!isSupabaseConfigured || !supabase) {
        connectWebSocket()
        return
      }

      setConnection({
        mode: 'supabase',
        status: 'connecting',
        endpoint: 'public.sensor_readings + public.flood_alerts',
      })

      const refreshFromDatabase = async () => {
        try {
          const [sensorResult, alertResult] = await Promise.all([
            supabase
              .from('sensor_readings')
              .select('id, device_id, timestamp, water_level_cm, blockage_index, gate_position, battery_level, gps_lat, gps_lon, waste_detected, waste_confidence, waste_area_pct, waste_objects, route_safe, valve_open')
              .order('timestamp', { ascending: false })
              .limit(100),
            supabase
              .from('flood_alerts')
              .select('id, device_id, triggered_at, resolved_at, water_level_cm, waste_confidence, alert_type, notes')
              .order('triggered_at', { ascending: false })
              .limit(25),
          ])

          if (sensorResult.error) {
            throw sensorResult.error
          }
          if (alertResult.error) {
            throw alertResult.error
          }

          setTelemetry((current) => {
            const nextTelemetry = buildTelemetryFromRecords(sensorResult.data ?? [], current)
            setAlerts(buildAlertsFromRecords(alertResult.data ?? [], nextTelemetry.sensors))
            setValves(buildValvesFromSensors(nextTelemetry.sensors))
            return nextTelemetry
          })

          setConnection({
            mode: 'supabase',
            status: 'live',
            endpoint: 'public.sensor_readings + public.flood_alerts',
          })
        } catch (error) {
          console.warn('Supabase fetch failed, falling back to live bridge.', error)
          setConnection({
            mode: 'supabase',
            status: 'error',
            endpoint: error?.message ?? 'Supabase query failed',
          })
          connectWebSocket()
        }
      }

      await refreshFromDatabase()

      realtimeChannel = supabase
        .channel('drainage-dashboard-live')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'sensor_readings' },
          () => refreshFromDatabase(),
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'flood_alerts' },
          () => refreshFromDatabase(),
        )
        .subscribe()

      pollTimer = window.setInterval(refreshFromDatabase, 15000)
    }

    if (typeof window !== 'undefined') {
      connectSupabase()
    } else {
      setConnection({ mode: 'websocket', status: 'offline', endpoint: WS_URL })
    }

    return () => {
      shouldReconnect = false

      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer)
      }

      if (pollTimer) {
        window.clearInterval(pollTimer)
      }

      if (realtimeChannel && supabase) {
        supabase.removeChannel(realtimeChannel)
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
        depth: Number((sensor.waterLevelCm / 40).toFixed(1)),
      })),
    [telemetry.sensors],
  )

  return { telemetry, zoneDepths, connection, alerts, valves }
}
