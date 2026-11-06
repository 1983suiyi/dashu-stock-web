export type StockRecord = {
  code: string
  name: string
  /** 模拟器口径的一级行业 */
  sector: string
  /** 模拟器口径的细分行业 */
  industry: string
  /** 原始数据源行业名，便于对表与回溯 */
  sourceIndustry?: string
  /** 现价：东财交易日快照打底，补 K 线时优先用腾讯最新价覆盖 */
  price: number | null
  pb: number | null
  pe: number | null
  ps: number | null
  roe: number | null
  debtRatio: number | null
  marketCap: number | null
  /** 股息率(%)：近 12 个月已实施税前派息 / 现价 × 100，无分红记录时为 0 */
  dividendYield: number | null
  /** 商誉占净资产(%)：取最新报告期，缺失时按 0 处理 */
  goodwillRatio: number | null
  /** 股权质押比例(%)：取最新交易日，缺失时按 0 处理 */
  pledgeRatio: number | null
  /** 前复权一年内最低价，由后端 K 线代理补齐 */
  lowPrice1y: number | null
  /** 前复权三年内最低价，由后端 K 线代理补齐 */
  lowPrice3y: number | null
  isST: boolean
}

export type MarketSnapshot = {
  allMarketPb: number
  allMarketPe: number
}

export type StrategyConfig = {
  /** 历史折扣 PB。>=1 时估值区间下限为 1.0，<1 时按 0.618 + 折扣×0.382 收敛 */
  discount: number
  /** 三好学生评分门槛，满分 300 */
  scoreThreshold: number
  /** 股息率下限(%) */
  minDividendYield: number
  /** 资产负债率宽容幅度：允许高于行业中位数多少（0.15 = 中位数 × 1.15） */
  debtMedianTolerance: number
  /** 满配过滤：单个行业持仓权重上限 */
  maxIndustryWeight: number
  /** 总权益仓位上限，默认 2/3 */
  maxEquityExposure: number
  /** K 线回溯自然日天数 */
  klineDays: number
  /** 两阶段剪枝：最多为多少只候选补 K 线 */
  maxKlineCandidates: number
}

export type ScoredStock = StockRecord & {
  pbScore: number | null
  peScore: number | null
  priceScore: number | null
  gain1y: number | null
  gain3y: number | null
  /** 当前公开口径的扫雷结果：100=未触发高风险硬过滤，越低风险越高 */
  mineScore: number
  /** 三项之和，满分 300；K 线缺失时为 PB+PE 两项之和 */
  totalScore: number
  /** 绝对胜算概率(%) = 总分 / 3 */
  winProbability: number | null
  pbBand: [number, number]
  peBand: [number, number]
  industryDebtMedian: number | null
  /** 行业中位数叠加宽容幅度后的判定上限 */
  industryDebtMedianLimit: number | null
  debtAboveIndustryMedian: boolean | null
  eligible: boolean
  notes: string[]
  missingFields: string[]
}

export type PortfolioHolding = {
  code: string
  name: string
  industry: string
  score: number
  winProbability: number | null
  targetWeight: number
  reason: string
}

export type IndustrySummary = {
  industry: string
  stockCount: number
  eligibleCount: number
  avgDebtRatio: number | null
  pbFloor: number | null
  pb: number | null
  pbGain: number | null
  pe: number | null
  marketCap: number | null
  netAsset: number | null
  bestStockCode: string | null
  bestStockName: string | null
}

export type PortfolioIndustrySummary = {
  industry: string
  holdingCount: number
  targetWeight: number
  avgScore: number
  avgWinProbability: number | null
  codes: string[]
}

export type KlineResult = {
  low1y: number | null
  low3y: number | null
  high1y: number | null
  lastClose: number | null
  from: string | null
  to: string | null
}

export type DataSourceMeta = {
  name: string
  tradeDate: string
  reportDate: string
  total: number
  klineCount: number
  fetchedAt: string
}
