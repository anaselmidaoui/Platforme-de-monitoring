import { useState, useEffect, useCallback } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Loader2, WifiOff, TrendingUp } from 'lucide-react'

function transformPrometheus(data, decimals = 3) {
  const result = data?.data?.result || []
  if (!result.length) return []
  const values = result[0]?.values || []
  return values.map(([ts, val]) => ({
    time: new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    value: parseFloat(parseFloat(val).toFixed(decimals)),
  }))
}

const STEP_FOR_RANGE = { 5: '15s', 60: '30s', 1440: '5m' }

const TooltipContent = ({ active, payload, label, unit }) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-xs shadow-xl">
      <p className="text-slate-400 mb-1">{label}</p>
      <p className="text-white font-semibold">
        {payload[0].value?.toFixed(3)} <span className="text-slate-400">{unit}</span>
      </p>
    </div>
  )
}

export default function MetricCard({ title, icon: Icon, query, unit, color, chartType = 'area', service, rangeMins }) {
  const [data, setData]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  const fetchData = useCallback(async () => {
    if (!service) return
    const resolvedQuery = typeof query === 'function' ? query(service) : query
    const step          = STEP_FOR_RANGE[rangeMins] || '30s'

    try {
      const res  = await fetch(
        `/api/metrics/range?query=${encodeURIComponent(resolvedQuery)}&range_minutes=${rangeMins}&step=${step}`
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const pts  = transformPrometheus(json)
      setData(pts)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [query, service, rangeMins])

  useEffect(() => {
    setLoading(true)
    setData([])
    fetchData()
    const id = setInterval(fetchData, 30_000)
    return () => clearInterval(id)
  }, [fetchData])

  const hasData = data.length > 0 && data.some(d => !isNaN(d.value))
  const latest  = hasData ? data[data.length - 1]?.value : null

  return (
    <div className="card p-5 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-slate-300 font-semibold text-sm">
          {Icon && <Icon size={15} style={{ color }} />}
          {title}
        </div>
        {loading && <Loader2 size={13} className="animate-spin text-slate-500" />}
        {!loading && latest !== null && (
          <span className="text-xs font-mono font-bold" style={{ color }}>
            {latest.toFixed(3)} {unit}
          </span>
        )}
      </div>

      {/* Chart */}
      <div className="h-36">
        {error ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-slate-500">
            <WifiOff size={22} />
            <p className="text-xs text-center">Prometheus inaccessible</p>
          </div>
        ) : !hasData && !loading ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-slate-600">
            <TrendingUp size={22} />
            <p className="text-xs">Aucune donnée</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {chartType === 'line' ? (
              <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="time"
                  tick={{ fill: '#64748b', fontSize: 9 }}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fill: '#64748b', fontSize: 9 }}
                  tickLine={false}
                  axisLine={false}
                  width={38}
                />
                <Tooltip content={<TooltipContent unit={unit} />} />
                <Line
                  type="monotone" dataKey="value" stroke={color}
                  strokeWidth={2} dot={false} isAnimationActive={false}
                />
              </LineChart>
            ) : (
              <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id={`grad-${title}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={color} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={color} stopOpacity={0}    />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="time"
                  tick={{ fill: '#64748b', fontSize: 9 }}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fill: '#64748b', fontSize: 9 }}
                  tickLine={false}
                  axisLine={false}
                  width={38}
                />
                <Tooltip content={<TooltipContent unit={unit} />} />
                <Area
                  type="monotone" dataKey="value" stroke={color} strokeWidth={2}
                  fill={`url(#grad-${title})`} isAnimationActive={false}
                />
              </AreaChart>
            )}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
