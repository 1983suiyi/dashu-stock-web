import type { DataSourceMeta, StockRecord } from '../types'

/**
 * 东方财富数据中心公开接口。
 *
 * 选它的原因（均经实测确认）：
 * 1. 免费、无需注册、无需 token；
 * 2. 响应头返回 `Access-Control-Allow-Origin: *`，浏览器可直连，无需自建后端；
 * 3. 单次可覆盖全部 A 股，且估值/财务/行业字段齐全。
 *
 * 注意：这是公开网页接口而非官方 API，字段和参数可能随时调整，
 * 因此所有解析都做了空值兜底，失败时向上抛出以便界面降级。
 */
const BASE = 'https://datacenter-web.eastmoney.com/api/data/v1/get'

type RawRow = Record<string, unknown>

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '' || value === '-') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const toText = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value)

type QueryParams = {
  reportName: string
  pageNumber: number
  pageSize: number
  sortColumns: string
  sortTypes: 1 | -1
  filter?: string
}

const queryPage = async (
  params: QueryParams,
): Promise<{ rows: RawRow[]; pages: number }> => {
  const url = new URL(BASE)
  url.searchParams.set('reportName', params.reportName)
  url.searchParams.set('columns', 'ALL')
  url.searchParams.set('pageNumber', String(params.pageNumber))
  url.searchParams.set('pageSize', String(params.pageSize))
  url.searchParams.set('sortColumns', params.sortColumns)
  url.searchParams.set('sortTypes', String(params.sortTypes))
  if (params.filter) url.searchParams.set('filter', params.filter)

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`数据接口返回 HTTP ${response.status}`)
  }

  const payload = (await response.json()) as {
    success?: boolean
    message?: string
    result?: { data?: RawRow[]; pages?: number } | null
  }

  if (!payload.success || !payload.result) {
    throw new Error(payload.message || '数据接口返回异常')
  }

  return {
    rows: payload.result.data ?? [],
    pages: payload.result.pages ?? 1,
  }
}

/** 限制并发，避免对公开接口造成压力或被限流 */
const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length)
  let cursor = 0

  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await task(items[index])
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  )
  return results
}

const PAGE_SIZE = 500
const CONCURRENCY = 5

const queryAll = async (
  params: Omit<QueryParams, 'pageNumber' | 'pageSize'>,
): Promise<RawRow[]> => {
  const first = await queryPage({ ...params, pageNumber: 1, pageSize: PAGE_SIZE })
  if (first.pages <= 1) return first.rows

  const remaining = Array.from(
    { length: first.pages - 1 },
    (_, index) => index + 2,
  )
  const rest = await mapLimit(remaining, CONCURRENCY, (pageNumber) =>
    queryPage({ ...params, pageNumber, pageSize: PAGE_SIZE }),
  )

  return rest.reduce<RawRow[]>((acc, page) => acc.concat(page.rows), first.rows)
}

/** 把某张报表最新一期的报告期锁定下来，保证财务数据口径一致 */
const latestReportDate = async (
  reportName: string,
  dateField: string,
): Promise<string> => {
  // 这些报表接口必须带 filter，否则返回 success:false；
  // 用「近一年」区间 + 按报告期倒序取第一条即可拿到最新报告期。
  const since = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)

  const page = await queryPage({
    reportName,
    pageNumber: 1,
    pageSize: 1,
    sortColumns: dateField,
    sortTypes: -1,
    filter: `(${dateField}>='${since}')`,
  })

  const value = toText(page.rows[0]?.[dateField])
  if (!value) throw new Error('未能获取最新报告期')
  return value.slice(0, 10)
}

/** 取最近一个交易日：按区间倒序取第一条，可自动跳过周末与节假日 */
const latestTradeDate = async (): Promise<string> => {
  const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)

  const page = await queryPage({
    reportName: 'RPT_VALUEANALYSIS_DET',
    pageNumber: 1,
    pageSize: 1,
    sortColumns: 'TRADE_DATE',
    sortTypes: -1,
    filter: `(TRADE_DATE>='${since}')`,
  })

  const value = toText(page.rows[0]?.TRADE_DATE)
  if (!value) throw new Error('未能获取最新交易日')
  return value.slice(0, 10)
}

const isAShare = (secucode: string) =>
  /\.(SH|SZ|BJ)$/.test(secucode) && !secucode.startsWith('9')

export type FetchProgress = (message: string) => void

export type RealMarketData = {
  stocks: StockRecord[]
  meta: DataSourceMeta
}

/**
 * 拉取全市场真实数据并合并成 StockRecord。
 * 数据来源分三张表：估值分析、资产负债表、业绩报表。
 */
export const fetchRealMarketData = async (
  onProgress?: FetchProgress,
): Promise<RealMarketData> => {
  onProgress?.('正在获取最新交易日…')
  const tradeDate = await latestTradeDate()

  onProgress?.(`正在获取全市场估值数据（${tradeDate}）…`)
  const valuationRows = await queryAll({
    reportName: 'RPT_VALUEANALYSIS_DET',
    sortColumns: 'SECURITY_CODE',
    sortTypes: 1,
    filter: `(TRADE_DATE='${tradeDate}')`,
  })

  onProgress?.('正在获取最近一期资产负债数据…')
  const balanceDate = await latestReportDate('RPT_DMSK_FN_BALANCE', 'REPORT_DATE')
  const balanceRows = await queryAll({
    reportName: 'RPT_DMSK_FN_BALANCE',
    sortColumns: 'SECURITY_CODE',
    sortTypes: 1,
    filter: `(REPORT_DATE='${balanceDate}')`,
  })

  onProgress?.('正在获取最近一期业绩数据…')
  // 注意：该报表的日期字段是 REPORTDATE，没有下划线
  const profitDate = await latestReportDate('RPT_LICO_FN_CPD', 'REPORTDATE')
  const profitRows = await queryAll({
    reportName: 'RPT_LICO_FN_CPD',
    sortColumns: 'SECURITY_CODE',
    sortTypes: 1,
    filter: `(REPORTDATE='${profitDate}')`,
  })

  onProgress?.('正在合并数据…')

  const debtByCode = new Map<string, number | null>()
  for (const row of balanceRows) {
    const code = toText(row.SECURITY_CODE)
    if (code) debtByCode.set(code, toNumber(row.DEBT_ASSET_RATIO))
  }

  const roeByCode = new Map<string, number | null>()
  for (const row of profitRows) {
    const code = toText(row.SECURITY_CODE)
    if (code) roeByCode.set(code, toNumber(row.WEIGHTAVG_ROE))
  }

  const stocks: StockRecord[] = []
  const seen = new Set<string>()

  for (const row of valuationRows) {
    const secucode = toText(row.SECUCODE)
    const code = toText(row.SECURITY_CODE)
    if (!code || seen.has(code)) continue
    if (secucode && !isAShare(secucode)) continue

    const name = toText(row.SECURITY_NAME_ABBR)
    if (!name) continue
    // 退市整理期股票估值极低（实测 PB 可低至 0.03），会污染低估值选股，直接剔除
    if (name.includes('退')) continue

    seen.add(code)
    stocks.push({
      code,
      name,
      industry: toText(row.BOARD_NAME) || '未分类',
      price: toNumber(row.CLOSE_PRICE),
      pb: toNumber(row.PB_MRQ),
      pe: toNumber(row.PE_TTM),
      ps: toNumber(row.PS_TTM),
      roe: roeByCode.get(code) ?? null,
      debtRatio: debtByCode.get(code) ?? null,
      marketCap: toNumber(row.TOTAL_MARKET_CAP),
      // 以下字段东财该表未提供，保持为空：股息率/商誉需另找数据源
      dividendYield: null,
      goodwillRatio: null,
      // 由后端 K 线代理补齐
      lowPrice1y: null,
      isST: /ST/i.test(name),
    })
  }

  if (stocks.length === 0) {
    throw new Error('未解析到任何股票数据')
  }

  return {
    stocks,
    meta: {
      name: '东方财富数据中心（公开接口）',
      tradeDate,
      reportDate: `${profitDate} / ${balanceDate}`,
      total: stocks.length,
      klineCount: 0,
      fetchedAt: new Date().toLocaleString('zh-CN'),
    },
  }
}
