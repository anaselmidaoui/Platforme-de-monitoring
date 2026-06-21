import { useState, useEffect, useRef, useCallback } from 'react'

const SERVICES = [
  { id: 'service-a', name: 'Service A', url: 'http://localhost:8081', accent: 'blue' },
  { id: 'service-b', name: 'Service B', url: 'http://localhost:8082', accent: 'violet' },
  { id: 'service-c', name: 'Service C', url: 'http://localhost:8083', accent: 'emerald' },
]

const ACCENT = {
  blue:    { border: 'border-blue-500',    hdr: 'from-blue-900/40',    btn: 'bg-blue-600 hover:bg-blue-500' },
  violet:  { border: 'border-violet-500',  hdr: 'from-violet-900/40',  btn: 'bg-violet-600 hover:bg-violet-500' },
  emerald: { border: 'border-emerald-500', hdr: 'from-emerald-900/40', btn: 'bg-emerald-600 hover:bg-emerald-500' },
}

function Toggle({ on, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`relative w-14 h-7 rounded-full transition-colors duration-200 focus:outline-none
        ${on ? 'bg-red-500' : 'bg-slate-600'}
        ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow-md
        transition-transform duration-200 ${on ? 'translate-x-7' : 'translate-x-0'}`} />
    </button>
  )
}

function StatBadge({ label, value, color }) {
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${color}`}>
      <span>{label}</span>
      <span className="font-bold">{value}</span>
    </div>
  )
}

function Row({ label, desc, children }) {
  return (
    <div className="bg-slate-700/50 rounded-xl px-4 py-3 flex items-center justify-between">
      <div>
        <p className="text-sm font-semibold text-slate-200">{label}</p>
        <p className="text-xs text-slate-400">{desc}</p>
      </div>
      {children}
    </div>
  )
}

function Chip({ color, label }) {
  const colors = {
    red:    'bg-red-500/20 text-red-300 border-red-500/30',
    orange: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
    yellow: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
    pink:   'bg-pink-500/20 text-pink-300 border-pink-500/30',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium animate-pulse ${colors[color]}`}>
      {label}
    </span>
  )
}

// ─── Service Card ─────────────────────────────────────────────────────────────

function ServiceCard({ service }) {
  const ac = ACCENT[service.accent]

  // ── State ──
  // toggles: source de vérité locale pour l'état des chaos (jamais écrasé par un poll en conflit)
  const [toggles, setToggles]     = useState({ cpuStress: false, memoryLeak: false, errorMode: false, latencyDelay: 0 })
  const [health, setHealth]       = useState('unknown')  // 'up' | 'degraded' | 'down' | 'unknown'
  const [initialized, setInitialized] = useState(false)
  const [latencyInput, setLatencyInput] = useState('')
  const [reqCount, setReqCount]   = useState(0)
  const [errCount, setErrCount]   = useState(0)
  const [trafficOn, setTrafficOn] = useState(false)

  // ── Refs ──
  const pendingPosts  = useRef(0)  // nombre de POST en vol — empêche le poll d'écraser l'état optimiste
  const pollingActive = useRef(true)
  const trafficRef    = useRef(null)

  // ── Poll séquentiel : attend la réponse avant de reprogrammer ──
  // Évite les requêtes chevauchantes qui créent des race conditions d'état
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${service.url}/api/status`, { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const data = await res.json()
        setHealth('up')
        // Ne pas écraser l'état local s'il y a des POSTs en vol
        // (le serveur renverrait encore l'ancien état)
        if (pendingPosts.current === 0) {
          setToggles({
            cpuStress:    data.cpuStress    ?? false,
            memoryLeak:   data.memoryLeak   ?? false,
            errorMode:    data.errorMode    ?? false,
            latencyDelay: data.latencyDelay ?? 0,
          })
          setInitialized(true)
        }
      } else {
        // 5xx — service dégradé (chaos actif) mais toujours joignable → garder l'état local
        setHealth('degraded')
        setInitialized(true)
      }
    } catch {
      // Timeout / réseau — service vraiment injoignable
      setHealth('down')
      setInitialized(true)
    }
  }, [service.url])

  useEffect(() => {
    pollingActive.current = true
    let cancelled = false

    const loop = async () => {
      while (pollingActive.current && !cancelled) {
        await fetchStatus()
        // Attendre 2s APRÈS la réponse — pas d'intervalle fixe
        if (pollingActive.current && !cancelled) {
          await new Promise(r => setTimeout(r, 2000))
        }
      }
    }
    loop()

    return () => {
      pollingActive.current = false
      cancelled = true
    }
  }, [fetchStatus])

  useEffect(() => () => { if (trafficRef.current) clearInterval(trafficRef.current) }, [])

  // ── POST avec mise à jour optimiste ──
  const post = useCallback(async (path, optimisticPatch) => {
    // 1. Appliquer immédiatement en local
    setToggles(prev => ({ ...prev, ...optimisticPatch }))
    pendingPosts.current++

    try {
      const res = await fetch(`${service.url}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(6000),
      })
      if (res.ok) {
        const data = await res.json()
        // Fusionner la confirmation serveur
        setToggles(prev => ({
          ...prev,
          ...(data.cpuStress    !== undefined && { cpuStress:    data.cpuStress }),
          ...(data.memoryLeak   !== undefined && { memoryLeak:   data.memoryLeak }),
          ...(data.errorMode    !== undefined && { errorMode:    data.errorMode }),
          ...(data.latencyDelay !== undefined && { latencyDelay: data.latencyDelay }),
        }))
        setHealth('up')
      }
    } catch { /* garder l'état optimiste — le prochain poll se resynchronisera */ }
    finally {
      pendingPosts.current--
    }
  }, [service.url])

  // ── Toggle handlers ──
  const toggleCpu    = () => post(`/api/stress/cpu?active=${!toggles.cpuStress}`,     { cpuStress:  !toggles.cpuStress })
  const toggleMemory = () => post(`/api/stress/memory?active=${!toggles.memoryLeak}`, { memoryLeak: !toggles.memoryLeak })
  const toggleError  = () => post(`/api/stress/error?active=${!toggles.errorMode}`,   { errorMode:  !toggles.errorMode })

  const applyLatency = () => {
    const d = parseInt(latencyInput) || 0
    post(`/api/stress/latency?delay=${d}`, { latencyDelay: d })
  }
  const resetLatency = () => {
    setLatencyInput('0')
    post('/api/stress/latency?delay=0', { latencyDelay: 0 })
  }

  // ── Trafic automatique ──
  const toggleTraffic = () => {
    if (trafficOn) {
      clearInterval(trafficRef.current)
      setTrafficOn(false)
    } else {
      setTrafficOn(true)
      trafficRef.current = setInterval(async () => {
        try {
          const r = await fetch(`${service.url}/api/status`, { signal: AbortSignal.timeout(3000) })
          setReqCount(c => c + 1)
          if (!r.ok) setErrCount(c => c + 1)
        } catch {
          setReqCount(c => c + 1)
          setErrCount(c => c + 1)
        }
      }, 500)
    }
  }

  // ── UI helpers ──
  const isUnreachable = health === 'down'
  const uptime      = health === 'up' ? 'UP' : health === 'degraded' ? 'DÉGRADÉ' : health === 'down' ? 'DOWN' : '...'
  const uptimeColor = health === 'up' ? 'text-emerald-400' : health === 'degraded' ? 'text-orange-400' : health === 'down' ? 'text-red-400' : 'text-slate-400'

  return (
    <div className={`bg-slate-800/70 backdrop-blur rounded-2xl border border-slate-700 border-t-4 ${ac.border}
      flex flex-col overflow-hidden shadow-xl`}>

      {/* Header */}
      <div className={`bg-gradient-to-r ${ac.hdr} to-transparent px-5 py-4 flex items-center justify-between`}>
        <div>
          <h2 className="text-lg font-bold text-white tracking-wide">{service.name}</h2>
          <p className="text-xs text-slate-400 mt-0.5">{service.url}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`text-sm font-black ${uptimeColor}`}>● {uptime}</span>
          {trafficOn && <span className="text-xs text-yellow-400 animate-pulse">trafic actif</span>}
        </div>
      </div>

      {/* Controls */}
      <div className="px-5 py-4 flex flex-col gap-3 flex-1">

        <Row label="Stress CPU" desc="Boucle busy-wait — sature 1 cœur à 100%">
          <Toggle on={toggles.cpuStress} onClick={toggleCpu} disabled={isUnreachable} />
        </Row>

        <Row label="Fuite Mémoire" desc="Alloue +1 MB/100ms dans la heap JVM">
          <Toggle on={toggles.memoryLeak} onClick={toggleMemory} disabled={isUnreachable} />
        </Row>

        {/* Latency */}
        <div className="bg-slate-700/50 rounded-xl px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-sm font-semibold text-slate-200">Latence Réseau</p>
              <p className="text-xs text-slate-400">
                Thread.sleep() actuel :{' '}
                <span className="text-orange-400 font-bold">{toggles.latencyDelay} ms</span>
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <input
              type="number" min="0" placeholder="ms, ex: 2000"
              value={latencyInput}
              onChange={e => setLatencyInput(e.target.value)}
              className="w-32 bg-slate-600 text-white text-sm rounded-lg px-3 py-1.5
                border border-slate-500 focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <button
              onClick={applyLatency} disabled={isUnreachable}
              className="bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold
                px-3 py-1.5 rounded-lg disabled:opacity-40 transition-colors"
            >
              Appliquer
            </button>
            <button
              onClick={resetLatency} disabled={isUnreachable}
              className="bg-slate-600 hover:bg-slate-500 text-slate-300 text-xs
                px-3 py-1.5 rounded-lg disabled:opacity-40 transition-colors"
            >
              Reset
            </button>
          </div>
        </div>

        <Row label="Taux d'erreur 50%" desc="Retourne HTTP 500 sur ~50% des requêtes">
          <Toggle on={toggles.errorMode} onClick={toggleError} disabled={isUnreachable} />
        </Row>

        {/* Auto Traffic */}
        <div className="bg-slate-700/50 rounded-xl px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-200">Trafic Automatique</p>
              <div className="flex gap-2 mt-1">
                <StatBadge label="Req" value={reqCount} color="bg-blue-500/20 text-blue-300" />
                <StatBadge label="Err" value={errCount} color="bg-red-500/20 text-red-300" />
              </div>
            </div>
            <button
              onClick={toggleTraffic}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200
                ${trafficOn
                  ? 'bg-yellow-600 hover:bg-yellow-500 text-white ring-2 ring-yellow-400/50'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white'}`}
            >
              {trafficOn ? '⏹ Stop' : '▶ Démarrer'}
            </button>
          </div>
        </div>
      </div>

      {/* Active indicators */}
      <div className="px-5 pb-4 flex flex-wrap gap-1.5 min-h-[2rem]">
        {toggles.cpuStress        && <Chip color="red"    label="CPU actif" />}
        {toggles.memoryLeak       && <Chip color="orange" label="Mémoire fuit" />}
        {toggles.errorMode        && <Chip color="pink"   label="Erreurs 50%" />}
        {toggles.latencyDelay > 0 && <Chip color="yellow" label={`+${toggles.latencyDelay}ms`} />}
      </div>
    </div>
  )
}

// ─── Global Traffic ───────────────────────────────────────────────────────────
function GlobalTraffic() {
  const [on, setOn]       = useState(false)
  const [counts, setCounts] = useState({ a: 0, b: 0, c: 0 })
  const ref = useRef(null)

  const toggle = () => {
    if (on) {
      clearInterval(ref.current)
      setOn(false)
    } else {
      setOn(true)
      ref.current = setInterval(() => {
        SERVICES.forEach((svc, i) => {
          const key = ['a', 'b', 'c'][i]
          fetch(`${svc.url}/api/status`, { signal: AbortSignal.timeout(3000) })
            .then(() => setCounts(c => ({ ...c, [key]: c[key] + 1 })))
            .catch(() => setCounts(c => ({ ...c, [key]: c[key] + 1 })))
        })
      }, 500)
    }
  }

  useEffect(() => () => { if (ref.current) clearInterval(ref.current) }, [])

  return (
    <div className="bg-slate-800/80 border border-slate-700 rounded-2xl px-6 py-4 flex items-center justify-between">
      <div>
        <p className="text-white font-semibold">Trafic Global (tous les services)</p>
        <div className="flex gap-3 mt-1">
          {SERVICES.map((s, i) => (
            <span key={s.id} className="text-xs text-slate-400">
              {s.name}: <span className="text-white font-bold">{counts[['a','b','c'][i]]}</span> req
            </span>
          ))}
        </div>
      </div>
      <button
        onClick={toggle}
        className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all duration-200
          ${on
            ? 'bg-yellow-500 hover:bg-yellow-400 text-black ring-2 ring-yellow-300/50 animate-pulse'
            : 'bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white'}`}
      >
        {on ? '⏹ Arrêter trafic global' : '▶ Générer trafic global'}
      </button>
    </div>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white">

      <header className="sticky top-0 z-20 bg-slate-950/80 backdrop-blur border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-black tracking-tight">
              <span className="text-indigo-400">Chaos</span> Engineering Dashboard
            </h1>
            <p className="text-xs text-slate-500">PFA — Test de résilience des microservices</p>
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse inline-block" />
            Polling séquentiel /api/status
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        <GlobalTraffic />

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {SERVICES.map(svc => <ServiceCard key={svc.id} service={svc} />)}
        </div>

        <div className="bg-slate-800/50 border border-slate-700 rounded-2xl px-6 py-5">
          <h3 className="text-slate-300 font-semibold mb-4 text-sm uppercase tracking-widest">
            Guide des simulations
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-5 text-sm">
            <Guide color="text-red-400"    title="Stress CPU"
              desc="Lance une boucle busy-wait dans un thread dédié — sature un cœur CPU à 100%." />
            <Guide color="text-orange-400" title="Fuite Mémoire"
              desc="Alloue des blocs de 1 MB toutes les 100ms dans une ArrayList heap JVM." />
            <Guide color="text-yellow-400" title="Latence Réseau"
              desc="Injecte un Thread.sleep(N) sur chaque requête entrante du service." />
            <Guide color="text-pink-400"   title="Taux d'erreur 50%"
              desc="Retourne HTTP 500 de façon aléatoire sur ~50% des appels + log ERROR." />
          </div>
        </div>
      </main>
    </div>
  )
}

function Guide({ color, title, desc }) {
  return (
    <div>
      <p className={`font-bold mb-1 ${color}`}>{title}</p>
      <p className="text-slate-400 text-xs leading-relaxed">{desc}</p>
    </div>
  )
}
