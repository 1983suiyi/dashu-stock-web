/**
 * 个股 PE / PB 历史序列（个股估值走势口径）
 *
 * 目的：为个案诊断补充 PE(TTM)、PB(MRQ) 的历史走势与当前历史分位，回答
 * 「当前估值处在自身历史的什么位置」，这是行业级序列无法替代的。
 *
 * 口径说明：
 * - 数据源为东财 RPT_VALUEANALYSIS_DET（与 pb-floor.mjs / industry-cycle.mjs 同源），
 *   该报表按交易日逐股存储 PE_TTM / PB_MRQ，可精确回看个股历史估值；
 * - 实测该报表自 2018 年起才有数据，起始日期可调，早于覆盖范围的月份自动跳过；
 * - 亏损或负估值的样本（PE_TTM <= 0）会置空，避免污染走势与分位统计；
 * - 曲线按季度采样（每季度取最后一个交易日），并始终保留最新一个交易日，
 *   既保证 2018 至今约 35 个点足够看清趋势，又避免逐日序列过密；
 * - 当前分位 = 历史（日频、正估值样本）中「小于等于当前值」的比例。
 */
import https from 'node:https'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = resolve(__dirname, 'stock-valuation-cache.json')
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 天
const START_DATE = process.env.STOCK_VALUATION_START || '2018-01-01'
/** 单只股票 2018 至今约 2100 个交易日，4000 足以一次取全 */
const PAGE_SIZE = 4000
/** 文件缓存最多保留多少只股票，超出按写入时间淘汰最旧的 */
const MAX_CACHE_ENTRIES = 400

const BASE_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get'

const fetchJson = (url) =>
  new Promise((resolve, reject) => {
    https
      .get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://data.eastmoney.com/',
        },
      })
      .on('error', reject)
      .on('response', (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (error) {
            reject(error)
          }
        })
      })
  })

const round2 = (value) => Math.round(value * 100) / 100

/** 代码需为 6 位数字，防止把用户输入直接拼进查询条件 */
const normalizeCode = (code) => {
  if (typeof code !== 'string') return null
  const trimmed = code.trim()
  return /^\d{6}$/.test(trimmed) ? trimmed : null
}

const buildUrl = (code) =>
  `${BASE_URL}?reportName=RPT_VALUEANALYSIS_DET` +
  '&columns=SECURITY_CODE,SECURITY_NAME_ABBR,TRADE_DATE,PE_TTM,PB_MRQ' +
  '&pageNumber=1' +
  `&pageSize=${PAGE_SIZE}` +
  '&sortColumns=TRADE_DATE&sortTypes=1' +
  `&filter=${encodeURIComponent(`(SECURITY_CODE="${code}")(TRADE_DATE>='${START_DATE}')`)}`

const quarterKey = (date) => {
  const year = date.slice(0, 4)
  const month = Number(date.slice(5, 7))
  return `${year}-Q${Math.floor((month - 1) / 3) + 1}`
}

/** 当前值在历史正估值样本中的分位（百分比，0~100），无有效样本时返回 null */
const percentileOf = (values, target) => {
  if (!Number.isFinite(target) || values.length === 0) return null
  let count = 0
  for (const value of values) {
    if (value <= target) count += 1
  }
  return round2((count / values.length) * 100)
}

const rangeOf = (values) =>
  values.length === 0
    ? { min: null, max: null }
    : { min: Math.min(...values), max: Math.max(...values) }

/**
 * 拉取并整理单只个股的 PE/PB 历史。
 * @param {string} rawCode
 * @returns {Promise<object | null>} 无数据时返回 null
 */
export const calculateStockValuation = async (rawCode) => {
  const code = normalizeCode(rawCode)
  if (code === null) return null

  const data = await fetchJson(buildUrl(code))
  const rows = data.result?.data || []
  if (rows.length === 0) return null

  const name = rows[0].SECURITY_NAME_ABBR ?? ''

  /** @type {Array<{ date: string, pe: number|null, pb: number|null }>} 日频且升序 */
  const daily = []
  for (const row of rows) {
    const date = String(row.TRADE_DATE).slice(0, 10)
    const peRaw = Number(row.PE_TTM)
    const pbRaw = Number(row.PB_MRQ)
    const pe = Number.isFinite(peRaw) && peRaw > 0 ? round2(peRaw) : null
    const pb = Number.isFinite(pbRaw) && pbRaw > 0 ? round2(pbRaw) : null
    if (pe === null && pb === null) continue
    daily.push({ date, pe, pb })
  }
  if (daily.length === 0) return null

  // 季度采样：daily 升序，同一季度反复覆盖即得到该季度最后一个交易日
  const quarterLast = new Map()
  for (const row of daily) {
    quarterLast.set(quarterKey(row.date), row)
  }
  const points = [...quarterLast.values()]
  const latest = daily[daily.length - 1]
  // 最新一个交易日可能落在当季中间，单独补一个点，让曲线延伸到「今天」
  if (points[points.length - 1]?.date !== latest.date) {
    points.push(latest)
  }

  // 各年度末估值（用于年表）
  const yearLast = new Map()
  for (const row of daily) {
    yearLast.set(row.date.slice(0, 4), row)
  }
  const yearEnd = [...yearLast.entries()].map(([year, row]) => ({
    year: Number(year),
    pe: row.pe,
    pb: row.pb,
  }))

  const peValues = daily.map((row) => row.pe).filter((value) => value !== null)
  const pbValues = daily.map((row) => row.pb).filter((value) => value !== null)

  return {
    code,
    name,
    points,
    current: { date: latest.date, pe: latest.pe, pb: latest.pb },
    pePercentile: percentileOf(peValues, latest.pe),
    pbPercentile: percentileOf(pbValues, latest.pb),
    peRange: rangeOf(peValues),
    pbRange: rangeOf(pbValues),
    yearEnd,
    samples: daily.length,
  }
}

let memoryCache = null
let memoryCacheTime = 0

const isCacheStale = (cacheTime) => Date.now() - cacheTime > CACHE_TTL_MS

const loadCacheFromFile = async () => {
  try {
    const raw = await readFile(CACHE_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.entries) {
      return parsed.entries
    }
  } catch {
    // 无缓存或格式错误
  }
  return {}
}

const saveCacheToFile = async (entries) => {
  await writeFile(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), entries }))
}

/** 超出上限时按写入时间淘汰最旧条目，避免缓存文件无限增长 */
const pruneEntries = (entries) => {
  const keys = Object.keys(entries)
  if (keys.length <= MAX_CACHE_ENTRIES) return entries
  const sorted = keys.sort(
    (a, b) => (entries[a].timestamp ?? 0) - (entries[b].timestamp ?? 0),
  )
  const next = {}
  for (const key of sorted.slice(keys.length - MAX_CACHE_ENTRIES)) {
    next[key] = entries[key]
  }
  return next
}

/**
 * 获取个股估值历史，优先使用当日缓存；缺失或过期时重新抓取并写入缓存。
 * @param {string} code
 * @returns {Promise<object>}
 */
export const getStockValuation = async (code) => {
  const normalized = normalizeCode(code)
  if (normalized === null) {
    return { error: '股票代码需为 6 位数字' }
  }

  if (memoryCache === null) {
    memoryCache = await loadCacheFromFile()
  }

  const cached = memoryCache[normalized]
  if (cached && !isCacheStale(cached.timestamp)) {
    return { ...cached.payload, cached: true, timestamp: cached.timestamp }
  }

  const payload = await calculateStockValuation(normalized)
  if (payload === null) {
    return { error: `未找到 ${normalized} 的估值历史数据` }
  }

  memoryCache[normalized] = { timestamp: Date.now(), payload }
  memoryCache = pruneEntries(memoryCache)
  await saveCacheToFile(memoryCache)

  return { ...payload, cached: false, timestamp: Date.now() }
}
