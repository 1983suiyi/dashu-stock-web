import type {
  MarketSnapshot,
  PortfolioHolding,
  ScoredStock,
  StockRecord,
  StrategyConfig,
} from '../types'

/**
 * 三好学生评分（还原自「大数模拟器」编译产物）
 *
 *   PB 得分  = bta(q, 2q, PB) * 100        取值范围 [q, 2q]
 *   PE 得分  = bta(10q, 20q, PE) * 100     用 PB×10 作为 PE 的取值区间
 *   涨幅得分 = 100 − 200 × 涨幅             一年内最低价到现价涨幅，区间 [0%, 50%]
 *   总分     = 三项之和（满分 300）
 *   绝对胜算概率 = 总分 / 3 (%)
 *
 * 其中 q = 0.618 + 历史折扣 × 0.382（历史折扣 < 1），否则 q = 1。
 * 因此 200 分门槛等价于 绝对胜算概率 66.67%，与 2/3 仓位约束同源。
 */
export const PB_BASE = 0.618
export const PB_ADJUST = 0.382
export const MAX_SCORE = 300
/** 公开口径的高风险兜底：先用最明显的两类财务/股权风险做硬过滤。 */
export const MAX_GOODWILL_RATIO = 20
export const MAX_PLEDGE_RATIO = 20

/** 原始实现的线性映射：v>=hi 记 0，v<=lo 记 1（即满分） */
const bta = (lo: number, hi: number, value: number) => {
  if (value >= hi) return 0
  if (value <= lo) return 1
  return 1 - (value - lo) / (hi - lo)
}

export const pbBand = (discount: number): [number, number] => {
  const lo = discount >= 1 ? 1 : PB_BASE + discount * PB_ADJUST
  return [lo, lo * 2]
}

export const peBand = (discount: number): [number, number] => {
  const [lo, hi] = pbBand(discount)
  return [lo * 10, hi * 10]
}

/**
 * PB / PE 必须为正值；<=0 往往对应亏损或净资产异常，
 * 若直接套用线性映射会被误判成“越低越便宜”，反而拿到满分。
 */
const toValuationScore = (value: number | null, lo: number, hi: number) =>
  value === null || Number.isNaN(value) || value <= 0
    ? null
    : bta(lo, hi, value) * 100

/** 一年内最低价 → 涨幅 → 涨幅得分 */
export const priceScoreOf = (price: number | null, low1y: number | null) => {
  if (price === null || low1y === null || low1y <= 0) {
    return { gain1y: null, priceScore: null }
  }
  const gain1y = (price - low1y) / low1y
  if (gain1y <= 0) return { gain1y, priceScore: 100 }
  return {
    gain1y,
    priceScore: Math.max(0, 100 - 200 * gain1y),
  }
}

export const gainOf = (price: number | null, low: number | null) => {
  if (price === null || low === null || low <= 0) return null
  return (price - low) / low
}

const mineScoreOf = (
  goodwillRatio: number | null,
  pledgeRatio: number | null,
) => {
  const goodwill = goodwillRatio ?? 0
  const pledge = pledgeRatio ?? 0

  // 当前公开口径只对“超过硬过滤线”的风险做降分；
  // 未触发高风险拦截时记 100，后续再继续补全更细的扫雷因子。
  const goodwillPenalty =
    goodwill <= MAX_GOODWILL_RATIO
      ? 0
      : Math.min(70, ((goodwill - MAX_GOODWILL_RATIO) / 30) * 70)
  const pledgePenalty =
    pledge <= MAX_PLEDGE_RATIO
      ? 0
      : Math.min(30, ((pledge - MAX_PLEDGE_RATIO) / 20) * 30)

  return Math.max(0, Math.round(100 - goodwillPenalty - pledgePenalty))
}

const median = (values: number[]) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/** 各行业资产负债率中位数，用于「资产负债率 < 行业中位数」判定 */
export const industryDebtMedians = (stocks: StockRecord[]) => {
  const grouped = new Map<string, number[]>()
  for (const stock of stocks) {
    if (stock.debtRatio === null) continue
    const bucket = grouped.get(stock.industry) ?? []
    bucket.push(stock.debtRatio)
    grouped.set(stock.industry, bucket)
  }

  const result = new Map<string, number>()
  for (const [industry, values] of grouped) {
    const value = median(values)
    if (value !== null) result.set(industry, value)
  }
  return result
}

export const scoreStocks = (
  stocks: StockRecord[],
  config: StrategyConfig,
): ScoredStock[] => {
  const [pbLo, pbHi] = pbBand(config.discount)
  const [peLo, peHi] = peBand(config.discount)
  const debtMedians = industryDebtMedians(stocks)

  return stocks
    .map<ScoredStock>((stock) => {
      const pbScore = toValuationScore(stock.pb, pbLo, pbHi)
      const peScore = toValuationScore(stock.pe, peLo, peHi)
      const { gain1y, priceScore } = priceScoreOf(stock.price, stock.lowPrice1y)
      const gain3y = gainOf(stock.price, stock.lowPrice3y)
      const mineScore = mineScoreOf(stock.goodwillRatio, stock.pledgeRatio)

      const notes: string[] = []
      const missingFields: string[] = []

      if (pbScore === null) missingFields.push('PB')
      if (peScore === null) missingFields.push('PE')
      if (priceScore === null) missingFields.push('一年内最低价')
      if (stock.lowPrice3y === null) missingFields.push('三年内最低价')
      if (stock.dividendYield === null) missingFields.push('股息率')
      if (stock.goodwillRatio === null) missingFields.push('商誉占比')
      if (stock.pledgeRatio === null) missingFields.push('股权质押比例')

      const parts = [pbScore, peScore, priceScore].filter(
        (value): value is number => value !== null,
      )
      const totalScore = parts.reduce((sum, value) => sum + value, 0)
      const complete = priceScore !== null
      const winProbability = complete ? totalScore / 3 : null

      const industryDebtMedian = debtMedians.get(stock.industry) ?? null
      let debtAboveIndustryMedian: boolean | null = null
      if (stock.debtRatio !== null && industryDebtMedian !== null) {
        debtAboveIndustryMedian = stock.debtRatio > industryDebtMedian
      }
      const goodwillTooHigh =
        stock.goodwillRatio !== null &&
        stock.goodwillRatio >= MAX_GOODWILL_RATIO
      const pledgeTooHigh =
        stock.pledgeRatio !== null && stock.pledgeRatio >= MAX_PLEDGE_RATIO

      if (pbScore !== null && pbScore >= 60) notes.push('PB 处于低估区间')
      if (peScore !== null && peScore >= 60) notes.push('PE 处于低估区间')
      if (priceScore !== null && priceScore >= 60) notes.push('接近一年内价格低点')
      if (debtAboveIndustryMedian === true) notes.push('资产负债率高于行业中位数')
      if (debtAboveIndustryMedian === false) notes.push('资产负债率低于行业中位数')
      if (goodwillTooHigh) notes.push(`商誉占净资产过高(>=${MAX_GOODWILL_RATIO}%)`)
      if (pledgeTooHigh) notes.push(`股权质押比例过高(>=${MAX_PLEDGE_RATIO}%)`)
      if (stock.dividendYield !== null && stock.dividendYield <= config.minDividendYield) {
        notes.push('股息率低于阈值')
      }
      if (stock.isST) notes.push('ST 风险')

      const eligible =
        !stock.isST &&
        complete &&
        totalScore > config.scoreThreshold &&
        debtAboveIndustryMedian !== true &&
        !goodwillTooHigh &&
        !pledgeTooHigh &&
        (stock.dividendYield === null ||
          stock.dividendYield > config.minDividendYield)

      return {
        ...stock,
        pbScore,
        peScore,
        priceScore,
        gain1y,
        gain3y,
        mineScore,
        totalScore,
        winProbability,
        pbBand: [pbLo, pbHi],
        peBand: [peLo, peHi],
        industryDebtMedian,
        debtAboveIndustryMedian,
        eligible,
        notes,
        missingFields,
      }
    })
    .sort((a, b) => b.totalScore - a.totalScore)
}

/**
 * 两阶段剪枝（结果精确、不丢候选）：
 * 总分 = PB + PE + 涨幅，且涨幅得分最高只有 100，
 * 因此 PB+PE 不到「门槛 − 100」的股票无论如何都及不了格，可直接跳过 K 线。
 */
export const pickKlineCandidates = (
  scored: ScoredStock[],
  config: StrategyConfig,
) => {
  const cutoff = config.scoreThreshold - 100
  return scored
    .filter((stock) => {
      if (stock.lowPrice1y !== null && stock.lowPrice3y !== null) return false
      if (stock.isST) return false
      if (stock.debtAboveIndustryMedian === true) return false
      if (stock.goodwillRatio !== null && stock.goodwillRatio >= MAX_GOODWILL_RATIO) {
        return false
      }
      if (stock.pledgeRatio !== null && stock.pledgeRatio >= MAX_PLEDGE_RATIO) {
        return false
      }
      return (stock.pbScore ?? 0) + (stock.peScore ?? 0) > cutoff
    })
    .slice(0, config.maxKlineCandidates)
    .map((stock) => stock.code)
}

export const recommendPortfolio = (
  scored: ScoredStock[],
  config: StrategyConfig,
  market: MarketSnapshot,
): PortfolioHolding[] => {
  let targetExposure = 0.2
  if (market.allMarketPb <= 1.5) targetExposure = config.maxEquityExposure
  else if (market.allMarketPb <= 2.0) targetExposure = 0.58
  else if (market.allMarketPb <= 2.5) targetExposure = 0.48
  else if (market.allMarketPb <= 3.0) targetExposure = 0.36

  let remaining = Math.min(targetExposure, config.maxEquityExposure)
  const industryWeight = new Map<string, number>()
  const holdings: PortfolioHolding[] = []

  for (const stock of scored) {
    if (remaining <= 0.0001) break
    if (!stock.eligible) continue

    const used = industryWeight.get(stock.industry) ?? 0
    const room = config.maxIndustryWeight - used
    if (room <= 0.0001) continue

    const weight = Math.min(room, remaining)
    holdings.push({
      code: stock.code,
      name: stock.name,
      industry: stock.industry,
      score: stock.totalScore,
      winProbability: stock.winProbability,
      targetWeight: weight,
      reason: stock.notes.slice(0, 3).join(' / ') || '三好学生评分靠前',
    })
    industryWeight.set(stock.industry, used + weight)
    remaining -= weight
  }

  return holdings
}

export const portfolioExposure = (portfolio: PortfolioHolding[]) =>
  portfolio.reduce((sum, item) => sum + item.targetWeight, 0)

export const summarizeMarket = (market: MarketSnapshot) => {
  if (market.allMarketPb <= 1.5) {
    return {
      label: '深度低估',
      tone: '积极分批建仓',
      description: '可将权益仓位提升到策略允许上限，但仍遵守 2/3 总仓位约束。',
    }
  }
  if (market.allMarketPb <= 2.5) {
    return {
      label: '中性偏低估',
      tone: '正常筛选与滚动建仓',
      description: '适合按分层组合逐步买入，优先低估值行业与高分股票。',
    }
  }
  if (market.allMarketPb <= 3.5) {
    return {
      label: '中性偏高估',
      tone: '控制节奏',
      description: '保留更多现金，执行低成本原则，减少追高行为。',
    }
  }
  return {
    label: '明显高估',
    tone: '停止扩张仓位',
    description: '仅做换仓与风险管理，避免在整体估值过高时新增大额仓位。',
  }
}

/** 用全市场样本中位数估算整体估值水平，避免依赖单一指数口径 */
export const deriveMarketSnapshot = (stocks: StockRecord[]): MarketSnapshot => {
  const pbs = stocks
    .map((stock) => stock.pb)
    .filter((value): value is number => value !== null)
  const pes = stocks
    .map((stock) => stock.pe)
    .filter((value): value is number => value !== null && value > 0)

  return {
    allMarketPb: Number((median(pbs) ?? 0).toFixed(2)),
    allMarketPe: Number((median(pes) ?? 0).toFixed(2)),
  }
}
