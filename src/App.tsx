import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defaultConfig, defaultMarketSnapshot, demoStocks } from './data/stocks'
import { downloadCsv, toCsv } from './lib/csv'
import { fetchRealMarketData, fetchStockByCode } from './lib/eastmoney'
import { normalizeIndustry } from './lib/industry'
import {
  applyKline,
  fetchIndexSnapshot,
  fetchKlines,
  toSymbol,
} from './lib/kline'
import {
  CYCLICAL_STRONG_THRESHOLD,
  classifyCyclical,
  computeCycleStats,
  formatMonth,
  scoreCyclicality,
} from './lib/cycle'
import { IndustryCycleChart } from './components/IndustryCycleChart'
import { StockValuationChart } from './components/StockValuationChart'
import { UserMenu } from './auth/UserMenu'
import { syncSave } from './auth/sync'
import { apiGet, apiSend } from './auth/api'
import {
  buildAiHighlights,
  explainStockExclusion,
  summarizeIndustries,
  summarizePortfolioIndustries,
} from './lib/analytics'
import {
  INDEX_POSITION_BANDS,
  MAX_GOODWILL_RATIO,
  MAX_PLEDGE_RATIO,
  MAX_SCORE,
  PB_FLOOR_FAR_PCT,
  PB_FLOOR_NEAR_PCT,
  deriveMarketSnapshot,
  matchesTripleLow,
  pbBand,
  peBand,
  pickIndexPositionBand,
  pickKlineCandidates,
  portfolioExposure,
  recommendPortfolio,
  scoreStocks,
  summarizeMarket,
  TRIPLE_LOW_PRESETS,
} from './lib/strategy'
import type { TripleLowTier } from './lib/strategy'
import type {
  DataSourceMeta,
  IndexSnapshot,
  MarketSnapshot,
  MarketTemperatureRecord,
  PortfolioHolding,
  KlineResult,
  CycleStats,
  IndustryCycleResponse,
  ScoredStock,
  StockRecord,
  StockValuationResponse,
  StrategyConfig,
} from './types'
import type { CyclicalityScore } from './lib/cycle'

const researchHighlights = [
  {
    title: '组合投资',
    detail:
      '用分层抽样替代单点押注：先覆盖行业，再在行业内找估值更低的样本企业。',
  },
  {
    title: '低估值建仓',
    detail:
      'PB 与 PE 各自映射成 0~100 分，只有在估值区间下沿才拿满分，价格越贵得分越低。',
  },
  {
    title: '长期持有',
    detail:
      '一年内最低价到现价的涨幅越低，得分越高，鼓励在价格低位而不是高位建仓。',
  },
  {
    title: '2/3 仓位上限',
    detail:
      '200 分门槛等于绝对胜算概率 66.67%，与 2/3 仓位约束同源，给极端行情留缓冲。',
  },
]

const csvHeaders = [
  'code',
  'name',
  'sector',
  'industry',
  'sourceIndustry',
  'price',
  'pb',
  'pe',
  'ps',
  'roe',
  'debtRatio',
  'dividendYield',
  'marketCap',
  'highPrice1y',
  'lowPrice1y',
  'lowPrice3y',
  'goodwillRatio',
  'pledgeRatio',
  'isST',
]

type WorkspaceView =
  | 'overview'
  | 'scores'
  | 'portfolio'
  | 'portfolioSummary'
  | 'industries'
  | 'cycle'
  | 'archives'
  | 'ai'

type ArchiveSnapshot = {
  id: string
  label: string
  createdAt: string
  stocks: StockRecord[]
  config: StrategyConfig
  market: MarketSnapshot
  dataMeta: DataSourceMeta | null
}

type HoldingImport = {
  code: string
  name: string
  weight: number | null
  costPrice: number | null
  source: 'manual' | 'csv'
}

type HoldingDetail = PortfolioHolding & {
  sector: string
  price: number | null
  pb: number | null
  pe: number | null
  costPrice: number | null
  sourceLabel: string
  weightKnown: boolean
}

type CapitalEventType = '入金' | '出金' | '分红' | '取现'

type CycleSortKey =
  | 'score'
  | 'current'
  | 'floor'
  | 'percentile'
  | 'amplitude'
  | 'trend1y'

type CycleRow = {
  industry: string
  /** 命中的预置周期行业分组，未命中为 null */
  group: string | null
  stats: CycleStats
  score: CyclicalityScore
}

type CapitalEvent = {
  id: string
  date: string
  type: CapitalEventType
  amount: number
  note: string
}

/** 大数评分表可排序的列 */
type ScoreSortKey =
  | 'name'
  | 'industry'
  | 'holding'
  | 'score'
  | 'pb'
  | 'stockPbFloor'
  | 'pe'
  | 'price'
  | 'gain1y'
  | 'gain3y'
  | 'mine'
  | 'marketCap'
  | 'dividendYield'
  | 'pledgeRatio'
  | 'goodwillRatio'
  | 'debtRatio'
  | 'eligible'

type SortDirection = 'asc' | 'desc'

/** 评分表范围：全部 / 三低池（通过筛选）/ 排雷通过 */
type ScoreScope = 'all' | 'eligible' | 'riskPassed'

/** 文本类列默认升序，数值类列默认降序 */
const TEXT_SORT_KEYS: ScoreSortKey[] = ['name', 'industry']

const ARCHIVE_STORAGE_KEY = 'dashu-workspace-archives'
const HOLDING_STORAGE_KEY = 'dashu-user-holdings'
const CASH_BALANCE_STORAGE_KEY = 'dashu-cash-balance'
const TOTAL_ASSETS_STORAGE_KEY = 'dashu-total-assets'
const CAPITAL_EVENTS_STORAGE_KEY = 'dashu-capital-events'
/** 全市场数据缓存：同一天内刷新页面直接复用，避免重复拉取 */
const MARKET_CACHE_KEY = 'dashu-market-cache'
/** 当天已补齐的 K 线结果，按代码增量保存，避免重复请求 */
const DAILY_KLINE_CACHE_KEY = 'dashu-daily-kline-cache'
const INDEX_CACHE_KEY = 'dashu-index-snapshot'
const MARKET_TEMPERATURE_CACHE_KEY = 'dashu-market-temperature'

const navItems: Array<{ key: WorkspaceView; label: string }> = [
  { key: 'overview', label: '市场概况' },
  { key: 'scores', label: '大数评分' },
  { key: 'portfolio', label: '持仓' },
  { key: 'portfolioSummary', label: '持仓汇总' },
  { key: 'industries', label: '细分行业' },
  { key: 'cycle', label: '周期行业' },
  { key: 'archives', label: '归档' },
  { key: 'ai', label: 'AI' },
]

const parseBoolean = (value: string) =>
  ['true', '1', 'yes', 'y', '是'].includes(value.trim().toLowerCase())

const splitCsvLine = (line: string) => {
  const cells: string[] = []
  let current = ''
  let inQuotes = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]

    if (char === '"') {
      const next = line[index + 1]
      if (inQuotes && next === '"') {
        current += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      cells.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  cells.push(current.trim())
  return cells
}

/** 空单元格统一解析为 null，避免 Number('') = 0 污染估值判定 */
const parseNumberCell = (value: string): number | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

const parseLooseNumber = (value: string): number | null => {
  const trimmed = value.trim().replace(/,/g, '').replace(/%/g, '')
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

const toRatio = (value: string): number | null => {
  const parsed = parseLooseNumber(value)
  if (parsed === null) return null
  if (parsed > 0 && parsed <= 1) return parsed
  if (parsed > 1 && parsed <= 100) return parsed / 100
  return null
}

const normalizeCode = (value: string) => {
  const matched = value.match(/\d{6}/)
  return matched ? matched[0] : ''
}

const headerIndexOf = (headers: string[], aliases: string[]) => {
  const normalizedAliases = aliases.map((item) => normalize(item))
  return headers.findIndex((header) =>
    normalizedAliases.includes(normalize(header.replace(/\uFEFF/g, ''))),
  )
}

const parseCsv = (text: string): StockRecord[] => {
  const rows = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (rows.length <= 1) return []

  const headers = splitCsvLine(rows[0])
  return rows.slice(1).map((row) => {
    const values = splitCsvLine(row)
    const get = (key: string) => values[headers.indexOf(key)] ?? ''
    const sourceIndustry = get('sourceIndustry') || get('industry')
    const { sector, industry } = normalizeIndustry(sourceIndustry)

    return {
      code: get('code'),
      name: get('name'),
      sector,
      industry,
      sourceIndustry,
      price: parseNumberCell(get('price')),
      pb: parseNumberCell(get('pb')),
      pe: parseNumberCell(get('pe')),
      ps: parseNumberCell(get('ps')),
      roe: parseNumberCell(get('roe')),
      debtRatio: parseNumberCell(get('debtRatio')),
      marketCap: parseNumberCell(get('marketCap')),
      dividendYield: parseNumberCell(get('dividendYield')),
      goodwillRatio: parseNumberCell(get('goodwillRatio')),
      pledgeRatio: parseNumberCell(get('pledgeRatio')),
      highPrice1y: parseNumberCell(get('highPrice1y')),
      lowPrice1y: parseNumberCell(get('lowPrice1y')),
      lowPrice3y: parseNumberCell(get('lowPrice3y')),
      isST: parseBoolean(get('isST')),
    }
  })
}

const parseHoldingsCsv = (text: string): HoldingImport[] => {
  const rows = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (rows.length <= 1) return []

  const headers = splitCsvLine(rows[0])
  const codeIndex = headerIndexOf(headers, ['code', '代码', '证券代码', '股票代码'])
  if (codeIndex < 0) return []

  const nameIndex = headerIndexOf(headers, ['name', '名称', '证券名称', '股票名称'])
  const weightIndex = headerIndexOf(headers, [
    'weight',
    '仓位',
    '持仓占比',
    '持仓比例',
    '仓位占比',
    '权重',
    '目标权重',
  ])
  const costPriceIndex = headerIndexOf(headers, [
    'costprice',
    '成本价',
    '成本',
    '买入价',
    '买入均价',
    '成交均价',
  ])
  const marketValueIndex = headerIndexOf(headers, [
    '市值',
    '持仓市值',
    '参考市值',
    '证券市值',
    '最新市值',
  ])

  const rawItems = rows
    .slice(1)
    .map((row) => splitCsvLine(row))
    .map((values) => ({
      code: normalizeCode(values[codeIndex] ?? ''),
      name: nameIndex >= 0 ? (values[nameIndex] ?? '').trim() : '',
      weight: weightIndex >= 0 ? toRatio(values[weightIndex] ?? '') : null,
      costPrice:
        costPriceIndex >= 0 ? parseLooseNumber(values[costPriceIndex] ?? '') : null,
      marketValue:
        marketValueIndex >= 0 ? parseLooseNumber(values[marketValueIndex] ?? '') : null,
    }))
    .filter((item) => item.code)

  if (rawItems.length === 0) return []

  const hasDirectWeight = rawItems.some((item) => item.weight !== null)
  const totalMarketValue = rawItems.reduce(
    (sum, item) => sum + Math.max(0, item.marketValue ?? 0),
    0,
  )

  const grouped = new Map<string, HoldingImport>()
  for (const item of rawItems) {
    const existing = grouped.get(item.code)
    const derivedWeight =
      item.weight ??
      (!hasDirectWeight && totalMarketValue > 0 && item.marketValue !== null
        ? item.marketValue / totalMarketValue
        : null)

    if (existing) {
      grouped.set(item.code, {
        ...existing,
        name: existing.name || item.name,
        costPrice: existing.costPrice ?? item.costPrice,
        weight:
          existing.weight !== null && derivedWeight !== null
            ? existing.weight + derivedWeight
            : existing.weight ?? derivedWeight,
      })
      continue
    }

    grouped.set(item.code, {
      code: item.code,
      name: item.name,
      weight: derivedWeight,
      costPrice: item.costPrice,
      source: 'csv',
    })
  }

  return [...grouped.values()]
}

const fixed = (value: number | null, digits = 2) =>
  value === null ? '' : value.toFixed(digits)

const show = (value: number | null, digits = 2) =>
  value === null ? '—' : value.toFixed(digits)

const percent = (value: number | null, digits = 2) =>
  value === null ? '' : `${(value * 100).toFixed(digits)}`

const percentView = (value: number | null, digits = 1) =>
  value === null ? '—' : `${value.toFixed(digits)}%`

const gainView = (value: number | null, digits = 0) =>
  value === null ? '—' : `${(value * 100).toFixed(digits)}%`

const yi = (value: number | null, digits = 0) =>
  value === null ? '—' : (value / 1e8).toFixed(digits)

/**
 * 个股 PB 相对「行业 PB 底」的偏离分档：
 * 贴近底部（≤10%）为绿色，偏离 10%~20% 为黄色，≥20% 为红色。
 */
const pbFloorClass = (value: number | null) => {
  if (value === null) return 'pb-level'
  if (value >= PB_FLOOR_FAR_PCT) return 'pb-level pb-level-high'
  if (value > PB_FLOOR_NEAR_PCT) return 'pb-level pb-level-mid'
  return 'pb-level pb-level-low'
}

const pbFloorTitle = (stock: ScoredStock) => {
  if (stock.pbVsFloorPct === null || stock.industryPbFloor === null) {
    return '行业 PB 底缺失，暂无法比较'
  }
  return `距行业 PB 底 +${stock.pbVsFloorPct.toFixed(1)}%（${stock.industry} PB 底 ${stock.industryPbFloor.toFixed(2)}）`
}

/** 扫雷三项的结构化结果：资产负债率、商誉、股权质押 */
type RiskItem = {
  key: 'debt' | 'goodwill' | 'pledge'
  label: string
  /** 右侧展示值，如「正常」「+4.0pp」「56.3%」 */
  value: string
  /** 阈值与口径说明 */
  detail: string
  /** true=触发硬过滤, false=通过, null=数据缺失 */
  triggered: boolean | null
}

const getRiskItems = (stock: ScoredStock): RiskItem[] => {
  const items: RiskItem[] = []

  // 1. 资产负债率 vs 行业中位数宽容上限
  if (stock.debtRatio !== null && stock.industryDebtMedianLimit !== null) {
    const median = stock.industryDebtMedian ?? 0
    const deviation = stock.debtRatio - median
    items.push({
      key: 'debt',
      label: '资产负债率偏离同行业中位',
      value:
        stock.debtAboveIndustryMedian === true
          ? `${deviation >= 0 ? '+' : ''}${deviation.toFixed(1)}pp`
          : '正常',
      detail: `本公司 ${stock.debtRatio.toFixed(1)}%，行业中位 ${median.toFixed(1)}%（宽容上限 ${stock.industryDebtMedianLimit.toFixed(1)}%）`,
      triggered: stock.debtAboveIndustryMedian,
    })
  } else {
    items.push({
      key: 'debt',
      label: '资产负债率偏离同行业中位',
      value: '数据缺失',
      detail: '资产负债率或行业中位数缺失，暂无法判定',
      triggered: null,
    })
  }

  // 2. 商誉占净资产
  if (stock.goodwillRatio !== null) {
    items.push({
      key: 'goodwill',
      label: '商誉 / 净资产',
      value: `${stock.goodwillRatio.toFixed(1)}%`,
      detail: `商誉占净资产比例，阈值 ${MAX_GOODWILL_RATIO}%`,
      triggered: stock.goodwillRatio >= MAX_GOODWILL_RATIO,
    })
  } else {
    items.push({
      key: 'goodwill',
      label: '商誉 / 净资产',
      value: '数据缺失',
      detail: `阈值 ${MAX_GOODWILL_RATIO}%`,
      triggered: null,
    })
  }

  // 3. 股权质押比例
  if (stock.pledgeRatio !== null) {
    items.push({
      key: 'pledge',
      label: '股权质押比例',
      value: `${stock.pledgeRatio.toFixed(1)}%`,
      detail: `全部股东质押合计 / 总股本，阈值 ${MAX_PLEDGE_RATIO}%`,
      triggered: stock.pledgeRatio >= MAX_PLEDGE_RATIO,
    })
  } else {
    items.push({
      key: 'pledge',
      label: '股权质押比例',
      value: '数据缺失',
      detail: `阈值 ${MAX_PLEDGE_RATIO}%`,
      triggered: null,
    })
  }

  return items
}

/** 触发硬过滤的扫雷项数量（null 表示数据缺失，不计入） */
const riskTriggeredCount = (stock: ScoredStock) =>
  getRiskItems(stock).filter((item) => item.triggered === true).length

/** 扫雷是否全部通过：只有明确触发的项才算未通过，数据缺失按通过处理 */
const riskPassed = (stock: ScoredStock) => riskTriggeredCount(stock) === 0

/** 金融行业（银行/保险/证券/多元金融），大数投资原则不纳入组合 */
const FINANCIAL_KEYWORDS = ['银行', '保险', '证券', '多元金融', '非银金融', '金融服务']
const isFinancialStock = (stock: ScoredStock) =>
  FINANCIAL_KEYWORDS.some(
    (keyword) => stock.sector.includes(keyword) || stock.industry.includes(keyword),
  )

const normalize = (value: string) => value.trim().toLowerCase()
const todayText = () => new Date().toISOString().slice(0, 10)

/** 全市场数据缓存结构 */
type MarketCache = {
  date: string
  fetchedAt: string
  stocks: StockRecord[]
  meta: DataSourceMeta
  market: MarketSnapshot
}

type DailyKlineCache = {
  date: string
  days: number
  entries: Record<string, KlineResult>
  completed: boolean
}

const loadDailyKlineCache = (days: number): DailyKlineCache | null => {
  try {
    const raw = localStorage.getItem(DAILY_KLINE_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DailyKlineCache
    if (
      parsed.date !== todayText() ||
      parsed.days !== days ||
      !parsed.entries ||
      typeof parsed.entries !== 'object'
    ) {
      return null
    }
    return {
      ...parsed,
      completed: parsed.completed === true,
    }
  } catch {
    return null
  }
}

const createDailyKlineCache = (days: number): DailyKlineCache => ({
  date: todayText(),
  days,
  entries: {},
  completed: false,
})

const saveDailyKlineCache = (cache: DailyKlineCache): boolean => {
  try {
    localStorage.setItem(DAILY_KLINE_CACHE_KEY, JSON.stringify(cache))
    return true
  } catch {
    return false
  }
}

/** 从 localStorage 加载当天缓存，若非当天或数据损坏则返回 null */
const loadMarketCache = (): MarketCache | null => {
  try {
    const raw = localStorage.getItem(MARKET_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as MarketCache
    if (parsed.date !== todayText()) return null
    if (!Array.isArray(parsed.stocks) || parsed.stocks.length === 0) return null
    if (!parsed.meta || !parsed.market) return null
    return parsed
  } catch {
    return null
  }
}

/** 将拉取结果写入 localStorage；超出容量时静默失败，内存态仍可用 */
const saveMarketCache = (cache: MarketCache) => {
  try {
    localStorage.setItem(MARKET_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // localStorage 超限（全市场数据可能较大），忽略，下次刷新会重新拉取
  }
}

/** 上证指数快照缓存结构 */
type IndexCache = {
  date: string
  snapshot: IndexSnapshot
}

const loadIndexCache = (): IndexCache | null => {
  try {
    const raw = localStorage.getItem(INDEX_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as IndexCache
    if (parsed.date !== todayText() || !parsed.snapshot) return null
    return parsed
  } catch {
    return null
  }
}

const saveIndexCache = (cache: IndexCache) => {
  try {
    localStorage.setItem(INDEX_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // 缓存失败不影响主流程
  }
}

/** 读取每日市场温度记录（按日期倒序，最多保留 240 个交易日） */
const loadMarketTemperature = (): MarketTemperatureRecord[] => {
  try {
    const raw = localStorage.getItem(MARKET_TEMPERATURE_CACHE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as MarketTemperatureRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * 按日期写入/覆盖当日温度记录并倒序保存。
 * 内容与已有当日记录完全一致时返回原数组，避免无谓的重渲染。
 * 同时异步写入服务端公共 market_temperature 表（所有用户共享一份）。
 */
const upsertMarketTemperature = (
  records: MarketTemperatureRecord[],
  record: MarketTemperatureRecord,
): MarketTemperatureRecord[] => {
  const existing = records.find((item) => item.date === record.date)
  if (existing && JSON.stringify(existing) === JSON.stringify(record)) {
    return records
  }
  const next = [record, ...records.filter((item) => item.date !== record.date)]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 240)
  try {
    localStorage.setItem(MARKET_TEMPERATURE_CACHE_KEY, JSON.stringify(next))
  } catch {
    // 缓存失败不影响主流程
  }
  // 异步同步到服务端公共表；失败不影响本地
  apiSend<{ updated: boolean }>('/api/market-temperature', 'POST', { record }).catch(() => {})
  return next
}
const currency = (value: number | null, digits = 0) =>
  value === null ? '—' : value.toFixed(digits)
const signedCapitalAmount = (event: Pick<CapitalEvent, 'type' | 'amount'>) =>
  event.type === '入金' || event.type === '分红' ? event.amount : -event.amount
const weightedAverage = (
  items: Array<{ weight: number; value: number | null }>,
) => {
  const valid = items.filter((item) => item.weight > 0 && item.value !== null)
  const totalWeight = valid.reduce((sum, item) => sum + item.weight, 0)
  if (totalWeight <= 0) return null
  return valid.reduce((sum, item) => sum + item.weight * (item.value ?? 0), 0) / totalWeight
}

function App() {
  const [stocks, setStocks] = useState<StockRecord[]>(demoStocks)
  const [config, setConfig] = useState<StrategyConfig>(defaultConfig)
  const [market, setMarket] = useState(defaultMarketSnapshot)
  const [message, setMessage] = useState('当前使用内置演示数据。')
  const [warning, setWarning] = useState('')
  const [dataMeta, setDataMeta] = useState<DataSourceMeta | null>(null)
  const [indexSnapshot, setIndexSnapshot] = useState<IndexSnapshot | null>(null)
  const [marketTemperature, setMarketTemperature] = useState<
    MarketTemperatureRecord[]
  >(() => loadMarketTemperature())

  // 挂载时从服务端公共表拉取市场温度，覆盖本地缓存
  useEffect(() => {
    let active = true
    apiGet<{ records: MarketTemperatureRecord[] }>('/api/market-temperature').then((result) => {
      if (active && result.ok && result.data.records?.length) {
        setMarketTemperature(result.data.records)
        try {
          localStorage.setItem(MARKET_TEMPERATURE_CACHE_KEY, JSON.stringify(result.data.records))
        } catch {
          // 缓存失败不影响主流程
        }
      }
    })
    return () => {
      active = false
    }
  }, [])
  const [indexLoading, setIndexLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [fullKlineCompleted, setFullKlineCompleted] = useState(false)
  const [scoreScope, setScoreScope] = useState<ScoreScope>('all')
  const [excludeFinancial, setExcludeFinancial] = useState(false)
  const [onlyNearPbFloor, setOnlyNearPbFloor] = useState(false)
  const [tripleLowTier, setTripleLowTier] = useState<TripleLowTier>('off')
  const [scoreQuery, setScoreQuery] = useState('')
  const [queryingHighCode, setQueryingHighCode] = useState<string | null>(null)
  const lastAutoHighQueryRef = useRef<string | null>(null)
  const [scoreSortKey, setScoreSortKey] = useState<ScoreSortKey | null>(null)
  const [scoreSortDirection, setScoreSortDirection] = useState<SortDirection>('desc')
  const [activeView, setActiveView] = useState<WorkspaceView>('overview')
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [stockQuery, setStockQuery] = useState('000589')
  const [industryQuery, setIndustryQuery] = useState('')
  const [snapshots, setSnapshots] = useState<ArchiveSnapshot[]>([])
  const [holdingImports, setHoldingImports] = useState<HoldingImport[]>([])
  const [holdingCodeInput, setHoldingCodeInput] = useState('')
  const [holdingWeightInput, setHoldingWeightInput] = useState('')
  const [holdingCostInput, setHoldingCostInput] = useState('')
  const [cashBalance, setCashBalance] = useState(0)
  const [cashBalanceInput, setCashBalanceInput] = useState('0')
  const [totalAssets, setTotalAssets] = useState<number | null>(null)
  const [totalAssetsInput, setTotalAssetsInput] = useState('')
  const [capitalEvents, setCapitalEvents] = useState<CapitalEvent[]>([])
  const [capitalDateInput, setCapitalDateInput] = useState(todayText())
  const [historicalPbFloors, setHistoricalPbFloors] = useState<Record<string, number> | null>(null)
  const [historicalStockPbFloors, setHistoricalStockPbFloors] = useState<Record<string, number> | null>(null)
  const [industryCycle, setIndustryCycle] = useState<IndustryCycleResponse | null>(null)
  const [industryCycleLoading, setIndustryCycleLoading] = useState(true)
  const [industryCycleError, setIndustryCycleError] = useState<string | null>(null)
  const [industryCycleFetchAttempt, setIndustryCycleFetchAttempt] = useState(0)
  const [cycleQuery, setCycleQuery] = useState('')
  const [cycleSelectValue, setCycleSelectValue] = useState('')
  const [cycleOnlyCyclical, setCycleOnlyCyclical] = useState(true)
  const [cycleMinScore, setCycleMinScore] = useState(0)
  const [cycleMinScoreInput, setCycleMinScoreInput] = useState('0')
  const [cycleSortKey, setCycleSortKey] = useState<CycleSortKey>('score')
  const [cycleSortDirection, setCycleSortDirection] = useState<SortDirection>('desc')
  const [stockValuation, setStockValuation] =
    useState<StockValuationResponse | null>(null)
  const [stockValuationLoading, setStockValuationLoading] = useState(false)
  const [stockValuationError, setStockValuationError] = useState<string | null>(
    null,
  )
  const [selectedCycleIndustry, setSelectedCycleIndustry] = useState<string | null>(null)
  const [capitalTypeInput, setCapitalTypeInput] = useState<CapitalEventType>('入金')
  const [capitalAmountInput, setCapitalAmountInput] = useState('')
  const [capitalNoteInput, setCapitalNoteInput] = useState('')

  // 用于在挂载 effect 中调用最新的 handleFetchAll，避免依赖闭包过期
  const fetchAllRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    try {
      const raw = localStorage.getItem(ARCHIVE_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as ArchiveSnapshot[]
      setSnapshots(Array.isArray(parsed) ? parsed : [])
    } catch {
      setSnapshots([])
    }
  }, [])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HOLDING_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as HoldingImport[]
      setHoldingImports(Array.isArray(parsed) ? parsed : [])
    } catch {
      setHoldingImports([])
    }
  }, [])

  useEffect(() => {
    syncSave('holdings', holdingImports)
  }, [holdingImports])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CASH_BALANCE_STORAGE_KEY)
      if (!raw) return
      const parsed = Number(raw)
      if (Number.isFinite(parsed)) {
        setCashBalance(parsed)
        setCashBalanceInput(parsed.toFixed(2))
      }
    } catch {
      setCashBalance(0)
      setCashBalanceInput('0')
    }
  }, [])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(TOTAL_ASSETS_STORAGE_KEY)
      if (!raw) return
      const parsed = Number(raw)
      if (Number.isFinite(parsed) && parsed > 0) {
        setTotalAssets(parsed)
        setTotalAssetsInput(parsed.toFixed(2))
      }
    } catch {
      setTotalAssets(null)
      setTotalAssetsInput('')
    }
  }, [])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CAPITAL_EVENTS_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as CapitalEvent[]
      setCapitalEvents(Array.isArray(parsed) ? parsed : [])
    } catch {
      setCapitalEvents([])
    }
  }, [])

  // 拉取服务端按「大数模拟器」口径计算的行业历史统计 PB 底
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch('/api/pb-floor')
        if (!resp.ok) return
        const data = await resp.json()
        if (cancelled) return
        if (data && data.floors && typeof data.floors === 'object') {
          setHistoricalPbFloors(data.floors)
        }
        if (data && data.stockFloors && typeof data.stockFloors === 'object') {
          setHistoricalStockPbFloors(data.stockFloors)
        }
      } catch {
        // 服务端不可用时静默回退到截面最低 PB
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 拉取服务端缓存的行业 PB 月度序列（数据源从 2018 年起可用）
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setIndustryCycleLoading(true)
      setIndustryCycleError(null)
      try {
        const resp = await fetch('/api/industry-cycle')
        if (!resp.ok) {
          throw new Error(`接口请求失败（HTTP ${resp.status}）`)
        }
        const contentType = resp.headers.get('content-type') ?? ''
        if (!contentType.includes('application/json')) {
          throw new Error('当前服务未提供行业周期数据接口，请重启应用服务后重试')
        }
        const data = (await resp.json()) as IndustryCycleResponse
        if (cancelled) return
        if (!data || !Array.isArray(data.dates) || !data.series) {
          throw new Error('行业周期接口返回的数据格式不正确')
        }
        setIndustryCycle(data)
      } catch (error) {
        if (!cancelled) {
          setIndustryCycleError(
            error instanceof Error
              ? error.message
              : '行业周期数据加载失败，请检查服务端状态后重试',
          )
        }
      } finally {
        if (!cancelled) setIndustryCycleLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [industryCycleFetchAttempt])

  useEffect(() => {
    syncSave('cash', cashBalance)
  }, [cashBalance])

  useEffect(() => {
    syncSave('totalAssets', totalAssets)
  }, [totalAssets])

  useEffect(() => {
    syncSave('capitalEvents', capitalEvents)
  }, [capitalEvents])

  const scoredStocks = useMemo(
    () =>
      scoreStocks(
        stocks,
        config,
        historicalPbFloors ?? undefined,
        historicalStockPbFloors ?? undefined,
      ),
    [stocks, config, historicalPbFloors, historicalStockPbFloors],
  )
  const eligibleStocks = useMemo(
    () => scoredStocks.filter((stock) => stock.eligible),
    [scoredStocks],
  )
  const portfolio = useMemo(
    () => recommendPortfolio(scoredStocks, config, market),
    [scoredStocks, config, market],
  )
  const holdingDetails = useMemo<HoldingDetail[]>(() => {
    return holdingImports
      .map((item) => {
        const scoredMatched = scoredStocks.find((stock) => stock.code === item.code)
        const stockMatched =
          scoredMatched ?? stocks.find((stock) => stock.code === item.code)

        return {
          code: item.code,
          name: stockMatched?.name ?? item.name ?? item.code,
          sector: stockMatched?.sector ?? '—',
          industry: stockMatched?.industry ?? '未匹配',
          score: scoredMatched?.totalScore ?? 0,
          winProbability: scoredMatched?.winProbability ?? null,
          targetWeight: item.weight ?? 0,
          weightKnown: item.weight !== null,
          price: stockMatched?.price ?? null,
          pb: stockMatched?.pb ?? null,
          pe: stockMatched?.pe ?? null,
          costPrice: item.costPrice,
          reason: item.source === 'manual' ? '手动添加' : 'CSV 导入',
          sourceLabel: item.source === 'manual' ? '手动添加' : '同花顺/CSV 导入',
        }
      })
      .sort((a, b) => (b.targetWeight || 0) - (a.targetWeight || 0) || b.score - a.score)
  }, [holdingImports, scoredStocks, stocks])
  const holdingWeightByCode = useMemo(
    () => new Map(holdingDetails.map((item) => [item.code, item.targetWeight])),
    [holdingDetails],
  )
  const knownHoldingWeight = useMemo(
    () =>
      holdingDetails.reduce(
        (sum, item) => sum + (item.weightKnown ? Math.max(0, item.targetWeight) : 0),
        0,
      ),
    [holdingDetails],
  )
  const derivedTotalAsset = useMemo(() => {
    if (knownHoldingWeight < 0) return null
    if (knownHoldingWeight >= 1) return null
    return cashBalance / (1 - knownHoldingWeight)
  }, [cashBalance, knownHoldingWeight])
  /** 手动填写的总资产优先；留空时回退到「按持仓占比推算」 */
  const effectiveTotalAsset = totalAssets ?? derivedTotalAsset
  const estimatedHoldingMarketValue = useMemo(() => {
    if (effectiveTotalAsset === null) return null
    if (totalAssets !== null) return Math.max(0, effectiveTotalAsset - cashBalance)
    return effectiveTotalAsset * knownHoldingWeight
  }, [effectiveTotalAsset, totalAssets, cashBalance, knownHoldingWeight])
  /** 手动填写总资产时按金额算仓位，否则沿用持仓占比合计 */
  const currentPositionRatio = useMemo(() => {
    if (totalAssets === null || totalAssets <= 0) return knownHoldingWeight
    return Math.min(1, Math.max(0, (estimatedHoldingMarketValue ?? 0) / totalAssets))
  }, [totalAssets, estimatedHoldingMarketValue, knownHoldingWeight])
  const capitalNetFlow = useMemo(
    () => capitalEvents.reduce((sum, item) => sum + signedCapitalAmount(item), 0),
    [capitalEvents],
  )
  const holdingWeightedPb = useMemo(
    () =>
      weightedAverage(
        holdingDetails.map((item) => ({
          weight: item.weightKnown ? item.targetWeight : 0,
          value: item.pb,
        })),
      ),
    [holdingDetails],
  )
  const holdingWeightedPe = useMemo(
    () =>
      weightedAverage(
        holdingDetails.map((item) => ({
          weight: item.weightKnown ? item.targetWeight : 0,
          value: item.pe,
        })),
      ),
    [holdingDetails],
  )
  const estimatedFloatingProfit = useMemo(() => {
    if (estimatedHoldingMarketValue === null || estimatedHoldingMarketValue <= 0) {
      return null
    }
    if (knownHoldingWeight <= 0) return null
    const profit = holdingDetails.reduce((sum, item) => {
      if (!item.weightKnown || item.price === null || item.costPrice === null || item.price <= 0) {
        return sum
      }
      const share = item.targetWeight / knownHoldingWeight
      const currentValue = estimatedHoldingMarketValue * share
      const estimatedCostValue = currentValue * (item.costPrice / item.price)
      return sum + (currentValue - estimatedCostValue)
    }, 0)
    return Number.isFinite(profit) ? profit : null
  }, [estimatedHoldingMarketValue, knownHoldingWeight, holdingDetails])
  const marketSummary = useMemo(() => summarizeMarket(market), [market])
  const exposure = useMemo(() => portfolioExposure(portfolio), [portfolio])
  const indexBand = useMemo(
    () => pickIndexPositionBand(indexSnapshot?.price ?? null),
    [indexSnapshot],
  )
  // 档位相邻关系：bands 按点位从高到低排列，index+1 为更低点位（仓位更重）
  const indexBandIndex = indexBand ? INDEX_POSITION_BANDS.indexOf(indexBand) : -1
  const lowerIndexBand =
    indexBandIndex >= 0 ? INDEX_POSITION_BANDS[indexBandIndex + 1] ?? null : null
  const upperIndexBand =
    indexBandIndex > 0 ? INDEX_POSITION_BANDS[indexBandIndex - 1] : null

  /** 当日市场温度：把关键指标固化成一行，按日期累积留存 */
  const todayTemperature = useMemo<MarketTemperatureRecord>(
    () => ({
      date: todayText(),
      indexLevel: indexSnapshot?.price ?? null,
      exposurePct: indexBand?.maxPct ?? null,
      pbMedian: market.allMarketPb > 0 ? market.allMarketPb : null,
      peMedian: market.allMarketPe > 0 ? market.allMarketPe : null,
      belowNetCount: scoredStocks.filter(
        (stock) => stock.pb !== null && stock.pb > 0 && stock.pb < 1,
      ).length,
      threeLowCount: eligibleStocks.length,
      riskPassedCount: scoredStocks.filter((stock) => riskPassed(stock)).length,
    }),
    [scoredStocks, eligibleStocks, market, indexSnapshot, indexBand],
  )

  // 有全市场数据时，按日期写入/覆盖当日温度记录
  useEffect(() => {
    if (stocks.length === 0) return
    setMarketTemperature((prev) =>
      upsertMarketTemperature(prev, todayTemperature),
    )
  }, [stocks.length, todayTemperature])
  const industrySummaries = useMemo(
    () => summarizeIndustries(scoredStocks, historicalPbFloors ?? undefined),
    [scoredStocks, historicalPbFloors],
  )
  const portfolioSummaries = useMemo(
    () => summarizePortfolioIndustries(holdingDetails),
    [holdingDetails],
  )
  const recommendedPortfolioSummaries = useMemo(
    () => summarizePortfolioIndustries(portfolio),
    [portfolio],
  )
  const aiHighlights = useMemo(
    () => buildAiHighlights(scoredStocks, industrySummaries, portfolio),
    [scoredStocks, industrySummaries, portfolio],
  )
  const [pbLo, pbHi] = pbBand(config.discount)
  const [peLo, peHi] = peBand(config.discount)

  const pendingKline = useMemo(
    () =>
      scoredStocks.filter(
        (stock) => stock.lowPrice1y === null || stock.lowPrice3y === null,
      ).length,
    [scoredStocks],
  )
  const fullKlineDoneForCurrentStocks = useMemo(() => {
    if (!fullKlineCompleted) return false
    const cache = loadDailyKlineCache(config.klineDays)
    return Boolean(
      cache?.completed &&
        stocks.every((stock) => {
          const symbol = toSymbol(stock.code)
          return symbol !== null && Boolean(cache.entries[symbol])
        }),
    )
  }, [config.klineDays, fullKlineCompleted, stocks])
  const visibleStocks = useMemo(() => {
    const keyword = normalize(scoreQuery)
    return scoredStocks.filter(
      (stock) =>
        (!excludeFinancial || !isFinancialStock(stock)) &&
        (scoreScope === 'all' ||
          (scoreScope === 'eligible' && stock.eligible) ||
          (scoreScope === 'riskPassed' && riskPassed(stock))) &&
        (!onlyNearPbFloor ||
          (stock.pbVsFloorPct !== null &&
            stock.pbVsFloorPct <= PB_FLOOR_NEAR_PCT)) &&
        matchesTripleLow(stock, tripleLowTier) &&
        (!keyword ||
          stock.code.includes(keyword) ||
          normalize(stock.name).includes(keyword) ||
          normalize(stock.industry).includes(keyword) ||
          normalize(stock.sector).includes(keyword)),
    )
  }, [scoredStocks, scoreScope, excludeFinancial, onlyNearPbFloor, tripleLowTier, scoreQuery])

  /** 按当前列与方向排序；未选择列时保持原始顺序，空值始终排在最后 */
  const sortedVisibleStocks = useMemo(() => {
    if (scoreSortKey === null) return visibleStocks
    const direction = scoreSortDirection === 'asc' ? 1 : -1
    const valueOf = (stock: ScoredStock): number | string | null => {
      switch (scoreSortKey) {
        case 'name':
          return stock.name
        case 'industry':
          return `${stock.sector} ${stock.industry}`
        case 'holding':
          return holdingWeightByCode.get(stock.code) ?? null
        case 'score':
          return stock.totalScore
        case 'pb':
          return stock.pb
        case 'stockPbFloor':
          return stock.stockPbFloor
        case 'pe':
          return stock.pe
        case 'price':
          return stock.price
        case 'gain1y':
          return stock.gain1y
        case 'gain3y':
          return stock.gain3y
        case 'mine':
          return stock.mineScore
        case 'marketCap':
          return stock.marketCap
        case 'dividendYield':
          return stock.dividendYield
        case 'pledgeRatio':
          return stock.pledgeRatio
        case 'goodwillRatio':
          return stock.goodwillRatio
        case 'debtRatio':
          return stock.debtRatio
        case 'eligible':
          return stock.eligible ? 1 : 0
        default:
          return null
      }
    }
    const isBlank = (value: number | string | null) =>
      value === null ||
      value === undefined ||
      value === '' ||
      (typeof value === 'number' && !Number.isFinite(value))

    return visibleStocks
      .map((stock, index) => ({ stock, index, value: valueOf(stock) }))
      .sort((a, b) => {
        const blankA = isBlank(a.value)
        const blankB = isBlank(b.value)
        if (blankA && blankB) return a.index - b.index
        if (blankA) return 1
        if (blankB) return -1
        if (typeof a.value === 'string' && typeof b.value === 'string') {
          return a.value.localeCompare(b.value, 'zh-Hans-CN') * direction
        }
        return ((a.value as number) - (b.value as number)) * direction
      })
      .map((item) => item.stock)
  }, [visibleStocks, scoreSortKey, scoreSortDirection, holdingWeightByCode])

  const toggleScoreSort = (key: ScoreSortKey) => {
    if (scoreSortKey === key) {
      setScoreSortDirection(scoreSortDirection === 'asc' ? 'desc' : 'asc')
      return
    }
    setScoreSortKey(key)
    setScoreSortDirection(TEXT_SORT_KEYS.includes(key) ? 'asc' : 'desc')
  }

  /**
   * 大数评分表各列说明，鼠标悬停表头时展示。
   * 口径全部来自公开数据源与策略代码，不含模拟器私有数据。
   */
  const COLUMN_TOOLTIPS: Partial<Record<ScoreSortKey, string>> = {
    name: '股票名称与 6 位代码。点击列头可按名称排序。',
    industry: '一级行业 / 细分行业，由东方财富 BOARD_NAME 归一化得到。',
    holding: '你的实际持仓占比(%)，来自手动添加或 CSV 导入，非系统生成。',
    score:
      '三好学生评分（满分 300）= PB 得分 + PE 得分 + 涨幅得分。> 200 分视为入池门槛。',
    pb:
      '市净率。颜色按距行业 PB 底的偏离着色：绿=贴近底部，黄=已离开，红=明显偏离。悬停可看具体偏离值。',
    stockPbFloor:
      '个股 PB 底：历史月度采样最低正 PB 与当前 PB 取较低值，避免月内新低未被月度采样捕捉。',
    pe: '市盈率(TTM)。亏损或负值记为无效，不参与估值评分。',
    price: '当前现价。优先使用腾讯快照实时价，缺省时回退东方财富交易日快照。',
    gain1y:
      '一年内涨幅 = (现价 − 一年内最低价) ÷ 一年内最低价。一年内最低价由腾讯 52 周快照提供。',
    gain3y:
      '三年内涨幅 = (现价 − 三年内最低价) ÷ 三年内最低价。三年内最低价由腾讯前复权日线逐只补齐。',
    mine:
      '扫雷宝评分（满分 100）。基于商誉占净资产与股权质押比例连续扣分；任一 ≥ 20% 触发硬过滤。',
    marketCap: '总市值（亿元），来自东方财富。',
    dividendYield:
      '股息率(%) = 近 12 个月已实施税前每 10 股派息 ÷ 10 ÷ 现价 × 100。未实施方案与未来日期不计入。',
    pledgeRatio: '股权质押比例(%)，最新交易日数据，来自东方财富 RPT_CSDC_LIST_NEWEST。',
    goodwillRatio: '商誉占净资产比例(%)，最新报告期，来自东方财富 RPT_GOODWILL_STOCKDETAILS。',
    debtRatio:
      '资产负债率(%)，右侧小字为该值相对同行业中位数的偏离（百分点）。宽容上限 = 行业资产负债率中位数 × (1 + 宽容幅度，默认 15%)，超过上限不予入池。',
    eligible: '入池状态：通过 = 满足全部筛选条件；未通过 = 至少一项不满足。',
  }

  const renderScoreSortHeader = (key: ScoreSortKey, label: string) => {
    const isActive = scoreSortKey === key
    const tooltip = COLUMN_TOOLTIPS[key]
    return (
      <th
        key={key}
        aria-sort={
          isActive ? (scoreSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'
        }
      >
        <button
          type="button"
          className={isActive ? 'sort-button active' : 'sort-button'}
          onClick={() => toggleScoreSort(key)}
        >
          <span>{label}</span>
          <span className="sort-arrows" aria-hidden="true">
            <span className={isActive && scoreSortDirection === 'asc' ? 'arrow on' : 'arrow'}>
              ▲
            </span>
            <span className={isActive && scoreSortDirection === 'desc' ? 'arrow on' : 'arrow'}>
              ▼
            </span>
          </span>
          {tooltip && <span className="sort-tooltip" role="tooltip">{tooltip}</span>}
        </button>
      </th>
    )
  }

  const searchedStocks = useMemo(() => {
    const keyword = normalize(stockQuery)
    if (!keyword) return []
    return scoredStocks
      .filter((stock) => {
        const hay = `${stock.code} ${stock.name} ${stock.industry}`.toLowerCase()
        return hay.includes(keyword)
      })
      .slice(0, 12)
  }, [scoredStocks, stockQuery])
  const selectedStock = searchedStocks[0] ?? null

  // 选中个股变化时拉取该股 PE/PB 历史走势（服务端按 2018 至今季度采样）
  const selectedStockCode = selectedStock?.code ?? null
  useEffect(() => {
    if (selectedStockCode === null) {
      setStockValuation(null)
      setStockValuationError(null)
      return
    }
    let cancelled = false
    ;(async () => {
      setStockValuationLoading(true)
      setStockValuationError(null)
      try {
        const resp = await fetch(
          `/api/stock-valuation?code=${encodeURIComponent(selectedStockCode)}`,
        )
        const contentType = resp.headers.get('content-type') ?? ''
        if (!contentType.includes('application/json')) {
          throw new Error('当前服务未提供个股估值历史接口，请重启应用服务后重试')
        }
        const data = (await resp.json()) as StockValuationResponse
        if (cancelled) return
        if (data.error) {
          setStockValuation(null)
          setStockValuationError(data.error)
          return
        }
        setStockValuation(data)
      } catch (error) {
        if (!cancelled) {
          setStockValuation(null)
          setStockValuationError(
            error instanceof Error ? error.message : '个股估值历史加载失败',
          )
        }
      } finally {
        if (!cancelled) setStockValuationLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedStockCode])

  const visibleIndustries = useMemo(() => {
    const keyword = normalize(industryQuery)
    if (!keyword) return industrySummaries
    return industrySummaries.filter((item) => {
      const hay = `${item.industry} ${item.bestStockName ?? ''} ${item.bestStockCode ?? ''}`.toLowerCase()
      return hay.includes(keyword)
    })
  }, [industryQuery, industrySummaries])

  /**
   * 周期行业页面数据：把服务端的月度 PB 序列换算成周期特征与周期性评分，
   * 再按搜索词、是否周期行业、最低评分做筛选。
   */
  const cycleIndustryOptions = useMemo<CycleRow[]>(() => {
    if (!industryCycle) return []
    return Object.entries(industryCycle.series)
      .map<CycleRow>(([industry, series]) => {
        const stats = computeCycleStats(series, industryCycle.dates)
        const group = classifyCyclical(industry)
        return { industry, group, stats, score: scoreCyclicality(group, stats) }
      })
      .filter((row) => row.stats.current !== null)
      .filter((row) => (cycleOnlyCyclical ? row.group !== null : true))
      .filter((row) => row.score.total >= cycleMinScore)
      .sort((a, b) => a.industry.localeCompare(b.industry))
  }, [industryCycle, cycleOnlyCyclical, cycleMinScore])

  const cycleRows = useMemo<CycleRow[]>(() => {
    const keyword = normalize(cycleQuery)
    const valueOf = (row: CycleRow): number | null => {
      switch (cycleSortKey) {
        case 'current':
          return row.stats.current
        case 'floor':
          return row.stats.min
        case 'percentile':
          return row.stats.percentile
        case 'amplitude':
          return row.stats.amplitude
        case 'trend1y':
          return row.stats.trend1y
        default:
          return row.score.total
      }
    }

    return cycleIndustryOptions
      .filter((row) => (keyword ? row.industry.toLowerCase().includes(keyword) : true))
      .sort((a, b) => {
        const left = valueOf(a)
        const right = valueOf(b)
        if (left === null && right === null) return a.industry.localeCompare(b.industry)
        if (left === null) return 1
        if (right === null) return -1
        const diff = cycleSortDirection === 'desc' ? right - left : left - right
        return diff !== 0 ? diff : a.industry.localeCompare(b.industry)
      })
  }, [
    cycleIndustryOptions,
    cycleQuery,
    cycleSortKey,
    cycleSortDirection,
  ])

  const selectedCycleRow =
    cycleRows.find((row) => row.industry === selectedCycleIndustry) ??
    cycleRows[0] ??
    null

  const handleCycleSort = (key: CycleSortKey) => {
    if (cycleSortKey === key) {
      setCycleSortDirection((current) => (current === 'desc' ? 'asc' : 'desc'))
      return
    }
    setCycleSortKey(key)
    setCycleSortDirection(key === 'percentile' ? 'asc' : 'desc')
  }

  const renderCycleSortHeader = (key: CycleSortKey, label: string) => {
    const isActive = cycleSortKey === key
    return (
      <th
        key={key}
        aria-sort={
          isActive ? (cycleSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'
        }
      >
        <button
          type="button"
          className={isActive ? 'sort-button active' : 'sort-button'}
          onClick={() => handleCycleSort(key)}
        >
          <span>{label}</span>
          <span className="sort-arrows" aria-hidden="true">
            <span className={isActive && cycleSortDirection === 'asc' ? 'arrow on' : 'arrow'}>
              ▲
            </span>
            <span className={isActive && cycleSortDirection === 'desc' ? 'arrow on' : 'arrow'}>
              ▼
            </span>
          </span>
        </button>
      </th>
    )
  }

  const persistSnapshots = (next: ArchiveSnapshot[]) => {
    setSnapshots(next)
    syncSave('archives', next)
  }

  const handleConfigChange = (key: keyof StrategyConfig, value: number) => {
    if (key === 'klineDays') {
      setFullKlineCompleted(
        loadDailyKlineCache(value)?.completed ?? false,
      )
    }
    setConfig((current) => ({ ...current, [key]: value }))
  }

  const runKlineStep = async (universe: StockRecord[]) => {
    const dailyCache =
      loadDailyKlineCache(config.klineDays) ??
      createDailyKlineCache(config.klineDays)
    const stocksWithCachedKline = applyKline(universe, dailyCache.entries)
    const candidates = pickKlineCandidates(
      scoreStocks(
        stocksWithCachedKline,
        config,
        historicalPbFloors ?? undefined,
        historicalStockPbFloors ?? undefined,
      ),
      config,
    )
    const missingCandidates = candidates.filter((code) => {
      const symbol = toSymbol(code)
      return symbol !== null && !dailyCache.entries[symbol]
    })

    let failed: string[] = []
    if (missingCandidates.length > 0) {
      const result = await fetchKlines(
        missingCandidates,
        config.klineDays,
        (done, total) => setProgress(`正在补齐候选 K 线：${done}/${total}`),
      )
      Object.assign(dailyCache.entries, result.data)
      failed = result.failed
      saveDailyKlineCache(dailyCache)
    }

    return {
      stocks: applyKline(universe, dailyCache.entries),
      count: Object.keys(dailyCache.entries).length,
      failed,
    }
  }

  // 拉取上证指数快照：复用 /api/kline 代理，返回当前点位与近一年高低
  const refreshIndexSnapshot = async (): Promise<boolean> => {
    setIndexLoading(true)
    try {
      const entry = await fetchIndexSnapshot()
      if (!entry || entry.lastClose === null) return false
      const snapshot: IndexSnapshot = {
        price: entry.lastClose,
        high1y: entry.high1y,
        low1y: entry.low1y,
      }
      setIndexSnapshot(snapshot)
      saveIndexCache({ date: todayText(), snapshot })
      return true
    } finally {
      setIndexLoading(false)
    }
  }

  const handleFetchAll = async () => {
    setLoading(true)
    setWarning('')
    setProgress('开始拉取…')
    try {
      const { stocks: universe, meta } = await fetchRealMarketData(setProgress)
      const { stocks: enriched, count, failed } = await runKlineStep(universe)
      const derivedMarket = deriveMarketSnapshot(enriched)
      setStocks(enriched)
      setMarket(derivedMarket)
      // 同步刷新上证指数点位，供「按点位定仓位」模块使用
      void refreshIndexSnapshot()
      setDataMeta({ ...meta, klineCount: count })
      setFullKlineCompleted(
        loadDailyKlineCache(config.klineDays)?.completed ?? false,
      )
      setMessage(
        `已接入最新数据：${meta.total} 只 A 股，东财交易日 ${meta.tradeDate}，` +
          `其中 ${count} 只补齐了一年/三年低价，并已用腾讯快照刷新现价。`,
      )
      if (failed.length > 0) {
        setWarning(`有 ${failed.length} 只候选未能取到 K 线，其涨幅得分暂缺。`)
      }
      // 写入当天缓存，刷新页面时直接复用，避免重复拉取
      saveMarketCache({
        date: todayText(),
        fetchedAt: new Date().toISOString(),
        stocks: enriched,
        meta: { ...meta, klineCount: count },
        market: derivedMarket,
      })
    } catch (error) {
      setWarning(
        `拉取失败：${error instanceof Error ? error.message : String(error)}。` +
          ' 若在 vite preview 下运行，请改用 npm run dev（K 线接口需要本地服务）。',
      )
    } finally {
      setLoading(false)
      setProgress('')
    }
  }

  // 挂载时：若当天缓存可用则直接加载，否则自动拉取一次
  fetchAllRef.current = handleFetchAll
  useEffect(() => {
    const cached = loadMarketCache()
    const dailyKlineCache = loadDailyKlineCache(defaultConfig.klineDays)
    setFullKlineCompleted(dailyKlineCache?.completed ?? false)
    if (cached) {
      const cachedStocks = dailyKlineCache
        ? applyKline(cached.stocks, dailyKlineCache.entries)
        : cached.stocks
      setStocks(cachedStocks)
      setMarket(deriveMarketSnapshot(cachedStocks))
      setDataMeta({
        ...cached.meta,
        klineCount: Math.max(
          cached.meta.klineCount,
          Object.keys(dailyKlineCache?.entries ?? {}).length,
        ),
      })
      const time = new Date(cached.fetchedAt).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      })
      setMessage(
        `已加载本地缓存：${cached.meta.total} 只 A 股（交易日 ${cached.meta.tradeDate}，${time} 拉取）。` +
          ' 如需更新请点击「拉取最新数据」。',
      )
      return
    }
    void fetchAllRef.current()
  }, [])

  // 挂载时：上证指数快照当天有缓存直接用，否则拉取一次
  const indexFetchRef = useRef<() => Promise<boolean>>(async () => false)
  indexFetchRef.current = refreshIndexSnapshot
  useEffect(() => {
    const cached = loadIndexCache()
    if (cached) {
      setIndexSnapshot(cached.snapshot)
      return
    }
    void indexFetchRef.current()
  }, [])

  const handleFillKline = async () => {
    const dailyCache =
      loadDailyKlineCache(config.klineDays) ??
      createDailyKlineCache(config.klineDays)
    const allCodes = [...new Set(stocks.map((stock) => stock.code))]
    const alreadyCovered = allCodes.every((code) => {
      const symbol = toSymbol(code)
      return symbol !== null && Boolean(dailyCache.entries[symbol])
    })
    if (dailyCache.completed && alreadyCovered) {
      setFullKlineCompleted(true)
      setMessage('今日全量 K 线请求已完成，直接复用缓存，不会重复请求。')
      return
    }
    dailyCache.completed = false

    setLoading(true)
    setWarning('')
    setProgress('准备全市场 K 线…')
    try {
      const pendingCodes = allCodes.filter((code) => {
        const symbol = toSymbol(code)
        return symbol !== null && !dailyCache.entries[symbol]
      })
      const failed = new Set<string>(
        allCodes.filter((code) => toSymbol(code) === null),
      )
      let processed = 0
      let currentStocks = applyKline(stocks, dailyCache.entries)

      for (let index = 0; index < pendingCodes.length; index += 120) {
        const batch = pendingCodes.slice(index, index + 120)
        try {
          const result = await fetchKlines(
            batch,
            config.klineDays,
            (done) =>
              setProgress(
                `全市场补齐 K 线：${processed + done}/${pendingCodes.length}`,
              ),
          )
          Object.assign(dailyCache.entries, result.data)
          result.failed.forEach((symbol) => failed.add(symbol))
          currentStocks = applyKline(currentStocks, result.data)
          setStocks(currentStocks)
          setMarket(deriveMarketSnapshot(currentStocks))
          setDataMeta((current) =>
            current
              ? {
                  ...current,
                  klineCount: allCodes.filter((code) => {
                    const symbol = toSymbol(code)
                    return symbol !== null && dailyCache.entries[symbol]
                  }).length,
                }
              : current,
          )
          saveDailyKlineCache(dailyCache)
        } catch {
          batch.forEach((code) => failed.add(code))
        }
        processed += batch.length
        setProgress(
          `全市场补齐 K 线：${processed}/${pendingCodes.length}，` +
            `本次失败 ${failed.size} 只`,
        )
      }

      setStocks(currentStocks)
      setMarket(deriveMarketSnapshot(currentStocks))
      const missingCodes = allCodes.filter((code) => {
        const symbol = toSymbol(code)
        return symbol === null || !dailyCache.entries[symbol]
      })
      dailyCache.completed = missingCodes.length === 0
      const persisted = saveDailyKlineCache(dailyCache)
      setFullKlineCompleted(dailyCache.completed && persisted)

      if (missingCodes.length > 0) {
        setMessage(
          `已取得 ${allCodes.length - missingCodes.length}/${allCodes.length} 只标的的 K 线响应；` +
            `剩余 ${missingCodes.length} 只会在重试时单独补拉。`,
        )
        setWarning('部分标的未能取得 K 线，请稍后重试；已成功数据不会重复请求。')
      } else if (!persisted) {
        setMessage(`已完成 ${allCodes.length} 只标的的全量 K 线请求。`)
        setWarning('浏览器无法保存当日 K 线缓存，刷新页面后可能需要重新补齐。')
      } else {
        setMessage(
          `今日已完成全部 ${allCodes.length} 只标的的 K 线请求；当天再次操作会直接复用缓存。`,
        )
      }
    } catch (error) {
      setWarning(
        `全量补齐失败：${error instanceof Error ? error.message : String(error)}。` +
          ' 请确认通过 npm run dev 或 npm start 启动（K 线需要本地服务）。',
      )
    } finally {
      setLoading(false)
      setProgress('')
    }
  }

  const handleQueryYearHigh = useCallback(async (stock: ScoredStock) => {
    const symbol = toSymbol(stock.code)
    if (!symbol) {
      setWarning(`无法识别股票代码 ${stock.code}，暂时无法查询近一年最高价。`)
      return
    }

    setQueryingHighCode(stock.code)
    setWarning('')
    try {
      const { data, failed } = await fetchKlines([stock.code], 20)
      const highPrice1y = data[symbol]?.high1y
      if (highPrice1y === null || highPrice1y === undefined) {
        setWarning(
          failed.includes(symbol)
            ? `未能获取 ${stock.name} 的行情快照，请稍后重试。`
            : `${stock.name} 暂无可用的近一年最高价数据。`,
        )
        return
      }

      const updateHighPrice = (items: StockRecord[]) =>
        items.map((item) =>
          item.code === stock.code ? { ...item, highPrice1y } : item,
        )
      const updatedStocks = updateHighPrice(stocks)
      setStocks(updatedStocks)

      const cached = loadMarketCache()
      if (cached) {
        saveMarketCache({ ...cached, stocks: updateHighPrice(cached.stocks) })
      }
      setMessage(
        `已查询 ${stock.name}（${stock.code}）近一年最高价：${highPrice1y.toFixed(2)}。`,
      )
    } catch (error) {
      setWarning(
        `查询近一年最高价失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    } finally {
      setQueryingHighCode((current) =>
        current === stock.code ? null : current,
      )
    }
  }, [stocks])

  const exactStockQuery = selectedStock &&
    [selectedStock.code, selectedStock.name].some(
      (value) => normalize(value) === normalize(stockQuery),
    )
    ? `${selectedStock.code}:${normalize(stockQuery)}`
    : null

  useEffect(() => {
    if (!selectedStock || !exactStockQuery) {
      lastAutoHighQueryRef.current = null
      return
    }
    if (lastAutoHighQueryRef.current === exactStockQuery) return

    const timer = window.setTimeout(() => {
      lastAutoHighQueryRef.current = exactStockQuery
      void handleQueryYearHigh(selectedStock)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [exactStockQuery, handleQueryYearHigh, selectedStock])

  const handleFileImport = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const parsed = parseCsv(text).filter((item) => item.code && item.name)
      if (parsed.length === 0) {
        setMessage('CSV 已读取，但未识别到有效股票行。')
        return
      }

      setStocks(parsed)
      setDataMeta(null)
      setWarning('')
      setMessage(`已导入 ${parsed.length} 条股票记录。`)
    } catch (error) {
      setMessage(`导入失败：${String(error)}`)
    } finally {
      event.target.value = ''
    }
  }

  const handleHoldingsImport = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const parsed = parseHoldingsCsv(text)
      if (parsed.length === 0) {
        setMessage('持仓 CSV 已读取，但未识别到有效持仓行。')
        return
      }

      setHoldingImports(parsed)
      setWarning('')
      setMessage(`已导入 ${parsed.length} 条持仓记录。`)
      setActiveView('portfolio')
    } catch (error) {
      setMessage(`持仓导入失败：${String(error)}`)
    } finally {
      event.target.value = ''
    }
  }

  const handleAddHolding = async () => {
    const code = normalizeCode(holdingCodeInput)
    const weight = toRatio(holdingWeightInput)
    const costPrice = holdingCostInput.trim()
      ? parseLooseNumber(holdingCostInput)
      : null
    let addWarning = ''

    if (!code) {
      setWarning('请先输入 6 位股票代码。')
      return
    }
    if (weight === null) {
      setWarning('请填写有效的持仓占比，例如 3 或 3%。')
      return
    }
    if (holdingCostInput.trim() && costPrice === null) {
      setWarning('请填写有效的成本价，例如 12.36。')
      return
    }

    let matched =
      scoredStocks.find((stock) => stock.code === code) ??
      stocks.find((stock) => stock.code === code)

    if (!matched) {
      setLoading(true)
      setWarning('')
      try {
        const fetched = await fetchStockByCode(
          code,
          (text) => setProgress(text),
        )
        if (fetched) {
          matched = fetched
          setProgress(`正在补齐 ${code} 的一年/三年低价…`)
          const { data } = await fetchKlines([code], config.klineDays)
          matched = applyKline([fetched], data)[0]
          const mergedStocks = [...stocks.filter((item) => item.code !== code), matched]
          setStocks(mergedStocks)
          setMarket(deriveMarketSnapshot(mergedStocks))
        } else {
          addWarning = `未找到股票 ${code} 的公开市场资料，将先按手动持仓保存。`
        }
      } catch (error) {
        addWarning =
          `未能自动补齐 ${code} 的股票资料：${
            error instanceof Error ? error.message : String(error)
          }。已先保存为手动持仓。`
      } finally {
        setLoading(false)
        setProgress('')
      }
    }

    setHoldingImports((current) => {
      const next = current.filter((item) => item.code !== code)
      return [
        ...next,
        {
          code,
          name: matched?.name ?? code,
          weight,
          costPrice,
          source: 'manual',
        },
      ]
    })
    setHoldingCodeInput('')
    setHoldingWeightInput('')
    setHoldingCostInput('')
    setWarning(addWarning)
    setMessage(
      `已添加持仓：${matched?.name ?? code}，持仓占比 ${(weight * 100).toFixed(2)}%，成本价 ${costPrice === null ? '未填写' : costPrice.toFixed(2)}。`,
    )
  }

  const handleDeleteHolding = (code: string) => {
    setHoldingImports((current) => current.filter((item) => item.code !== code))
    setMessage(`已移除持仓：${code}`)
  }

  const handleClearHoldings = () => {
    setHoldingImports([])
    setMessage('已清空当前持仓列表。')
  }

  const handleSaveAccountAmounts = () => {
    const parsedCash = parseLooseNumber(cashBalanceInput)
    if (parsedCash === null || parsedCash < 0) {
      setWarning('请填写有效的现金余额。')
      return
    }

    const rawTotal = totalAssetsInput.trim()
    let parsedTotal: number | null = null
    if (rawTotal) {
      parsedTotal = parseLooseNumber(rawTotal)
      if (parsedTotal === null || parsedTotal < 0) {
        setWarning('请填写有效的总资产，或留空改用持仓占比推算。')
        return
      }
      if (parsedTotal < parsedCash) {
        setWarning('总资产不能小于现金余额。')
        return
      }
    }

    setCashBalance(parsedCash)
    setCashBalanceInput(parsedCash.toFixed(2))
    setTotalAssets(parsedTotal)
    setTotalAssetsInput(parsedTotal === null ? '' : parsedTotal.toFixed(2))
    setWarning('')
    setMessage(
      parsedTotal === null
        ? `已更新现金余额：${parsedCash.toFixed(2)}，总资产改回按持仓占比推算。`
        : `已更新账户资金：现金 ${parsedCash.toFixed(2)}，总资产 ${parsedTotal.toFixed(2)}。`,
    )
  }

  const handleAddCapitalEvent = () => {
    const amount = parseLooseNumber(capitalAmountInput)
    if (!capitalDateInput) {
      setWarning('请选择资金变动日期。')
      return
    }
    if (amount === null || amount <= 0) {
      setWarning('请填写大于 0 的资金变动金额。')
      return
    }

    const event: CapitalEvent = {
      id: String(Date.now()),
      date: capitalDateInput,
      type: capitalTypeInput,
      amount,
      note: capitalNoteInput.trim(),
    }

    setCapitalEvents((current) => [event, ...current])
    setCashBalance((current) => Number((current + signedCapitalAmount(event)).toFixed(2)))
    setCapitalAmountInput('')
    setCapitalNoteInput('')
    setWarning('')
    setMessage(
      `已记录资金变动：${event.type} ${amount.toFixed(2)}，现金余额同步更新。`,
    )
  }

  const handleDeleteCapitalEvent = (id: string) => {
    setCapitalEvents((current) => {
      const target = current.find((item) => item.id === id)
      if (target) {
        setCashBalance((cash) =>
          Number((cash - signedCapitalAmount(target)).toFixed(2)),
        )
      }
      return current.filter((item) => item.id !== id)
    })
    setMessage('已移除一条资金变动记录，并回滚现金余额。')
  }

  const handleRestoreDemo = () => {
    setStocks(demoStocks)
    setMarket(defaultMarketSnapshot)
    setDataMeta(null)
    setWarning('')
    setMessage('已恢复为内置演示数据。')
  }

  const handleArchiveCurrent = () => {
    const snapshot: ArchiveSnapshot = {
      id: String(Date.now()),
      label: dataMeta
        ? `${dataMeta.tradeDate} ${dataMeta.total}只`
        : `本地快照 ${new Date().toLocaleTimeString('zh-CN')}`,
      createdAt: new Date().toLocaleString('zh-CN'),
      stocks,
      config,
      market,
      dataMeta,
    }
    const next = [snapshot, ...snapshots].slice(0, 6)
    persistSnapshots(next)
    setMessage(`已归档当前结果，共保留 ${next.length} 份快照。`)
    setActiveView('archives')
  }

  const handleRestoreSnapshot = (snapshot: ArchiveSnapshot) => {
    setStocks(snapshot.stocks)
    setConfig(snapshot.config)
    setMarket(snapshot.market)
    setDataMeta(snapshot.dataMeta)
    setWarning('')
    setMessage(`已恢复归档：${snapshot.label}`)
    setActiveView('overview')
  }

  const handleDeleteSnapshot = (id: string) => {
    const next = snapshots.filter((snapshot) => snapshot.id !== id)
    persistSnapshots(next)
  }

  const exportScoreTable = () => {
    const rows = scoredStocks.map((stock) => [
      stock.code,
      stock.name,
      stock.sector,
      stock.industry,
      stock.sourceIndustry ?? '',
      holdingWeightByCode.has(stock.code)
        ? ((holdingWeightByCode.get(stock.code) ?? 0) * 100).toFixed(2)
        : '',
      fixed(stock.mineScore, 0),
      fixed(stock.pb),
      fixed(stock.stockPbFloor),
      fixed(stock.pe),
      fixed(stock.price),
      percent(stock.gain1y),
      percent(stock.gain3y),
      fixed(stock.pbScore, 1),
      fixed(stock.peScore, 1),
      fixed(stock.priceScore, 1),
      fixed(stock.totalScore, 1),
      fixed(stock.winProbability, 1),
      fixed(stock.highPrice1y),
      fixed(stock.lowPrice1y),
      fixed(stock.lowPrice3y),
      yi(stock.marketCap),
      fixed(stock.debtRatio),
      fixed(stock.industryDebtMedian),
      fixed(stock.industryDebtMedianLimit),
      fixed(stock.dividendYield),
      fixed(stock.goodwillRatio),
      fixed(stock.pledgeRatio),
      stock.eligible ? '通过' : '未通过',
      stock.notes.join(' / '),
    ])
    downloadCsv(
      '大数评分表.csv',
      toCsv(
        [
          '代码',
          '名称',
          '行业',
          '细分',
          '原始行业',
          '持仓(%)',
          '扫雷宝',
          '当前市净率',
          '个股PB底',
          'PE',
          '现价',
          '一年涨幅(%)',
          '三年涨幅(%)',
          'PB得分',
          'PE得分',
          '涨幅得分',
          '三好学生评分',
          '绝对胜算概率(%)',
          '近一年最高价',
          '一年内最低价',
          '三年内最低价',
          '总市值(亿)',
          '资产负债率(%)',
          '行业资产负债率中位数(%)',
          '行业资产负债率宽容上限(%)',
          '股息率(%)',
          '商誉占净资产(%)',
          '股权质押比例(%)',
          '是否通过',
          '风险提示',
        ],
        rows,
      ),
    )
  }

  const exportPortfolio = () => {
    const rows = holdingDetails.map((item) => {
      return [
        item.code,
        item.name,
        item.sector,
        item.industry,
        item.score > 0 ? fixed(item.score, 1) : '',
        fixed(item.winProbability, 1),
        item.weightKnown ? (item.targetWeight * 100).toFixed(2) : '',
        fixed(item.costPrice),
        fixed(item.price),
        item.sourceLabel,
      ]
    })
    downloadCsv(
      '当前持仓.csv',
      toCsv(
        [
          '代码',
          '名称',
          '行业',
          '细分',
          '三好学生评分',
          '绝对胜算概率(%)',
          '持仓占比(%)',
          '成本价',
          '现价',
          '来源',
        ],
        rows,
      ),
    )
  }

  const exportIndustryTable = () => {
    const rows = industrySummaries.map((item) => [
      item.industry,
      item.stockCount,
      item.eligibleCount,
      fixed(item.avgDebtRatio, 1),
      fixed(item.pbGain, 1),
      fixed(item.pbFloor),
      fixed(item.pb),
      fixed(item.pe),
      yi(item.marketCap),
      yi(item.netAsset),
      item.bestStockCode ?? '',
      item.bestStockName ?? '',
    ])
    downloadCsv(
      '细分行业汇总.csv',
      toCsv(
        [
          '细分行业',
          '股票数',
          '通过筛选数',
          '资产负债率(%)',
          'PB涨幅(%)',
          'PB底',
          'PB',
          'PE',
          '总市值(亿)',
          '净资产(亿)',
          '行业高分股代码',
          '行业高分股名称',
        ],
        rows,
      ),
    )
  }

  const stockDiagnosis = useMemo(() => {
    if (!selectedStock) return []
    const inPortfolio = portfolio.find((item) => item.code === selectedStock.code)
    if (inPortfolio) {
      return [
        `已入选推荐组合，目标权重 ${(inPortfolio.targetWeight * 100).toFixed(2)}%。`,
        inPortfolio.reason,
      ]
    }

    const reasons = explainStockExclusion(selectedStock, config)
    if (reasons.length > 0) return reasons

    const industryHolding = recommendedPortfolioSummaries.find(
      (item) => item.industry === selectedStock.industry,
    )
    if (
      industryHolding &&
      industryHolding.targetWeight >= config.maxIndustryWeight - 0.0001
    ) {
      return ['该细分行业在推荐组合中已达到单行业上限，优先保留排名更高的股票。']
    }
    if (exposure >= config.maxEquityExposure - 0.0001) {
      return ['推荐组合总权益仓位已满，当前股票虽合格但未进入前排持仓位。']
    }
    return ['当前未入选，通常是排序落后于更高分股票。']
  }, [config, exposure, portfolio, recommendedPortfolioSummaries, selectedStock])

  const overviewSection = (
    <>
      <header className="hero">
        <div>
          <span className="eyebrow">大数选股管理工具</span>
          <h1>三好学生评分驱动的选股与组合管理</h1>
          <p className="hero-text">
            评分算法还原自「大数模拟器」：PB、PE、一年内价格低点涨幅各 100
            分，满分 {MAX_SCORE} 分，绝对胜算概率 = 总分 / 3。
          </p>
          <div className="hero-tags">
            <span>全市场最新数据</span>
            <span>三好学生评分</span>
            <span>细分行业</span>
            <span>归档与 AI 摘要</span>
          </div>
        </div>

        <div className="hero-panel">
          <div className="metric-card accent">
            <span>市场状态</span>
            <strong>{marketSummary.label}</strong>
            <p>{marketSummary.description}</p>
          </div>
          <div className="metric-grid">
            <div className="metric-card">
              <span>候选股票</span>
              <strong>{stocks.length}</strong>
            </div>
            <div className="metric-card">
              <span>通过筛选</span>
              <strong>{eligibleStocks.length}</strong>
            </div>
            <div className="metric-card">
              <span>建议持仓数</span>
              <strong>{portfolio.length}</strong>
            </div>
            <div className="metric-card">
              <span>建议权益仓位</span>
              <strong>{(exposure * 100).toFixed(1)}%</strong>
            </div>
          </div>
        </div>
      </header>

      <section className="panel index-position-panel">
        <div className="section-title">
          <h2>上证点位定仓位</h2>
          <p>
            大数投资「按点位定仓位」：越跌仓位越重，只应对不预测。下标按上证指数每
            100 点一档给出建议权益仓位，并高亮当前所在档位，作为整体仓位的参考刻度。
          </p>
        </div>

        <div className="index-position-body">
          <div className="index-position-summary">
            <div className="metric-card accent">
              <span>上证指数</span>
              <strong>
                {indexSnapshot?.price != null
                  ? indexSnapshot.price.toFixed(2)
                  : indexLoading
                    ? '加载中…'
                    : '—'}
              </strong>
              <p>
                {indexBand
                  ? `落在 ${indexBand.label} 档，理论上限仓位 ${indexBand.maxPct}%。` +
                    (lowerIndexBand
                      ? ` 若继续跌至 ${lowerIndexBand.label} 区间，仓位上限可提高到 ${lowerIndexBand.maxPct}%；`
                      : ' ') +
                    (upperIndexBand
                      ? `反之反弹至 ${upperIndexBand.label} 区间应减回 ${upperIndexBand.maxPct}%。`
                      : '')
                  : '暂无上证指数数据，请点击「刷新指数」或「拉取最新数据」。'}
              </p>
            </div>

            <div className="metric-grid">
              <div className="metric-card">
                <span>当前档位</span>
                <strong>{indexBand ? indexBand.label : '—'}</strong>
              </div>
              <div className="metric-card">
                <span>按点位建议仓位</span>
                <strong>
                  {indexBand
                    ? indexBand.minPct === indexBand.maxPct
                      ? `${indexBand.maxPct}%`
                      : `${indexBand.minPct}% – ${indexBand.maxPct}%`
                    : '—'}
                </strong>
              </div>
              <div className="metric-card">
                <span>近一年高</span>
                <strong>{indexSnapshot?.high1y?.toFixed(0) ?? '—'}</strong>
              </div>
              <div className="metric-card">
                <span>近一年低</span>
                <strong>{indexSnapshot?.low1y?.toFixed(0) ?? '—'}</strong>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void refreshIndexSnapshot()}
              disabled={indexLoading}
            >
              {indexLoading ? '刷新中…' : '刷新指数'}
            </button>
          </div>

          <div className="table-wrap sticky-head index-position-table-wrap">
            <table className="index-position-table">
              <thead>
                <tr>
                  <th>上证指数区间</th>
                  <th>建议投资比例</th>
                </tr>
              </thead>
              <tbody>
                {INDEX_POSITION_BANDS.map((band) => (
                  <tr
                    key={band.label}
                    className={band === indexBand ? 'active' : undefined}
                  >
                    <td>{band.label}</td>
                    <td>
                      {band.minPct === band.maxPct
                        ? `${band.maxPct}%`
                        : `${band.minPct}% – ${band.maxPct}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="section-title">
          <h2>市场温度</h2>
          <p>
            每个交易日自动留存一行当日市场位置（上证点位、建议仓位、PE/PB
            中位数、破净家数、三低命中与排雷通过家数），最新记录在最上方，便于对比市场冷热变化。
            数据保存在本地浏览器，最多保留近 240 个交易日。
          </p>
        </div>
        {marketTemperature.length === 0 ? (
          <p className="helper-text">暂无记录，拉取全市场数据后会自动写入当日温度。</p>
        ) : (
          <div className="table-wrap sticky-head">
            <table className="market-temperature-table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>上证</th>
                  <th>建议仓位</th>
                  <th>PE 中位</th>
                  <th>PB 中位</th>
                  <th>破净数</th>
                  <th>三低命中</th>
                  <th>排雷通过</th>
                </tr>
              </thead>
              <tbody>
                {marketTemperature.map((record) => (
                  <tr key={record.date}>
                    <td>{record.date}</td>
                    <td>{record.indexLevel?.toFixed(2) ?? '—'}</td>
                    <td>
                      {record.exposurePct !== null ? `${record.exposurePct}%` : '—'}
                    </td>
                    <td>{record.peMedian?.toFixed(2) ?? '—'}</td>
                    <td>{record.pbMedian?.toFixed(2) ?? '—'}</td>
                    <td>{record.belowNetCount}</td>
                    <td>{record.threeLowCount}</td>
                    <td>{record.riskPassedCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-title">
          <h2>数据与导出</h2>
          <p>
            财务与估值主表来自东方财富公开接口（浏览器直连）；现价、一年低点与三年低点由本地
            <code> /api/kline </code> 代理补齐，其中现价优先使用腾讯最新快照，用于计算涨1、涨3与涨幅得分。
          </p>
        </div>

        <div className="action-row">
          <button type="button" onClick={handleFetchAll} disabled={loading}>
            {loading ? '处理中…' : '拉取最新数据并评分'}
          </button>
          <button
            type="button"
            onClick={handleFillKline}
            disabled={loading || fullKlineDoneForCurrentStocks}
          >
            {loading
              ? '处理中…'
              : fullKlineDoneForCurrentStocks
                ? '今日全量 K 线请求已完成'
                : '全量补齐 K 线'}
          </button>
          <button type="button" onClick={exportScoreTable}>
            导出评分表 CSV
          </button>
          <button
            type="button"
            onClick={exportPortfolio}
            disabled={holdingDetails.length === 0}
          >
            导出持仓 CSV
          </button>
          <button type="button" onClick={exportIndustryTable}>
            导出行业汇总 CSV
          </button>
          <button type="button" onClick={handleArchiveCurrent}>
            归档当前结果
          </button>
          <label className="file-button">
            导入股票池 CSV
            <input type="file" accept=".csv" onChange={handleFileImport} />
          </label>
          <button type="button" onClick={handleRestoreDemo} disabled={loading}>
            恢复演示数据
          </button>
        </div>

        {progress && <p className="helper-text">{progress}</p>}
        <p className="helper-text">{message}</p>
        {warning && <p className="helper-text error">{warning}</p>}

        {dataMeta && (
          <div className="meta-grid">
            <div>
              <span>数据源</span>
              <strong>{dataMeta.name}</strong>
            </div>
            <div>
              <span>交易日</span>
              <strong>{dataMeta.tradeDate}</strong>
            </div>
            <div>
              <span>财务报告期</span>
              <strong>{dataMeta.reportDate}</strong>
            </div>
            <div>
              <span>样本数量</span>
              <strong>{dataMeta.total}</strong>
            </div>
            <div>
              <span>已补 K 线</span>
              <strong>{dataMeta.klineCount}</strong>
            </div>
            <div>
              <span>拉取时间</span>
              <strong>{dataMeta.fetchedAt}</strong>
            </div>
          </div>
        )}

        <p className="helper-text">
          说明：财务与估值字段采用最近公开快照；现价优先使用腾讯最新快照。首次拉取仍优先补可能达到门槛的候选以尽快完成评分；
          点击「全量补齐 K 线」可处理当前全部标的。结果按批次缓存，当天重复操作只会重试未成功的标的；
          全部标的均返回后当天不再请求。当前仍有 {pendingKline} 只缺少一年或三年低点数据，可能是上游无可用历史记录。
        </p>
        <p className="helper-text">
          当前已接入<strong>股息率</strong>、<strong>商誉占净资产</strong>与
          <strong>股权质押比例</strong>；扫雷宝展示的是当前公开口径结果。股票池导入字段：
          <code>{csvHeaders.join(', ')}</code>
        </p>
      </section>

      <section className="panel two-columns">
        <div>
          <div className="section-title">
            <h2>规则配置</h2>
            <p>参数化还原大数模拟器口径，改任意阈值都会立刻重算。</p>
          </div>
          <div className="control-grid">
            <label>
              历史折扣 PB
              <input
                type="number"
                step="0.1"
                value={config.discount}
                min={0}
                max={1}
                onChange={(event) =>
                  handleConfigChange('discount', Number(event.target.value))
                }
              />
            </label>
            <label>
              评分门槛（满分 {MAX_SCORE}）
              <input
                type="number"
                value={config.scoreThreshold}
                min={0}
                max={MAX_SCORE}
                onChange={(event) =>
                  handleConfigChange('scoreThreshold', Number(event.target.value))
                }
              />
            </label>
            <label>
              股息率下限(%)
              <input
                type="number"
                step="0.1"
                value={config.minDividendYield}
                min={0}
                max={10}
                onChange={(event) =>
                  handleConfigChange('minDividendYield', Number(event.target.value))
                }
              />
            </label>
            <label>
              负债率宽容幅度（0.15 = 中位数 ×1.15）
              <input
                type="number"
                step="0.01"
                value={config.debtMedianTolerance}
                min={0}
                max={1}
                onChange={(event) =>
                  handleConfigChange(
                    'debtMedianTolerance',
                    Number(event.target.value),
                  )
                }
              />
            </label>
            <label>
              满配过滤：单行业上限
              <input
                type="number"
                step="0.01"
                value={config.maxIndustryWeight}
                min={0.01}
                max={0.5}
                onChange={(event) =>
                  handleConfigChange('maxIndustryWeight', Number(event.target.value))
                }
              />
            </label>
            <label>
              总权益仓位上限
              <input
                type="number"
                step="0.01"
                value={config.maxEquityExposure}
                min={0.2}
                max={0.67}
                onChange={(event) =>
                  handleConfigChange('maxEquityExposure', Number(event.target.value))
                }
              />
            </label>
            <label>
              K 线回溯天数
              <input
                type="number"
                value={config.klineDays}
                min={20}
                max={1400}
                onChange={(event) =>
                  handleConfigChange('klineDays', Number(event.target.value))
                }
              />
            </label>
            <label>
              最多补 K 线只数
              <input
                type="number"
                value={config.maxKlineCandidates}
                min={50}
                max={5000}
                step={50}
                onChange={(event) =>
                  handleConfigChange(
                    'maxKlineCandidates',
                    Number(event.target.value),
                  )
                }
              />
            </label>
          </div>

          <div className="market-callout">
            <strong>估值区间</strong>
            <p>
              PB 取值范围 [ {pbLo.toFixed(3)}, {pbHi.toFixed(3)} ]，PE 取值范围 [
              {peLo.toFixed(2)}, {peHi.toFixed(2)} ]。区间下沿得满分 100
              分，上沿得 0 分，中间线性递减。
            </p>
          </div>
        </div>

        <div>
          <div className="section-title">
            <h2>个股诊断</h2>
            <p>输入完整股票代码或名称后自动查询近一年最高价。默认已定位到贵州轮胎。</p>
          </div>
          <div className="control-grid single-column">
            <label>
              股票代码 / 名称
              <input
                value={stockQuery}
                onChange={(event) => setStockQuery(event.target.value)}
                placeholder="例如 000589 或 贵州轮胎"
              />
            </label>
          </div>
          {selectedStock ? (
            <div className="diagnostic-card">
              <div className="diagnostic-head">
                <div>
                  <strong>
                    {selectedStock.name}（{selectedStock.code}）
                  </strong>
                  <p>
                    {selectedStock.sector} / {selectedStock.industry} / 总分 {selectedStock.totalScore.toFixed(1)} / 状态{' '}
                    {selectedStock.eligible ? '通过筛选' : '未通过筛选'}
                  </p>
                </div>
                <span
                  className={
                    selectedStock.eligible ? 'status ok' : 'status muted'
                  }
                >
                  {selectedStock.eligible ? '可入池' : '未入池'}
                </span>
              </div>
              <div className="mini-metrics">
                <span>PB {show(selectedStock.pb)}</span>
                <span>PE {show(selectedStock.pe)}</span>
                <span>现价 {show(selectedStock.price)}</span>
                <span>扫雷宝 {selectedStock.mineScore}</span>
                <span>涨1 {gainView(selectedStock.gain1y, 0)}</span>
                <span>涨3 {gainView(selectedStock.gain3y, 0)}</span>
                <span>
                  近一年最高价{' '}
                  {selectedStock.highPrice1y == null &&
                  queryingHighCode === selectedStock.code
                    ? '查询中…'
                    : show(selectedStock.highPrice1y ?? null)}
                </span>
                <span className={pbFloorClass(selectedStock.pbVsFloorPct)}>
                  距 PB 底{' '}
                  {selectedStock.pbVsFloorPct === null
                    ? '—'
                    : `+${selectedStock.pbVsFloorPct.toFixed(1)}%`}
                </span>
                <span>一年内低点 {show(selectedStock.lowPrice1y)}</span>
                <span>三年内低点 {show(selectedStock.lowPrice3y)}</span>
              </div>
              {(() => {
                const riskItems = getRiskItems(selectedStock)
                const triggeredCount = riskItems.filter(
                  (r) => r.triggered === true,
                ).length
                return (
                  <div className="risk-panel">
                    <div className="risk-panel-head">
                      <strong>扫雷三项</strong>
                      <span
                        className={
                          triggeredCount > 0
                            ? 'risk-count danger'
                            : 'risk-count ok'
                        }
                      >
                        {triggeredCount > 0
                          ? `${triggeredCount} 项触发，按规则暂时剔除`
                          : '全部通过'}
                      </span>
                    </div>
                    <div className="risk-items">
                      {riskItems.map((item) => (
                        <div
                          key={item.key}
                          className={`risk-item-row ${
                            item.triggered === true
                              ? 'is-danger'
                              : item.triggered === false
                                ? 'is-ok'
                                : 'is-unknown'
                          }`}
                        >
                          <span className="risk-icon" aria-hidden="true">
                            {item.triggered === true
                              ? '!'
                              : item.triggered === false
                                ? '✓'
                                : '?'}
                          </span>
                          <div className="risk-item-body">
                            <div className="risk-item-label">{item.label}</div>
                            <div className="risk-item-detail">{item.detail}</div>
                          </div>
                          <span className="risk-item-value">{item.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}
              <div className="valuation-panel">
                <div className="valuation-panel-head">
                  <strong>PE / PB 历史走势</strong>
                  <span>季度采样，虚线为历史最低 / 最高</span>
                </div>
                {stockValuationLoading ? (
                  <p className="helper-text">估值历史加载中…</p>
                ) : stockValuationError ? (
                  <p className="helper-text">{stockValuationError}</p>
                ) : stockValuation ? (
                  <>
                    <div className="valuation-charts">
                      <StockValuationChart
                        label="PE(TTM)"
                        points={stockValuation.points.map((point) => ({
                          date: point.date,
                          value: point.pe,
                        }))}
                        current={stockValuation.current.pe}
                        percentile={stockValuation.pePercentile}
                        range={stockValuation.peRange}
                      />
                      <StockValuationChart
                        label="PB(MRQ)"
                        points={stockValuation.points.map((point) => ({
                          date: point.date,
                          value: point.pb,
                        }))}
                        current={stockValuation.current.pb}
                        percentile={stockValuation.pbPercentile}
                        range={stockValuation.pbRange}
                      />
                    </div>
                    <div className="table-wrap">
                      <table className="valuation-year-table">
                        <thead>
                          <tr>
                            <th>年度末</th>
                            <th>PE(TTM)</th>
                            <th>PB(MRQ)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stockValuation.yearEnd.map((row) => (
                            <tr key={row.year}>
                              <td>{row.year}</td>
                              <td>{row.pe === null ? '—' : row.pe.toFixed(2)}</td>
                              <td>{row.pb === null ? '—' : row.pb.toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <p className="helper-text">暂无估值历史数据。</p>
                )}
              </div>
              <ul className="explain-list">
                {stockDiagnosis.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="helper-text">未找到匹配股票。</p>
          )}
        </div>
      </section>

      <section className="section-grid">
        {researchHighlights.map((item) => (
          <article key={item.title} className="insight-card">
            <h2>{item.title}</h2>
            <p>{item.detail}</p>
          </article>
        ))}
      </section>
    </>
  )

  const scoreSection = (
    <section className="panel">
      <div className="section-title">
        <h2>大数评分</h2>
        <p>
          按截图补齐名称/代码、行业/细分、持仓、大数分、现价、涨1、涨3、扫雷宝与风险字段。
          这里的“持仓”展示你的实际持仓占比，不再使用系统自动生成的推荐权重。
          资产负债率判定放宽到「行业中位数 ×{' '}
          {(1 + config.debtMedianTolerance).toFixed(2)}」。
        </p>
      </div>

      <div className="action-row">
        <button type="button" onClick={exportScoreTable}>
          导出为 CSV
        </button>
        <div className="scope-tabs" role="tablist" aria-label="股票范围">
          <button
            type="button"
            role="tab"
            aria-selected={scoreScope === 'eligible'}
            className={scoreScope === 'eligible' ? 'scope-tab active' : 'scope-tab'}
            onClick={() => setScoreScope('eligible')}
          >
            三低池
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scoreScope === 'riskPassed'}
            className={scoreScope === 'riskPassed' ? 'scope-tab active' : 'scope-tab'}
            onClick={() => setScoreScope('riskPassed')}
          >
            排雷通过
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scoreScope === 'all'}
            className={scoreScope === 'all' ? 'scope-tab active' : 'scope-tab'}
            onClick={() => setScoreScope('all')}
          >
            全市场
          </button>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={excludeFinancial}
            onChange={(event) => setExcludeFinancial(event.target.checked)}
          />
          剔除金融（银行/保险/证券）
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={onlyNearPbFloor}
            onChange={(event) => setOnlyNearPbFloor(event.target.checked)}
          />
          只看接近 PB 底（≤{PB_FLOOR_NEAR_PCT}%）
        </label>
        <label className="inline-select">
          <span>三低档位</span>
          <select
            value={tripleLowTier}
            onChange={(event) =>
              setTripleLowTier(event.target.value as TripleLowTier)
            }
          >
            <option value="off">不限</option>
            <option value="loose">{TRIPLE_LOW_PRESETS.loose.label}</option>
            <option value="standard">{TRIPLE_LOW_PRESETS.standard.label}</option>
            <option value="strict">{TRIPLE_LOW_PRESETS.strict.label}</option>
          </select>
        </label>
        <input
          className="score-search"
          value={scoreQuery}
          onChange={(event) => setScoreQuery(event.target.value)}
          placeholder="搜索代码 / 名称 / 行业"
        />
        {scoreQuery && (
          <button
            type="button"
            className="link-button"
            onClick={() => setScoreQuery('')}
          >
            清除
          </button>
        )}
        <span className="helper-text">共 {visibleStocks.length} 条</span>
      </div>

      <div className="table-wrap tall sticky-head">
        <table>
          <thead>
            <tr>
              {renderScoreSortHeader('name', '名称/代码')}
              {renderScoreSortHeader('industry', '行业/细分')}
              {renderScoreSortHeader('holding', '持仓')}
              {renderScoreSortHeader('score', '大数分')}
              {renderScoreSortHeader('pb', 'PB')}
              {renderScoreSortHeader('stockPbFloor', '个股PB底')}
              {renderScoreSortHeader('pe', 'PE')}
              {renderScoreSortHeader('price', '现价')}
              {renderScoreSortHeader('gain1y', '涨1')}
              {renderScoreSortHeader('gain3y', '涨3')}
              {renderScoreSortHeader('mine', '扫雷宝')}
              {renderScoreSortHeader('marketCap', '总市值')}
              {renderScoreSortHeader('dividendYield', '股息率')}
              {renderScoreSortHeader('pledgeRatio', '质押率')}
              {renderScoreSortHeader('goodwillRatio', '商誉')}
              {renderScoreSortHeader('debtRatio', '资产负债率')}
              {renderScoreSortHeader('eligible', '状态')}
              <th>排雷</th>
            </tr>
          </thead>
          <tbody>
            {sortedVisibleStocks.slice(0, 300).map((stock) => {
              const hintItems = [
                ...stock.notes,
                ...stock.missingFields.map((field) => `待补：${field}`),
              ]
              const riskItems = getRiskItems(stock)
              const triggeredCount = riskItems.filter(
                (item) => item.triggered === true,
              ).length
              const debtDeviation =
                stock.debtRatio !== null && stock.industryDebtMedian !== null
                  ? stock.debtRatio - stock.industryDebtMedian
                  : null

              return (
              <tr key={stock.code}>
                <td>
                  <div>{stock.name}</div>
                  <div className="helper-text">{stock.code}</div>
                </td>
                <td>
                  <div>{stock.sector}</div>
                  <div className="helper-text">{stock.industry}</div>
                </td>
                <td>
                  {holdingWeightByCode.has(stock.code)
                    ? `${((holdingWeightByCode.get(stock.code) ?? 0) * 100).toFixed(0)}%`
                    : '—'}
                </td>
                <td>
                  <div>{show(stock.winProbability, 1)}</div>
                  <div className="helper-text">{stock.totalScore.toFixed(0)}</div>
                </td>
                <td className={pbFloorClass(stock.pbVsFloorPct)} title={pbFloorTitle(stock)}>
                  {show(stock.pb)}
                </td>
                <td>{show(stock.stockPbFloor)}</td>
                <td>{show(stock.pe)}</td>
                <td>{show(stock.price)}</td>
                <td>{gainView(stock.gain1y, 0)}</td>
                <td>{gainView(stock.gain3y, 0)}</td>
                <td>{stock.mineScore}</td>
                <td>{yi(stock.marketCap)}</td>
                <td>{percentView(stock.dividendYield, 1)}</td>
                <td>{percentView(stock.pledgeRatio, 1)}</td>
                <td>{percentView(stock.goodwillRatio, 1)}</td>
                <td>
                  {show(stock.debtRatio, 1)}
                  {debtDeviation !== null && (
                    <span
                      className={
                        stock.debtAboveIndustryMedian === true
                          ? 'debt-dev danger'
                          : 'debt-dev'
                      }
                    >
                      {' '}
                      {debtDeviation >= 0 ? '+' : ''}
                      {debtDeviation.toFixed(0)}
                    </span>
                  )}
                </td>
                <td>
                  <span className={stock.eligible ? 'status ok' : 'status muted'}>
                    {stock.eligible ? '通过' : '未通过'}
                  </span>
                </td>
                <td className="risk-cell">
                  <span
                    className={
                      triggeredCount > 0
                        ? 'risk-status danger'
                        : 'risk-status ok'
                    }
                  >
                    {triggeredCount > 0 ? `${triggeredCount} 项` : '通过'}
                  </span>
                  <div className="risk-dots">
                    {riskItems.map((item) => (
                      <span
                        key={item.key}
                        className={`risk-dot ${
                          item.triggered === true
                            ? 'is-danger'
                            : item.triggered === false
                              ? 'is-ok'
                              : 'is-unknown'
                        }`}
                      >
                        {item.key === 'debt'
                          ? '债'
                          : item.key === 'goodwill'
                            ? '誉'
                            : '质'}
                      </span>
                    ))}
                  </div>
                  <div className="risk-popover">
                    <button
                      type="button"
                      className="risk-trigger"
                      aria-label={`查看 ${stock.name} 的风险提示`}
                    >
                      查看
                    </button>
                    <div className="risk-bubble">
                      {hintItems.length > 0 ? (
                        <div className="risk-list">
                          {hintItems.map((item) => (
                            <div key={item} className="risk-item">
                              {item}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="risk-empty">无明显提示</div>
                      )}
                    </div>
                  </div>
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="helper-text pb-legend">
        <span className="pb-level pb-level-low">PB 绿</span> = 距行业 PB 底 ≤ {PB_FLOOR_NEAR_PCT}%（相对便宜）；
        <span className="pb-level pb-level-mid">PB 黄</span> = 高于底部 {PB_FLOOR_NEAR_PCT}%~{PB_FLOOR_FAR_PCT}%；
        <span className="pb-level pb-level-high">PB 红</span> = 高于底部 ≥ {PB_FLOOR_FAR_PCT}%。
        PB 底取该细分行业内最低的正 PB，悬停单个 PB 可看具体偏离值。
      </p>
    </section>
  )

  const portfolioSection = (
    <section className="panel">
      <div className="section-title">
        <h2>持仓</h2>
        <p>
          持仓由你手动维护，或者通过同花顺/券商导出的 CSV 导入；系统只负责基于当前股票池补齐评分与诊断信息。
        </p>
      </div>
      <div className="meta-grid">
        <div>
          <span>组合 PB</span>
          <strong>{show(holdingWeightedPb)}</strong>
        </div>
        <div>
          <span>组合 PEttm</span>
          <strong>{show(holdingWeightedPe)}</strong>
        </div>
        <div>
          <span>当前仓位</span>
          <strong>{(currentPositionRatio * 100).toFixed(1)}%</strong>
        </div>
        <div>
          <span>持仓市值</span>
          <strong>{currency(estimatedHoldingMarketValue, 0)}</strong>
        </div>
        <div>
          <span>现金</span>
          <strong>{currency(cashBalance, 0)}</strong>
        </div>
        <div>
          <span>总资产</span>
          <strong>{currency(effectiveTotalAsset, 0)}</strong>
        </div>
      </div>
      <p className="helper-text">
        现金与总资产在「持仓汇总 → 账户资金」里手动填写；总资产留空时按“现金 ÷ (1 − 持仓占比合计)”推算。
      </p>
      <div className="action-row">
        <label className="inline-search">
          <span>股票代码</span>
          <input
            value={holdingCodeInput}
            onChange={(event) => setHoldingCodeInput(event.target.value)}
            placeholder="例如 600036"
          />
        </label>
        <label className="inline-search">
          <span>持仓占比(%)</span>
          <input
            value={holdingWeightInput}
            onChange={(event) => setHoldingWeightInput(event.target.value)}
            placeholder="例如 3 或 3%"
          />
        </label>
        <label className="inline-search">
          <span>成本价</span>
          <input
            value={holdingCostInput}
            onChange={(event) => setHoldingCostInput(event.target.value)}
            placeholder="例如 12.36"
          />
        </label>
        <button type="button" onClick={handleAddHolding}>
          添加持仓
        </button>
        <label className="file-button">
          导入持仓 CSV
          <input type="file" accept=".csv" onChange={handleHoldingsImport} />
        </label>
        <button
          type="button"
          className="button-secondary"
          onClick={handleClearHoldings}
          disabled={holdingDetails.length === 0}
        >
          清空持仓
        </button>
      </div>
      <p className="helper-text">
        支持直接导入同花顺/通用 CSV。优先识别“持仓占比/仓位/权重”和“成本价/买入价/成交均价”；若缺少占比但存在“市值/持仓市值”，则会按市值自动折算持仓占比。
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>代码</th>
              <th>名称</th>
              <th>行业</th>
              <th>细分</th>
              <th>三好学生评分</th>
              <th>绝对胜算概率</th>
              <th>持仓占比</th>
              <th>成本价</th>
              <th>现价</th>
              <th>来源</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {holdingDetails.map((item) => {
              return (
                <tr key={item.code}>
                  <td>{item.code}</td>
                  <td>{item.name}</td>
                  <td>{item.sector}</td>
                  <td>{item.industry}</td>
                  <td>{item.score > 0 ? item.score.toFixed(1) : '—'}</td>
                  <td>{percentView(item.winProbability, 1)}</td>
                  <td>{item.weightKnown ? `${(item.targetWeight * 100).toFixed(2)}%` : '—'}</td>
                  <td>{show(item.costPrice)}</td>
                  <td>{show(item.price)}</td>
                  <td>{item.sourceLabel}</td>
                  <td>
                    <button
                      type="button"
                      className="risk-trigger"
                      onClick={() => handleDeleteHolding(item.code)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              )
            })}
            {holdingDetails.length === 0 && (
              <tr>
                <td colSpan={11}>
                  暂无持仓数据。请手动添加，或导入同花顺导出的持仓 CSV。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )

  const portfolioSummarySection = (
    <section className="panel">
      <div className="section-title">
        <h2>持仓汇总</h2>
        <p>按你的实际持仓聚合行业，方便看仓位分散度和行业权重占用情况。</p>
      </div>
      <div className="two-columns">
        <div>
          <div className="section-title">
            <h2>账户资金</h2>
            <p>手动维护现金余额与总资产，并自动汇总净流入、持仓市值、当前仓位与浮盈亏。</p>
          </div>
          <div className="action-row">
            <label className="inline-search">
              <span>当前现金</span>
              <input
                value={cashBalanceInput}
                onChange={(event) => setCashBalanceInput(event.target.value)}
                placeholder="例如 47068"
              />
            </label>
            <label className="inline-search">
              <span>总资产</span>
              <input
                value={totalAssetsInput}
                onChange={(event) => setTotalAssetsInput(event.target.value)}
                placeholder="留空则按持仓占比推算"
              />
            </label>
            <button type="button" onClick={handleSaveAccountAmounts}>
              保存
            </button>
          </div>
          <div className="meta-grid">
            <div>
              <span>累计净流入</span>
              <strong>{currency(capitalNetFlow, 0)}</strong>
            </div>
            <div>
              <span>现金余额</span>
              <strong>{currency(cashBalance, 0)}</strong>
            </div>
            <div>
              <span>持仓市值</span>
              <strong>{currency(estimatedHoldingMarketValue, 0)}</strong>
            </div>
            <div>
              <span>总资产</span>
              <strong>{currency(effectiveTotalAsset, 0)}</strong>
            </div>
            <div>
              <span>当前仓位</span>
              <strong>{(currentPositionRatio * 100).toFixed(1)}%</strong>
            </div>
            <div>
              <span>推算浮盈亏</span>
              <strong>{currency(estimatedFloatingProfit, 0)}</strong>
            </div>
          </div>
        </div>
        <div>
          <div className="section-title">
            <h2>资金变动</h2>
            <p>记录入金、出金、分红和取现，系统会同步调整现金余额并保留流水。</p>
          </div>
          <div className="control-grid capital-grid">
            <label>
              日期
              <input
                type="date"
                value={capitalDateInput}
                onChange={(event) => setCapitalDateInput(event.target.value)}
              />
            </label>
            <label>
              类型
              <select
                value={capitalTypeInput}
                onChange={(event) =>
                  setCapitalTypeInput(event.target.value as CapitalEventType)
                }
              >
                <option value="入金">入金</option>
                <option value="出金">出金</option>
                <option value="分红">分红</option>
                <option value="取现">取现</option>
              </select>
            </label>
            <label>
              金额
              <input
                value={capitalAmountInput}
                onChange={(event) => setCapitalAmountInput(event.target.value)}
                placeholder="例如 5000"
              />
            </label>
            <label>
              备注
              <input
                value={capitalNoteInput}
                onChange={(event) => setCapitalNoteInput(event.target.value)}
                placeholder="例如 银证转入 / 红利到账"
              />
            </label>
          </div>
          <div className="action-row">
            <button type="button" onClick={handleAddCapitalEvent}>
              记录资金变动
            </button>
          </div>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>类型</th>
              <th>金额</th>
              <th>净影响</th>
              <th>备注</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {capitalEvents.map((item) => (
              <tr key={item.id}>
                <td>{item.date}</td>
                <td>{item.type}</td>
                <td>{currency(item.amount, 2)}</td>
                <td>{signedCapitalAmount(item).toFixed(2)}</td>
                <td>{item.note || '—'}</td>
                <td>
                  <button
                    type="button"
                    className="risk-trigger"
                    onClick={() => handleDeleteCapitalEvent(item.id)}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
            {capitalEvents.length === 0 && (
              <tr>
                <td colSpan={6}>暂无资金流水，先记录一笔入金或分红即可开始。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>行业</th>
              <th>持仓数</th>
              <th>持仓占比</th>
              <th>平均评分</th>
              <th>平均胜算</th>
              <th>股票代码</th>
            </tr>
          </thead>
          <tbody>
            {portfolioSummaries.map((item) => (
              <tr key={item.industry}>
                <td>{item.industry}</td>
                <td>{item.holdingCount}</td>
                <td>{(item.targetWeight * 100).toFixed(2)}%</td>
                <td>{item.avgScore.toFixed(1)}</td>
                <td>{percentView(item.avgWinProbability, 1)}</td>
                <td>{item.codes.join(', ')}</td>
              </tr>
            ))}
            {portfolioSummaries.length === 0 && (
              <tr>
                <td colSpan={6}>暂无持仓汇总数据，请先录入你的持仓。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )

  const industriesSection = (
    <section className="panel">
      <div className="section-title">
        <h2>细分行业</h2>
        <p>对截图里的行业汇总能力做了完整接入，核心看 PB 底、PB 涨幅、PE、总市值与净资产。</p>
      </div>
      <div className="action-row">
        <label className="inline-search">
          <span>搜索行业</span>
          <input
            value={industryQuery}
            onChange={(event) => setIndustryQuery(event.target.value)}
            placeholder="例如 银行 / 汽车零部件"
          />
        </label>
        <button type="button" onClick={exportIndustryTable}>
          导出行业汇总 CSV
        </button>
      </div>
      <div className="table-wrap tall">
        <table>
          <thead>
            <tr>
              <th>细分</th>
              <th>资产负债率</th>
              <th>PB涨幅</th>
              <th>PB底</th>
              <th>PB</th>
              <th>↑PE</th>
              <th>总市值(亿)</th>
              <th>净资产(亿)</th>
              <th>通过数</th>
              <th>行业高分股</th>
            </tr>
          </thead>
          <tbody>
            {visibleIndustries.map((item) => (
              <tr key={item.industry}>
                <td>{item.industry}</td>
                <td>{percentView(item.avgDebtRatio, 0)}</td>
                <td>{percentView(item.pbGain, 1)}</td>
                <td>{show(item.pbFloor)}</td>
                <td>{show(item.pb)}</td>
                <td>{show(item.pe)}</td>
                <td>{yi(item.marketCap, 0)}</td>
                <td>{yi(item.netAsset, 0)}</td>
                <td>
                  {item.eligibleCount} / {item.stockCount}
                </td>
                <td>
                  {item.bestStockName ?? '—'}
                  {item.bestStockCode ? ` (${item.bestStockCode})` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )

  const cycleSection = (
    <section className="panel">
      <div className="section-title">
        <h2>周期行业</h2>
        <p>
          先按预置的经典周期行业清单命中，再用行业 PB 月度序列的振幅与波动强度补足评分；
          右侧（下方）曲线为该行业 2018 年至今的市值加权 PB（虚线为中位数），
          并标注历史高低点与当前所处分位。
        </p>
      </div>

      <div className="action-row">
        <label className="inline-search">
          <span>搜索行业</span>
          <input
            value={cycleQuery}
            onChange={(event) => {
              setCycleQuery(event.target.value)
              setCycleSelectValue('')
            }}
            placeholder="例如 有色 / 水泥 / 生猪"
          />
        </label>
        <label className="inline-search">
          <span>或从行业列表选择</span>
          <select
            value={cycleSelectValue}
            onChange={(event) => {
              const industry = event.target.value
              setCycleSelectValue(industry)
              setCycleQuery(industry)
              if (industry) setSelectedCycleIndustry(industry)
            }}
          >
            <option value="">选择周期行业</option>
            {industryCycle === null ? (
              <option value="__status__" disabled>
                {industryCycleLoading
                  ? '行业列表加载中…'
                  : industryCycleError
                    ? '行业数据暂不可用'
                    : '暂无行业数据'}
              </option>
            ) : cycleIndustryOptions.length > 0 ? (
              cycleIndustryOptions.map((row) => (
                <option key={row.industry} value={row.industry}>
                  {row.industry}（{row.group ?? '非预置'} · {row.score.total.toFixed(0)}分）
                </option>
              ))
            ) : (
              <option value="__empty__" disabled>
                当前筛选条件下暂无行业
              </option>
            )}
          </select>
        </label>
        <label className="inline-search">
          <span>最低周期评分</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={3}
            value={cycleMinScoreInput}
            onChange={(event) => {
              const digits = event.target.value.replace(/\D/g, '').slice(0, 3)
              const normalized = digits.replace(/^0+(?=\d)/, '')
              const next = normalized === '' ? 0 : Number(normalized)
              const clamped = Math.min(100, next)
              setCycleMinScoreInput(normalized === '' ? '' : String(clamped))
              setCycleMinScore(clamped)
            }}
          />
        </label>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={cycleOnlyCyclical}
            onChange={(event) => setCycleOnlyCyclical(event.target.checked)}
          />
          <span>只看命中预置清单的行业</span>
        </label>
      </div>

      {industryCycle === null ? (
        <div className="cycle-load-status" role={industryCycleError ? 'alert' : 'status'}>
          <p className={industryCycleError ? 'helper-text error' : 'helper-text'}>
            {industryCycleLoading
              ? '正在从服务端获取行业 PB 历史序列（数据源覆盖 2018 年至今）。首次生成缓存约需 2–3 分钟。'
              : industryCycleError}
          </p>
          {industryCycleError && (
            <button
              type="button"
              className="button-secondary"
              onClick={() => setIndustryCycleFetchAttempt((attempt) => attempt + 1)}
            >
              重试加载
            </button>
          )}
        </div>
      ) : (
        <>
          {selectedCycleRow && (
            <div className="cycle-detail">
              <div className="metric-grid cycle-metric-grid">
                <article className="metric-card">
                  <span>当前 PB</span>
                  <strong>{show(selectedCycleRow.stats.current)}</strong>
                </article>
                <article className="metric-card">
                  <span>历史最低 PB（{formatMonth(selectedCycleRow.stats.minDate)}）</span>
                  <strong>{show(selectedCycleRow.stats.min)}</strong>
                </article>
                <article className="metric-card">
                  <span>当前历史分位</span>
                  <strong>{percentView(selectedCycleRow.stats.percentile, 0)}</strong>
                </article>
                <article className="metric-card">
                  <span>周期性评分 / 归类</span>
                  <strong>
                    {selectedCycleRow.score.total.toFixed(0)}
                    <small className="cycle-level"> {selectedCycleRow.score.level}</small>
                  </strong>
                </article>
              </div>
              <IndustryCycleChart
                industry={selectedCycleRow.industry}
                dates={industryCycle.dates}
                series={industryCycle.series[selectedCycleRow.industry]}
                stats={selectedCycleRow.stats}
              />
            </div>
          )}

          {cycleRows.length === 0 ? (
            <p className="helper-text">
              没有符合条件的行业，可尝试降低周期评分门槛或关闭「只看命中预置清单的行业」。
            </p>
          ) : (
            <div className="table-wrap tall">
              <table>
                <thead>
                  <tr>
                    <th>细分行业</th>
                    <th>周期归类</th>
                    {renderCycleSortHeader('score', '周期评分')}
                    {renderCycleSortHeader('current', '当前PB')}
                    {renderCycleSortHeader('floor', '历史最低PB')}
                    {renderCycleSortHeader('percentile', '当前分位')}
                    {renderCycleSortHeader('amplitude', '振幅(倍)')}
                    {renderCycleSortHeader('trend1y', '近一年')}
                  </tr>
                </thead>
                <tbody>
                  {cycleRows.map((row) => (
                    <tr
                      key={row.industry}
                      className={
                        selectedCycleRow?.industry === row.industry
                          ? 'cycle-row active'
                          : 'cycle-row'
                      }
                      onClick={() => setSelectedCycleIndustry(row.industry)}
                    >
                      <td>{row.industry}</td>
                      <td>
                        {row.group ?? '—'}
                        <span
                          className={
                            row.score.total >= CYCLICAL_STRONG_THRESHOLD
                              ? 'cycle-badge strong'
                              : 'cycle-badge'
                          }
                        >
                          {row.score.level}
                        </span>
                      </td>
                      <td>{row.score.total.toFixed(1)}</td>
                      <td>{show(row.stats.current)}</td>
                      <td>
                        {show(row.stats.min)}
                        <span className="helper-text">
                          {' '}
                          {formatMonth(row.stats.minDate)}
                        </span>
                      </td>
                      <td>{percentView(row.stats.percentile, 0)}</td>
                      <td>{fixed(row.stats.amplitude === null ? null : 1 + row.stats.amplitude, 2)}</td>
                      <td>
                        {row.stats.trend1y === null
                          ? '—'
                          : `${row.stats.trend1y >= 0 ? '+' : ''}${row.stats.trend1y.toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )

  const archivesSection = (
    <section className="panel">
      <div className="section-title">
        <h2>归档</h2>
        <p>保留最近 6 份本地快照，可随时回放当时的股票池、参数与市场快照。</p>
      </div>
      <div className="archive-list">
        {snapshots.map((snapshot) => (
          <article key={snapshot.id} className="archive-card">
            <div>
              <strong>{snapshot.label}</strong>
              <p>{snapshot.createdAt}</p>
              <p>
                {snapshot.dataMeta?.name ?? '本地数据'} / {snapshot.stocks.length} 只股票
              </p>
            </div>
            <div className="action-row">
              <button type="button" onClick={() => handleRestoreSnapshot(snapshot)}>
                恢复
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => handleDeleteSnapshot(snapshot.id)}
              >
                删除
              </button>
            </div>
          </article>
        ))}
        {snapshots.length === 0 && <p className="helper-text">暂无归档，先拉最新数据后点击“归档当前结果”。</p>}
      </div>
    </section>
  )

  const aiSection = (
    <section className="panel">
      <div className="section-title">
        <h2>AI</h2>
        <p>这里先集成基于当前数据实时生成的策略摘要，后续可以再接外部模型。</p>
      </div>
      <div className="ai-grid">
        {aiHighlights.map((line) => (
          <article key={line} className="insight-card">
            <p>{line}</p>
          </article>
        ))}
      </div>
    </section>
  )

  return (
    <div className={sidebarVisible ? 'workspace-shell' : 'workspace-shell sidebar-collapsed'}>
      <aside className={sidebarVisible ? 'sidebar' : 'sidebar hidden'}>
        <div className="sidebar-header">
          <strong>大数工作台</strong>
          <p>suiyi / 研究模式</p>
        </div>
        <nav className="nav-list">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={item.key === activeView ? 'nav-item active' : 'nav-item'}
              onClick={() => setActiveView(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <p>当前数据：{dataMeta ? `${dataMeta.total} 只` : '演示数据'}</p>
          <p>未补 K 线：{pendingKline} 只</p>
          <UserMenu />
        </div>
      </aside>

      <main className="workspace-main">
        <div className="sidebar-toggle-bar">
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setSidebarVisible((current) => !current)}
          >
            {sidebarVisible ? '隐藏菜单' : '显示菜单'}
          </button>
        </div>

        {activeView === 'overview' && overviewSection}
        {activeView === 'scores' && scoreSection}
        {activeView === 'portfolio' && portfolioSection}
        {activeView === 'portfolioSummary' && portfolioSummarySection}
        {activeView === 'industries' && industriesSection}
        {activeView === 'cycle' && cycleSection}
        {activeView === 'archives' && archivesSection}
        {activeView === 'ai' && aiSection}

        <footer className="footer-note">
          评分算法还原自「大数模拟器」公开前端产物，方法源头为《大数投资》公开信息；
          行情与财务数据来自东方财富与腾讯公开接口。仅作研究与工具演示，不构成投资建议。
        </footer>
      </main>
    </div>
  )
}

export default App
