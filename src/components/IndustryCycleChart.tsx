import { useMemo, useRef, useState } from 'react'
import type { CycleStats, IndustryCycleSeries } from '../types'
import { formatMonth } from '../lib/cycle'

type Props = {
  industry: string
  dates: string[]
  series: IndustryCycleSeries | undefined
  stats: CycleStats
}

const VIEW_WIDTH = 960
const VIEW_HEIGHT = 340
const PADDING = { top: 22, right: 26, bottom: 34, left: 58 }

const INNER_WIDTH = VIEW_WIDTH - PADDING.left - PADDING.right
const INNER_HEIGHT = VIEW_HEIGHT - PADDING.top - PADDING.bottom

type Point = { x: number; y: number }

const buildSegments = (
  values: (number | null)[],
  toX: (index: number) => number,
  toY: (value: number) => number,
) => {
  const segments: Point[][] = []
  let current: Point[] = []

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

const toPath = (points: Point[]) =>
  points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')

/**
 * 行业 PB 月度曲线。主曲线为市值加权 PB，虚线为中位数 PB，便于观察周期波动与当前所处位置。
 */
export const IndustryCycleChart = ({ industry, dates, series, stats }: Props) => {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  const scale = useMemo(() => {
    const values = [...(series?.pb ?? []), ...(series?.median ?? [])].filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
    )
    if (values.length === 0) return null

    let min = Math.min(...values)
    let max = Math.max(...values)
    if (max === min) {
      max = min * 1.1
      min = min * 0.9
    }
    const span = max - min
    // 上下各留 8% 余量，避免曲线贴边
    min -= span * 0.08
    max += span * 0.08
    return { min, max }
  }, [series])

  const count = dates.length
  const toX = (index: number) =>
    PADDING.left + (count <= 1 ? 0 : (index / (count - 1)) * INNER_WIDTH)
  const toY = (value: number) =>
    scale === null
      ? PADDING.top
      : PADDING.top + (1 - (value - scale.min) / (scale.max - scale.min)) * INNER_HEIGHT

  const pbSegments = useMemo(
    () => (scale === null ? [] : buildSegments(series?.pb ?? [], toX, toY)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, scale, count],
  )
  const medianSegments = useMemo(
    () => (scale === null ? [] : buildSegments(series?.median ?? [], toX, toY)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, scale, count],
  )

  // 横轴按年打点：取每个年份的第一条数据位置
  const yearTicks = useMemo(() => {
    const ticks: { index: number; label: string }[] = []
    let lastYear = ''
    dates.forEach((date, index) => {
      const year = date.slice(0, 4)
      if (year !== lastYear) {
        ticks.push({ index, label: year })
        lastYear = year
      }
    })
    return ticks
  }, [dates])

  // 主曲线最后一个有效点，用于标记「当前」位置
  const lastValidIndex = useMemo(() => {
    const values = series?.pb ?? []
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const value = values[index]
      if (typeof value === 'number' && Number.isFinite(value)) return index
    }
    return null
  }, [series])

  const handleMove = (event: React.MouseEvent<SVGRectElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || count === 0) return
    const svgX = ((event.clientX - rect.left) / rect.width) * VIEW_WIDTH
    const ratio = (svgX - PADDING.left) / INNER_WIDTH
    const index = Math.round(ratio * (count - 1))
    setHoverIndex(Math.min(count - 1, Math.max(0, index)))
  }

  if (scale === null) {
    return (
      <div className="cycle-chart empty">
        <p className="helper-text">该行业暂无可用的历史 PB 序列。</p>
      </div>
    )
  }

  const hoverValue = hoverIndex === null ? null : series?.pb?.[hoverIndex] ?? null
  const hoverX = hoverIndex === null ? 0 : toX(hoverIndex)
  const hoverY =
    typeof hoverValue === 'number' ? toY(hoverValue) : PADDING.top + INNER_HEIGHT / 2
  // 悬停标签超出右侧时改为左对齐，避免被裁切
  const tooltipLeft = hoverX > VIEW_WIDTH - 170 ? hoverX - 158 : hoverX + 12

  return (
    <div className="cycle-chart">
      <div className="cycle-chart-head">
        <strong>{industry}</strong>
        <span>
          当前 PB {stats.current?.toFixed(2) ?? '—'} / 历史区间{' '}
          {stats.min?.toFixed(2) ?? '—'} ~ {stats.max?.toFixed(2) ?? '—'}
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="img"
        aria-label={`${industry} 历史 PB 走势`}
      >
        {/* 水平网格与纵轴刻度 */}
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
                className="cycle-grid"
              />
              <text x={PADDING.left - 8} y={y + 4} className="cycle-axis" textAnchor="end">
                {value.toFixed(2)}
              </text>
            </g>
          )
        })}

        {/* 横轴年份刻度 */}
        {yearTicks.map((tick) => (
          <text
            key={tick.label}
            x={toX(tick.index)}
            y={VIEW_HEIGHT - 12}
            className="cycle-axis"
            textAnchor="middle"
          >
            {tick.label}
          </text>
        ))}

        {/* 历史低点 / 高点参考线 */}
        <line
          x1={PADDING.left}
          y1={toY(stats.min as number)}
          x2={VIEW_WIDTH - PADDING.right}
          y2={toY(stats.min as number)}
          className="cycle-ref low"
        />
        <line
          x1={PADDING.left}
          y1={toY(stats.max as number)}
          x2={VIEW_WIDTH - PADDING.right}
          y2={toY(stats.max as number)}
          className="cycle-ref high"
        />

        {medianSegments.map((segment, index) => (
          <path key={`median-${index}`} d={toPath(segment)} className="cycle-line median" />
        ))}
        {pbSegments.map((segment, index) => (
          <path key={`pb-${index}`} d={toPath(segment)} className="cycle-line pb" />
        ))}

        {/* 当前值标记 */}
        {stats.current !== null && lastValidIndex !== null && (
          <circle
            cx={toX(lastValidIndex)}
            cy={toY(stats.current)}
            r={4}
            className="cycle-current-dot"
          />
        )}

        {hoverIndex !== null && (
          <g>
            <line
              x1={hoverX}
              y1={PADDING.top}
              x2={hoverX}
              y2={PADDING.top + INNER_HEIGHT}
              className="cycle-hover-line"
            />
            <circle cx={hoverX} cy={hoverY} r={3.5} className="cycle-hover-dot" />
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
        <div className="cycle-tooltip" style={{ left: tooltipLeft, top: Math.max(8, hoverY - 34) }}>
          <span>{formatMonth(dates[hoverIndex] ?? null)}</span>
          <strong>
            PB {typeof hoverValue === 'number' ? hoverValue.toFixed(2) : '—'}
            {' · '}
            中位数 {series?.median?.[hoverIndex]?.toFixed(2) ?? '—'}
          </strong>
        </div>
      )}
    </div>
  )
}
