import type {
  Candle,
  CyclePivot,
  IndexHistoryResponse,
  MarketCycleResult,
  MarketPhase,
} from '../types'

/** 上证指数在腾讯行情的符号 */
export const SHANGHAI_INDEX_SYMBOL = 'sh000001'

/** 默认反转阈值：价格自高点回撤 / 自低点反弹达到 20% 才确认顶/底 */
export const DEFAULT_REVERSAL_THRESHOLD = 0.2

/** 拉取指数日线历史（默认上证指数近 20 年） */
export const fetchIndexHistory = async (
  symbol: string = SHANGHAI_INDEX_SYMBOL,
  years = 20,
): Promise<IndexHistoryResponse> => {
  const params = new URLSearchParams({ symbol, years: String(years) })
  const response = await fetch(`/api/index-history?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`指数历史接口返回 HTTP ${response.status}`)
  }
  return (await response.json()) as IndexHistoryResponse
}

const closeOf = (candle: Candle): number | null =>
  typeof candle.close === 'number' && candle.close > 0 ? candle.close : null

const daysBetween = (from: string, to: string): number => {
  const start = new Date(`${from}T00:00:00`).getTime()
  const end = new Date(`${to}T00:00:00`).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, Math.round((end - start) / (24 * 60 * 60 * 1000)))
}

type DetectResult = {
  pivots: CyclePivot[]
  /** 末尾未确认的运行极值方向：1=正在找顶（自低点上行），-1=正在找底 */
  trend: 1 | -1 | 0
  /** 末尾未确认的极值点 */
  pending: CyclePivot | null
}

/**
 * 用「回撤/反弹阈值」在收盘价序列上做 zigzag，识别牛熊顶底点。
 *
 * 规则：价格自区间高点回落 ≥ threshold 时确认一个「顶」，自区间低点反弹 ≥ threshold
 * 时确认一个「底」。序列起点的退化顶/底（下标为 0）会被剔除，避免把数据起点当作顶。
 * 末尾尚未走出确认幅度的极值作为 pending 返回，用于标识「进行中」阶段。
 */
export const detectPivots = (
  candles: Candle[],
  threshold: number = DEFAULT_REVERSAL_THRESHOLD,
): DetectResult => {
  const first = closeOf(candles[0] ?? { close: null } as Candle)
  if (candles.length < 2 || first === null) {
    return { pivots: [], trend: 0, pending: null }
  }

  const pivots: CyclePivot[] = []
  let hi = { price: first, index: 0 }
  let lo = { price: first, index: 0 }
  let trend: 1 | -1 | 0 = 0
  let ext = { price: first, index: 0 }

  let cursor = 1
  // 初始化：先确定第一段方向——上涨突破或下跌突破哪个先发生
  for (; cursor < candles.length; cursor += 1) {
    const price = closeOf(candles[cursor])
    if (price === null) continue
    if (price > hi.price) hi = { price, index: cursor }
    if (price < lo.price) lo = { price, index: cursor }

    if (lo.price > 0 && (price - lo.price) / lo.price >= threshold) {
      pivots.push({ type: 'low', index: lo.index, date: candles[lo.index].date, price: lo.price })
      trend = 1
      ext = { price, index: cursor }
      break
    }
    if (hi.price > 0 && (hi.price - price) / hi.price >= threshold) {
      pivots.push({ type: 'high', index: hi.index, date: candles[hi.index].date, price: hi.price })
      trend = -1
      ext = { price, index: cursor }
      break
    }
  }

  // 主体：按当前方向跟踪极值，反向突破阈值即确认一个顶/底
  for (let i = cursor + 1; i < candles.length; i += 1) {
    const price = closeOf(candles[i])
    if (price === null) continue

    if (trend === 1) {
      if (price > ext.price) ext = { price, index: i }
      if (ext.price > 0 && (ext.price - price) / ext.price >= threshold) {
        pivots.push({ type: 'high', index: ext.index, date: candles[ext.index].date, price: ext.price })
        trend = -1
        ext = { price, index: i }
      }
      continue
    }

    if (trend === -1) {
      if (price < ext.price) ext = { price, index: i }
      if (ext.price > 0 && (price - ext.price) / ext.price >= threshold) {
        pivots.push({ type: 'low', index: ext.index, date: candles[ext.index].date, price: ext.price })
        trend = 1
        ext = { price, index: i }
      }
    }
  }

  // 剔除起点退化顶/底
  const cleaned = pivots.filter((pivot) => pivot.index > 0)
  const pending =
    trend === 0
      ? null
      : {
          type: trend === 1 ? ('high' as const) : ('low' as const),
          index: ext.index,
          date: candles[ext.index]?.date ?? '',
          price: ext.price,
        }

  return { pivots: cleaned, trend, pending }
}

const buildPhase = (
  seq: number,
  kind: 'bull' | 'bear',
  start: { date: string; price: number; index: number },
  end: { date: string; price: number; index: number },
  ongoing: boolean,
): MarketPhase => ({
  seq,
  kind,
  startDate: start.date,
  startPrice: start.price,
  endDate: end.date,
  endPrice: end.price,
  changePct: start.price > 0 ? (end.price / start.price - 1) * 100 : 0,
  tradingDays: Math.max(0, end.index - start.index),
  calendarDays: daysBetween(start.date, end.date),
  ongoing,
})

/**
 * 由顶底点归纳牛熊阶段：
 * - 低 → 高：牛市；高 → 低：熊市；
 * - 数据起点到首个顶底点作为首段（方向由首段顶底类型推断）；
 * - 最后一个顶底点到最新交易日作为「进行中」阶段。
 */
export const buildMarketCycle = (
  candles: Candle[],
  threshold: number = DEFAULT_REVERSAL_THRESHOLD,
): MarketCycleResult => {
  const { pivots } = detectPivots(candles, threshold)
  if (candles.length === 0) {
    return { pivots, phases: [], current: null }
  }

  const firstClose = closeOf(candles[0])
  const lastIndex = candles.length - 1
  const lastClose = closeOf(candles[lastIndex])
  if (firstClose === null || lastClose === null) {
    return { pivots, phases: [], current: null }
  }

  const phases: MarketPhase[] = []
  const startPoint = { date: candles[0].date, price: firstClose, index: 0 }

  if (pivots.length === 0) {
    return { pivots, phases, current: null }
  }

  // 首段：数据起点 → 第一个顶底点
  phases.push(
    buildPhase(
      1,
      pivots[0].type === 'low' ? 'bear' : 'bull',
      startPoint,
      { date: pivots[0].date, price: pivots[0].price, index: pivots[0].index },
      false,
    ),
  )

  // 中间各段：相邻顶底点
  for (let i = 0; i < pivots.length - 1; i += 1) {
    const from = pivots[i]
    const to = pivots[i + 1]
    phases.push(
      buildPhase(
        phases.length + 1,
        from.type === 'low' ? 'bull' : 'bear',
        { date: from.date, price: from.price, index: from.index },
        { date: to.date, price: to.price, index: to.index },
        false,
      ),
    )
  }

  // 末段：最后一个顶底点 → 最新交易日（进行中）
  const lastPivot = pivots[pivots.length - 1]
  phases.push(
    buildPhase(
      phases.length + 1,
      lastPivot.type === 'low' ? 'bull' : 'bear',
      { date: lastPivot.date, price: lastPivot.price, index: lastPivot.index },
      { date: candles[lastIndex].date, price: lastClose, index: lastIndex },
      true,
    ),
  )

  return { pivots, phases, current: phases[phases.length - 1] ?? null }
}

/**
 * 取某个顶底点前后各 windowDays 个交易日的蜡烛窗口，用于绘制局部 K 线。
 */
export const pivotWindow = (
  candles: Candle[],
  pivot: CyclePivot,
  windowDays: number,
): Candle[] => {
  const from = Math.max(0, pivot.index - windowDays)
  const to = Math.min(candles.length - 1, pivot.index + windowDays)
  return candles.slice(from, to + 1)
}

/** 交易日窗口 → 近似自然月（每月约 21 个交易日） */
export const monthsToTradingDays = (months: number) => Math.round(months * 21)
