import { useState, useEffect, useRef, useCallback } from 'react'
import {
  BrainCircuit, Play, RefreshCw, Clock, AlertTriangle,
  CheckCircle2, XCircle, Loader2, ChevronDown, ChevronUp,
  Activity, Cpu, MemoryStick, Zap, TrendingUp, Timer,
  Sparkles, Copy, Check, RotateCcw, X, WifiOff, KeyRound,
} from 'lucide-react'

// ─── Config ──────────────────────────────────────────────────────────────────

const ANOMALY = {
  normal:         { label: 'Normal',          color: 'emerald', bg: 'bg-emerald-900/25', border: 'border-emerald-500/40', badge: 'bg-emerald-900/60 text-emerald-300 border-emerald-600/50', dot: 'bg-emerald-400' },
  cpu_spike:      { label: 'Pic CPU',          color: 'orange',  bg: 'bg-orange-900/25',  border: 'border-orange-500/40',  badge: 'bg-orange-900/60 text-orange-300 border-orange-600/50',   dot: 'bg-orange-400'  },
  latency_spike:  { label: 'Latence élevée',   color: 'yellow',  bg: 'bg-yellow-900/25',  border: 'border-yellow-500/40',  badge: 'bg-yellow-900/60 text-yellow-300 border-yellow-600/50',   dot: 'bg-yellow-400'  },
  error_5xx:      { label: 'Erreurs 5xx',      color: 'red',     bg: 'bg-red-900/25',     border: 'border-red-500/40',     badge: 'bg-red-900/60 text-red-300 border-red-600/50',            dot: 'bg-red-400'     },
  memory_leak:    { label: 'Fuite mémoire',    color: 'purple',  bg: 'bg-purple-900/25',  border: 'border-purple-500/40',  badge: 'bg-purple-900/60 text-purple-300 border-purple-600/50',   dot: 'bg-purple-400'  },
}

const FEATURE_FR = {
  latency_p95:        'Latence P95',
  error_rate:         "Taux d'erreur",
  cpu_usage:          'Utilisation CPU',
  memory_mb:          'Mémoire heap',
  req_per_second:     'Requêtes/s',
  has_errors_in_logs: 'Erreurs dans logs',
  has_slow_traces:    'Traces lentes',
}

const LOG_STYLE = {
  log:     'text-slate-300',
  success: 'text-emerald-400 font-semibold',
  error:   'text-red-400 font-semibold',
  ping:    'hidden',
}

const fmtPct = v => `${(v * 100).toFixed(1)}%`
const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('fr-FR') : '—'

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, color = 'indigo' }) {
  const colors = {
    indigo:  'text-indigo-400  bg-indigo-900/20  border-indigo-500/20',
    emerald: 'text-emerald-400 bg-emerald-900/20 border-emerald-500/20',
    amber:   'text-amber-400   bg-amber-900/20   border-amber-500/20',
    violet:  'text-violet-400  bg-violet-900/20  border-violet-500/20',
  }
  return (
    <div className={`card p-4 border ${colors[color]}`}>
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} className={colors[color].split(' ')[0]} />
        <span className="text-xs text-slate-500 uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-2xl font-bold text-white tabular-nums">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  )
}

function FeatureBar({ name, value, max }) {
  const pct = max > 0 ? (value / max) * 100 : 0
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="text-xs text-slate-400 w-36 flex-shrink-0 truncate">{FEATURE_FR[name] || name}</span>
      <div className="flex-1 bg-slate-800 rounded-full h-2 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-indigo-600 to-violet-500 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-slate-400 w-10 text-right tabular-nums">{(value * 100).toFixed(1)}%</span>
    </div>
  )
}

function ReportTable({ report, labels }) {
  if (!report || labels.length === 0) return null
  const metrics = ['precision', 'recall', 'f1-score']
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-slate-700">
          <th className="text-left py-1.5 text-slate-500 font-medium">Classe</th>
          {metrics.map(m => (
            <th key={m} className="text-right py-1.5 text-slate-500 font-medium capitalize">{m.replace('-score', '')}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {labels.map(lbl => {
          const row = report[lbl] || {}
          const a = ANOMALY[lbl] || ANOMALY.normal
          return (
            <tr key={lbl} className="border-b border-slate-800/50">
              <td className="py-1.5">
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] ${a.badge}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${a.dot}`} />
                  {a.label}
                </span>
              </td>
              {metrics.map(m => (
                <td key={m} className="py-1.5 text-right text-slate-300 tabular-nums">
                  {row[m] != null ? (row[m] * 100).toFixed(0) + '%' : '—'}
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function ServiceCard({ pred }) {
  const [expanded, setExpanded] = useState(false)
  if (!pred) return (
    <div className="card p-4 flex items-center justify-center h-32 text-slate-600 text-sm">
      Aucune prédiction
    </div>
  )
  const a    = ANOMALY[pred.prediction] || ANOMALY.normal
  const conf = Math.round(pred.confidence * 100)

  return (
    <div className={`card border ${a.border} ${a.bg} transition-all`}>
      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div>
            <div className="text-xs text-slate-500 mb-0.5">{pred.service}</div>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-sm font-semibold ${a.badge}`}>
              {pred.is_anomaly ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}
              {a.label}
            </span>
          </div>
          {/* Confidence donut-like */}
          <div className="text-right">
            <div className="text-2xl font-bold text-white tabular-nums">{conf}%</div>
            <div className="text-xs text-slate-500">confiance</div>
          </div>
        </div>

        {/* Mini metrics */}
        <div className="grid grid-cols-3 gap-1.5 text-[11px]">
          {[
            { icon: Zap,         label: 'Lat.', val: `${pred.metrics.latency_ms}ms` },
            { icon: Cpu,         label: 'CPU',  val: `${pred.metrics.cpu_pct}%` },
            { icon: MemoryStick, label: 'Mem',  val: `${pred.metrics.memory_mb}MB` },
            { icon: XCircle,     label: 'Err',  val: `${pred.metrics.error_pct}%` },
            { icon: TrendingUp,  label: 'RPS',  val: pred.metrics.rps },
            { icon: Clock,       label: 'Heure',val: fmtTime(pred.timestamp) },
          ].map(({ icon: I, label, val }) => (
            <div key={label} className="bg-slate-900/50 rounded-lg px-2 py-1.5 flex flex-col gap-0.5">
              <span className="text-slate-500 flex items-center gap-1"><I size={9} />{label}</span>
              <span className="text-white font-mono font-semibold">{val}</span>
            </div>
          ))}
        </div>

        {/* Expand probabilities */}
        <button
          onClick={() => setExpanded(e => !e)}
          className="mt-2 w-full text-xs text-slate-500 hover:text-slate-300 flex items-center justify-center gap-1 transition-colors"
        >
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          {expanded ? 'Masquer' : 'Probabilités par classe'}
        </button>
        {expanded && (
          <div className="mt-2 space-y-1">
            {Object.entries(pred.probabilities)
              .sort(([, a], [, b]) => b - a)
              .map(([cls, p]) => {
                const ac = ANOMALY[cls] || ANOMALY.normal
                return (
                  <div key={cls} className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${ac.dot}`} />
                    <span className="text-[11px] text-slate-400 w-28 truncate">{ac.label}</span>
                    <div className="flex-1 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                      <div className={`h-full rounded-full ${ac.dot}`} style={{ width: `${p * 100}%` }} />
                    </div>
                    <span className="text-[11px] text-slate-400 w-8 text-right tabular-nums">{(p * 100).toFixed(0)}%</span>
                  </div>
                )
              })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── SuggestionPanel ─────────────────────────────────────────────────────────

function SuggestionPanel({ suggestion, loading, error, anomalies, onRegenerate, onDismiss }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (!suggestion) return
    navigator.clipboard.writeText(suggestion).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // Formater le markdown basique en JSX
  const renderContent = (text) => {
    if (!text) return null
    return text.split('\n').map((line, i) => {
      const bold = line.replace(/\*\*(.*?)\*\*/g, (_, m) => `<b>${m}</b>`)
      if (line.startsWith('**') || /^\*\*[🔍⚡🛡️]/.test(line)) {
        return (
          <p key={i} className="font-semibold text-violet-300 mt-3 first:mt-0"
             dangerouslySetInnerHTML={{ __html: bold }} />
        )
      }
      if (line.startsWith('- ') || line.startsWith('• ')) {
        return (
          <p key={i} className="text-slate-300 pl-3 before:content-['•'] before:mr-2 before:text-violet-500"
             dangerouslySetInnerHTML={{ __html: bold.replace(/^[-•]\s*/, '') }} />
        )
      }
      if (line.trim() === '') return <div key={i} className="h-1" />
      return (
        <p key={i} className="text-slate-300"
           dangerouslySetInnerHTML={{ __html: bold }} />
      )
    })
  }

  return (
    <div className="card border border-violet-500/40 bg-violet-950/10 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-violet-700/30 bg-violet-950/20">
        <Sparkles size={14} className="text-violet-400 flex-shrink-0" />
        <span className="text-sm font-semibold text-violet-300">Suggestion IA</span>
        <span className="text-[10px] text-violet-600 font-mono">Groq · llama-3.1-8b</span>

        {/* Anomaly badges */}
        {anomalies.length > 0 && (
          <div className="flex gap-1 ml-1 flex-wrap">
            {anomalies.map(a => (
              <span key={a} className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/40 border border-red-700/40 text-red-300 font-mono">
                {a}
              </span>
            ))}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-1 ml-auto flex-shrink-0">
          <button
            onClick={handleCopy}
            disabled={!suggestion || loading}
            title="Copier la suggestion"
            className="flex items-center gap-1 text-xs px-2 py-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors disabled:opacity-30"
          >
            {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
            {copied ? 'Copié' : 'Copier'}
          </button>
          <button
            onClick={onRegenerate}
            disabled={loading}
            title="Regénérer la suggestion"
            className="flex items-center gap-1 text-xs px-2 py-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors disabled:opacity-30"
          >
            <RotateCcw size={11} className={loading ? 'animate-spin' : ''} />
            Regénérer
          </button>
          <button
            onClick={onDismiss}
            title="Fermer"
            className="text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 p-1 rounded transition-colors"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="px-5 py-4">
        {loading ? (
          <div className="flex items-center gap-3 text-slate-400 text-sm py-2">
            <Loader2 size={16} className="animate-spin text-violet-400 flex-shrink-0" />
            <span>Génération de la suggestion par Groq en cours<span className="animate-pulse">…</span></span>
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 text-sm">
            {error.includes('GROQ_API_KEY') ? (
              <>
                <KeyRound size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <span className="text-amber-300">
                  Clé API manquante — définissez <code className="bg-slate-800 px-1 py-0.5 rounded text-xs">GROQ_API_KEY</code> dans l'environnement du backend, puis redémarrez uvicorn.
                </span>
              </>
            ) : (
              <>
                <WifiOff size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
                <span className="text-red-300">{error}</span>
              </>
            )}
          </div>
        ) : suggestion ? (
          <div className="space-y-0.5 text-sm leading-relaxed">
            {renderContent(suggestion)}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function HistoryTable({ history }) {
  if (history.length === 0) return (
    <div className="flex items-center justify-center py-12 text-slate-600 text-sm">
      Aucune analyse effectuée
    </div>
  )
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-700">
            {['Heure', 'Service', 'Prédiction', 'Confiance', 'CPU', 'Latence', 'Erreurs'].map(h => (
              <th key={h} className="text-left py-2 px-3 text-slate-500 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {history.map((h, i) => {
            const a = ANOMALY[h.prediction] || ANOMALY.normal
            return (
              <tr key={i} className="border-b border-slate-800/40 hover:bg-slate-800/20 transition-colors">
                <td className="py-2 px-3 text-slate-500 tabular-nums font-mono">{fmtTime(h.timestamp)}</td>
                <td className="py-2 px-3 text-slate-300">{h.service}</td>
                <td className="py-2 px-3">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium ${a.badge}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${a.dot}`} />
                    {a.label}
                  </span>
                </td>
                <td className="py-2 px-3 tabular-nums text-slate-300">{Math.round(h.confidence * 100)}%</td>
                <td className="py-2 px-3 tabular-nums text-slate-400">{h.metrics?.cpu_pct ?? '—'}%</td>
                <td className="py-2 px-3 tabular-nums text-slate-400">{h.metrics?.latency_ms ?? '—'}ms</td>
                <td className="py-2 px-3 tabular-nums text-slate-400">{h.metrics?.error_pct ?? '—'}%</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AnalysePage() {
  const [status,           setStatus]           = useState(null)
  const [predictions,      setPredictions]      = useState([])
  const [history,          setHistory]          = useState([])
  const [training,         setTraining]         = useState(false)
  const [trainLogs,        setTrainLogs]        = useState([])
  const [showConsole,      setShowConsole]      = useState(false)
  const [analyzing,        setAnalyzing]        = useState(false)
  const [autoActive,       setAutoActive]       = useState(false)
  const [autoInterval,     setAutoInterval]     = useState(30)
  const [countdown,        setCountdown]        = useState(0)

  // ── Suggestion IA ──
  const [suggestion,       setSuggestion]       = useState(null)
  const [suggestLoading,   setSuggestLoading]   = useState(false)
  const [suggestError,     setSuggestError]     = useState(null)
  const [suggestAnomalies, setSuggestAnomalies] = useState([])
  const [suggestDismissed, setSuggestDismissed] = useState(false)

  const autoRef      = useRef(null)
  const countRef     = useRef(null)
  const consoleRef   = useRef(null)
  const predsRef     = useRef([])

  // ── fetch status ────────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/model/status')
      setStatus(await r.json())
    } catch {}
  }, [])

  const fetchHistory = useCallback(async () => {
    try {
      const r = await fetch('/api/model/history?limit=60')
      const j = await r.json()
      setHistory(j.history || [])
    } catch {}
  }, [])

  useEffect(() => {
    fetchStatus()
    fetchHistory()
  }, [fetchStatus, fetchHistory])

  // auto-scroll console
  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight
  }, [trainLogs])

  // ── generate suggestion ────────────────────────────────────────────────────
  const generateSuggestion = useCallback(async (preds) => {
    setSuggestLoading(true)
    setSuggestError(null)
    setSuggestion(null)
    try {
      const r = await fetch('/api/suggestions/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ predictions: preds }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`)
      setSuggestion(j.suggestion)
      setSuggestAnomalies(j.anomalies || [])
    } catch (e) {
      setSuggestError(e.message)
    } finally {
      setSuggestLoading(false)
    }
  }, [])

  // ── analyze ────────────────────────────────────────────────────────────────
  const analyzeNow = useCallback(async () => {
    if (analyzing) return
    setAnalyzing(true)
    try {
      const r = await fetch('/api/model/predict/current', { method: 'POST' })
      if (!r.ok) { const e = await r.json(); throw new Error(e.detail || r.statusText) }
      const j = await r.json()
      const preds = j.predictions || []
      setPredictions(preds)
      predsRef.current = preds
      setHistory(prev => [...preds, ...prev].slice(0, 60))
      localStorage.setItem('lastPredictions', JSON.stringify(preds))

      // Déclencher la suggestion automatiquement si anomalie détectée
      const hasAnomaly = preds.some(p => p.is_anomaly)
      if (hasAnomaly) {
        setSuggestDismissed(false)
        generateSuggestion(preds)
      } else {
        // Tout normal : cacher la suggestion précédente
        setSuggestDismissed(true)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setAnalyzing(false)
    }
  }, [analyzing, generateSuggestion])

  // ── auto-analyze ───────────────────────────────────────────────────────────
  useEffect(() => {
    clearInterval(autoRef.current)
    clearInterval(countRef.current)
    if (!autoActive) { setCountdown(0); return }

    analyzeNow()
    setCountdown(autoInterval)

    autoRef.current  = setInterval(analyzeNow, autoInterval * 1000)
    countRef.current = setInterval(() => setCountdown(c => c <= 1 ? autoInterval : c - 1), 1000)

    return () => {
      clearInterval(autoRef.current)
      clearInterval(countRef.current)
    }
  }, [autoActive, autoInterval])

  // ── train ──────────────────────────────────────────────────────────────────
  async function startTraining() {
    if (training) return
    setTraining(true)
    setShowConsole(true)
    setTrainLogs([])
    try {
      const res = await fetch('/api/model/train', { method: 'POST' })
      const reader = res.body.getReader()
      const dec    = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          try {
            const { type, message } = JSON.parse(line.slice(5).trim())
            if (type === 'done') { fetchStatus(); break }
            if (type !== 'ping') setTrainLogs(prev => [...prev, { type, message }])
          } catch {}
        }
      }
    } catch (e) {
      setTrainLogs(prev => [...prev, { type: 'error', message: String(e) }])
    } finally {
      setTraining(false)
      fetchStatus()
    }
  }

  // ── derived ────────────────────────────────────────────────────────────────
  const fi         = status?.feature_importance || {}
  const fiSorted   = Object.entries(fi).sort(([, a], [, b]) => b - a)
  const maxFi      = fiSorted[0]?.[1] || 1
  const anomalies  = predictions.filter(p => p.is_anomaly).length
  const histAnomalies = history.filter(h => h.is_anomaly).length

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">

      {/* ── Page title ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-violet-600/20 border border-violet-500/30 rounded-xl flex items-center justify-center">
          <BrainCircuit size={18} className="text-violet-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Analyse par Random Forest</h1>
          <p className="text-sm text-slate-500">Détection d'anomalies sur les métriques en temps réel</p>
        </div>
      </div>

      {/* ── Stat cards ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={BrainCircuit}
          label="Modèle"
          value={status?.trained ? 'Entraîné' : 'Non entraîné'}
          sub={status?.trained_at ? `Le ${fmtTime(status.trained_at)}` : 'Lancez l\'entraînement'}
          color={status?.trained ? 'emerald' : 'indigo'}
        />
        <StatCard
          icon={Activity}
          label="Accuracy"
          value={status?.trained ? fmtPct(status.accuracy) : '—'}
          sub={status?.n_samples ? `sur ${status.n_samples} échantillons` : 'dataset.csv requis'}
          color="violet"
        />
        <StatCard
          icon={TrendingUp}
          label="Dataset"
          value={status?.dataset?.rows ?? 0}
          sub="lignes dans dataset.csv"
          color="amber"
        />
        <StatCard
          icon={AlertTriangle}
          label="Anomalies détectées"
          value={histAnomalies}
          sub={`sur ${history.length} prédictions`}
          color={histAnomalies > 0 ? 'amber' : 'emerald'}
        />
      </div>

      {!status?.available && (
        <div className="card p-4 border border-red-500/30 bg-red-900/10 text-red-300 text-sm">
          scikit-learn non installé — <code className="bg-slate-800 px-1 rounded">pip install scikit-learn pandas numpy</code>
        </div>
      )}

      {/* ── Main grid ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

        {/* Left — Model panel */}
        <div className="lg:col-span-2 space-y-4">

          {/* Train card */}
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
              <BrainCircuit size={14} className="text-violet-400" />
              Entraînement du modèle
            </h2>

            <button
              onClick={startTraining}
              disabled={training || !status?.available}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg
                         bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed
                         text-white font-medium text-sm transition-colors"
            >
              {training
                ? <><Loader2 size={14} className="animate-spin" /> Entraînement en cours…</>
                : <><Play size={14} /> {status?.trained ? 'Ré-entraîner le modèle' : 'Entraîner le modèle'}</>
              }
            </button>

            {/* Console toggle */}
            {trainLogs.length > 0 && (
              <button
                onClick={() => setShowConsole(v => !v)}
                className="mt-2 w-full text-xs text-slate-500 hover:text-slate-300 flex items-center justify-center gap-1"
              >
                {showConsole ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                {showConsole ? 'Masquer' : 'Afficher'} les logs ({trainLogs.length})
              </button>
            )}

            {showConsole && trainLogs.length > 0 && (
              <div
                ref={consoleRef}
                className="mt-3 bg-slate-950 rounded-lg p-3 font-mono text-[11px] space-y-0.5 max-h-44 overflow-y-auto border border-slate-800"
              >
                {trainLogs.map((l, i) => (
                  <div key={i} className={LOG_STYLE[l.type] || 'text-slate-300'}>
                    <span className="text-slate-600 mr-2">{'>'}</span>{l.message}
                  </div>
                ))}
                {training && (
                  <div className="text-slate-500 flex items-center gap-1">
                    <Loader2 size={10} className="animate-spin" /> en attente…
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Feature importance */}
          {fiSorted.length > 0 && (
            <div className="card p-5">
              <h2 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <TrendingUp size={14} className="text-indigo-400" />
                Importance des features
              </h2>
              <div className="space-y-0.5">
                {fiSorted.map(([name, val]) => (
                  <FeatureBar key={name} name={name} value={val} max={maxFi} />
                ))}
              </div>
            </div>
          )}

          {/* Per-class report */}
          {status?.trained && status?.report && status?.labels?.length > 0 && (
            <div className="card p-5">
              <h2 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <CheckCircle2 size={14} className="text-emerald-400" />
                Performance par classe
              </h2>
              <ReportTable report={status.report} labels={status.labels} />
            </div>
          )}
        </div>

        {/* Right — Live analysis */}
        <div className="lg:col-span-3 space-y-4">

          {/* Controls */}
          <div className="card p-4 flex flex-wrap items-center gap-3">
            <button
              onClick={analyzeNow}
              disabled={analyzing || !status?.trained}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500
                         disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
            >
              {analyzing
                ? <><Loader2 size={13} className="animate-spin" /> Analyse…</>
                : <><RefreshCw size={13} /> Analyser maintenant</>
              }
            </button>

            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-slate-500">Auto :</span>
              <select
                value={autoInterval}
                onChange={e => setAutoInterval(Number(e.target.value))}
                disabled={autoActive}
                className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-indigo-500"
              >
                <option value={10}>10 s</option>
                <option value={30}>30 s</option>
                <option value={60}>60 s</option>
                <option value={120}>2 min</option>
              </select>
              <button
                onClick={() => setAutoActive(v => !v)}
                disabled={!status?.trained}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                  ${autoActive
                    ? 'bg-emerald-700/40 text-emerald-300 border border-emerald-600/40 hover:bg-emerald-700/60'
                    : 'bg-slate-700 text-slate-300 border border-slate-600 hover:bg-slate-600'
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                <Timer size={11} />
                {autoActive ? `Actif (${countdown}s)` : 'Désactivé'}
              </button>
            </div>
          </div>

          {/* Service prediction cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {['service-a', 'service-b', 'service-c'].map(svc => (
              <ServiceCard
                key={svc}
                pred={predictions.find(p => p.service === svc)}
              />
            ))}
          </div>

          {/* Anomaly summary */}
          {predictions.length > 0 && (
            <div className={`card p-4 border flex items-center gap-3 ${
              anomalies > 0
                ? 'border-red-500/30 bg-red-900/10'
                : 'border-emerald-500/30 bg-emerald-900/10'
            }`}>
              {anomalies > 0
                ? <AlertTriangle size={18} className="text-red-400 flex-shrink-0" />
                : <CheckCircle2 size={18} className="text-emerald-400 flex-shrink-0" />
              }
              <div className="flex-1">
                <div className={`font-semibold text-sm ${anomalies > 0 ? 'text-red-300' : 'text-emerald-300'}`}>
                  {anomalies > 0
                    ? `${anomalies} anomalie${anomalies > 1 ? 's' : ''} détectée${anomalies > 1 ? 's' : ''}`
                    : 'Tous les services sont normaux'
                  }
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {predictions.map(p => {
                    const a = ANOMALY[p.prediction] || ANOMALY.normal
                    return `${p.service}: ${a.label}`
                  }).join(' · ')}
                </div>
              </div>
              {/* Bouton suggestion manuelle */}
              {anomalies > 0 && suggestDismissed && (
                <button
                  onClick={() => { setSuggestDismissed(false); generateSuggestion(predsRef.current) }}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg
                             bg-violet-900/40 border border-violet-600/40 text-violet-300
                             hover:bg-violet-900/60 transition-colors flex-shrink-0"
                >
                  <Sparkles size={11} />
                  Suggestion IA
                </button>
              )}
            </div>
          )}

          {/* ── Suggestion IA ── */}
          {!suggestDismissed && (suggestLoading || suggestion || suggestError) && (
            <SuggestionPanel
              suggestion={suggestion}
              loading={suggestLoading}
              error={suggestError}
              anomalies={suggestAnomalies}
              onDismiss={() => setSuggestDismissed(true)}
              onRegenerate={() => generateSuggestion(predsRef.current)}
            />
          )}
        </div>
      </div>

      {/* ── History ──────────────────────────────────────────────────────── */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
            <Clock size={14} className="text-slate-400" />
            Historique des prédictions
            <span className="text-xs text-slate-600 font-normal">({history.length} entrées)</span>
          </h2>
          <button
            onClick={fetchHistory}
            className="text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1 transition-colors"
          >
            <RefreshCw size={10} /> Actualiser
          </button>
        </div>
        <div style={{ maxHeight: '340px', overflowY: 'auto' }}>
          <HistoryTable history={history} />
        </div>
      </div>
    </div>
  )
}
