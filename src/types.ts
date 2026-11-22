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
  /** 腾讯行情快照提供的近 52 周最高价 */
  highPrice1y: number | null
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

/** 上证指数点位对应建议仓位的分档 */
export type IndexPositionBand = {
  /** 区间下沿（含），-Infinity 表示最低档 */
  floor: number
  /** 展示用区间标签，如「3600 – 3700」 */
  label: string
  /** 建议仓位下限（百分比，0~100） */
  minPct: number
  /** 建议仓位上限（百分比，0~100） */
  maxPct: number
}

/** 上证指数快照（按点位定仓位的输入） */
export type IndexSnapshot = {
  /** 当前点位 */
  price: number | null
  /** 近一年最高点位 */
  high1y: number | null
  /** 近一年最低点位 */
  low1y: number | null
}

/** 每日市场温度：把当日关键指标按日期留存，便于回看市场位置变化 */
export type MarketTemperatureRecord = {
  /** 记录日期，形如 2026-11-17 */
  date: string
  /** 当日上证指数点位 */
  indexLevel: number | null
  /** 按上证点位推算的建议仓位上限（百分比） */
  exposurePct: number | null
  /** 全市场 PB 中位数 */
  pbMedian: number | null
  /** 全市场 PE 中位数 */
  peMedian: number | null
  /** 破净股数量（PB 介于 0~1） */
  belowNetCount: number
  /** 命中三低（通过筛选）的股票数 */
  threeLowCount: number
  /** 扫雷全部通过的股票数 */
  riskPassedCount: number
}

/** 个股 PE/PB 历史走势上的一个采样点 */
export type StockValuationPoint = {
  date: string
  pe: number | null
  pb: number | null
}

/** 个股各年度末估值 */
export type StockValuationYearEnd = {
  year: number
  pe: number | null
  pb: number | null
}

/** 个股 PE/PB 历史估值响应 */
export type StockValuationResponse = {
  code: string
  name: string
  /** 季度采样（每季度末）+ 最新交易日的走势点 */
  points: StockValuationPoint[]
  current: { date: string; pe: number | null; pb: number | null }
  /** 当前 PE 在历史正估值样本中的分位（0~100） */
  pePercentile: number | null
  /** 当前 PB 在历史正估值样本中的分位（0~100） */
  pbPercentile: number | null
  peRange: { min: number | null; max: number | null }
  pbRange: { min: number | null; max: number | null }
  /** 各年度末估值，按年份升序 */
  yearEnd: StockValuationYearEnd[]
  /** 参与统计的日频样本数 */
  samples: number
  /** 服务端错误说明，存在时表示无数据 */
  error?: string
  cached?: boolean
  timestamp?: number
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
  /** 同细分行业内的最低正 PB（PB 底），口径与「细分行业」表一致 */
  industryPbFloor: number | null
  /** 个股历史 PB 低点：该股票历史各期最低正 PB（模拟器「个股历史PB低点」口径） */
  stockPbFloor: number | null
  /** 个股 PB 相对行业 PB 底的偏离幅度(%)，越接近 0 越贴近行业底部 */
  pbVsFloorPct: number | null
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

/** 单个细分行业按月的 PB 序列（与 dates 逐项对齐，无样本的位置为 null） */
export type IndustryCycleSeries = {
  /** 市值加权 PB（Σ总市值 / Σ净资产） */
  pb: (number | null)[]
  /** 行业中位数 PB，用于规避超大市值个股主导曲线 */
  median: (number | null)[]
  /** 当月参与统计的个股数量 */
  count: number[]
}

export type IndustryCycleResponse = {
  /** 序列对应的月份列表，格式 YYYY-MM-01 */
  dates: string[]
  /** 细分行业名 → 月度序列 */
  series: Record<string, IndustryCycleSeries>
  cached: boolean
  timestamp: number
  industries: number
}

/** 由月度 PB 序列归纳出的周期特征 */
export type CycleStats = {
  /** 有效月份数 */
  months: number
  current: number | null
  min: number | null
  max: number | null
  minDate: string | null
  maxDate: string | null
  /** 当前 PB 在历史分布中的分位（0~100，越低越接近历史底部） */
  percentile: number | null
  /** 振幅：最高/最低 - 1 */
  amplitude: number | null
  /** 波动率：月度 PB 环比绝对变化的均值 */
  volatility: number | null
  /** 近 12 个月 PB 变化率（%） */
  trend1y: number | null
}

export type DataSourceMeta = {
  name: string
  tradeDate: string
  reportDate: string
  total: number
  klineCount: number
  fetchedAt: string
}

/** 单根日线蜡烛 */
export type Candle = {
  date: string
  open: number | null
  close: number | null
  high: number | null
  low: number | null
  volume: number | null
}

/** 指数日线历史响应（/api/index-history） */
export type IndexHistoryResponse = {
  symbol: string
  candles: Candle[]
  from: string | null
  to: string | null
  requestedYears: number
  fetchedAt: string
  cached?: boolean
  error?: string
}

/** 牛熊顶底点（由指数收盘价序列自动识别） */
export type CyclePivot = {
  /** high=顶部，low=底部 */
  type: 'high' | 'low'
  /** 在日线序列中的下标 */
  index: number
  date: string
  price: number
}

/** 由相邻顶底点归纳出的牛熊阶段 */
export type MarketPhase = {
  /** 阶段序号，从 1 开始 */
  seq: number
  /** bull=牛市（底部→顶部），bear=熊市（顶部→底部） */
  kind: 'bull' | 'bear'
  startDate: string
  startPrice: number
  endDate: string
  endPrice: number
  /** 区间涨跌幅（%） */
  changePct: number
  /** 区间交易日数 */
  tradingDays: number
  /** 区间自然日天数 */
  calendarDays: number
  /** 是否为仍在进行中的最后一段 */
  ongoing: boolean
}

/** 牛熊识别结果 */
export type MarketCycleResult = {
  pivots: CyclePivot[]
  phases: MarketPhase[]
  /** 当前所处阶段（取 phases 最后一段） */
  current: MarketPhase | null
}

