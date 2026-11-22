import { useMemo, useRef, useState } from 'react'
import type { Candle } from '../types'

type Props = {
  candles: Candle[]
  /** 需要标注的关键日期（顶/底点） */
  highlightDate?: string
  /** 关键点类型，决定标注颜色与文案 */
  highlightType?: 'high' | 'low'
  /** 图表高度（viewBox 单位） */
  height?: number
  /** 是否显示成交量副图 */
  showVolume?: boolean
}

const VIEW_WIDTH = 640
const PADDING = { top: 18, right: 52, bottom: 24, left: 8 }

const fmt = (value: number | null, digits = 2) =>
  value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits)

/**
 * 通用日线蜡烛图（内联 SVG）。
 * 红涨绿跌，顶部标注关键顶/底点，横轴按年月打点，支持鼠标悬停查看 OHLC。
 */
export const CandlestickChart = ({
  candles,
  highlightDate,
  highlightType,
  height = 220,
  showVolume = false,
}: Props) => {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  const priceHeight = showVolume ? height * 0.76 : height
  const volumeTop = priceHeight + 8
  const volumeHeight = height - volumeTop - 4

  const scale = useMemo(() => {
    const highs = candles
      .map((c) => c.high ?? c.close)
      .filter((v): v is number => typeof v === 'number' && v > 0)
    const lows = candles
      .map((c) => c.low ?? c.close)
      .filter((v): v is number => typeof v === 'number' && v > 0)
    if (highs.length === 0 || lows.length === 0) return null
    let min = Math.min(...lows)
    let max = Math.max(...highs)
    if (max === min) {
      max = min * 1.05
      min = min * 0.95
    }
    const span = max - min
    min -= span * 0.06
    max += span * 0.06
    return { min, max }
  }, [candles])

  const maxVolume = useMemo(
    () =>
      candles.reduce(
        (acc, c) => (typeof c.volume === 'number' && c.volume > acc ? c.volume : acc),
        0,
      ),
    [candles],
  )

  // 横轴：按“年-月”切换打点
  const xTicks = useMemo(() => {
    const ticks: { index: number; label: string }[] = []
    let last = ''
    candles.forEach((candle, index) => {
      const month = candle.date.slice(0, 7)
      if (month !== last) {
        ticks.push({ index, label: candle.date.slice(2, 7) })
        last = month
      }
    })
    // 月份点太密时只保留每年首个
    if (ticks.length > 12) {
      let lastYear = ''
      return ticks.filter((tick) => {
        const year = candles[tick.index].date.slice(0, 4)
        if (year !== lastYear) {
          lastYear = year
          return true
        }
        return false
      })
    }
    return ticks
  }, [candles])

  if (scale === null || candles.length === 0) {
    return <p className="helper-text">暂无 K 线数据。</p>
  }

  const count = candles.length
  const innerWidth = VIEW_WIDTH - PADDING.left - PADDING.right
  const innerHeight = priceHeight - PADDING.top - PADDING.bottom
  const step = innerWidth / count
  const bodyWidth = Math.max(1, Math.min(step * 0.68, 9))

  const toX = (index: number) => PADDING.left + step * (index + 0.5)
  const toY = (value: number) =>
    PADDING.top + (1 - (value - scale.min) / (scale.max - scale.min)) * innerHeight

  const highlightIndex = highlightDate
    ? candles.findIndex((candle) => candle.date === highlightDate)
    : -1

  const handleMove = (event: React.MouseEvent<SVGRectElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const svgX = ((event.clientX - rect.left) / rect.width) * VIEW_WIDTH
    const index = Math.floor((svgX - PADDING.left) / step)
    setHoverIndex(Math.min(count - 1, Math.max(0, index)))
  }

  const hover = hoverIndex === null ? null : candles[hoverIndex]

  return (
    <div className="candle-chart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
        role="img"
        aria-label="指数 K 线图"
      >
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
                className="candle-grid"
              />
              <text x={VIEW_WIDTH - PADDING.right + 6} y={y + 4} className="candle-axis">
                {value.toFixed(0)}
              </text>
            </g>
          )
        })}

        {candles.map((candle, index) => {
          const open = candle.open ?? candle.close
          const close = candle.close ?? candle.open
          const high = candle.high ?? Math.max(open ?? 0, close ?? 0)
          const low = candle.low ?? Math.min(open ?? 0, close ?? 0)
          if (open === null || close === null || high === null || low === null) return null
          const up = close >= open
          const x = toX(index)
          const colorClass = up ? 'candle-up' : 'candle-down'
          const yHigh = toY(high)
          const yLow = toY(low)
          const yOpen = toY(open)
          const yClose = toY(close)
          const bodyTop = Math.min(yOpen, yClose)
          const bodyHeight = Math.max(1, Math.abs(yClose - yOpen))
          return (
            <g key={candle.date} className={colorClass}>
              <line x1={x} y1={yHigh} x2={x} y2={yLow} className="candle-wick" />
              <rect
                x={x - bodyWidth / 2}
                y={bodyTop}
                width={bodyWidth}
                height={bodyHeight}
                className="candle-body"
              />
            </g>
          )
        })}

        {showVolume &&
          maxVolume > 0 &&
          candles.map((candle, index) => {
            if (typeof candle.volume !== 'number' || candle.volume <= 0) return null
            const open = candle.open ?? 0
            const close = candle.close ?? 0
            const barHeight = (candle.volume / maxVolume) * volumeHeight
            return (
              <rect
                key={`v-${candle.date}`}
                x={toX(index) - bodyWidth / 2}
                y={volumeTop + volumeHeight - barHeight}
                width={bodyWidth}
                height={barHeight}
                className={close >= open ? 'candle-vol up' : 'candle-vol down'}
              />
            )
          })}

        {xTicks.map((tick) => (
          <text
            key={tick.label}
            x={toX(tick.index)}
            y={height - 6}
            className="candle-axis"
            textAnchor="middle"
          >
            {tick.label}
          </text>
        ))}

        {highlightIndex >= 0 && (
          <g>
            <line
              x1={toX(highlightIndex)}
              y1={PADDING.top}
              x2={toX(highlightIndex)}
              y2={PADDING.top + innerHeight}
              className={highlightType === 'low' ? 'candle-mark low' : 'candle-mark high'}
            />
            <circle
              cx={toX(highlightIndex)}
              cy={
                highlightType === 'low'
                  ? toY(candles[highlightIndex].low ?? 0)
                  : toY(candles[highlightIndex].high ?? 0)
              }
              r={4}
              className={highlightType === 'low' ? 'candle-mark-dot low' : 'candle-mark-dot high'}
            />
          </g>
        )}

        {hoverIndex !== null && (
          <line
            x1={toX(hoverIndex)}
            y1={PADDING.top}
            x2={toX(hoverIndex)}
            y2={PADDING.top + innerHeight}
            className="candle-hover-line"
          />
        )}

        <rect
          x={PADDING.left}
          y={PADDING.top}
          width={innerWidth}
          height={innerHeight}
          fill="transparent"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
        />
      </svg>

      {hover && (
        <div className="candle-tooltip">
          <span>{hover.date}</span>
          <strong>
            开 {fmt(hover.open)} 高 {fmt(hover.high)}
          </strong>
          <strong>
            低 {fmt(hover.low)} 收 {fmt(hover.close)}
          </strong>
        </div>
      )}
    </div>
  )
}
