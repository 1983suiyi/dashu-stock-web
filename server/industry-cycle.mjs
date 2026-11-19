/**
 * 行业 PB 时间序列（周期研究口径）
 *
 * 目的：为「周期行业」页面提供按月的行业 PB 曲线，用于判断行业景气所处位置。
 *
 * 口径说明：
 * - 数据源与 pb-floor.mjs 相同（东财 RPT_VALUEANALYSIS_DET 月度快照），
 *   只是这里保留完整序列而不是只取最低值；
 * - 该报表按交易日存储，直接查「每月 1 号」在非交易日会返回空，
 *   因此改为查「当月 1 号 ~ 月末」，按交易日倒序取当月最后一个交易日；
 * - 行业 PB 主序列用市值加权（Σ总市值 / Σ净资产），与「细分行业」表当前 PB 口径一致；
 * - 同时保留中位数序列，避免超大市值个股主导曲线；
 * - 起始年份默认 2014，会自动跳过数据源尚未覆盖的月份
 *   （实测该报表自 2018 年起才有数据），可用 INDUSTRY_CYCLE_START_YEAR 覆盖。
 */
import https from 'node:https'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = resolve(__dirname, 'industry-cycle-cache.json')
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 天
const START_YEAR = Number(process.env.INDUSTRY_CYCLE_START_YEAR || 2014)
/** 单个行业某月样本太少时不参与当月统计，避免小样本失真 */
const MIN_SAMPLES = 5
/** 单个月份请求的行数上限，需大于单日全市场个股数（当前约 5600） */
const PAGE_SIZE = 8000

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

const median = (sorted) => {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

const round3 = (value) => Math.round(value * 1000) / 1000

const toIsoDate = (year, month, day) =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

const monthEndOf = (monthStart) => {
  const year = Number(monthStart.slice(0, 4))
  const month = Number(monthStart.slice(5, 7))
  // Date.UTC 的 day=0 表示上个月最后一天，这里传入 month 即当月最后一天
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

const buildUrl = ({ columns, filter, pageSize, sortTypes }) =>
  `${BASE_URL}?reportName=RPT_VALUEANALYSIS_DET` +
  `&columns=${columns}` +
  '&pageNumber=1' +
  `&pageSize=${pageSize}` +
  `&sortColumns=TRADE_DATE&sortTypes=${sortTypes}` +
  `&filter=${encodeURIComponent(filter)}`

/** 探测数据源实际最早可用的交易日 */
const earliestTradeDate = async () => {
  try {
    const data = await fetchJson(
      buildUrl({
        columns: 'TRADE_DATE',
        filter: `(TRADE_DATE>='${START_YEAR}-01-01')`,
        pageSize: 1,
        sortTypes: 1,
      }),
    )
    const value = data.result?.data?.[0]?.TRADE_DATE
    return typeof value === 'string' ? value.slice(0, 10) : null
  } catch (error) {
    console.error('[industry-cycle] 探测起始日期失败:', error.message)
    return null
  }
}

/** 生成自起算年月起、到当前月为止的每月 1 号列表 */
const generateMonthlyStarts = (startYear, startMonth) => {
  const months = []
  const now = new Date()
  let year = startYear
  let month = startMonth
  while (year < now.getFullYear() || (year === now.getFullYear() && month <= now.getMonth() + 1)) {
    months.push(toIsoDate(year, month, 1))
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return months
}

/**
 * 取某月最后一个交易日的全市场估值行。
 *
 * 注意：该接口的 pageSize 是「本次返回总行数」而非「每日行数」，
 * 一个月包含 20 多个交易日，必定超限，因此这里依赖
 * sortColumns=TRADE_DATE & sortTypes=-1 让最新交易日排在最前，
 * 再按最新交易日过滤；只要单日行数小于 PAGE_SIZE 就不会截断。
 * @param {string} monthStart 该月 1 号，格式 YYYY-MM-01
 * @returns {Promise<{ date: string, rows: unknown[] } | null>}
 */
const fetchMonthRows = async (monthStart) => {
  const filter = `(TRADE_DATE>='${monthStart}')(TRADE_DATE<='${monthEndOf(monthStart)}')`
  const data = await fetchJson(
    buildUrl({
      columns: 'SECURITY_CODE,BOARD_NAME,PB_MRQ,TOTAL_MARKET_CAP,TRADE_DATE',
      filter,
      pageSize: PAGE_SIZE,
      sortTypes: -1,
    }),
  )
  const rows = data.result?.data || []
  if (rows.length === 0) return null

  const latest = rows[0].TRADE_DATE.slice(0, 10)
  const onLatest = rows.filter((row) => row.TRADE_DATE.slice(0, 10) === latest)

  if (onLatest.length >= PAGE_SIZE) {
    console.warn(`[industry-cycle] ${latest} 单日行数达到分页上限，数据可能不完整`)
  }

  return { date: latest, rows: onLatest }
}

const MONTH_CONCURRENCY = Number(process.env.INDUSTRY_CYCLE_CONCURRENCY || 4)

/**
 * 并发拉取各月数据，按传入顺序返回结果。
 * @param {string[]} monthStarts
 * @returns {Promise<Array<{ date: string, rows: unknown[] } | null>>}
 */
const fetchAllMonths = async (monthStarts) => {
  /** @type {Array<{ date: string, rows: unknown[] } | null>} */
  const results = new Array(monthStarts.length).fill(null)
  let cursor = 0

  const worker = async () => {
    while (cursor < monthStarts.length) {
      const index = cursor
      cursor += 1
      const monthStart = monthStarts[index]
      try {
        results[index] = await fetchMonthRows(monthStart)
      } catch (error) {
        console.error(`[industry-cycle] 拉取 ${monthStart} 失败:`, error.message)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MONTH_CONCURRENCY, monthStarts.length) }, () => worker()),
  )
  return results
}

/**
 * 全量计算行业 PB 月度序列。
 * @returns {Promise<{ dates: string[], series: Record<string, { pb: (number|null)[], median: (number|null)[], count: number[] }> }>}
 *   dates 为各月实际使用的交易日，series 中每个数组与 dates 逐项对齐
 */
export const calculateIndustryCycle = async () => {
  const earliest = await earliestTradeDate()
  const startYear = earliest ? Number(earliest.slice(0, 4)) : START_YEAR
  const startMonth = earliest ? Number(earliest.slice(5, 7)) : 1
  const monthStarts = generateMonthlyStarts(startYear, startMonth)

  if (earliest) {
    console.log(
      `[industry-cycle] 数据源最早交易日 ${earliest}，从 ${startYear}-${startMonth} 起算，共 ${monthStarts.length} 个月`,
    )
  }

  const monthly = await fetchAllMonths(monthStarts)

  /** @type {string[]} 各月实际交易日 */
  const dates = []
  /** @type {Map<string, { pb: (number|null)[], median: (number|null)[], count: number[] }>} */
  const series = new Map()

  for (const month of monthly) {
    if (!month || month.rows.length === 0) continue

    /** @type {Map<string, { caps: number[], pbs: number[] }>} */
    const grouped = new Map()
    for (const row of month.rows) {
      const board = row.BOARD_NAME
      const pb = Number(row.PB_MRQ)
      const cap = Number(row.TOTAL_MARKET_CAP)
      if (!board || !Number.isFinite(pb) || pb <= 0) continue
      if (!Number.isFinite(cap) || cap <= 0) continue

      if (!grouped.has(board)) grouped.set(board, { caps: [], pbs: [] })
      const bucket = grouped.get(board)
      bucket.caps.push(cap)
      bucket.pbs.push(pb)
    }

    const index = dates.length
    dates.push(month.date)

    for (const [board, bucket] of grouped) {
      if (bucket.pbs.length < MIN_SAMPLES) continue

      let capSum = 0
      let netAssetSum = 0
      for (let i = 0; i < bucket.pbs.length; i += 1) {
        capSum += bucket.caps[i]
        netAssetSum += bucket.caps[i] / bucket.pbs[i]
      }
      const weighted = netAssetSum > 0 ? capSum / netAssetSum : null
      const mid = median([...bucket.pbs].sort((a, b) => a - b))

      if (!series.has(board)) {
        series.set(board, {
          pb: Array(index).fill(null),
          median: Array(index).fill(null),
          count: Array(index).fill(0),
        })
      }
      const target = series.get(board)
      // 补齐该行业尚未覆盖的前置月份，保证序列与 dates 对齐
      while (target.pb.length < index) {
        target.pb.push(null)
        target.median.push(null)
        target.count.push(0)
      }
      target.pb.push(weighted === null ? null : round3(weighted))
      target.median.push(round3(mid))
      target.count.push(bucket.pbs.length)
    }
  }

  // 收尾：把尾部缺失月份补 null，使所有序列长度一致
  const length = dates.length
  for (const target of series.values()) {
    while (target.pb.length < length) {
      target.pb.push(null)
      target.median.push(null)
      target.count.push(0)
    }
  }

  console.log(
    `[industry-cycle] 完成：${dates.length} 个月（${dates[0] ?? '—'} ~ ${dates.at(-1) ?? '—'}），${series.size} 个行业`,
  )

  return { dates, series: Object.fromEntries(series) }
}

let memoryCache = null
let memoryCacheTime = 0
let recalculating = false

const isCacheStale = (cacheTime) => Date.now() - cacheTime > CACHE_TTL_MS

const loadCacheFromFile = async () => {
  try {
    const raw = await readFile(CACHE_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.dates) && parsed.series && parsed.timestamp) {
      return parsed
    }
  } catch {
    // 无缓存或格式错误
  }
  return null
}

const saveCacheToFile = async (dates, series) => {
  await writeFile(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), dates, series }))
}

const toPayload = (dates, series, cached, timestamp) => ({
  dates,
  series,
  cached,
  timestamp,
  industries: Object.keys(series).length,
})

/**
 * 获取行业 PB 月度序列，优先使用缓存；缓存过期时在后台重算。
 * @returns {Promise<{ dates: string[], series: Record<string, unknown>, cached: boolean, timestamp: number, industries: number }>}
 */
export const getIndustryCycle = async () => {
  if (memoryCache && !isCacheStale(memoryCacheTime)) {
    return toPayload(
      memoryCache.dates,
      memoryCache.series,
      true,
      memoryCacheTime,
    )
  }

  const fileCache = await loadCacheFromFile()
  if (fileCache) {
    memoryCache = { dates: fileCache.dates, series: fileCache.series }
    memoryCacheTime = fileCache.timestamp

    if (isCacheStale(fileCache.timestamp) && !recalculating) {
      recalculating = true
      setImmediate(async () => {
        try {
          const result = await calculateIndustryCycle()
          await saveCacheToFile(result.dates, result.series)
          memoryCache = result
          memoryCacheTime = Date.now()
          console.log('[industry-cycle] 后台重算完成')
        } catch (error) {
          console.error('[industry-cycle] 后台重算失败:', error.message)
        } finally {
          recalculating = false
        }
      })
    }

    return toPayload(fileCache.dates, fileCache.series, true, fileCache.timestamp)
  }

  console.log(
    `[industry-cycle] 无缓存，开始全量计算（${START_YEAR} 至今，约 2-3 分钟）...`,
  )
  const result = await calculateIndustryCycle()
  await saveCacheToFile(result.dates, result.series)
  memoryCache = result
  memoryCacheTime = Date.now()
  console.log('[industry-cycle] 全量计算完成')

  return toPayload(result.dates, result.series, false, memoryCacheTime)
}
