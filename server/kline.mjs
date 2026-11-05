/**
 * K 线代理（服务端）
 *
 * 为什么需要它：一年内最低价是「三好学生评分」涨幅分项的输入，
 * 但腾讯前复权 K 线接口不允许浏览器跨域直连，必须由服务端代取。
 *
 * 数据源：腾讯 qt.gtimg.cn 行情快照。
 * 该接口直接返回 52 周高低点，规避了 web.ifzq.gtimg.cn 在当前环境下被 WAF 拦截的问题。
 * 该模块同时被 Vite 开发中间件和独立生产服务器复用，保证两种环境行为一致。
 */
const QUOTE_BASE = 'https://qt.gtimg.cn/q='
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const TIMEOUT_MS = Number(process.env.KLINE_TIMEOUT_MS || 15000)
const MAX_SYMBOLS = Number(process.env.KLINE_MAX_SYMBOLS || 600)
const UPSTREAM_BATCH_SIZE = Number(process.env.KLINE_UPSTREAM_BATCH_SIZE || 80)
const MIN_DAYS = 20
const MAX_DAYS = 400

const SYMBOL_PATTERN = /^(sh|sz|bj)\d{6}$/
const LAST_CLOSE_INDEX = 3
const HIGH_1Y_INDEX = 67
const LOW_1Y_INDEX = 68

/**
 * @typedef {Object} KlineEntry
 * @property {number|null} low1y 一年内最低价（前复权）
 * @property {number|null} high1y 一年内最高价（前复权）
 * @property {number|null} lastClose 最新收盘价（前复权）
 * @property {string|null} from 区间起始日期
 * @property {string|null} to 区间结束日期
 */

const toNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 腾讯快照接口字段位置中：
 * - 3  = 最新价
 * - 67 = 52 周最高
 * - 68 = 52 周最低
 * 这里只取三好学生评分需要的一年内低点。
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

    if (low1y === null || low1y <= 0) continue

    entries[symbol] = {
      low1y,
      high1y,
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
      const entries = await fetchBatch(batch)
      Object.assign(data, entries)
      for (const symbol of batch) {
        if (!entries[symbol]) failed.push(symbol)
      }
    } catch {
      failed.push(...batch)
    }
  }

  return { data, failed, requested: symbols.length }
}
