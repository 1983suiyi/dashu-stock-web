import { useEffect, useMemo, useState } from 'react'
import { defaultConfig, defaultMarketSnapshot, demoStocks } from './data/stocks'
import { downloadCsv, toCsv } from './lib/csv'
import { fetchRealMarketData, fetchStockByCode } from './lib/eastmoney'
import { normalizeIndustry } from './lib/industry'
import { applyKline, fetchKlines } from './lib/kline'
import {
  buildAiHighlights,
  explainStockExclusion,
  summarizeIndustries,
  summarizePortfolioIndustries,
} from './lib/analytics'
import {
  MAX_SCORE,
  deriveMarketSnapshot,
  pbBand,
  peBand,
  pickKlineCandidates,
  portfolioExposure,
  recommendPortfolio,
  scoreStocks,
  summarizeMarket,
} from './lib/strategy'
import type {
  DataSourceMeta,
  MarketSnapshot,
  PortfolioHolding,
  StockRecord,
  StrategyConfig,
} from './types'

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

type CapitalEvent = {
  id: string
  date: string
  type: CapitalEventType
  amount: number
  note: string
}

const ARCHIVE_STORAGE_KEY = 'dashu-workspace-archives'
const HOLDING_STORAGE_KEY = 'dashu-user-holdings'
const CASH_BALANCE_STORAGE_KEY = 'dashu-cash-balance'
const TOTAL_ASSETS_STORAGE_KEY = 'dashu-total-assets'
const CAPITAL_EVENTS_STORAGE_KEY = 'dashu-capital-events'

const navItems: Array<{ key: WorkspaceView; label: string }> = [
  { key: 'overview', label: '市场概况' },
  { key: 'scores', label: '大数评分' },
  { key: 'portfolio', label: '持仓' },
  { key: 'portfolioSummary', label: '持仓汇总' },
  { key: 'industries', label: '细分行业' },
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

const normalize = (value: string) => value.trim().toLowerCase()
const todayText = () => new Date().toISOString().slice(0, 10)
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
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [onlyEligible, setOnlyEligible] = useState(false)
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
  const [capitalTypeInput, setCapitalTypeInput] = useState<CapitalEventType>('入金')
  const [capitalAmountInput, setCapitalAmountInput] = useState('')
  const [capitalNoteInput, setCapitalNoteInput] = useState('')

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
    try {
      localStorage.setItem(HOLDING_STORAGE_KEY, JSON.stringify(holdingImports))
    } catch {
      // localStorage 超限时保留内存态，不打断主流程
    }
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

  useEffect(() => {
    try {
      localStorage.setItem(CASH_BALANCE_STORAGE_KEY, String(cashBalance))
    } catch {
      // localStorage 超限时保留内存态，不打断主流程
    }
  }, [cashBalance])

  useEffect(() => {
    try {
      localStorage.setItem(
        TOTAL_ASSETS_STORAGE_KEY,
        totalAssets === null ? '' : String(totalAssets),
      )
    } catch {
      // localStorage 超限时保留内存态，不打断主流程
    }
  }, [totalAssets])

  useEffect(() => {
    try {
      localStorage.setItem(CAPITAL_EVENTS_STORAGE_KEY, JSON.stringify(capitalEvents))
    } catch {
      // localStorage 超限时保留内存态，不打断主流程
    }
  }, [capitalEvents])

  const scoredStocks = useMemo(
    () => scoreStocks(stocks, config),
    [stocks, config],
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
  const industrySummaries = useMemo(
    () => summarizeIndustries(scoredStocks),
    [scoredStocks],
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
  const visibleStocks = onlyEligible ? eligibleStocks : scoredStocks
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
  const visibleIndustries = useMemo(() => {
    const keyword = normalize(industryQuery)
    if (!keyword) return industrySummaries
    return industrySummaries.filter((item) => {
      const hay = `${item.industry} ${item.bestStockName ?? ''} ${item.bestStockCode ?? ''}`.toLowerCase()
      return hay.includes(keyword)
    })
  }, [industryQuery, industrySummaries])

  const persistSnapshots = (next: ArchiveSnapshot[]) => {
    setSnapshots(next)
    try {
      localStorage.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // localStorage 超限时保留内存态，不打断主流程
    }
  }

  const handleConfigChange = (key: keyof StrategyConfig, value: number) => {
    setConfig((current) => ({ ...current, [key]: value }))
  }

  const runKlineStep = async (universe: StockRecord[]) => {
    const candidates = pickKlineCandidates(
      scoreStocks(universe, config),
      config,
    )
    if (candidates.length === 0) {
      return { stocks: universe, count: 0, failed: [] as string[] }
    }

    const { data, failed } = await fetchKlines(
      candidates,
      config.klineDays,
      (done, total) => setProgress(`正在补齐一年/三年低价：${done}/${total}`),
    )

    return {
      stocks: applyKline(universe, data),
      count: Object.keys(data).length,
      failed,
    }
  }

  const handleFetchAll = async () => {
    setLoading(true)
    setWarning('')
    setProgress('开始拉取…')
    try {
      const { stocks: universe, meta } = await fetchRealMarketData(setProgress)
      const { stocks: enriched, count, failed } = await runKlineStep(universe)
      setStocks(enriched)
      setMarket(deriveMarketSnapshot(enriched))
      setDataMeta({ ...meta, klineCount: count })
      setMessage(
        `已接入最新数据：${meta.total} 只 A 股，东财交易日 ${meta.tradeDate}，` +
          `其中 ${count} 只补齐了一年/三年低价，并已用腾讯快照刷新现价。`,
      )
      if (failed.length > 0) {
        setWarning(`有 ${failed.length} 只候选未能取到 K 线，其涨幅得分暂缺。`)
      }
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

  const handleFillKline = async () => {
    setLoading(true)
    setWarning('')
    setProgress('开始补齐 K 线…')
    try {
      const { stocks: enriched, count, failed } = await runKlineStep(stocks)
      setStocks(enriched)
      setMarket(deriveMarketSnapshot(enriched))
      setDataMeta((current) =>
        current ? { ...current, klineCount: count } : current,
      )
      setMessage(`已为 ${count} 只候选补齐一年/三年低价，并刷新最新现价。`)
      if (failed.length > 0) {
        setWarning(`有 ${failed.length} 只候选未能取到 K 线。`)
      }
    } catch (error) {
      setWarning(
        `补齐失败：${error instanceof Error ? error.message : String(error)}。` +
          ' 请确认通过 npm run dev 或 npm start 启动（K 线需要本地服务）。',
      )
    } finally {
      setLoading(false)
      setProgress('')
    }
  }

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
      fixed(stock.pe),
      fixed(stock.price),
      percent(stock.gain1y),
      percent(stock.gain3y),
      fixed(stock.pbScore, 1),
      fixed(stock.peScore, 1),
      fixed(stock.priceScore, 1),
      fixed(stock.totalScore, 1),
      fixed(stock.winProbability, 1),
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
          'PE',
          '现价',
          '一年涨幅(%)',
          '三年涨幅(%)',
          'PB得分',
          'PE得分',
          '涨幅得分',
          '三好学生评分',
          '绝对胜算概率(%)',
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
          <button type="button" onClick={handleFillKline} disabled={loading}>
            仅补齐 K 线
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
          说明：财务与估值字段采用最近公开快照；现价优先使用腾讯最新快照。涨幅得分依赖「一年内最低价」，截图中的涨3依赖「三年内最低价」。为控制请求量，只对
          <strong>可能达到门槛</strong>的候选（PB+PE 得分 &gt; 门槛 − 100）补 K
          线，该剪枝不丢结果。当前仍有 {pendingKline} 只未补齐。
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
            <p>这里可以直接查某只股票为什么未进推荐组合。默认已定位到贵州轮胎。</p>
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
                <span>
                  资产负债率 {show(selectedStock.debtRatio, 1)} / 中位数{' '}
                  {show(selectedStock.industryDebtMedian, 1)} / 上限{' '}
                  {show(selectedStock.industryDebtMedianLimit, 1)}
                </span>
                <span>涨1 {gainView(selectedStock.gain1y, 0)}</span>
                <span>涨3 {gainView(selectedStock.gain3y, 0)}</span>
                <span>一年内低点 {show(selectedStock.lowPrice1y)}</span>
                <span>三年内低点 {show(selectedStock.lowPrice3y)}</span>
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
        <label className="toggle">
          <input
            type="checkbox"
            checked={onlyEligible}
            onChange={(event) => setOnlyEligible(event.target.checked)}
          />
          只看通过筛选
        </label>
        <span className="helper-text">共 {visibleStocks.length} 条</span>
      </div>

      <div className="table-wrap tall sticky-head">
        <table>
          <thead>
            <tr>
              <th>名称/代码</th>
              <th>行业/细分</th>
              <th>持仓</th>
              <th>大数分</th>
              <th>PB</th>
              <th>PE</th>
              <th>现价</th>
              <th>涨1</th>
              <th>涨3</th>
              <th>扫雷宝</th>
              <th>总市值</th>
              <th>股息率</th>
              <th>质押率</th>
              <th>商誉</th>
              <th>资产负债 / 宽容上限</th>
              <th>状态</th>
              <th>风险提示</th>
            </tr>
          </thead>
          <tbody>
            {visibleStocks.slice(0, 300).map((stock) => {
              const hintItems = [
                ...stock.notes,
                ...stock.missingFields.map((field) => `待补：${field}`),
              ]

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
                <td>{show(stock.pb)}</td>
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
                  {show(stock.debtRatio, 1)} / {show(stock.industryDebtMedianLimit, 1)}
                </td>
                <td>
                  <span className={stock.eligible ? 'status ok' : 'status muted'}>
                    {stock.eligible ? '通过' : '未通过'}
                  </span>
                </td>
                <td className="risk-cell">
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
