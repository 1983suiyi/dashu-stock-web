/**
 * 指数日线历史（服务端）
 *
 * 用途：为「牛熊阶段」页面提供指数近 20 年日线 OHLC，用于自动识别牛熊顶底，
 * 并在每个顶/底点附近绘制 K 线窗口。
 *
 * 数据源：腾讯前复权日线 proxy.finance.qq.com（与 kline.mjs 同源）。
 * 单次最多返回约 2000 条，故按结束日期向前分页，最多翻若干页覆盖约 20 年。
 */
const HISTORY_BASE =
  'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get'
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const TIMEOUT_MS = Number(process.env.INDEX_HISTORY_TIMEOUT_MS || 15000)
/** 腾讯接口单次返回上限约为 2000 条，超过会报 param error */
const PAGE_COUNT = 2000
/** 最多翻页数，4 页 × 2000 ≈ 32 年，足以覆盖近 20 年 */
const MAX_PAGES = 4
/** 内存缓存有效期：日线数据一天内基本不变，缓存 6 小时 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

const SYMBOL_PATTERN = /^(sh|sz|bj)\d{6}$/

/** 缓存：{ symbol -> { at, payload } } */
const cache = new Map()

const toNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const todayStr = () => {
  const d = new Date()
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 拉取一页日线。
 * @param {string} symbol
 * @param {string} end 结束日期（YYYY-MM-DD），空串表示取最新一段
 * @returns {Promise<Array<[string, string, string, string, string, ...]> | null>}
 */
const fetchPage = async (symbol, end) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const url = new URL(HISTORY_BASE)
    url.searchParams.set('_var', 'kline_dayqfq')
    url.searchParams.set(
      'param',
      `${symbol},day,,${end},${PAGE_COUNT},`,
    )

    const response = await fetch(url.toString(), {
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://gu.qq.com/' },
      signal: controller.signal,
    })
    if (!response.ok) return null

    const raw = await response.text()
    const jsonStart = raw.indexOf('{')
    if (jsonStart < 0) return null
    const payload = JSON.parse(raw.slice(jsonStart))
    const node = payload?.data?.[symbol]
    const rows = node?.day || node?.qfqday
    return Array.isArray(rows) ? rows : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 查询指数日线历史（分页向前回溯）。
 * @param {string} rawSymbol sh/sz/bj + 6 位代码
 * @param {string|number} [years] 需要回溯的年数
 */
export const queryIndexHistory = async (rawSymbol, years) => {
  const symbol = String(rawSymbol ?? '').trim()
  if (!SYMBOL_PATTERN.test(symbol)) {
    return { symbol, error: '参数错误：需要 sh/sz/bj + 6 位代码', candles: [] }
  }

  const span = Number.isFinite(Number(years)) ? Number(years) : 20
  const floorYear = new Date().getFullYear() - span

  const cachedEntry = cache.get(symbol)
  if (cachedEntry && Date.now() - cachedEntry.at < CACHE_TTL_MS) {
    return { ...cachedEntry.payload, cached: true }
  }

  /** @type {Map<string, {date:string, open:number|null, close:number|null, high:number|null, low:number|null, volume:number|null}>} */
  const byDate = new Map()
  let end = ''
  let from = null
  let to = null

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await fetchPage(symbol, end)
    if (!rows || rows.length === 0) break

    for (const row of rows) {
      const date = row[0]
      if (!date || byDate.has(date)) continue
      byDate.set(date, {
        date,
        open: toNumber(row[1]),
        close: toNumber(row[2]),
        high: toNumber(row[3]),
        low: toNumber(row[4]),
        volume: toNumber(row[5]),
      })
      if (from === null || date < from) from = date
      if (to === null || date > to) to = date
    }

    const oldest = rows[0][0]
    // 已回溯到目标年份或数据不足一页，停止翻页
    if (!oldest || Number(oldest.slice(0, 4)) <= floorYear) break
    if (rows.length < PAGE_COUNT) break
    end = oldest
  }

  const candles = [...byDate.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  )

  const payload = {
    symbol,
    candles,
    from,
    to,
    requestedYears: span,
    fetchedAt: todayStr(),
  }

  if (candles.length > 0) {
    cache.set(symbol, { at: Date.now(), payload })
  }

  return { ...payload, cached: false }
}
