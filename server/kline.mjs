/**
 * K 线代理（服务端）
 *
 * 为什么需要它：
 * - 一年内最低价是「三好学生评分」涨幅分项的输入；
 * - 一年内最高价用于个股诊断查询；
 * - 三年内最低价用于展示截图里的「涨3」字段；
 * - 这两类数据都不适合直接在浏览器端高并发拉取，因此统一由服务端代取。
 *
 * 数据源：
 * - 腾讯 qt.gtimg.cn 行情快照：直接返回 52 周高低点；
 * - 腾讯 proxy.finance.qq.com 前复权日线：逐只回看近 3 年，用于三年内低点。
 * 该模块同时被 Vite 开发中间件和独立生产服务器复用，保证两种环境行为一致。
 */
const QUOTE_BASE = 'https://qt.gtimg.cn/q='
// 三年低点历史 K 线：东财 push2his 在部分网络环境下被阻断，
// 改用腾讯前复权日线接口 proxy.finance.qq.com，实测稳定可用。
const HISTORY_BASE = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get'
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const TIMEOUT_MS = Number(process.env.KLINE_TIMEOUT_MS || 15000)
const MAX_SYMBOLS = Number(process.env.KLINE_MAX_SYMBOLS || 600)
const UPSTREAM_BATCH_SIZE = Number(process.env.KLINE_UPSTREAM_BATCH_SIZE || 80)
const HISTORY_CONCURRENCY = Number(process.env.KLINE_HISTORY_CONCURRENCY || 2)
const HISTORY_RETRY = Number(process.env.KLINE_HISTORY_RETRY || 2)
const HISTORY_BATCH_DELAY_MS = Number(
  process.env.KLINE_HISTORY_BATCH_DELAY_MS || 1200,
)
const MIN_DAYS = 20
const MAX_DAYS = 1400

const SYMBOL_PATTERN = /^(sh|sz|bj)\d{6}$/
const LAST_CLOSE_INDEX = 3
const HIGH_1Y_INDEX = 67
const LOW_1Y_INDEX = 68

/**
 * @typedef {Object} KlineEntry
 * @property {number|null} low1y 一年内最低价（前复权）
 * @property {number|null} low3y 三年内最低价（前复权）
 * @property {number|null} high1y 一年内最高价（前复权）
 * @property {number|null} lastClose 最新收盘价（前复权）
 * @property {string|null} from 区间起始日期
 * @property {string|null} to 区间结束日期
 */

const toNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 腾讯快照接口字段位置中：
 * - 3  = 最新价
 * - 67 = 52 周最高
 * - 68 = 52 周最低
 * 同时返回一年内高低点；低点用于评分，高点用于个股查询展示。
 * @param {string} body
 * @returns {Record<string, KlineEntry>}
 */
const parseQuotePayload = (body) => {
  /** @type {Record<string, KlineEntry>} */
  const entries = {}

  for (const rawLine of body.split(';')) {
    const line = rawLine.trim()
    if (!line || line === `v_pv_none_match="1"`) continue

    const matched = /^v_([^=]+)="(.*)"$/.exec(line)
    if (!matched) continue

    const symbol = matched[1]
    const fields = matched[2].split('~')
    const lastClose = toNumber(fields[LAST_CLOSE_INDEX])
    const high1y = toNumber(fields[HIGH_1Y_INDEX])
    const low1y = toNumber(fields[LOW_1Y_INDEX])

    const validLow1y = low1y !== null && low1y > 0 ? low1y : null
    const validHigh1y = high1y !== null && high1y > 0 ? high1y : null
    if (validLow1y === null && validHigh1y === null) continue

    entries[symbol] = {
      low1y: validLow1y,
      low3y: null,
      high1y: validHigh1y,
      lastClose,
      from: null,
      to: null,
    }
  }

  return entries
}

/**
 * @param {string[]} symbols
 * @returns {Promise<Record<string, KlineEntry>>}
 */
const fetchBatch = async (symbols) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const url = `${QUOTE_BASE}${symbols.join(',')}`
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://gu.qq.com/' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    return parseQuotePayload(await response.text())
  } finally {
    clearTimeout(timer)
  }
}

const beginDateOf = (days) => {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const todayStr = () => {
  const d = new Date()
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 从腾讯前复权日线接口取近 N 天最低价。
 * 接口返回 JSONP：kline_dayqfq={"data":{"<symbol>":{"qfqday":[[date,open,close,high,low,...],...]}}}
 * 相比东财 push2his，腾讯接口在更多网络环境下可达，且返回前复权数据可直接比较。
 */
const fetchHistoryLow = async (symbol, days) => {
  for (let attempt = 0; attempt <= HISTORY_RETRY; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const url = new URL(HISTORY_BASE)
      url.searchParams.set('_var', 'kline_dayqfq')
      // 腾讯接口的 COUNT 参数即返回的最大 K 线条数，按交易日近似取 days
      url.searchParams.set(
        'param',
        `${symbol},day,${beginDateOf(days)},${todayStr()},${Math.min(1500, Math.ceil(days * 1.5))},qfq`,
      )

      const response = await fetch(url.toString(), {
        headers: {
          'User-Agent': USER_AGENT,
          Referer: 'https://gu.qq.com/',
        },
        signal: controller.signal,
      })
      if (!response.ok) {
        if (attempt < HISTORY_RETRY) await sleep(250 * (attempt + 1))
        continue
      }

      // 腾讯返回 JSONP：kline_dayqfq={...}，去掉前缀后解析
      const raw = await response.text()
      const jsonStart = raw.indexOf('{')
      if (jsonStart < 0) {
        if (attempt < HISTORY_RETRY) await sleep(250 * (attempt + 1))
        continue
      }
      const payload = JSON.parse(raw.slice(jsonStart))
      const klines = payload?.data?.[symbol]?.qfqday
      if (!Array.isArray(klines) || klines.length === 0) return null

      let low3y = null
      let from = null
      let to = null
      for (const row of klines) {
        const day = row[0] || null
        const low = toNumber(row[4])
        if (day && from === null) from = day
        if (day) to = day
        if (low === null || low <= 0) continue
        low3y = low3y === null ? low : Math.min(low3y, low)
      }

      if (low3y === null) return null
      return { low3y, from, to }
    } catch {
      if (attempt < HISTORY_RETRY) await sleep(250 * (attempt + 1))
    } finally {
      clearTimeout(timer)
    }
  }

  return null
}

const fetchHistoryLows = async (symbols, days) => {
  /** @type {Record<string, { low3y: number|null, from: string|null, to: string|null }>} */
  const result = {}
  let cursor = 0

  const worker = async () => {
    while (cursor < symbols.length) {
      const index = cursor
      cursor += 1
      const symbol = symbols[index]
      const entry = await fetchHistoryLow(symbol, days)
      if (entry) result[symbol] = entry
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(HISTORY_CONCURRENCY, symbols.length) },
      () => worker(),
    ),
  )

  return result
}

/**
 * 查询一批标的的一年内最低价
 * @param {string|null|undefined} codesParam 逗号分隔的 sh/sz/bj + 6 位代码
 * @param {string|null|undefined} daysParam K 线回溯自然日条数
 * @returns {Promise<{ data: Record<string, KlineEntry>, failed: string[], requested: number }>}
 */
export const queryKline = async (codesParam, daysParam) => {
  const rawDays = Number(daysParam)
  const days = Number.isFinite(rawDays)
    ? Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(rawDays)))
    : 300
  // 当前腾讯快照接口直接返回 52 周区间高低点，不按 days 裁剪；
  // 保留该参数是为了兼容前后端既有 /api/kline 调用约定。
  void days

  const symbols = [
    ...new Set(
      String(codesParam ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => SYMBOL_PATTERN.test(item)),
    ),
  ].slice(0, MAX_SYMBOLS)

  if (symbols.length === 0) {
    return { data: {}, failed: [], requested: 0 }
  }

  const data = {}
  const failed = []

  for (let index = 0; index < symbols.length; index += UPSTREAM_BATCH_SIZE) {
    const batch = symbols.slice(index, index + UPSTREAM_BATCH_SIZE)
    try {
      const [entries, history] = await Promise.all([
        fetchBatch(batch),
        fetchHistoryLows(batch, days),
      ])
      for (const symbol of Object.keys(entries)) {
        const extra = history[symbol]
        if (extra) {
          entries[symbol] = { ...entries[symbol], ...extra }
        }
      }
      Object.assign(data, entries)
      for (const symbol of batch) {
        if (!entries[symbol]) failed.push(symbol)
      }
    } catch {
      failed.push(...batch)
    }
    if (index + UPSTREAM_BATCH_SIZE < symbols.length) {
      await sleep(HISTORY_BATCH_DELAY_MS)
    }
  }

  return { data, failed, requested: symbols.length }
}
