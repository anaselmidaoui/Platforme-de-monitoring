import { useState, useEffect, useRef, useCallback } from 'react'
import { ScrollText, Filter, WifiOff, Loader2, ChevronDown, ChevronRight } from 'lucide-react'

const LEVELS = ['ALL', 'ERROR', 'WARN', 'INFO']

const LEVEL_COLORS = {
  ERROR: { row: 'border-l-red-500 bg-red-950/20 hover:bg-red-950/30',   badge: 'bg-red-900/60 text-red-300 border-red-700/50',    text: 'text-red-300'    },
  WARN:  { row: 'border-l-yellow-500 bg-yellow-950/20 hover:bg-yellow-950/30', badge: 'bg-yellow-900/60 text-yellow-300 border-yellow-700/50', text: 'text-yellow-300' },
  INFO:  { row: 'border-l-slate-600 hover:bg-slate-800/40',              badge: 'bg-slate-700/60 text-slate-300 border-slate-600/50',  text: 'text-slate-300'  },
  DEBUG: { row: 'border-l-slate-700 hover:bg-slate-800/30',              badge: 'bg-slate-800/60 text-slate-400 border-slate-700/50',  text: 'text-slate-400'  },
}

function parseLog(raw) {
  try {
    const obj = JSON.parse(raw)
    const level = (obj.level || obj.severity || 'INFO').toUpperCase()
    return {
      level,
      msg:    obj.msg || obj.message || obj.MESSAGE || raw,
      logger: obj.logger || obj.class || '',
      ts:     obj.ts || obj.timestamp || obj['@timestamp'] || '',
      traceId: obj.traceId || '',
      spanId:  obj.spanId  || '',
      raw:    obj,
    }
  } catch {
    return { level: 'INFO', msg: raw, logger: '', ts: '', traceId: '', spanId: '', raw: {} }
  }
}

function fmtTime(tsNs, tsStr) {
  if (tsStr) {
    try {
      const d = new Date(tsStr)
      return d.toLocaleTimeString('fr-FR', { hour12: false }) +
        '.' + String(d.getMilliseconds()).padStart(3, '0')
    } catch {}
  }
  if (tsNs) {
    const d = new Date(parseInt(tsNs) / 1_000_000)
    return d.toLocaleTimeString('fr-FR', { hour12: false }) +
      '.' + String(d.getMilliseconds()).padStart(3, '0')
  }
  return '--:--:--'
}

function LogRow({ log }) {
  const [expanded, setExpanded] = useState(false)
  const c = LEVEL_COLORS[log.level] || LEVEL_COLORS.INFO

  const fields = Object.entries(log.raw).filter(
    ([k]) => !['msg', 'message', 'level', 'severity'].includes(k)
  )

  return (
    <div className={`border-l-2 ${c.row} transition-colors cursor-pointer select-none`}
         onClick={() => setExpanded(e => !e)}>
      {/* Main row */}
      <div className="flex items-start gap-2 px-3 py-1.5 font-mono text-xs">
        <span className="text-slate-500 flex-shrink-0 w-24 tabular-nums">
          {log.time}
        </span>
        <span className={`flex-shrink-0 w-[42px] text-center text-[10px] font-bold px-1 py-0 rounded border ${c.badge}`}>
          {log.level}
        </span>
        {expanded
          ? <ChevronDown size={11} className="flex-shrink-0 mt-0.5 text-slate-500" />
          : <ChevronRight size={11} className="flex-shrink-0 mt-0.5 text-slate-500" />
        }
        <span className={`break-all leading-relaxed ${c.text}`}>{log.msg}</span>
      </div>

      {/* Expanded details */}
      {expanded && fields.length > 0 && (
        <div className="px-4 pb-2 pt-0 ml-[68px] space-y-0.5">
          {fields.map(([k, v]) => v !== '' && v !== null && (
            <div key={k} className="flex gap-2 text-[11px] font-mono">
              <span className="text-slate-500 flex-shrink-0 min-w-[72px]">{k}</span>
              <span className="text-slate-300 break-all">{String(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function LogStream({ service, rangeMins }) {
  const [logs,    setLogs]    = useState([])
  const [filter,  setFilter]  = useState('ALL')
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const bottomRef    = useRef(null)
  const autoScroll   = useRef(true)
  const containerRef = useRef(null)

  const fetchLogs = useCallback(async () => {
    if (!service) return
    const lokiQuery = `{service_name="${service}"}`
    try {
      const res = await fetch(
        `/api/metrics/loki?query=${encodeURIComponent(lokiQuery)}&range_minutes=${rangeMins}&limit=200`
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json  = await res.json()
      const items = []
      for (const stream of (json?.data?.result || [])) {
        for (const [tsNs, line] of (stream.values || [])) {
          const parsed = parseLog(line)
          items.push({
            id:    tsNs,
            time:  fmtTime(tsNs, parsed.ts),
            level: parsed.level,
            msg:   parsed.msg,
            raw:   parsed.raw,
          })
        }
      }
      items.sort((a, b) => a.id.localeCompare(b.id))
      setLogs(items)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [service, rangeMins])

  useEffect(() => {
    setLoading(true)
    setLogs([])
    fetchLogs()
    const id = setInterval(fetchLogs, 5_000)
    return () => clearInterval(id)
  }, [fetchLogs])

  useEffect(() => {
    if (autoScroll.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs])

  const handleScroll = () => {
    const el = containerRef.current
    if (!el) return
    autoScroll.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20
  }

  const visible = filter === 'ALL' ? logs : logs.filter(l => l.level === filter)
  const counts  = { ERROR: 0, WARN: 0, INFO: 0 }
  logs.forEach(l => { counts[l.level] = (counts[l.level] || 0) + 1 })

  return (
    <div className="card flex flex-col overflow-hidden" style={{ gridColumn: 'span 1' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-700 flex-shrink-0">
        <ScrollText size={13} className="text-violet-400 flex-shrink-0" />
        <span className="text-slate-300 font-semibold text-sm">Logs — {service}</span>
        {loading && <Loader2 size={11} className="animate-spin text-slate-500" />}

        <div className="flex gap-1 ml-auto">
          {counts.ERROR > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border bg-red-900/50 text-red-300 border-red-800/50 font-mono font-bold">
              {counts.ERROR} ERR
            </span>
          )}
          {counts.WARN > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border bg-yellow-900/50 text-yellow-300 border-yellow-800/50 font-mono font-bold">
              {counts.WARN} WRN
            </span>
          )}
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-slate-700/50 flex-shrink-0 bg-slate-900/50">
        <Filter size={10} className="text-slate-500 mr-1" />
        {LEVELS.map(lvl => (
          <button
            key={lvl}
            onClick={() => setFilter(lvl)}
            className={`text-[11px] px-2.5 py-0.5 rounded transition-colors font-medium ${
              filter === lvl
                ? 'bg-indigo-600/30 text-indigo-300 ring-1 ring-indigo-500/40'
                : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
            }`}
          >
            {lvl}
            {lvl !== 'ALL' && counts[lvl] > 0 && (
              <span className="ml-1 opacity-60">{counts[lvl]}</span>
            )}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-slate-600 tabular-nums">
          {visible.length} ligne{visible.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Log list */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-slate-950 min-h-0"
        style={{ height: '260px' }}
      >
        {error ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-slate-600 p-4">
            <WifiOff size={20} />
            <p className="text-xs text-center">Loki inaccessible</p>
          </div>
        ) : visible.length === 0 && !loading ? (
          <div className="h-full flex items-center justify-center text-slate-600 text-xs">
            Aucun log disponible
          </div>
        ) : (
          <div className="divide-y divide-slate-800/50">
            {visible.map(log => <LogRow key={log.id} log={log} />)}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  )
}
