import { useState, useRef, useEffect, useCallback } from 'react'
import { FolderOpen, Search, Play, CheckCircle, XCircle, AlertCircle, Loader2, Terminal } from 'lucide-react'

const LOG_COLORS = {
  info:    'text-blue-300',
  log:     'text-slate-300',
  success: 'text-emerald-400 font-semibold',
  error:   'text-red-400 font-semibold',
  ping:    'hidden',
  done:    'hidden',
}

function StatusBadge({ value, label }) {
  return value ? (
    <span className="inline-flex items-center gap-1 text-emerald-400 text-xs font-medium">
      <CheckCircle size={12} /> {label}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-slate-500 text-xs">
      <XCircle size={12} /> {label}
    </span>
  )
}

export default function SetupPage() {
  const [projectPath, setProjectPath]     = useState(() => localStorage.getItem('mp_project_path') || '')
  const [services, setServices]           = useState([])
  const [scanning, setScanning]           = useState(false)
  const [instrumenting, setInstrumenting] = useState(false)
  const [logs, setLogs]                   = useState([])
  const [scanError, setScanError]         = useState('')
  const [done, setDone]                   = useState(false)
  const logRef  = useRef(null)
  const esRef   = useRef(null)

  // Auto-scroll log console
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logs])

  const addLog = useCallback((type, message) => {
    setLogs(prev => [...prev, { type, message, id: Date.now() + Math.random() }])
  }, [])

  const handleScan = async () => {
    if (!projectPath.trim()) return
    setScanning(true)
    setScanError('')
    setServices([])

    try {
      const res  = await fetch('/api/scan', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ project_path: projectPath.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Erreur de scan')
      setServices(data.services)
      localStorage.setItem('mp_project_path', projectPath.trim())
      localStorage.setItem('mp_services', JSON.stringify(data.services))
    } catch (e) {
      setScanError(e.message)
    } finally {
      setScanning(false)
    }
  }

  const handleInstrument = () => {
    if (instrumenting) return
    setLogs([])
    setDone(false)
    setInstrumenting(true)

    if (esRef.current) esRef.current.close()

    const es = new EventSource(
      `/api/instrument?project_path=${encodeURIComponent(projectPath.trim())}`,
    )

    // EventSource doesn't support POST — we'll use fetch with streaming instead
    es.close()

    // Use fetch + ReadableStream for POST SSE
    setInstrumenting(true)
    fetch('/api/instrument', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ project_path: projectPath.trim() }),
    }).then(async (res) => {
      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer    = ''

      while (true) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const evt = JSON.parse(line.slice(6))
              addLog(evt.type, evt.message)
              if (evt.type === 'done') {
                setInstrumenting(false)
                setDone(true)
                return
              }
            } catch { /* ignore malformed line */ }
          }
        }
      }
      setInstrumenting(false)
    }).catch((e) => {
      addLog('error', e.message)
      setInstrumenting(false)
    })
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleScan()
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-10 space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Configuration &amp; Initialisation</h1>
        <p className="text-slate-400 text-sm mt-1">
          Scannez votre projet Spring Boot, vérifiez les services détectés, puis lancez
          l&apos;instrumentation en un clic.
        </p>
      </div>

      {/* Path input card */}
      <div className="card p-6 space-y-4">
        <div className="flex items-center gap-2 text-slate-300 font-semibold">
          <FolderOpen size={18} className="text-indigo-400" />
          Chemin du projet
        </div>
        <div className="flex gap-3">
          <input
            className="text-input flex-1"
            placeholder="Ex : C:\Users\anas\Desktop\PFA_final_version\app"
            value={projectPath}
            onChange={e => setProjectPath(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className="btn-primary"
            onClick={handleScan}
            disabled={scanning || !projectPath.trim()}
          >
            {scanning
              ? <><Loader2 size={15} className="animate-spin" /> Scan…</>
              : <><Search size={15} /> Scanner</>}
          </button>
        </div>
        {scanError && (
          <div className="flex items-center gap-2 text-red-400 text-sm bg-red-900/20 border border-red-800/40 rounded-xl px-4 py-3">
            <AlertCircle size={15} />
            {scanError}
          </div>
        )}
      </div>

      {/* Services table */}
      {services.length > 0 && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
            <div className="flex items-center gap-2 font-semibold text-slate-200">
              <CheckCircle size={16} className="text-emerald-400" />
              {services.length} service{services.length > 1 ? 's' : ''} détecté{services.length > 1 ? 's' : ''}
            </div>
            <button
              className="btn-primary"
              onClick={handleInstrument}
              disabled={instrumenting}
            >
              {instrumenting
                ? <><Loader2 size={15} className="animate-spin" /> Instrumentation…</>
                : <><Play size={15} /> Lancer l&apos;instrumentation et le Monitoring</>}
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-900/60">
                <tr className="text-left text-slate-400 text-xs uppercase tracking-wider">
                  <th className="px-6 py-3">Nom du service</th>
                  <th className="px-6 py-3">Package principal</th>
                  <th className="px-6 py-3">Port externe</th>
                  <th className="px-6 py-3">Port conteneur</th>
                  <th className="px-6 py-3">Actuator</th>
                  <th className="px-6 py-3">Prometheus</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {services.map(svc => (
                  <tr key={svc.name} className="hover:bg-slate-700/20 transition-colors">
                    <td className="px-6 py-3 font-semibold text-indigo-300">{svc.name}</td>
                    <td className="px-6 py-3 text-slate-400 font-mono text-xs">{svc.main_package || svc.group_id || '—'}</td>
                    <td className="px-6 py-3">
                      <span className="bg-slate-700 text-slate-200 px-2 py-0.5 rounded text-xs font-mono">
                        :{svc.external_port}
                      </span>
                    </td>
                    <td className="px-6 py-3">
                      <span className="text-slate-400 text-xs font-mono">:{svc.container_port}</span>
                    </td>
                    <td className="px-6 py-3">
                      <StatusBadge value={svc.has_actuator} label="Actuator" />
                    </td>
                    <td className="px-6 py-3">
                      <StatusBadge value={svc.has_prometheus} label="Prometheus" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Log console */}
      {logs.length > 0 && (
        <div className="card overflow-hidden">
          <div className="flex items-center gap-2 px-6 py-3 border-b border-slate-700 bg-slate-900/60">
            <Terminal size={15} className="text-slate-400" />
            <span className="text-slate-300 text-sm font-semibold">Console</span>
            {done && (
              <span className="ml-auto flex items-center gap-1.5 text-emerald-400 text-xs font-semibold">
                <CheckCircle size={13} /> Terminé
              </span>
            )}
            {instrumenting && (
              <span className="ml-auto flex items-center gap-1.5 text-indigo-400 text-xs">
                <Loader2 size={13} className="animate-spin" /> En cours…
              </span>
            )}
          </div>
          <div
            ref={logRef}
            className="h-72 overflow-y-auto p-5 font-mono text-xs leading-relaxed space-y-0.5 bg-slate-950"
          >
            {logs.map(log => (
              <div key={log.id} className={LOG_COLORS[log.type] || 'text-slate-300'}>
                {log.type === 'success' && '✓ '}
                {log.type === 'error'   && '✗ '}
                {log.type === 'info'    && '› '}
                {log.message}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Done banner → go to dashboard */}
      {done && (
        <div className="bg-emerald-900/30 border border-emerald-700/50 rounded-2xl px-6 py-5
                        flex items-center justify-between">
          <div>
            <p className="text-emerald-300 font-semibold">Stack de monitoring opérationnelle !</p>
            <p className="text-emerald-500 text-sm mt-0.5">
              Prometheus · Loki · Jaeger · Grafana sont démarrés et configurés.
            </p>
          </div>
          <a
            href="/dashboard"
            className="btn-primary bg-emerald-700 hover:bg-emerald-600"
          >
            Voir le Dashboard →
          </a>
        </div>
      )}
    </div>
  )
}
