import { useEffect, useMemo, useState } from 'react'
import type { Candle, IndexHistoryResponse } from '../types'
import {
  buildMarketCycle,
  fetchIndexHistory,
  monthsToTradingDays,
  pivotWindow,
  SHANGHAI_INDEX_SYMBOL,
} from '../lib/market-cycle'
import { CandlestickChart } from './CandlestickChart'
import { IndexCycleChart } from './IndexCycleChart'

/** 可选的反转阈值（%）：阈值越大，识别出的牛熊周期越少、越大 */
const THRESHOLD_OPTIONS = [20, 25, 30, 35]
/** 可选的 K 线窗口（月），顶底点前后各取这么久 */
const WINDOW_OPTIONS = [3, 6, 12]

const pct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`

const durationText = (calendarDays: number) => {
  if (calendarDays < 60) return `${calendarDays} 天`
  const months = calendarDays / 30.4
  if (months < 24) return `${months.toFixed(1)} 个月`
  return `${(calendarDays / 365.25).toFixed(1)} 年`
}

/**
 * 「牛熊阶段」页面：基于上证指数日线自动识别牛熊顶底，展示当前阶段、
 * 历史阶段列表，以及每个顶/底点附近的 K 线窗口。
 */
export const BullBearSection = () => {
  const [data, setData] = useState<IndexHistoryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [thresholdPct, setThresholdPct] = useState(THRESHOLD_OPTIONS[0])
  const [windowMonths, setWindowMonths] = useState(WINDOW_OPTIONS[1])
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchIndexHistory(SHANGHAI_INDEX_SYMBOL, 20)
      .then((payload) => {
        if (cancelled) return
        if (payload.error && payload.candles.length === 0) {
          setError(payload.error)
          setData(null)
          return
        }
        setData(payload)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setData(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  const candles = useMemo<Candle[]>(() => data?.candles ?? [], [data])
  const cycle = useMemo(
    () => buildMarketCycle(candles, thresholdPct / 100),
    [candles, thresholdPct],
  )

  const windowDays = monthsToTradingDays(windowMonths)
  const reversedPivots = useMemo(() => [...cycle.pivots].reverse(), [cycle.pivots])

  return (
    <section className="panel">
      <div className="section-title">
        <h2>牛熊阶段</h2>
        <p>
          以上证指数日线收盘价为基准，按「自高点回撤 / 自低点反弹」达到阈值自动识别牛熊顶底：
          低点 → 高点为牛市，高点 → 低点为熊市。下方列出每个顶/底点附近的 K 线窗口，
          便于回看当时的市场形态与位置。
        </p>
      </div>

      <div className="action-row">
        <label className="inline-search">
          <span>反转阈值</span>
          <select
            value={thresholdPct}
            onChange={(event) => setThresholdPct(Number(event.target.value))}
          >
            {THRESHOLD_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}%（{option <= 20 ? '较灵敏' : option >= 35 ? '仅大周期' : '较平滑'}）
              </option>
            ))}
          </select>
        </label>
        <label className="inline-search">
          <span>K 线窗口</span>
          <select
            value={windowMonths}
            onChange={(event) => setWindowMonths(Number(event.target.value))}
          >
            {WINDOW_OPTIONS.map((option) => (
              <option key={option} value={option}>
                顶底前后各 {option} 个月
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button-secondary"
          onClick={() => setAttempt((value) => value + 1)}
          disabled={loading}
        >
          {loading ? '加载中…' : '刷新数据'}
        </button>
      </div>

      {data && (
        <p className="helper-text">
          数据区间 {data.from ?? '—'} ~ {data.to ?? '—'}，共 {candles.length} 个交易日
          {data.cached ? '（服务端缓存）' : ''}。
        </p>
      )}

      {error && (
        <div className="cycle-load-status" role="alert">
          <p className="helper-text error">{error}</p>
          <button
            type="button"
            className="button-secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试
          </button>
        </div>
      )}

      {loading && !data && (
        <p className="helper-text">正在获取上证指数近 20 年日线数据…</p>
      )}

      {data && cycle.current && (
        <>
          <div className="metric-grid cycle-metric-grid">
            <article className={`metric-card ${cycle.current.kind}`}>
              <span>当前阶段</span>
              <strong>{cycle.current.kind === 'bull' ? '牛市（上行）' : '熊市（下行）'}</strong>
            </article>
            <article className="metric-card">
              <span>阶段起点（{cycle.current.startDate}）</span>
              <strong>{cycle.current.startPrice.toFixed(2)}</strong>
            </article>
            <article className="metric-card">
              <span>区间涨跌 / 最新点位</span>
              <strong className={cycle.current.changePct >= 0 ? 'up' : 'down'}>
                {pct(cycle.current.changePct)} · {cycle.current.endPrice.toFixed(2)}
              </strong>
            </article>
            <article className="metric-card">
              <span>阶段时长</span>
              <strong>
                {durationText(cycle.current.calendarDays)}
                <span className="helper-text"> · {cycle.current.tradingDays} 个交易日</span>
              </strong>
            </article>
          </div>

          <IndexCycleChart
            candles={candles}
            phases={cycle.phases}
            pivots={cycle.pivots}
          />

          <div className="cycle-legend">
            <span className="legend-item bull">牛市区间</span>
            <span className="legend-item bear">熊市区间</span>
            <span className="legend-item high">顶（自高点回撤 ≥ {thresholdPct}%）</span>
            <span className="legend-item low">底（自低点反弹 ≥ {thresholdPct}%）</span>
          </div>

          <h3 className="subsection-title">历史牛熊阶段（{cycle.phases.length} 段）</h3>
          <div className="table-scroll">
            <table className="cycle-phase-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>类型</th>
                  <th>起始日</th>
                  <th>起点</th>
                  <th>结束日</th>
                  <th>终点</th>
                  <th>涨跌幅</th>
                  <th>时长</th>
                </tr>
              </thead>
              <tbody>
                {cycle.phases.map((phase) => (
                  <tr key={phase.seq}>
                    <td>{phase.seq}</td>
                    <td>
                      <span className={`cycle-badge ${phase.kind}`}>
                        {phase.kind === 'bull' ? '牛市' : '熊市'}
                        {phase.ongoing ? '（进行中）' : ''}
                      </span>
                    </td>
                    <td>{phase.startDate}</td>
                    <td>{phase.startPrice.toFixed(2)}</td>
                    <td>{phase.endDate}</td>
                    <td>{phase.endPrice.toFixed(2)}</td>
                    <td className={phase.changePct >= 0 ? 'up' : 'down'}>
                      {pct(phase.changePct)}
                    </td>
                    <td>{durationText(phase.calendarDays)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="subsection-title">
            牛熊顶底点 K 线（{cycle.pivots.length} 个，最新在前）
          </h3>
          <div className="pivot-grid">
            {reversedPivots.map((pivot) => (
              <article key={`${pivot.date}-${pivot.type}`} className="pivot-card">
                <div className="pivot-card-head">
                  <span className={`cycle-badge ${pivot.type === 'high' ? 'bear' : 'bull'}`}>
                    {pivot.type === 'high' ? '顶' : '底'}
                  </span>
                  <strong>{pivot.date}</strong>
                  <span className="pivot-price">{pivot.price.toFixed(2)}</span>
                </div>
                <CandlestickChart
                  candles={pivotWindow(candles, pivot, windowDays)}
                  highlightDate={pivot.date}
                  highlightType={pivot.type}
                  height={180}
                />
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
