import { useState } from 'react'
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
  ResponsiveContainer,
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

const initialAlerts = [
  {
    id: 'AL-204',
    zone: 'Sector North / Drain 14',
    issue: 'Plastic buildup detected by camera analytics',
    coordinates: '25.2854, 51.5310',
    severity: 'High',
    eta: '8 min',
    status: 'Pending',
  },
  {
    id: 'AL-198',
    zone: 'Central Market Culvert',
    issue: 'Water level trend exceeds safe threshold',
    coordinates: '25.2811, 51.5268',
    severity: 'Medium',
    eta: '12 min',
    status: 'Queued',
  },
  {
    id: 'AL-176',
    zone: 'Transit Hub Outlet',
    issue: 'Sediment accumulation flagged for manual cleaning',
    coordinates: '25.2769, 51.5346',
    severity: 'High',
    eta: '6 min',
    status: 'Pending',
  },
]

const initialValves = [
  { id: 'V-12', location: 'Tunnel West', state: 'Open', flow: '62%' },
  { id: 'V-08', location: 'North Junction', state: 'Closed', flow: '14%' },
  { id: 'V-21', location: 'Central Basin', state: 'Open', flow: '74%' },
]

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
  const [alerts, setAlerts] = useState(initialAlerts)
  const [valves, setValves] = useState(initialValves)
  const { telemetry, zoneDepths, connection } = useSensorData()

  const activeAlerts =
    alerts.filter((alert) => alert.status !== 'Dispatched').length + Number(telemetry.blockageDetected)
  const openValves = valves.filter((valve) => valve.state === 'Open').length
  const riskBand =
    telemetry.floodRisk >= 70 ? 'Critical' : telemetry.floodRisk >= 45 ? 'Elevated' : 'Stable'
  const blockageMessage = telemetry.blockageDetected
    ? `Edge AI flagged obstruction near ${telemetry.blockedSegment}`
    : 'Edge AI reports clear flow through the monitored pipe segments'
  const liveRiskTrend = riskTrend.map((point, index) =>
    index === riskTrend.length - 1 ? { ...point, probability: telemetry.floodRisk } : point,
  )
  const sceneNodes = telemetry.sensors.map((sensor, index) => ({
    name: `${sensor.name} (${sensor.id})`,
    status: `${sensor.waterLevel}% • ${sensor.blockageDetected ? 'AI alert' : 'Normal flow'}`,
    position: twinNodePositions[index % twinNodePositions.length],
  }))

  const handleDispatch = (id) => {
    setAlerts((current) =>
      current.map((alert) =>
        alert.id === id ? { ...alert, status: 'Dispatched', eta: 'Team en route' } : alert,
      ),
    )
  }

  const toggleValve = (id) => {
    setValves((current) =>
      current.map((valve) =>
        valve.id === id
          ? {
              ...valve,
              state: valve.state === 'Open' ? 'Closed' : 'Open',
              flow: valve.state === 'Open' ? '12%' : '71%',
            }
          : valve,
      ),
    )
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
                {connection.mode === 'websocket'
                  ? `WebSocket ${connection.status === 'live' ? 'Live' : 'Connecting'}`
                  : 'Simulation Fallback'}
              </span>
              <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 font-medium text-cyan-200">
                {telemetry.transport?.mqttConnected ? 'MQTT TLS Bridge Active' : 'FastAPI Demo Stream'}
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
            helper="Sensor fabric stable across the camera, pipe, and level telemetry streams"
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

          <aside className="space-y-4">
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

              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={liveRiskTrend}>
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
                </ResponsiveContainer>
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

              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={zoneDepths}>
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
                </ResponsiveContainer>
              </div>
            </section>
          </aside>
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.25fr_0.95fr]">
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
                Commands are structured for PLC, WebSocket, or MQTT publishing once backend endpoints are connected.
              </p>
            </div>
          </section>
        </section>
      </div>
    </div>
  )
}

export default App
