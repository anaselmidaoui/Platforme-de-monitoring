import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Wrench, RefreshCw, Play, Square, RotateCcw,
  Cpu, MemoryStick, Terminal, ChevronDown, ChevronUp,
  CheckCircle, XCircle, AlertTriangle, Layers, Loader2,
  ZoomIn, ZoomOut, ScrollText, Activity
} from 'lucide-react'

// ─── helpers ──────────────────────────────────────────────────────────────────

function parsePercent(str) {
  if (!str) return 0
  return parseFloat(str.replace('%', '')) || 0
}

function parseMem(str) {
  // "512MiB / 2GiB" → { used: 512, limit: 2048, usedStr: '512 MiB', limitStr: '2 GiB' }
  if (!str) return { used: 0, limit: 0, usedStr: '–', limitStr: '–' }
  const parts = str.split('/')
  const parse = (s) => {
    if (!s) return 0
    s = s.trim()
    const n = parseFloat(s)
    if (s.includes('GiB') || s.includes('GB')) return n * 1024
    if (s.includes('MiB') || s.includes('MB')) return n
    if (s.includes('KiB') || s.includes('KB')) return n / 1024
    return n
  }
  return {
    used: parse(parts[0]),
    limit: parse(parts[1]),
    usedStr: parts[0]?.trim() || '–',
    limitStr: parts[1]?.trim() || '–',
  }
}

const ANOMALY_SUGGESTIONS = {
  cpu_spike: [
    { label: 'Redémarrer le service', action: 'restart', icon: RotateCcw },
    { label: 'Augmenter les CPU alloués', action: 'cpu', icon: Cpu },
  ],
  memory_leak: [
    { label: 'Redémarrer (vide le heap)', action: 'restart', icon: RotateCcw },
    { label: 'Augmenter la limite mémoire', action: 'memory', icon: MemoryStick },
  ],
  latency_spike: [
    { label: 'Redémarrer le service', action: 'restart', icon: RotateCcw },
    { label: 'Consulter les logs', action: 'logs', icon: ScrollText },
  ],
  error_5xx: [
    { label: 'Redémarrer le service', action: 'restart', icon: RotateCcw },
    { label: 'Consulter les logs', action: 'logs', icon: ScrollText },
  ],
}

const SERVICE_LABEL_MAP = {
  'service-a': 'Service A',
  'service-b': 'Service B',
  'service-c': 'Service C',
}

// ─── sub-components ──────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const running = typeof status === 'string' && status.toLowerCase().includes('up')
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium
      ${running ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${running ? 'bg-emerald-400' : 'bg-red-400'}`} />
      {running ? 'Running' : 'Stopped'}
    </span>
  )
}

function ProgressBar({ value, max = 100, color = 'indigo' }) {
  const pct = Math.min(100, max > 0 ? (value / max) * 100 : value)
  const colors = {
    indigo: 'bg-indigo-500',
    emerald: 'bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-red-500',
  }
  const barColor = pct > 80 ? colors.red : pct > 60 ? colors.amber : colors[color]
  return (
    <div className="h-1.5 w-full bg-slate-700 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${barColor}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

function FeedbackBanner({ msg, type, onClose }) {
  if (!msg) return null
  const styles = {
    success: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300',
    error: 'bg-red-500/15 border-red-500/30 text-red-300',
    info: 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300',
  }
  const icons = { success: CheckCircle, error: XCircle, info: Activity }
  const Icon = icons[type] || Activity
  return (
    <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm ${styles[type]}`}>
      <Icon size={15} />
      <span className="flex-1">{msg}</span>
      <button onClick={onClose} className="opacity-60 hover:opacity-100">×</button>
    </div>
  )
}

// ─── Container Card ──────────────────────────────────────────────────────────

function ContainerCard({ container, stats, anomalyMap, onAction, onShowLogs }) {
  const [memMb, setMemMb] = useState('')
  const [cpuVal, setCpuVal] = useState('')
  const [replicas, setReplicas] = useState(1)
  const [busy, setBusy] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [feedback, setFeedback] = useState(null)

  const name = container.Names || container.Name || '–'
  const statusStr = container.Status || ''
  const running = statusStr.toLowerCase().includes('up')

  const stat = stats.find(s =>
    s.Name === name || s.Name === name.replace(/^\//, '') ||
    s.ID === (container.ID || container.Id)
  )

  const cpuPct = stat ? parsePercent(stat.CPUPerc) : 0
  const mem = stat ? parseMem(stat.MemUsage) : { used: 0, limit: 0, usedStr: '–', limitStr: '–' }
  const memPct = mem.limit > 0 ? (mem.used / mem.limit) * 100 : 0

  // Find which Spring Boot service this container corresponds to
  const matchedService = Object.keys(SERVICE_LABEL_MAP).find(svc =>
    name.toLowerCase().includes(svc.replace('-', ''))
    || name.toLowerCase().includes(svc)
  )
  const anomaly = matchedService ? anomalyMap[matchedService] : null
  const suggestions = anomaly && ANOMALY_SUGGESTIONS[anomaly] ? ANOMALY_SUGGESTIONS[anomaly] : []

  const doAction = async (endpoint, body, label) => {
    setBusy(label)
    setFeedback(null)
    try {
      const r = await fetch(`/api/remediation/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await r.json()
      if (data.success) {
        setFeedback({ msg: `${label} réussi`, type: 'success' })
        onAction()
      } else {
        setFeedback({ msg: data.stderr || `Échec de ${label}`, type: 'error' })
      }
    } catch (e) {
      setFeedback({ msg: e.message, type: 'error' })
    } finally {
      setBusy('')
    }
  }

  const applyResources = () => {
    const body = { container: name }
    if (memMb) body.memory_mb = parseInt(memMb)
    if (cpuVal) body.cpus = parseFloat(cpuVal)
    if (!body.memory_mb && !body.cpus) return
    doAction('resources', body, 'Mise à jour ressources')
  }

  const isBusy = (lbl) => busy === lbl

  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5 flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-mono text-sm text-white truncate" title={name}>{name}</p>
          <div className="flex items-center gap-2 mt-1">
            <StatusBadge status={statusStr} />
            {anomaly && (
              <span className="px-2 py-0.5 rounded-full text-xs bg-amber-500/15 text-amber-400 border border-amber-500/20">
                {anomaly.replace('_', ' ')}
              </span>
            )}
          </div>
        </div>
        <div className="text-xs text-slate-500 font-mono shrink-0">
          {container.Image || ''}
        </div>
      </div>

      {/* Stats */}
      {stat ? (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-slate-400">CPU</span>
              <span className="text-slate-200 font-mono">{stat.CPUPerc}</span>
            </div>
            <ProgressBar value={cpuPct} color="indigo" />
          </div>
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-slate-400">Mémoire</span>
              <span className="text-slate-200 font-mono">{mem.usedStr}</span>
            </div>
            <ProgressBar value={memPct} color="emerald" />
            <p className="text-xs text-slate-500 mt-0.5 text-right">/ {mem.limitStr}</p>
          </div>
        </div>
      ) : (
        <p className="text-xs text-slate-500 italic">Stats indisponibles (conteneur arrêté ou non suivi)</p>
      )}

      {/* Feedback */}
      {feedback && (
        <FeedbackBanner msg={feedback.msg} type={feedback.type} onClose={() => setFeedback(null)} />
      )}

      {/* Quick actions */}
      <div className="flex gap-2 flex-wrap">
        {running ? (
          <>
            <button
              onClick={() => doAction('restart', { container: name }, 'Redémarrage')}
              disabled={!!busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                         bg-indigo-600/20 text-indigo-400 border border-indigo-500/30
                         hover:bg-indigo-600/30 disabled:opacity-50 transition-colors"
            >
              {isBusy('Redémarrage') ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
              Redémarrer
            </button>
            <button
              onClick={() => doAction('stop', { container: name }, 'Arrêt')}
              disabled={!!busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                         bg-red-600/20 text-red-400 border border-red-500/30
                         hover:bg-red-600/30 disabled:opacity-50 transition-colors"
            >
              {isBusy('Arrêt') ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
              Arrêter
            </button>
          </>
        ) : (
          <button
            onClick={() => doAction('start', { container: name }, 'Démarrage')}
            disabled={!!busy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                       bg-emerald-600/20 text-emerald-400 border border-emerald-500/30
                       hover:bg-emerald-600/30 disabled:opacity-50 transition-colors"
          >
            {isBusy('Démarrage') ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            Démarrer
          </button>
        )}
        <button
          onClick={() => onShowLogs(name)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                     bg-slate-700 text-slate-300 border border-slate-600
                     hover:bg-slate-600 transition-colors"
        >
          <ScrollText size={12} />
          Logs
        </button>
      </div>

      {/* Suggestions IA */}
      {suggestions.length > 0 && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
          <p className="text-xs text-amber-400 font-medium mb-2">Actions suggérées ({anomaly})</p>
          <div className="flex flex-col gap-1.5">
            {suggestions.map(({ label, action, icon: Icon }) => (
              <button
                key={label}
                onClick={() => {
                  if (action === 'restart') doAction('restart', { container: name }, 'Redémarrage')
                  else if (action === 'memory') setExpanded(true)
                  else if (action === 'cpu') setExpanded(true)
                  else if (action === 'logs') onShowLogs(name)
                }}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs
                           bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-colors text-left"
              >
                <Icon size={12} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Resource controls (expandable) */}
      <div>
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          Modifier les ressources
        </button>
        {expanded && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Mémoire limite (MB)</label>
              <input
                type="number"
                value={memMb}
                onChange={e => setMemMb(e.target.value)}
                placeholder="ex: 512"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5
                           text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">CPU (cores)</label>
              <input
                type="number"
                step="0.1"
                value={cpuVal}
                onChange={e => setCpuVal(e.target.value)}
                placeholder="ex: 0.5"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5
                           text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div className="col-span-2">
              <button
                onClick={applyResources}
                disabled={(!memMb && !cpuVal) || !!busy}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm
                           bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50
                           disabled:cursor-not-allowed transition-colors font-medium"
              >
                {isBusy('Mise à jour ressources') ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
                Appliquer
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Log Viewer ──────────────────────────────────────────────────────────────

function LogViewer({ container, onClose }) {
  const [logs, setLogs] = useState([])
  const [lines, setLines] = useState(50)
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef(null)

  const fetchLogs = useCallback(async () => {
    if (!container) return
    setLoading(true)
    try {
      const r = await fetch(`/api/remediation/logs/${encodeURIComponent(container)}?lines=${lines}`)
      const data = await r.json()
      setLogs(data.logs || [])
    } catch {
      setLogs(['[Erreur lors du chargement des logs]'])
    } finally {
      setLoading(false)
    }
  }, [container, lines])

  useEffect(() => { fetchLogs() }, [fetchLogs])
  useEffect(() => { bottomRef.current?.scrollIntoView() }, [logs])

  return (
    <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-800/50">
        <div className="flex items-center gap-2">
          <Terminal size={15} className="text-slate-400" />
          <span className="text-sm font-medium text-slate-200">Logs : {container}</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={lines}
            onChange={e => setLines(Number(e.target.value))}
            className="bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-xs text-slate-300
                       focus:outline-none focus:border-indigo-500"
          >
            {[25, 50, 100, 200, 500].map(n => (
              <option key={n} value={n}>{n} lignes</option>
            ))}
          </select>
          <button
            onClick={fetchLogs}
            disabled={loading}
            className="p-1.5 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors text-sm"
          >
            ×
          </button>
        </div>
      </div>
      <div className="h-72 overflow-y-auto font-mono text-xs p-4 space-y-0.5">
        {logs.length === 0 && !loading && (
          <p className="text-slate-500 italic">Aucun log disponible.</p>
        )}
        {logs.map((line, i) => {
          const isError = /error|exception|fatal/i.test(line)
          const isWarn = /warn/i.test(line)
          return (
            <p key={i} className={
              isError ? 'text-red-400' :
              isWarn ? 'text-amber-400' :
              'text-slate-400'
            }>
              {line}
            </p>
          )
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

// ─── Scale Panel ─────────────────────────────────────────────────────────────

function ScalePanel({ composePath }) {
  const services = ['service-a', 'service-b', 'service-c']
  const [replicas, setReplicas] = useState({ 'service-a': 1, 'service-b': 1, 'service-c': 1 })
  const [busy, setBusy] = useState('')
  const [feedbacks, setFeedbacks] = useState({})

  const scale = async (service) => {
    if (!composePath) return
    setBusy(service)
    try {
      const r = await fetch('/api/remediation/scale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ compose_path: composePath, service, replicas: replicas[service] }),
      })
      const data = await r.json()
      setFeedbacks(f => ({ ...f, [service]: data.success ? 'success' : 'error' }))
      setTimeout(() => setFeedbacks(f => ({ ...f, [service]: null })), 3000)
    } catch {
      setFeedbacks(f => ({ ...f, [service]: 'error' }))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Layers size={16} className="text-violet-400" />
        <h3 className="text-sm font-semibold text-slate-200">Scale des services</h3>
        <span className="text-xs text-slate-500">(docker compose)</span>
      </div>
      {!composePath && (
        <p className="text-xs text-amber-400 mb-3">
          Définissez le chemin du docker-compose dans la page Configuration.
        </p>
      )}
      <div className="grid grid-cols-3 gap-4">
        {services.map(svc => (
          <div key={svc} className="flex flex-col gap-2">
            <p className="text-xs font-medium text-slate-300">{SERVICE_LABEL_MAP[svc] || svc}</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setReplicas(r => ({ ...r, [svc]: Math.max(1, r[svc] - 1) }))}
                className="w-7 h-7 flex items-center justify-center rounded-lg bg-slate-700
                           text-slate-300 hover:bg-slate-600 transition-colors text-sm"
              >
                <ZoomOut size={13} />
              </button>
              <span className="w-6 text-center text-sm font-mono text-white">{replicas[svc]}</span>
              <button
                onClick={() => setReplicas(r => ({ ...r, [svc]: Math.min(10, r[svc] + 1) }))}
                className="w-7 h-7 flex items-center justify-center rounded-lg bg-slate-700
                           text-slate-300 hover:bg-slate-600 transition-colors"
              >
                <ZoomIn size={13} />
              </button>
            </div>
            <button
              onClick={() => scale(svc)}
              disabled={!composePath || busy === svc}
              className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs
                          font-medium transition-colors
                          ${feedbacks[svc] === 'success' ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30' :
                            feedbacks[svc] === 'error' ? 'bg-red-600/20 text-red-400 border border-red-500/30' :
                            'bg-violet-600/20 text-violet-400 border border-violet-500/30 hover:bg-violet-600/30'}
                          disabled:opacity-50`}
            >
              {busy === svc ? (
                <Loader2 size={12} className="animate-spin" />
              ) : feedbacks[svc] === 'success' ? (
                <CheckCircle size={12} />
              ) : feedbacks[svc] === 'error' ? (
                <XCircle size={12} />
              ) : (
                <Layers size={12} />
              )}
              Appliquer
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function RemediationPage() {
  const [containers, setContainers] = useState([])
  const [stats, setStats] = useState([])
  const [loadingContainers, setLoadingContainers] = useState(false)
  const [loadingStats, setLoadingStats] = useState(false)
  const [logsContainer, setLogsContainer] = useState(null)
  const [composePath, setComposePath] = useState(() => localStorage.getItem('composePath') || '')
  const [lastPredictions, setLastPredictions] = useState([])
  const statsTimerRef = useRef(null)

  // Build anomaly map: { 'service-a': 'cpu_spike', ... }
  const anomalyMap = {}
  lastPredictions.forEach(p => {
    if (p.is_anomaly && p.service) {
      anomalyMap[p.service] = p.label
    }
  })

  const fetchContainers = useCallback(async () => {
    setLoadingContainers(true)
    try {
      const r = await fetch('/api/remediation/containers')
      const data = await r.json()
      setContainers(data.containers || [])
    } catch {
      setContainers([])
    } finally {
      setLoadingContainers(false)
    }
  }, [])

  const fetchStats = useCallback(async () => {
    setLoadingStats(true)
    try {
      const r = await fetch('/api/remediation/stats')
      const data = await r.json()
      setStats(data.stats || [])
    } catch {
      setStats([])
    } finally {
      setLoadingStats(false)
    }
  }, [])

  // Load last predictions from localStorage (set by AnalysePage)
  useEffect(() => {
    const stored = localStorage.getItem('lastPredictions')
    if (stored) {
      try { setLastPredictions(JSON.parse(stored)) } catch {}
    }
    fetchContainers()
    fetchStats()
  }, [fetchContainers, fetchStats])

  // Auto-refresh stats every 8 seconds
  useEffect(() => {
    statsTimerRef.current = setInterval(fetchStats, 8000)
    return () => clearInterval(statsTimerRef.current)
  }, [fetchStats])

  const handleRefresh = () => {
    fetchContainers()
    fetchStats()
  }

  const anomalyCount = Object.keys(anomalyMap).length

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-amber-500/20 rounded-xl flex items-center justify-center border border-amber-500/30">
            <Wrench size={18} className="text-amber-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Remédiation</h1>
            <p className="text-xs text-slate-400">Gestion et correction des conteneurs Docker</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {anomalyCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <AlertTriangle size={14} className="text-amber-400" />
              <span className="text-xs text-amber-400">{anomalyCount} anomalie{anomalyCount > 1 ? 's' : ''} détectée{anomalyCount > 1 ? 's' : ''}</span>
            </div>
          )}
          <button
            onClick={handleRefresh}
            disabled={loadingContainers || loadingStats}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm
                       bg-slate-700 text-slate-300 border border-slate-600
                       hover:bg-slate-600 disabled:opacity-50 transition-colors"
          >
            {(loadingContainers || loadingStats)
              ? <Loader2 size={14} className="animate-spin" />
              : <RefreshCw size={14} />}
            Actualiser
          </button>
        </div>
      </div>

      {/* Compose path config */}
      <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4 flex items-center gap-3">
        <Layers size={15} className="text-slate-400 shrink-0" />
        <label className="text-sm text-slate-400 shrink-0">Chemin docker-compose.yml</label>
        <input
          type="text"
          value={composePath}
          onChange={e => {
            setComposePath(e.target.value)
            localStorage.setItem('composePath', e.target.value)
          }}
          placeholder="ex: C:\Users\anasm\Desktop\ensias\ensias 2A\PFA\PFA_final_version"
          className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5
                     text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono"
        />
      </div>

      {/* Containers grid */}
      <div>
        <h2 className="text-sm font-semibold text-slate-300 mb-3">
          Conteneurs
          <span className="ml-2 text-slate-500 font-normal">({containers.length})</span>
          {loadingStats && <Loader2 size={12} className="inline ml-2 animate-spin text-slate-500" />}
        </h2>
        {containers.length === 0 && !loadingContainers ? (
          <div className="text-center py-12 text-slate-500 text-sm">
            Aucun conteneur trouvé. Vérifiez que Docker est en cours d'exécution.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {containers.map((c, i) => (
              <ContainerCard
                key={c.ID || c.Id || i}
                container={c}
                stats={stats}
                anomalyMap={anomalyMap}
                onAction={handleRefresh}
                onShowLogs={(name) => setLogsContainer(name)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Scale panel */}
      <ScalePanel composePath={composePath} />

      {/* Log viewer */}
      {logsContainer && (
        <LogViewer
          container={logsContainer}
          onClose={() => setLogsContainer(null)}
        />
      )}
    </div>
  )
}
