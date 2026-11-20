import { useMemo, useRef, useState } from 'react'

type Point = { date: string; value: number | null }

type Props = {
  /** 指标名，如 PE(TTM) / PB(MRQ) */
  label: string
  points: Point[]
  current: number | null
  percentile: number | null
  range: { min: number | null; max: number | null }
}

const VIEW_WIDTH = 520
const VIEW_HEIGHT = 220
const PADDING = { top: 16, right: 16, bottom: 26, left: 46 }

const INNER_WIDTH = VIEW_WIDTH - PADDING.left - PADDING.right
const INNER_HEIGHT = VIEW_HEIGHT - PADDING.top - PADDING.bottom

/** 把带空值的序列切成若干连续段，遇到空值即断开，避免跨缺口连线 */
const buildSegments = (
  values: (number | null)[],
  toX: (index: number) => number,
  toY: (value: number) => number,
) => {
  const segments: { x: number; y: number }[][] = []
  let current: { x: number; y: number }[] = []

  values.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      if (current.length > 0) segments.push(current)
      current = []
      return
    }
    current.push({ x: toX(index), y: toY(value) })
  })

  if (current.length > 0) segments.push(current)
  return segments
}

const toPath = (points: { x: number; y: number }[]) =>
  points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ')

const toArea = (points: { x: number; y: number }[]) => {
  if (points.length === 0) return ''
  const first = points[0]
  const last = points[points.length - 1]
  return `${toPath(points)} L${last.x.toFixed(1)} ${(PADDING.top + INNER_HEIGHT).toFixed(1)} L${first.x.toFixed(1)} ${(PADDING.top + INNER_HEIGHT).toFixed(1)} Z`
}

/** 分位对应的颜色档：<=30% 绿、<=70% 黄、其余红（估值越低越有利） */
const percentileTone = (percentile: number | null) => {
  if (percentile === null) return 'muted'
  if (percentile <= 30) return 'low'
  if (percentile <= 70) return 'mid'
  return 'high'
}

/**
 * 个股单一估值指标（PE 或 PB）的历史走势图。
 * 折线为季度采样序列，虚线为历史最低 / 最高参考线，圆点标记当前值。
 */
export const StockValuationChart = ({
  label,
  points,
  current,
  percentile,
  range,
}: Props) => {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  const scale = useMemo(() => {
    const values = points
      .map((point) => point.value)
      .filter((value): value is number => typeof value === 'number' && value > 0)
    if (values.length === 0) return null

    let min = Math.min(...values)
    let max = Math.max(...values)
    if (max === min) {
      max = min * 1.1
      min = min * 0.9
    }
    const span = max - min
    min -= span * 0.1
    max += span * 0.1
    return { min: Math.max(min, 0), max }
  }, [points])

  const count = points.length
  const toX = (index: number) =>
    PADDING.left + (count <= 1 ? 0 : (index / (count - 1)) * INNER_WIDTH)
  const toY = (value: number) =>
    scale === null
      ? PADDING.top
      : PADDING.top + (1 - (value - scale.min) / (scale.max - scale.min)) * INNER_HEIGHT

  const values = points.map((point) => point.value)
  const segments = useMemo(
    () => (scale === null ? [] : buildSegments(values, toX, toY)),
    // toX / toY 由 count 与 scale 决定，故依赖这三者即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, scale, count],
  )

  // 横轴按年打点
  const yearTicks = useMemo(() => {
    const ticks: { index: number; label: string }[] = []
    let lastYear = ''
    points.forEach((point, index) => {
      const year = point.date.slice(0, 4)
      if (year !== lastYear) {
        ticks.push({ index, label: year })
        lastYear = year
      }
    })
    return ticks
  }, [points])

  // 连续空值区间（亏损期，PE 无意义被置空），用于绘制灰色阴影
  const lossRanges = useMemo(() => {
    const ranges: { start: number; end: number }[] = []
    let start = -1
    values.forEach((value, index) => {
      const isNull = typeof value !== 'number'
      if (isNull && start === -1) start = index
      if (!isNull && start !== -1) {
        ranges.push({ start, end: index - 1 })
        start = -1
      }
    })
    if (start !== -1) ranges.push({ start, end: values.length - 1 })
    return ranges
  }, [values])

  // 最后一个有效点的位置，用于标记当前值
  const lastValidIndex = useMemo(() => {
    for (let index = values.length - 1; index >= 0; index -= 1) {
      if (typeof values[index] === 'number') return index
    }
    return null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points])

  if (scale === null) {
    return (
      <div className="valuation-chart empty">
        <div className="valuation-chart-head">
          <strong>{label}</strong>
        </div>
        <p className="helper-text">暂无历史数据。</p>
      </div>
    )
  }

  const handleMove = (event: React.MouseEvent<SVGRectElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || count === 0) return
    const svgX = ((event.clientX - rect.left) / rect.width) * VIEW_WIDTH
    const ratio = (svgX - PADDING.left) / INNER_WIDTH
    const index = Math.round(ratio * (count - 1))
    setHoverIndex(Math.min(count - 1, Math.max(0, index)))
  }

  const hoverValue = hoverIndex === null ? null : values[hoverIndex]
  const hoverX = hoverIndex === null ? 0 : toX(hoverIndex)
  const hoverY =
    typeof hoverValue === 'number' ? toY(hoverValue) : PADDING.top + INNER_HEIGHT / 2
  const tooltipLeft = hoverX > VIEW_WIDTH - 150 ? hoverX - 140 : hoverX + 10

  return (
    <div className="valuation-chart">
      <div className="valuation-chart-head">
        <strong>{label}</strong>
        <span className="valuation-current">
          当前 {current !== null ? current.toFixed(2) : '—'}
        </span>
        <span className={`valuation-percentile ${percentileTone(percentile)}`}>
          历史分位 {percentile !== null ? `${percentile.toFixed(0)}%` : '—'}
        </span>
      </div>
      <div className="valuation-range">
        历史区间 {range.min?.toFixed(2) ?? '—'} ~ {range.max?.toFixed(2) ?? '—'}
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="img"
        aria-label={`${label} 历史走势`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = PADDING.top + ratio * INNER_HEIGHT
          const value = scale.max - ratio * (scale.max - scale.min)
          return (
            <g key={ratio}>
              <line
                x1={PADDING.left}
                y1={y}
                x2={VIEW_WIDTH - PADDING.right}
                y2={y}
                className="valuation-grid"
              />
              <text
                x={PADDING.left - 6}
                y={y + 4}
                className="valuation-axis"
                textAnchor="end"
              >
                {value.toFixed(value >= 10 ? 0 : 1)}
              </text>
            </g>
          )
        })}

        {yearTicks.map((tick) => (
          <text
            key={tick.label}
            x={toX(tick.index)}
            y={VIEW_HEIGHT - 8}
            className="valuation-axis"
            textAnchor="middle"
          >
            {tick.label}
          </text>
        ))}

        {lossRanges.map((range, index) => {
          const xStart = toX(range.start)
          const xEnd = toX(range.end)
          const halfStep = count <= 1 ? 0 : INNER_WIDTH / (count - 1) / 2
          return (
            <g key={`loss-${index}`}>
              <rect
                x={xStart - halfStep}
                y={PADDING.top}
                width={Math.max(1, xEnd - xStart + halfStep * 2)}
                height={INNER_HEIGHT}
                className="valuation-loss-range"
              />
              {range.end - range.start >= 2 && (
                <text
                  x={(xStart + xEnd) / 2}
                  y={PADDING.top + 14}
                  className="valuation-loss-label"
                  textAnchor="middle"
                >
                  亏损期
                </text>
              )}
            </g>
          )
        })}

        {range.min !== null && (
          <line
            x1={PADDING.left}
            y1={toY(range.min)}
            x2={VIEW_WIDTH - PADDING.right}
            y2={toY(range.min)}
            className="valuation-ref low"
          />
        )}
        {range.max !== null && (
          <line
            x1={PADDING.left}
            y1={toY(range.max)}
            x2={VIEW_WIDTH - PADDING.right}
            y2={toY(range.max)}
            className="valuation-ref high"
          />
        )}

        {segments.map((segment, index) => (
          <path
            key={`area-${index}`}
            d={toArea(segment)}
            className="valuation-area"
          />
        ))}
        {segments.map((segment, index) => (
          <path key={`line-${index}`} d={toPath(segment)} className="valuation-line" />
        ))}

        {current !== null && lastValidIndex !== null && (
          <circle
            cx={toX(lastValidIndex)}
            cy={toY(current)}
            r={4}
            className="valuation-current-dot"
          />
        )}

        {hoverIndex !== null && (
          <g>
            <line
              x1={hoverX}
              y1={PADDING.top}
              x2={hoverX}
              y2={PADDING.top + INNER_HEIGHT}
              className="valuation-hover-line"
            />
            {typeof hoverValue === 'number' && (
              <circle cx={hoverX} cy={hoverY} r={3.5} className="valuation-hover-dot" />
            )}
          </g>
        )}

        <rect
          x={PADDING.left}
          y={PADDING.top}
          width={INNER_WIDTH}
          height={INNER_HEIGHT}
          fill="transparent"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
        />
      </svg>

      {hoverIndex !== null && (
        <div
          className="valuation-tooltip"
          style={{ left: tooltipLeft, top: Math.max(6, hoverY - 30) }}
        >
          <span>{points[hoverIndex]?.date ?? ''}</span>
          <strong>
            {typeof hoverValue === 'number'
              ? `${label} ${hoverValue.toFixed(2)}`
              : `${label} 亏损期（无意义）`}
          </strong>
        </div>
      )}
    </div>
  )
}
