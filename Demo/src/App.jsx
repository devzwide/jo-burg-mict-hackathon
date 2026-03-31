import { useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Droplets,
  Gauge,
  MapPinned,
  Move,
  Radio,
  RotateCw,
  Send,
  ShieldCheck,
  Waves,
  Wrench,
  ZoomIn,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import DigitalTwinScene from './components/DigitalTwinScene'
import { useSensorData } from './hooks/useSensorData'
import './App.css'

const riskTrend = [
  { time: '08:00', probability: 24 },
  { time: '10:00', probability: 31 },
  { time: '12:00', probability: 37 },
  { time: '14:00', probability: 48 },
  { time: '16:00', probability: 56 },
  { time: '18:00', probability: 63 },
]

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() || ''

const twinNodePositions = [
  'top-[18%] left-[16%]',
  'top-[32%] right-[10%]',
  'bottom-[24%] left-[20%]',
  'bottom-[16%] right-[12%]',
]

function StatusCard({ icon, label, value, helper, tone = 'cyan' }) {
  const tones = {
    cyan: 'border-cyan-500/20 bg-cyan-500/10',
    emerald: 'border-emerald-500/20 bg-emerald-500/10',
    amber: 'border-amber-500/20 bg-amber-500/10',
    rose: 'border-rose-500/20 bg-rose-500/10',
  }

  return (
    <article className={`rounded-2xl border p-4 ${tones[tone]}`}>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-[0.28em] text-slate-300">{label}</p>
        {icon}
      </div>
      <div className="text-3xl font-semibold text-white">{value}</div>
      <p className="mt-2 text-sm text-slate-300">{helper}</p>
    </article>
  )
}

function App() {
  const [alertOverrides, setAlertOverrides] = useState({})
  const [valveOverrides, setValveOverrides] = useState({})
  const { telemetry, zoneDepths, connection, alerts: dbAlerts, valves: dbValves } = useSensorData()

  const alerts = useMemo(
    () => dbAlerts.map((alert) => ({ ...alert, ...(alertOverrides[alert.id] ?? {}) })),
    [dbAlerts, alertOverrides],
  )
  const valves = useMemo(
    () => dbValves.map((valve) => ({ ...valve, ...(valveOverrides[valve.id] ?? {}) })),
    [dbValves, valveOverrides],
  )

  const activeAlerts =
    alerts.filter((alert) => !['Dispatched', 'Resolved'].includes(alert.status)).length +
    Number(telemetry.blockageDetected)
  const openValves = valves.filter((valve) => valve.state === 'Open').length
  const riskBand =
    telemetry.floodRisk >= 70 ? 'Critical' : telemetry.floodRisk >= 45 ? 'Elevated' : 'Stable'
  const blockageMessage = !telemetry.sensors.length
    ? 'Waiting for live ESP32 telemetry from aquasensor/data'
    : telemetry.blockageDetected
      ? `Edge AI flagged obstruction near ${telemetry.blockedSegment}`
      : 'Live telemetry reports clear flow through the monitored pipe segments'
  const liveRiskTrend = riskTrend.map((point, index) =>
    index === riskTrend.length - 1 ? { ...point, probability: telemetry.floodRisk } : point,
  )
  const sceneNodes = telemetry.sensors.map((sensor, index) => ({
    name: `${sensor.name} (${sensor.id})`,
    status: `${sensor.waterLevel}% • ${sensor.blockageDetected ? 'AI alert' : 'Normal flow'}`,
    position: twinNodePositions[index % twinNodePositions.length],
  }))
  const liveWaterNodes = telemetry.sensors.length
    ? telemetry.sensors
    : [
        {
          id: 'NETWORK',
          name: 'Network Average',
          zone: 'All Zones',
          waterLevel: telemetry.waterLevel,
          waterLevelCm: Number(((telemetry.waterLevelMm ?? 0) / 10).toFixed(1)),
          blockageDetected: telemetry.blockageDetected,
        },
      ]
  const waterDepthChartData = zoneDepths.length
    ? zoneDepths
    : [{ zone: 'Network', depth: Number((((telemetry.waterLevelMm ?? 0) / 10 / 40)).toFixed(1)) }]
  const priorityWaterNode = [...liveWaterNodes].sort(
    (left, right) => (right.waterLevel ?? 0) - (left.waterLevel ?? 0),
  )[0]

  const handleDispatch = (id) => {
    setAlertOverrides((current) => ({
      ...current,
      [id]: { status: 'Dispatched', eta: 'Team en route' },
    }))
  }

  const toggleValve = async (id) => {
    const currentValve = valves.find((valve) => valve.id === id)
    if (!currentValve) {
      return
    }

    const nextState = currentValve.state === 'Open' ? 'Closed' : 'Open'

    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/valve-command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          node_id: currentValve.nodeId,
          open: nextState === 'Open',
        }),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      setValveOverrides((current) => ({
        ...current,
        [id]: {
          state: nextState,
          flow: nextState === 'Open' ? '90%' : '0%',
        },
      }))
    } catch (error) {
      console.warn('Valve command publish failed.', error)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
        <header className="rounded-2xl border border-cyan-500/20 bg-slate-900/80 p-5 shadow-2xl shadow-cyan-950/20 backdrop-blur">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.32em] text-cyan-300">
                <Radio className="h-4 w-4" />
                Smart City CPS • Layer 5 Command Center
              </div>
              <h1 className="text-3xl font-semibold text-white sm:text-4xl">
                Smart Drainage System Dashboard
              </h1>
              <p className="mt-2 max-w-3xl text-sm text-slate-300">
                MQTT telemetry, HTTPS edge alerts, and FastAPI WebSocket streaming converge here for a
                single operator view.
              </p>
            </div>

            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 font-medium text-emerald-300">
                {connection.mode === 'supabase'
                  ? `Supabase ${connection.status === 'live' ? 'Live' : 'Syncing'}`
                  : `WebSocket ${connection.status === 'live' ? 'Live' : connection.status === 'reconnecting' ? 'Reconnecting' : 'Waiting'}`}
              </span>
              <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 font-medium text-cyan-200">
                {connection.mode === 'supabase'
                  ? 'Supabase Postgres Live'
                  : telemetry.transport?.mqttConnected
                    ? 'MQTT Bridge Active'
                    : 'Awaiting MQTT telemetry'}
              </span>
              <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 font-medium text-violet-200">
                Last Sync {telemetry.updatedAt.toLocaleTimeString()}
              </span>
            </div>
          </div>
        </header>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatusCard
            icon={<ShieldCheck className="h-5 w-5 text-white" />}
            label="System Health"
            value={`${telemetry.health}%`}
            helper="Sensor fabric stable across the pipe, valve, and water-level telemetry streams"
            tone="emerald"
          />
          <StatusCard
            icon={<AlertTriangle className="h-5 w-5 text-white" />}
            label="Active Blockage Alerts"
            value={activeAlerts}
            helper={blockageMessage}
            tone="rose"
          />
          <StatusCard
            icon={<Droplets className="h-5 w-5 text-white" />}
            label="Live Water Level"
            value={`${telemetry.waterLevel}%`}
            helper={`Mapped to the 3D twin water mesh • ${telemetry.waterLevelMm ?? 0} mm`}
            tone="cyan"
          />
          <StatusCard
            icon={<Gauge className="h-5 w-5 text-white" />}
            label="Valve Availability"
            value={`${openValves}/${valves.length}`}
            helper={`Hydraulic pressure ${telemetry.pressure} psi • manual override enabled`}
            tone="amber"
          />
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
          <div className="rounded-2xl border border-cyan-500/20 bg-slate-900/70 p-4 backdrop-blur">
            <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-[11px] uppercase tracking-[0.32em] text-cyan-300">
                  Digital Twin Viewer
                </p>
                <h2 className="mt-1 text-xl font-semibold text-white">
                  Urban drainage network 3D digital twin
                </h2>
              </div>

              <div className="flex flex-wrap gap-2">
                <button className="rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-200 transition hover:border-cyan-400/60 hover:text-white">
                  <span className="flex items-center gap-2">
                    <ZoomIn className="h-4 w-4" /> Zoom
                  </span>
                </button>
                <button className="rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-200 transition hover:border-cyan-400/60 hover:text-white">
                  <span className="flex items-center gap-2">
                    <Move className="h-4 w-4" /> Pan
                  </span>
                </button>
                <button className="rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-200 transition hover:border-cyan-400/60 hover:text-white">
                  <span className="flex items-center gap-2">
                    <RotateCw className="h-4 w-4" /> Rotate
                  </span>
                </button>
              </div>
            </div>

            <div className="command-grid glow-ring radar-sweep relative h-[420px] overflow-hidden rounded-2xl border border-cyan-500/20 bg-slate-950/80">
              <DigitalTwinScene telemetry={telemetry} />

              <div className="pointer-events-none absolute left-4 top-4 z-10 rounded-full border border-cyan-500/30 bg-slate-900/85 px-3 py-1 text-xs text-cyan-200">
                GLTF city-block proxy loaded
              </div>
              <div className="pointer-events-none absolute right-4 top-4 z-10 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">
                OrbitControls active
              </div>

              {sceneNodes.map((node) => (
                <div
                  key={node.name}
                  className={`pointer-events-none sensor-node absolute ${node.position} z-10 rounded-xl border border-cyan-400/30 bg-slate-900/90 px-3 py-2`}
                >
                  <p className="text-xs font-medium text-white">{node.name}</p>
                  <p className="text-[11px] text-cyan-200">{node.status}</p>
                </div>
              ))}

              <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-10 grid gap-3 md:grid-cols-3">
                <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-3 text-sm">
                  <p className="text-slate-400">Water Fill</p>
                  <p className="mt-1 font-medium text-white">{telemetry.waterLevel}% pipe capacity</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-3 text-sm">
                  <p className="text-slate-400">Edge AI Status</p>
                  <p className="mt-1 font-medium text-white">
                    {telemetry.blockageDetected ? 'Bright red pulse triggered' : 'Pipe segment clear'}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-3 text-sm">
                  <p className="text-slate-400">GPS Anchors</p>
                  <p className="mt-1 font-medium text-white">
                    {telemetry.sensors.length} sensor markers georeferenced in 3D space
                  </p>
                </div>
              </div>
            </div>
          </div>

          <aside className="min-w-0 space-y-4">
            <section className="rounded-2xl border border-violet-500/20 bg-slate-900/70 p-4 backdrop-blur">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.32em] text-violet-300">
                    Predictive AI Analytics
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-white">Flood risk probability</h2>
                </div>
                <Bot className="h-5 w-5 text-violet-300" />
              </div>

              <div className="mb-4 rounded-xl border border-violet-500/20 bg-violet-500/10 p-3">
                <p className="text-sm text-slate-300">Current AI risk band</p>
                <div className="mt-1 flex items-end justify-between gap-3">
                  <span className="text-3xl font-semibold text-white">{telemetry.floodRisk}%</span>
                  <span className="rounded-full border border-violet-500/30 px-2.5 py-1 text-xs font-medium text-violet-200">
                    {riskBand}
                  </span>
                </div>
              </div>

              <div className="h-56 min-w-0">
                <AreaChart
                  responsive
                  data={liveRiskTrend}
                  style={{ width: '100%', height: '100%', minWidth: 200, minHeight: 200 }}
                >
                  <defs>
                    <linearGradient id="riskFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.45} />
                      <stop offset="95%" stopColor="#22d3ee" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                  <XAxis dataKey="time" stroke="#94a3b8" fontSize={12} />
                  <YAxis domain={[0, 100]} stroke="#94a3b8" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0f172a',
                      border: '1px solid rgba(34, 211, 238, 0.2)',
                      borderRadius: '12px',
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="probability"
                    stroke="#22d3ee"
                    strokeWidth={2}
                    fill="url(#riskFill)"
                  />
                </AreaChart>
              </div>

              <ul className="mt-4 space-y-2 text-sm text-slate-300">
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                  Cloud AI prioritizes the active blockage zone for preventive clearing
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                  Telemetry updates immediately reshape the 3D scene without reloads
                </li>
              </ul>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 backdrop-blur">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.32em] text-cyan-300">
                    Sensor Telemetry
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-white">Water depth by zone</h2>
                </div>
                <Waves className="h-5 w-5 text-cyan-300" />
              </div>

              <div className="h-48 min-w-0">
                <BarChart
                  responsive
                  data={waterDepthChartData}
                  style={{ width: '100%', height: '100%', minWidth: 200, minHeight: 150 }}
                >
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="zone" stroke="#94a3b8" fontSize={12} />
                  <YAxis stroke="#94a3b8" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0f172a',
                      border: '1px solid rgba(34, 211, 238, 0.2)',
                      borderRadius: '12px',
                    }}
                  />
                  <Bar dataKey="depth" fill="#38bdf8" radius={[6, 6, 0, 0]} />
                </BarChart>
              </div>
            </section>
          </aside>
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
          <div className="rounded-2xl border border-cyan-500/20 bg-slate-900/70 p-4 backdrop-blur">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.32em] text-cyan-300">
                  Live Water Level
                </p>
                <h2 className="mt-1 text-lg font-semibold text-white">Real-time water monitoring</h2>
              </div>
              <Droplets className="h-5 w-5 text-cyan-300" />
            </div>

            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-3">
                <p className="text-xs uppercase tracking-[0.24em] text-cyan-200">Peak Level</p>
                <p className="mt-2 text-2xl font-semibold text-white">{telemetry.waterLevel}%</p>
                <p className="mt-1 text-xs text-slate-300">{telemetry.waterLevelMm ?? 0} mm network max</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3">
                <p className="text-xs uppercase tracking-[0.24em] text-slate-300">Priority Node</p>
                <p className="mt-2 text-base font-semibold text-white">{priorityWaterNode?.name ?? 'Awaiting telemetry'}</p>
                <p className="mt-1 text-xs text-slate-400">{priorityWaterNode?.zone ?? 'Network overview'}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3">
                <p className="text-xs uppercase tracking-[0.24em] text-slate-300">Refresh State</p>
                <p className="mt-2 text-base font-semibold text-white">{connection.status === 'live' ? 'Streaming' : 'Standby'}</p>
                <p className="mt-1 text-xs text-slate-400">Updated {telemetry.updatedAt.toLocaleTimeString()}</p>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium text-white">Water depth by zone</p>
                  <span className="text-xs text-slate-400">Live telemetry</span>
                </div>
                <div className="h-64 min-w-0">
                  <BarChart
                    responsive
                    data={waterDepthChartData}
                    style={{ width: '100%', height: '100%', minWidth: 200, minHeight: 180 }}
                  >
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="zone" stroke="#94a3b8" fontSize={12} />
                    <YAxis stroke="#94a3b8" fontSize={12} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#0f172a',
                        border: '1px solid rgba(34, 211, 238, 0.2)',
                        borderRadius: '12px',
                      }}
                    />
                    <Bar dataKey="depth" fill="#22d3ee" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </div>
              </div>

              <div className="space-y-3">
                {liveWaterNodes.map((sensor) => (
                  <article key={sensor.id} className="rounded-xl border border-slate-800 bg-slate-950/80 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-white">{sensor.name}</p>
                        <p className="mt-1 text-xs text-slate-400">{sensor.zone} • {sensor.id}</p>
                      </div>
                      <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-xs text-cyan-100">
                        {sensor.waterLevel ?? 0}%
                      </span>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className={`h-full rounded-full ${
                          (sensor.waterLevel ?? 0) >= 75
                            ? 'bg-rose-500'
                            : (sensor.waterLevel ?? 0) >= 45
                              ? 'bg-amber-400'
                              : 'bg-cyan-400'
                        }`}
                        style={{ width: `${Math.min(100, Math.max(sensor.waterLevel ?? 0, 0))}%` }}
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-400">
                      <span>{sensor.waterLevelCm ?? 0} cm</span>
                      <span>{sensor.blockageDetected ? 'Inspection needed' : 'Normal flow'}</span>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-4">
            <section className="rounded-2xl border border-amber-500/20 bg-slate-900/70 p-4 backdrop-blur">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.32em] text-amber-300">
                    Field Team Dispatch & Manual Cleaning Alerts
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-white">Manual cleaning queue</h2>
                </div>
                <MapPinned className="h-5 w-5 text-amber-300" />
              </div>

              <div className="space-y-3 max-h-96 overflow-y-auto">
                <div className="space-y-3">
                  {alerts.map((alert) => (
                    <article key={alert.id} className="rounded-xl border border-slate-800 bg-slate-950/80 p-4">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium text-white">{alert.zone}</p>
                            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200">
                              {alert.severity}
                            </span>
                            <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300">
                              {alert.id}
                            </span>
                          </div>
                          <p className="mt-2 text-sm text-slate-300">{alert.issue}</p>
                          <div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-400">
                            <span>GPS: {alert.coordinates}</span>
                            <span>ETA: {alert.eta}</span>
                            <span>Status: {alert.status}</span>
                          </div>
                        </div>

                        <button
                          onClick={() => handleDispatch(alert.id)}
                          className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-sm font-medium text-cyan-100 transition hover:border-cyan-400/60 hover:bg-cyan-500/20"
                        >
                          <span className="flex items-center gap-2">
                            <Send className="h-4 w-4" />
                            {alert.status === 'Dispatched' ? 'Team En Route' : 'Dispatch Team'}
                          </span>
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-emerald-500/20 bg-slate-900/70 p-4 backdrop-blur">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.32em] text-emerald-300">
                    Actuator Controls
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-white">Drainage valves manual override</h2>
                </div>
                <Activity className="h-5 w-5 text-emerald-300" />
              </div>

              <div className="space-y-3">
                {valves.map((valve) => (
                  <article key={valve.id} className="rounded-xl border border-slate-800 bg-slate-950/80 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-white">{valve.id}</p>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] ${
                              valve.state === 'Open'
                                ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                                : 'border border-rose-500/30 bg-rose-500/10 text-rose-200'
                            }`}
                          >
                            {valve.state}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-slate-300">{valve.location}</p>
                        <p className="mt-1 text-xs text-slate-400">Current flow: {valve.flow}</p>
                      </div>

                      <button
                        onClick={() => toggleValve(valve.id)}
                        className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-400/60 hover:bg-emerald-500/20"
                      >
                        <span className="flex items-center gap-2">
                          <Wrench className="h-4 w-4" />
                          {valve.state === 'Open' ? 'Close Valve' : 'Open Valve'}
                        </span>
                      </button>
                    </div>
                  </article>
                ))}
              </div>

              <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-slate-200">
                <p className="font-medium text-white">Operator control note</p>
                <p className="mt-1 text-slate-300">
                  Commands now publish live to the `aquasensor/command` MQTT topic when the backend bridge is connected.
                </p>
              </div>
            </section>
          </div>
        </section>
      </div>
    </div>
  )
}

export default App
