import { useState } from 'react'
import { X, Layers, Loader2, CheckCircle, AlertCircle } from 'lucide-react'

export default function ScaleModal({ service, composePath, onClose }) {
  const [replicas, setReplicas] = useState(2)
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState(null) // { success, message }

  const handleScale = async () => {
    setLoading(true)
    setResult(null)
    try {
      const res  = await fetch('/api/docker/scale', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ compose_path: composePath, service, replicas }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setResult({
        success: data.success,
        message: data.success
          ? `${service} mis à l'échelle à ${replicas} réplica(s) avec succès.`
          : data.stderr || data.stdout || 'Erreur inconnue',
      })
    } catch (e) {
      setResult({ success: false, message: e.message })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-40"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-slate-800 border border-slate-600 rounded-2xl shadow-2xl w-full max-w-md">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
            <div className="flex items-center gap-2 font-semibold text-white">
              <Layers size={18} className="text-indigo-400" />
              Scale — {service}
            </div>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 p-1 rounded-lg hover:bg-slate-700 transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          {/* Body */}
          <div className="px-6 py-5 space-y-5">
            <p className="text-slate-400 text-sm">
              Ajustez le nombre d&apos;instances de <span className="text-indigo-300 font-semibold">{service}</span>.
              La commande <code className="text-xs bg-slate-700 px-1.5 py-0.5 rounded">docker compose scale</code> sera exécutée.
            </p>

            <div className="space-y-2">
              <label className="text-sm text-slate-300 font-medium">
                Nombre de réplicas
              </label>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setReplicas(r => Math.max(1, r - 1))}
                  className="w-9 h-9 rounded-lg bg-slate-700 hover:bg-slate-600 text-white font-bold transition-colors"
                >
                  −
                </button>
                <input
                  type="number"
                  min={1} max={10}
                  value={replicas}
                  onChange={e => setReplicas(Math.min(10, Math.max(1, parseInt(e.target.value) || 1)))}
                  className="w-20 text-center text-input"
                />
                <button
                  onClick={() => setReplicas(r => Math.min(10, r + 1))}
                  className="w-9 h-9 rounded-lg bg-slate-700 hover:bg-slate-600 text-white font-bold transition-colors"
                >
                  +
                </button>
                <span className="text-slate-400 text-sm">instance{replicas > 1 ? 's' : ''}</span>
              </div>
            </div>

            {/* Result */}
            {result && (
              <div className={`flex items-start gap-2 text-sm px-4 py-3 rounded-xl border
                ${result.success
                  ? 'bg-emerald-900/30 border-emerald-700/50 text-emerald-300'
                  : 'bg-red-900/30 border-red-700/50 text-red-300'}`}
              >
                {result.success
                  ? <CheckCircle size={15} className="mt-0.5 flex-shrink-0" />
                  : <AlertCircle size={15} className="mt-0.5 flex-shrink-0" />}
                {result.message}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex gap-3 px-6 py-4 border-t border-slate-700">
            <button onClick={onClose} className="btn-secondary flex-1">
              {result?.success ? 'Fermer' : 'Annuler'}
            </button>
            {!result?.success && (
              <button
                onClick={handleScale}
                disabled={loading}
                className="btn-primary flex-1 justify-center"
              >
                {loading
                  ? <><Loader2 size={14} className="animate-spin" /> Scaling…</>
                  : <><Layers size={14} /> Appliquer</>}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
