import type {
  IndexPositionBand,
  MarketSnapshot,
  MarketTemperatureRecord,
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
/** 个股 PB 相对「行业 PB 底」的偏离分档(%)：≤10% 视为贴近底部，≥20% 视为明显偏离 */
export const PB_FLOOR_NEAR_PCT = 10
export const PB_FLOOR_FAR_PCT = 20

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

  // 公开口径下，先用商誉与质押做连续风险分：
  // - 商誉 5% 以内不扣分，之后逐步降分；
  // - 质押 10% 以内不扣分，之后逐步降分；
  // - 超过硬过滤线（20%）后继续快速降分。
  //
  // 这样既能保留高风险拦截，又不会让绝大部分样本都堆在 100 分。
  const goodwillPenalty =
    goodwill <= 5 ? 0 : Math.min(70, (goodwill - 5) * 4)
  const pledgePenalty =
    pledge <= 10 ? 0 : Math.min(30, (pledge - 10) * 2)

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

/**
 * 各行业「PB 底」。
 *
 * 优先使用服务端按「大数模拟器」口径计算的历史统计 PB 底
 * （行业内个股 PB 分布第 5 百分位数的历史最低值，按 BOARD_NAME 索引）。
 * 若未提供历史数据，则回退到当前截面最低正 PB（保守兜底）。
 *
 * 同一标准化行业可能对应多个 BOARD_NAME（如「食品加工制造」来自
 * 「调味发酵品Ⅱ」和「食品加工」），此时取所有来源 BOARD_NAME 中
 * 最低的 PB 底作为该行业的 PB 底。
 */
export const industryPbFloors = (
  stocks: StockRecord[],
  historicalFloors?: Record<string, number>,
): Map<string, number> => {
  const grouped = new Map<string, number>()

  if (historicalFloors) {
    // 按标准化行业聚合，取所有来源 BOARD_NAME 的最低 PB 底
    const byIndustry = new Map<string, number[]>()
    for (const stock of stocks) {
      const source = stock.sourceIndustry
      if (!source) continue
      const floor = historicalFloors[source]
      if (floor === undefined || floor <= 0) continue
      const list = byIndustry.get(stock.industry) ?? []
      list.push(floor)
      byIndustry.set(stock.industry, list)
    }
    for (const [industry, floors] of byIndustry) {
      grouped.set(industry, Math.min(...floors))
    }
    if (grouped.size > 0) return grouped
  }

  // 回退：当前截面最低正 PB
  for (const stock of stocks) {
    if (stock.pb === null || stock.pb <= 0) continue
    const current = grouped.get(stock.industry)
    if (current === undefined || stock.pb < current) {
      grouped.set(stock.industry, stock.pb)
    }
  }
  return grouped
}

export const scoreStocks = (
  stocks: StockRecord[],
  config: StrategyConfig,
  historicalPbFloors?: Record<string, number>,
  historicalStockPbFloors?: Record<string, number>,
): ScoredStock[] => {
  const [pbLo, pbHi] = pbBand(config.discount)
  const [peLo, peHi] = peBand(config.discount)
  const debtMedians = industryDebtMedians(stocks)
  const pbFloors = industryPbFloors(stocks, historicalPbFloors)

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
      const industryPbFloor = pbFloors.get(stock.industry) ?? null
      const historicalStockPbFloor = historicalStockPbFloors?.[stock.code] ?? null
      // Monthly snapshots can miss a newer intramonth low; include the current PB as an observation.
      const stockPbFloor =
        stock.pb !== null && stock.pb > 0
          ? historicalStockPbFloor === null
            ? stock.pb
            : Math.min(historicalStockPbFloor, stock.pb)
          : historicalStockPbFloor
      const pbVsFloorPct =
        stock.pb !== null && stock.pb > 0 && industryPbFloor !== null && industryPbFloor > 0
          ? (stock.pb / industryPbFloor - 1) * 100
          : null
      const industryDebtMedianLimit =
        industryDebtMedian === null
          ? null
          : industryDebtMedian * (1 + config.debtMedianTolerance)
      let debtAboveIndustryMedian: boolean | null = null
      if (stock.debtRatio !== null && industryDebtMedianLimit !== null) {
        debtAboveIndustryMedian = stock.debtRatio > industryDebtMedianLimit
      }
      const goodwillTooHigh =
        stock.goodwillRatio !== null &&
        stock.goodwillRatio >= MAX_GOODWILL_RATIO
      const pledgeTooHigh =
        stock.pledgeRatio !== null && stock.pledgeRatio >= MAX_PLEDGE_RATIO

      if (pbScore !== null && pbScore >= 60) notes.push('PB 处于低估区间')
      if (peScore !== null && peScore >= 60) notes.push('PE 处于低估区间')
      if (priceScore !== null && priceScore >= 60) notes.push('接近一年内价格低点')
      if (debtAboveIndustryMedian === true) {
        notes.push(
          `资产负债率超行业中位数宽容上限(中位数 × ${(1 + config.debtMedianTolerance).toFixed(2)})`,
        )
      }
      if (debtAboveIndustryMedian === false) notes.push('资产负债率在中位数宽容区间内')
      if (goodwillTooHigh) notes.push(`商誉占净资产过高(>=${MAX_GOODWILL_RATIO}%)`)
      if (pledgeTooHigh) notes.push(`股权质押比例过高(>=${MAX_PLEDGE_RATIO}%)`)
      if (stock.dividendYield !== null && stock.dividendYield <= config.minDividendYield) {
        notes.push('股息率低于阈值')
      }
      if (stock.isST) notes.push('ST 风险')
      if (pbVsFloorPct !== null) {
        notes.push(
          `距行业 PB 底 ${pbVsFloorPct.toFixed(1)}%（PB 底 ${industryPbFloor?.toFixed(2)}）`,
        )
      }

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
        industryDebtMedianLimit,
        industryPbFloor,
        stockPbFloor,
        pbVsFloorPct,
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

/**
 * 三低档位：PB / PE / 距一年低点涨幅三项阈值的预设档。
 * 「距一年低点」用现价相对一年内最低价的涨幅衡量，越接近 0 越贴近底部。
 */
export type TripleLowTier = 'off' | 'loose' | 'standard' | 'strict'

export const TRIPLE_LOW_PRESETS: Record<
  Exclude<TripleLowTier, 'off'>,
  { label: string; pbMax: number; peMax: number; lowGapMax: number }
> = {
  loose: { label: '宽松（PB≤1.2 / PE≤12 / 距低点≤10%）', pbMax: 1.2, peMax: 12, lowGapMax: 0.1 },
  standard: { label: '标准（PB≤1.0 / PE≤10 / 距低点≤5%）', pbMax: 1.0, peMax: 10, lowGapMax: 0.05 },
  strict: { label: '严格（PB≤0.8 / PE≤8 / 距低点≤3%）', pbMax: 0.8, peMax: 8, lowGapMax: 0.03 },
}

/** 三低筛选：PB、PE 与「现价距一年低点涨幅」需同时满足档位阈值；缺任一项视为不通过。 */
export const matchesTripleLow = (stock: ScoredStock, tier: TripleLowTier) => {
  if (tier === 'off') return true
  const preset = TRIPLE_LOW_PRESETS[tier]
  const { pb, pe, gain1y } = stock
  if (pb === null || pb <= 0 || pe === null || pe <= 0 || gain1y === null) {
    return false
  }
  return pb <= preset.pbMax && pe <= preset.peMax && gain1y <= preset.lowGapMax
}

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

/**
 * 上证指数点位 → 建议权益仓位分档表。
 * 越跌仓位越重：4100 点以上空仓，2100 点以下满仓，每 100 点一档，仓位上限线性上升 5%。
 * 作为大数投资「按点位定仓位」的参考刻度，与全市场 PB 口径互为印证。
 */
const buildIndexPositionBands = (): IndexPositionBand[] => {
  const topFloor = 4100
  const bottomFloor = 2100
  const bands: IndexPositionBand[] = [
    { floor: topFloor, label: `${topFloor} 以上`, minPct: 0, maxPct: 0 },
  ]
  for (let floor = topFloor - 100; floor >= bottomFloor; floor -= 100) {
    const maxPct = Math.round(
      ((topFloor - floor) / (topFloor - bottomFloor)) * 100,
    )
    bands.push({
      floor,
      label: `${floor} – ${floor + 100}`,
      minPct: Math.max(maxPct - 5, 0),
      maxPct,
    })
  }
  bands.push({
    floor: Number.NEGATIVE_INFINITY,
    label: `${bottomFloor} 以下`,
    minPct: 100,
    maxPct: 100,
  })
  return bands
}

export const INDEX_POSITION_BANDS = buildIndexPositionBands()

/** 返回点位落入的仓位档位；点位无效时返回 null */
export const pickIndexPositionBand = (
  level: number | null,
): IndexPositionBand | null => {
  if (level === null || !Number.isFinite(level)) return null
  return INDEX_POSITION_BANDS.find((band) => level >= band.floor) ?? null
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

/**
 * 扫雷是否全部通过：只有「明确触发」硬过滤的项才算未通过，
 * 数据缺失（null）按通过处理，避免因公开接口字段缺失而误杀。
 * 与 getRiskItems 的三项（资产负债率、商誉、股权质押）口径一致。
 */
export const riskPassed = (stock: ScoredStock): boolean => {
  if (stock.debtAboveIndustryMedian === true) return false
  if (stock.goodwillRatio !== null && stock.goodwillRatio >= MAX_GOODWILL_RATIO) return false
  if (stock.pledgeRatio !== null && stock.pledgeRatio >= MAX_PLEDGE_RATIO) return false
  return true
}

/**
 * 根据全市场股票 + 上证点位，计算当日市场温度记录。
 *
 * 这是用户端 todayTemperature 与管理端「自动拉取校正」共用的纯函数，
 * 保证两端口径完全一致。
 */
export const computeMarketTemperature = (
  stocks: StockRecord[],
  indexLevel: number | null,
  config: StrategyConfig,
  opts?: {
    historicalPbFloors?: Record<string, number>
    historicalStockPbFloors?: Record<string, number>
  },
): MarketTemperatureRecord => {
  const scored = scoreStocks(
    stocks,
    config,
    opts?.historicalPbFloors,
    opts?.historicalStockPbFloors,
  )
  const market = deriveMarketSnapshot(stocks)
  const indexBand = pickIndexPositionBand(indexLevel)

  return {
    date: new Date().toISOString().slice(0, 10),
    indexLevel,
    exposurePct: indexBand?.maxPct ?? null,
    pbMedian: market.allMarketPb > 0 ? market.allMarketPb : null,
    peMedian: market.allMarketPe > 0 ? market.allMarketPe : null,
    belowNetCount: scored.filter((s) => s.pb !== null && s.pb > 0 && s.pb < 1).length,
    threeLowCount: scored.filter((s) => s.eligible).length,
    riskPassedCount: scored.filter((s) => riskPassed(s)).length,
  }
}
