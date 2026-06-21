import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Database, Play, RefreshCw, Terminal, FileText, CheckCircle,
  Loader2, AlertCircle, Clock, CheckCircle2, WifiOff, StopCircle, Trash2,
} from 'lucide-react'

// ─── Scénarios ────────────────────────────────────────────────────────────────

const SCENARIOS = [
  { id: 'normal',        color: 'emerald', title: 'Normal',          desc: 'Aucun chaos — trafic nominal, baseline propre' },
  { id: 'cpu_spike',     color: 'red',     title: 'Pic CPU',         desc: 'Boucle CPU à 100 % sur les 3 services' },
  { id: 'latency_spike', color: 'orange',  title: 'Latence élevée',  desc: 'Thread.sleep 3 000 ms injecté par requête' },
  { id: 'error_5xx',     color: 'pink',    title: 'Erreurs 5xx',     desc: '50 % des requêtes retournent HTTP 500' },
  { id: 'memory_leak',   color: 'violet',  title: 'Fuite mémoire',   desc: 'Allocation 1 Mo / 100 ms sans libération' },
]

const COLORS = {
  emerald: { sel: 'border-emerald-500/60 bg-emerald-900/20 ring-1 ring-emerald-500/40', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  red:     { sel: 'border-red-500/60     bg-red-900/20     ring-1 ring-red-500/40',     dot: 'bg-red-400',     text: 'text-red-300'     },
  orange:  { sel: 'border-orange-500/60  bg-orange-900/20  ring-1 ring-orange-500/40',  dot: 'bg-orange-400',  text: 'text-orange-300'  },
  pink:    { sel: 'border-pink-500/60    bg-pink-900/20    ring-1 ring-pink-500/40',    dot: 'bg-pink-400',    text: 'text-pink-300'    },
  violet:  { sel: 'border-violet-500/60  bg-violet-900/20  ring-1 ring-violet-500/40',  dot: 'bg-violet-400',  text: 'text-violet-300'  },
}

const LOG_STYLE = {
  log:   'text-slate-300',
  error: 'text-red-400',
  done:  'text-emerald-400 font-semibold',
  ping:  'hidden',
}

// ─── Sous-composants ──────────────────────────────────────────────────────────

function StatCard({ label, value, color = 'indigo' }) {
  const c = { indigo: 'text-indigo-400', violet: 'text-violet-400', orange: 'text-orange-400', emerald: 'text-emerald-400' }
  return (
    <div className="card px-5 py-4 flex flex-col gap-1">
      <span className="text-xs text-slate-500 uppercase tracking-wide">{label}</span>
      <span className={`text-2xl font-bold font-mono ${c[color]}`}>{value}</span>
    </div>
  )
}

function FileRow({ name, stats }) {
  if (!stats) return null
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-700/50 last:border-0">
      <div className="flex items-center gap-2 text-sm text-slate-300">
        <FileText size={13} className="text-slate-500" />
        <span className="font-mono">{name}</span>
      </div>
      <div className="flex gap-4 text-xs text-slate-400">
        <span className="font-mono">{stats.rows} lignes</span>
        <span className="text-slate-500">{stats.size_kb} KB</span>
      </div>
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function CollectPage() {
  const [scenario,      setScenario]      = useState(null)
  const [duration,      setDuration]      = useState('')
  const [interval_,     setInterval_]     = useState(5)
  const [running,       setRunning]       = useState(false)
  const [logs,          setLogs]          = useState([])
  const [files,         setFiles]         = useState(null)
  const [elapsed,       setElapsed]       = useState(0)
  const [startTime,     setStartTime]     = useState(null)
  const [error,         setError]         = useState('')
  const [applying,      setApplying]      = useState(false)
  const [ready,         setReady]         = useState(false)
  const [waitTimer,     setWaitTimer]     = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting,      setDeleting]      = useState(false)

  const logRef   = useRef(null)
  const timerRef = useRef(null)

  const addLog = useCallback((type, msg) =>
    setLogs(prev => [...prev.slice(-400), { type, message: msg, id: Date.now() + Math.random() }]),
  [])

  // auto-scroll console
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  // timer collecte
  useEffect(() => {
    if (running && startTime)
      timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 1000)
    else
      clearInterval(timerRef.current)
    return () => clearInterval(timerRef.current)
  }, [running, startTime])

  // countdown stabilisation
  useEffect(() => {
    if (waitTimer <= 0) {
      if (waitTimer === 0 && !applying) setReady(true)
      return
    }
    setReady(false)
    const id = setTimeout(() => setWaitTimer(t => t - 1), 1000)
    return () => clearTimeout(id)
  }, [waitTimer, applying])

  // poll fichiers
  const refreshFiles = useCallback(async () => {
    try {
      const r = await fetch('/api/collect/status')
      const d = await r.json()
      setFiles(d.files)
      if (!d.running && running) setRunning(false)
    } catch {}
  }, [running])

  useEffect(() => {
    refreshFiles()
    const id = setInterval(refreshFiles, 5000)
    return () => clearInterval(id)
  }, [refreshFiles])

  // ── Sélection d'un scénario ───────────────────────────────────────────────
  const selectScenario = async (id) => {
    if (running || applying) return
    setScenario(id)
    setReady(false)
    setApplying(true)
    setWaitTimer(0)
    setError('')

    try {
      await fetch('/api/chaos/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: id }),
      })
      if (id === 'normal') {
        setReady(true)
      } else {
        setWaitTimer(20)
      }
    } catch {
      setReady(true)
    } finally {
      setApplying(false)
    }
  }

  // ── Démarrer la collecte ──────────────────────────────────────────────────
  const handleStart = async () => {
    if (!scenario || !ready) return
    setError('')
    setLogs([])
    setElapsed(0)
    try {
      const res = await fetch('/api/collect/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label:    scenario,
          duration: duration ? parseInt(duration) : null,
          interval: interval_,
        }),
      })
      const d = await res.json()
      if (!res.ok) { setError(d.detail || `Erreur ${res.status}`); return }
      setRunning(true)
      setStartTime(Date.now())
      addLog('log', `Collecte démarrée — label: ${scenario}  PID: ${d.pid}`)
      streamLogs()
    } catch (e) { setError(e.message) }
  }

  const streamLogs = () => {
    fetch('/api/collect/stream').then(async res => {
      const reader = res.body.getReader()
      const dec    = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const evt = JSON.parse(line.slice(6))
            if (evt.type !== 'ping') addLog(evt.type, evt.message)
            if (evt.type === 'done') { setRunning(false); refreshFiles() }
          } catch {}
        }
      }
    }).catch(e => addLog('error', `Stream: ${e.message}`))
  }

  const handleStop = async () => {
    try {
      await fetch('/api/collect/stop', { method: 'POST' })
      setRunning(false)
      addLog('done', 'Collecte arrêtée.')
      refreshFiles()
    } catch (e) { setError(e.message) }
  }

  const fmtDur = s => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
    return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`
  }

  const selMeta  = SCENARIOS.find(s => s.id === scenario)
  const selColor = selMeta ? COLORS[selMeta.color] : null

  return (
    <div className="max-w-5xl mx-auto px-6 py-10 space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Database size={22} className="text-indigo-400" />
          Collecte de données ML
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          Sélectionne un scénario, configure la durée, puis lance la collecte.
        </p>
      </div>

      {/* ── Carte paramètres ── */}
      <div className="card p-6 space-y-6">
        <p className="text-slate-300 font-semibold text-sm">Paramètres de collecte</p>

        {/* Scénarios */}
        <div className="space-y-2">
          <label className="text-xs text-slate-400 uppercase tracking-wide">Scénario</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {SCENARIOS.map(s => {
              const c          = COLORS[s.color]
              const isSelected = scenario === s.id
              return (
                <button
                  key={s.id}
                  onClick={() => selectScenario(s.id)}
                  disabled={running || applying}
                  className={`text-left px-4 py-3.5 rounded-xl border-2 transition-all duration-200
                    ${isSelected
                      ? c.sel
                      : 'border-slate-700 bg-slate-800/40 hover:border-slate-500 hover:bg-slate-800'}
                    ${(running || applying) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isSelected ? c.dot : 'bg-slate-600'}`} />
                    <span className={`font-semibold text-sm ${isSelected ? c.text : 'text-slate-300'}`}>
                      {s.title}
                    </span>
                    {isSelected && applying && (
                      <Loader2 size={11} className="animate-spin ml-auto text-slate-400" />
                    )}
                    {isSelected && !applying && ready && (
                      <CheckCircle2 size={11} className="ml-auto text-emerald-400" />
                    )}
                    {isSelected && !applying && waitTimer > 0 && (
                      <span className="ml-auto text-xs font-mono text-amber-300">{waitTimer}s</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-1 ml-4">{s.desc}</p>
                </button>
              )
            })}
          </div>
        </div>

        {/* Barre de stabilisation Prometheus */}
        {waitTimer > 0 && (
          <div className="rounded-xl border border-amber-600/30 bg-amber-900/15 px-4 py-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 flex items-center gap-1.5">
                <Clock size={11} /> Stabilisation Prometheus en cours…
              </span>
              <span className="font-mono font-bold text-amber-300">{waitTimer}s</span>
            </div>
            <div className="w-full bg-slate-700/60 rounded-full h-1.5 overflow-hidden">
              <div
                className="h-full rounded-full bg-amber-400 transition-all duration-1000"
                style={{ width: `${((20 - waitTimer) / 20) * 100}%` }}
              />
            </div>
          </div>
        )}

        {ready && !applying && waitTimer === 0 && scenario && (
          <div className="flex items-center gap-2 text-xs text-emerald-400">
            <CheckCircle2 size={12} />
            Chaos appliqué — prêt à collecter
          </div>
        )}

        {/* Durée */}
        <div className="space-y-2">
          <label className="text-xs text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
            <Clock size={11} /> Durée de collecte
          </label>
          <div className="flex flex-wrap gap-2">
            {[
              { label: '∞',     value: ''    },
              { label: '30s',   value: '30'  },
              { label: '1 min', value: '60'  },
              { label: '2 min', value: '120' },
              { label: '5 min', value: '300' },
              { label: '10 min',value: '600' },
            ].map(opt => (
              <button
                key={opt.label}
                onClick={() => setDuration(opt.value)}
                disabled={running}
                className={`px-3 py-1.5 rounded-lg border text-sm font-mono font-medium transition-colors
                  ${duration === opt.value
                    ? 'bg-indigo-600/30 border-indigo-500/60 text-indigo-300'
                    : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'}
                  disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {opt.label}
              </button>
            ))}
            <input
              type="number"
              min="10"
              placeholder="Perso (s)"
              value={duration && !['','30','60','120','300','600'].includes(duration) ? duration : ''}
              onChange={e => setDuration(e.target.value)}
              disabled={running}
              className="text-input w-24 py-1.5 text-sm"
            />
          </div>
          <p className="text-xs text-slate-600">
            {duration ? `Arrêt automatique après ${duration} s` : 'Infini — arrêt manuel requis'}
          </p>
        </div>

        {/* Intervalle */}
        <div className="space-y-1.5">
          <label className="text-xs text-slate-400 uppercase tracking-wide">Intervalle métriques</label>
          <div className="flex gap-2">
            {[5, 10, 15, 30].map(v => (
              <button
                key={v}
                onClick={() => setInterval_(v)}
                disabled={running}
                className={`px-3 py-1.5 rounded-lg border text-sm font-mono transition-colors
                  ${interval_ === v
                    ? 'bg-slate-600/40 border-slate-500 text-slate-200'
                    : 'bg-slate-800/50 border-slate-700 text-slate-500 hover:border-slate-500'}
                  disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {v}s
              </button>
            ))}
          </div>
        </div>

        {/* Erreur */}
        {error && (
          <div className="flex items-center gap-2 text-red-400 text-sm bg-red-900/20 border border-red-800/40 rounded-xl px-4 py-3">
            <AlertCircle size={15} /> {error}
          </div>
        )}

        {/* Start / Stop */}
        <div className="flex gap-3 items-center">
          {!running ? (
            <button
              onClick={handleStart}
              disabled={!scenario || !ready || applying || waitTimer > 0}
              className={`btn-primary
                ${(!scenario || !ready || applying || waitTimer > 0) ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <Play size={15} />
              Démarrer
              {selColor && scenario && (
                <span className={`font-mono ${selColor.text}`}> — {scenario}</span>
              )}
              {duration && <span className="ml-1 text-slate-400 text-xs font-normal">({duration}s)</span>}
            </button>
          ) : (
            <button
              onClick={handleStop}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500
                         text-white font-semibold text-sm transition-colors shadow-lg shadow-red-900/30"
            >
              <StopCircle size={16} /> Arrêter la collecte
            </button>
          )}

          {running && (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 size={14} className="animate-spin text-indigo-400" />
              <Clock size={13} />
              <span className="font-mono text-indigo-300 font-semibold">{fmtDur(elapsed)}</span>
              {duration && (
                <span className="text-slate-600 text-xs">/ {fmtDur(parseInt(duration))}</span>
              )}
            </div>
          )}

          {!running && !scenario && (
            <span className="text-xs text-slate-500">← Sélectionnez un scénario pour commencer</span>
          )}
        </div>
      </div>

      {/* ── Stats fichiers ── */}
      {files && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="metrics.csv"  value={files.metrics_csv?.rows  || 0} color="indigo"  />
          <StatCard label="dataset.csv"  value={files.dataset_csv?.rows  || 0} color="violet"  />
          <StatCard label="logs.json"    value={files.logs_json?.rows    || 0} color="orange"  />
          <StatCard label="traces.json"  value={files.traces_json?.rows  || 0} color="emerald" />
        </div>
      )}

      {/* ── Fichiers + Console ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Fichiers */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-slate-300 font-semibold text-sm flex items-center gap-2">
              <FileText size={14} className="text-slate-400" />
              Fichiers générés
            </p>
            <div className="flex items-center gap-2">
              <button onClick={refreshFiles} className="text-slate-500 hover:text-slate-300 transition-colors p-1">
                <RefreshCw size={12} />
              </button>
              {!confirmDelete ? (
                <button
                  onClick={() => setConfirmDelete(true)}
                  disabled={running || deleting || !files || Object.values(files).every(f => f.rows === 0)}
                  className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg
                             border border-red-800/50 text-red-400 hover:bg-red-900/30
                             disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <Trash2 size={11} /> Supprimer
                </button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-red-400">Confirmer ?</span>
                  <button
                    onClick={async () => {
                      setDeleting(true)
                      setConfirmDelete(false)
                      try {
                        await fetch('/api/collect/data', { method: 'DELETE' })
                        await refreshFiles()
                        setLogs([])
                      } catch {}
                      setDeleting(false)
                    }}
                    className="text-xs px-2 py-0.5 rounded bg-red-700 hover:bg-red-600 text-white"
                  >Oui</button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="text-xs px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300"
                  >Non</button>
                </div>
              )}
              {deleting && <Loader2 size={12} className="animate-spin text-red-400" />}
            </div>
          </div>

          <p className="text-xs text-slate-500 font-mono mb-2">scripts/ml/data/</p>

          {files ? (
            <>
              <FileRow name="metrics.csv"  stats={files.metrics_csv}  />
              <FileRow name="dataset.csv"  stats={files.dataset_csv}  />
              <FileRow name="logs.json"    stats={files.logs_json}    />
              <FileRow name="traces.json"  stats={files.traces_json}  />
            </>
          ) : (
            <p className="text-slate-600 text-xs">Aucun fichier encore généré.</p>
          )}

          <div className="mt-4 pt-3 border-t border-slate-700/50">
            <p className="text-xs text-slate-500 mb-2 font-semibold uppercase tracking-wide">Colonnes dataset.csv</p>
            <div className="flex flex-wrap gap-1">
              {['timestamp','service','latency_p95','error_rate','cpu_usage','memory_mb',
                'req_per_second','has_errors_in_logs','has_slow_traces','label'].map(col => (
                <span key={col} className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded font-mono">{col}</span>
              ))}
            </div>
          </div>
        </div>

        {/* Console */}
        <div className="card overflow-hidden flex flex-col">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-700 bg-slate-900/60 flex-shrink-0">
            <Terminal size={13} className="text-slate-400" />
            <span className="text-slate-300 text-sm font-semibold">Sortie du script</span>
            {running     && <Loader2    size={12} className="animate-spin text-indigo-400 ml-auto" />}
            {!running && logs.length > 0 && <CheckCircle size={12} className="text-emerald-400 ml-auto" />}
          </div>
          <div
            ref={logRef}
            className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed space-y-0.5 bg-slate-950"
            style={{ height: '280px' }}
          >
            {logs.length === 0
              ? <p className="text-slate-600">Lance une collecte pour voir la sortie ici…</p>
              : logs.map(log => (
                  <div key={log.id} className={LOG_STYLE[log.type] || 'text-slate-300'}>
                    {log.message}
                  </div>
                ))
            }
          </div>
        </div>
      </div>
    </div>
  )
}
