import { useState, useEffect, useCallback } from 'react'
import {
  Timer, AlertTriangle, Zap, Cpu, HardDrive,
  RefreshCw, Layers, ExternalLink, ChevronDown,
} from 'lucide-react'
import MetricCard from '../components/MetricCard'
import LogStream  from '../components/LogStream'
import ScaleModal from '../components/ScaleModal'

// ─── PromQL queries (per service) ─────────────────────────────────────────────
const METRICS = [
  {
    id:        'latency',
    title:     'Latence P95',
    unit:      'ms',
    color:     '#6366f1',
    icon:      Timer,
    chartType: 'line',
    query: svc =>
      `histogram_quantile(0.95, sum(rate(http_server_requests_seconds_bucket{application="${svc}"}[2m])) by (le)) * 1000`,
  },
  {
    id:        'errors',
    title:     'Erreurs 5xx',
    unit:      'req/s',
    color:     '#ef4444',
    icon:      AlertTriangle,
    chartType: 'area',
    query: svc =>
      `sum(rate(http_server_requests_seconds_count{application="${svc}",status=~"5.."}[2m])) or vector(0)`,
  },
  {
    id:        'throughput',
    title:     'Débit global',
    unit:      'req/s',
    color:     '#10b981',
    icon:      Zap,
    chartType: 'area',
    query: svc =>
      `sum(rate(http_server_requests_seconds_count{application="${svc}"}[2m])) or vector(0)`,
  },
  {
    id:        'cpu',
    title:     'CPU',
    unit:      '%',
    color:     '#f59e0b',
    icon:      Cpu,
    chartType: 'area',
    query: svc => `process_cpu_usage{application="${svc}"} * 100`,
  },
  {
    id:        'memory',
    title:     'Mémoire heap JVM',
    unit:      'MB',
    color:     '#8b5cf6',
    icon:      HardDrive,
    chartType: 'area',
    query: svc =>
      `sum(jvm_memory_used_bytes{application="${svc}",area="heap"}) / 1048576`,
  },
]

const TIME_RANGES = [
  { label: 'Dernières 5 min',    value: 5,    step: '15s' },
  { label: 'Dernière 1 heure',   value: 60,   step: '30s' },
  { label: 'Dernières 24 heures',value: 1440, step: '5m'  },
]

// ─── Container status bar ─────────────────────────────────────────────────────
function ContainerBadge({ c }) {
  const running = c.Status?.toLowerCase().includes('up')
  return (
    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono
      ${running
        ? 'bg-emerald-900/20 border-emerald-700/40 text-emerald-300'
        : 'bg-red-900/20 border-red-700/40 text-red-300'}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${running ? 'bg-emerald-400' : 'bg-red-400'}`} />
      {c.Names?.replace('/', '') || c.Image}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const storedServices = JSON.parse(localStorage.getItem('mp_services') || '[]')
  const serviceNames   = storedServices.length
    ? storedServices.map(s => s.name)
    : ['service-a', 'service-b', 'service-c']
  const projectPath = localStorage.getItem('mp_project_path') || ''

  const [selectedService, setSelectedService] = useState(serviceNames[0])
  const [timeRange, setTimeRange]             = useState(60)
  const [containers, setContainers]           = useState([])
  const [showScale, setShowScale]             = useState(false)
  const [refreshKey, setRefreshKey]           = useState(0)
  const [refreshing, setRefreshing]           = useState(false)

  const fetchContainers = useCallback(async () => {
    try {
      const res  = await fetch('/api/docker/containers')
      const data = await res.json()
      setContainers(data.containers || [])
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchContainers()
    const id = setInterval(fetchContainers, 15_000)
    return () => clearInterval(id)
  }, [fetchContainers])

  const handleRefresh = () => {
    setRefreshing(true)
    setRefreshKey(k => k + 1)
    fetchContainers()
    setTimeout(() => setRefreshing(false), 800)
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">

      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-3">
          {/* Service selector */}
          <div className="relative">
            <select
              value={selectedService}
              onChange={e => setSelectedService(e.target.value)}
              className="select-input pr-8 appearance-none"
            >
              {serviceNames.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          </div>

          {/* Time range */}
          <div className="relative">
            <select
              value={timeRange}
              onChange={e => setTimeRange(Number(e.target.value))}
              className="select-input pr-8 appearance-none"
            >
              {TIME_RANGES.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Scale button */}
          <button
            onClick={() => setShowScale(true)}
            className="btn-secondary flex items-center gap-2 text-sm"
          >
            <Layers size={14} /> Scale {selectedService}
          </button>

          {/* Refresh */}
          <button
            onClick={handleRefresh}
            className={`p-2.5 rounded-xl border border-slate-700 text-slate-400 hover:text-slate-200
                        hover:bg-slate-700 transition-all ${refreshing ? 'animate-spin' : ''}`}
          >
            <RefreshCw size={15} />
          </button>

          {/* Grafana link */}
          <a
            href="http://localhost:3001"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-indigo-700/50
                       bg-indigo-900/20 text-indigo-300 text-sm hover:bg-indigo-800/30 transition-colors"
          >
            <ExternalLink size={13} /> Grafana
          </a>
        </div>
      </div>

      {/* Container status strip */}
      {containers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {containers.map((c, i) => <ContainerBadge key={i} c={c} />)}
        </div>
      )}

      {/* Metrics grid : 3 cols, 2 rows → 5 charts + 1 log stream */}
      <div key={refreshKey} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {METRICS.map(m => (
          <MetricCard
            key={`${m.id}-${selectedService}-${timeRange}`}
            {...m}
            service={selectedService}
            rangeMins={timeRange}
          />
        ))}

        {/* Log stream takes the 6th cell */}
        <LogStream service={selectedService} rangeMins={Math.min(timeRange, 60)} />
      </div>

      {/* Jaeger link */}
      <div className="flex justify-center">
        <a
          href="http://localhost:16686"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-slate-500 hover:text-indigo-400 flex items-center gap-1.5 transition-colors"
        >
          <ExternalLink size={11} /> Voir les traces distribuées dans Jaeger
        </a>
      </div>

      {/* Scale modal */}
      {showScale && (
        <ScaleModal
          service={selectedService}
          composePath={projectPath}
          onClose={() => setShowScale(false)}
        />
      )}
    </div>
  )
}
