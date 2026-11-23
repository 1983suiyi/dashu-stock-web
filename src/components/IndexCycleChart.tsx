import { useMemo, useRef, useState } from 'react'
import type { Candle, CyclePivot, MarketPhase } from '../types'

type Props = {
  indexName: string
  candles: Candle[]
  phases: MarketPhase[]
  pivots: CyclePivot[]
  height?: number
}

const VIEW_WIDTH = 900
const PADDING = { top: 16, right: 58, bottom: 26, left: 10 }

/**
 * 全周期指数走势总览：折线为所选指数收盘价，牛/熊阶段用底色区分，
 * 并标注每个顶底点与当前所处位置。
 */
export const IndexCycleChart = ({ indexName, candles, phases, pivots, height = 300 }: Props) => {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  const indexByDate = useMemo(() => {
    const map = new Map<string, number>()
    candles.forEach((candle, index) => map.set(candle.date, index))
    return map
  }, [candles])

  const scale = useMemo(() => {
    const closes = candles
      .map((c) => c.close)
      .filter((v): v is number => typeof v === 'number' && v > 0)
    if (closes.length === 0) return null
    let min = Math.min(...closes)
    let max = Math.max(...closes)
    const span = max - min || 1
    min -= span * 0.05
    max += span * 0.05
    return { min, max }
  }, [candles])

  const yearTicks = useMemo(() => {
    const ticks: { index: number; label: string }[] = []
    let lastYear = ''
    candles.forEach((candle, index) => {
      const year = candle.date.slice(0, 4)
      if (year !== lastYear) {
        ticks.push({ index, label: year })
        lastYear = year
      }
    })
    // 年份过多时隔年显示
    const stride = ticks.length > 14 ? 2 : 1
    return ticks.filter((_, i) => i % stride === 0)
  }, [candles])

  if (scale === null || candles.length === 0) {
    return <p className="helper-text">暂无指数数据。</p>
  }

  const count = candles.length
  const innerWidth = VIEW_WIDTH - PADDING.left - PADDING.right
  const innerHeight = height - PADDING.top - PADDING.bottom
  const toX = (index: number) =>
    PADDING.left + (count <= 1 ? 0 : (index / (count - 1)) * innerWidth)
  const toY = (value: number) =>
    PADDING.top + (1 - (value - scale.min) / (scale.max - scale.min)) * innerHeight

  const linePath = candles
    .map((candle, index) => {
      const value = candle.close
      if (typeof value !== 'number') return null
      return `${index === 0 ? 'M' : 'L'}${toX(index).toFixed(1)} ${toY(value).toFixed(1)}`
    })
    .filter((part): part is string => part !== null)
    .join(' ')

  const bands = phases.map((phase) => {
    const start = indexByDate.get(phase.startDate)
    const end = indexByDate.get(phase.endDate)
    if (start === undefined || end === undefined) return null
    return { phase, start, end }
  })

  const moveTo = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const svgX = ((clientX - rect.left) / rect.width) * VIEW_WIDTH
    const ratio = (svgX - PADDING.left) / innerWidth
    const index = Math.round(ratio * (count - 1))
    setHoverIndex(Math.min(count - 1, Math.max(0, index)))
  }

  const handleMove = (event: React.MouseEvent<SVGRectElement>) => moveTo(event.clientX)

  /** 触摸设备无法悬停，改用点按/拖动查看 */
  const handleTouch = (event: React.TouchEvent<SVGRectElement>) => {
    const touch = event.touches[0]
    if (touch) moveTo(touch.clientX)
  }

  const hover = hoverIndex === null ? null : candles[hoverIndex]
  const hoverX = hoverIndex === null ? 0 : toX(hoverIndex)
  const hoverY = hover && typeof hover.close === 'number' ? toY(hover.close) : PADDING.top

  return (
    <div className="cycle-overview">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
        role="img"
        aria-label={`${indexName}牛熊阶段总览`}
      >
        {bands.map((band) =>
          band ? (
            <rect
              key={`band-${band.phase.seq}`}
              x={toX(band.start)}
              y={PADDING.top}
              width={Math.max(1, toX(band.end) - toX(band.start))}
              height={innerHeight}
              className={`index-band ${band.phase.kind}${band.phase.ongoing ? ' ongoing' : ''}`}
            />
          ) : null,
        )}

        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = PADDING.top + ratio * innerHeight
          const value = scale.max - ratio * (scale.max - scale.min)
          return (
            <g key={ratio}>
              <line
                x1={PADDING.left}
                y1={y}
                x2={VIEW_WIDTH - PADDING.right}
                y2={y}
                className="cycle-grid"
              />
              <text x={VIEW_WIDTH - PADDING.right + 6} y={y + 4} className="cycle-axis">
                {value.toFixed(0)}
              </text>
            </g>
          )
        })}

        {yearTicks.map((tick) => (
          <text
            key={tick.label}
            x={toX(tick.index)}
            y={height - 8}
            className="cycle-axis"
            textAnchor="middle"
          >
            {tick.label}
          </text>
        ))}

        <path d={linePath} className="index-line" />

        {pivots.map((pivot) => {
          const x = toX(pivot.index)
          const y = toY(pivot.price)
          const isHigh = pivot.type === 'high'
          return (
            <g key={`${pivot.date}-${pivot.type}`}>
              <circle
                cx={x}
                cy={y}
                r={3}
                className={isHigh ? 'index-pivot-dot high' : 'index-pivot-dot low'}
              />
              <text
                x={x}
                y={isHigh ? y - 8 : y + 16}
                textAnchor="middle"
                className={isHigh ? 'index-pivot-label high' : 'index-pivot-label low'}
              >
                {isHigh ? '顶' : '底'}
                {pivot.date.slice(0, 4)}
              </text>
            </g>
          )
        })}

        {hover && (
          <g>
            <line
              x1={hoverX}
              y1={PADDING.top}
              x2={hoverX}
              y2={PADDING.top + innerHeight}
              className="cycle-hover-line"
            />
            {typeof hover.close === 'number' && (
              <circle cx={hoverX} cy={hoverY} r={3} className="cycle-hover-dot" />
            )}
          </g>
        )}

        <rect
          x={PADDING.left}
          y={PADDING.top}
          width={innerWidth}
          height={innerHeight}
          fill="transparent"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
          onTouchStart={handleTouch}
          onTouchMove={handleTouch}
        />
      </svg>

      {hover && (
        <div className="cycle-tooltip">
          <span>{hover.date}</span>
          <strong>收盘 {hover.close?.toFixed(2) ?? '—'}</strong>
          <strong>最高 {hover.high?.toFixed(2) ?? '—'}</strong>
          <strong>最低 {hover.low?.toFixed(2) ?? '—'}</strong>
        </div>
      )}
    </div>
  )
}
