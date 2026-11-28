/**
 * 资金流向代理。
 *
 * 数据源：东方财富 push2 公开接口（无鉴权）。
 * - 大盘实时：push2.eastmoney.com/api/qt/ulist.np/get  一次拉 4 个指数
 * - 大盘历史：push2his.eastmoney.com/api/qt/stock/fflow/daykline/get
 * - 个股实时：push2.eastmoney.com/api/qt/ulist.np/get  一次批量拉多只股票
 *
 * 大盘返回结构（供"实时行情"面板消费）：
 * {
 *   isTradingDay: boolean,
 *   date: 'YYYY-MM-DD',
 *   indices: [{ code, name, today:{mainNet,superLargeNet,smallNet}, yesterday:{...} }]
 * }
 * 个股返回结构：{ stocks: [{ code, name, price, changePct, mainNet, mainPct, superLargeNet, largeNet, mediumNet, smallNet }] }
 */
import https from 'node:https'

const INDICES = [
  { secid: '1.000001', code: '000001', name: '上证指数' },
  { secid: '0.399001', code: '399001', name: '深证成指' },
  { secid: '0.399006', code: '399006', name: '创业板指' },
  { secid: '1.000300', code: '000300', name: '沪深300' },
]

const CACHE_TTL_MS = 30_000
let cache = null

/** 个股资金流缓存：按查询的股票组合缓存，TTL 与大盘一致 */
const stockCache = new Map()
/** 单次最多查询的股票数，避免上游限流 */
const MAX_STOCK_QUERY = 50
/** 股票名称搜索缓存，减少重复访问上游 */
const stockSearchCache = new Map()

const fetchJson = async (url, retries = 2) => {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
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
            res.on('data', (c) => (data += c))
            res.on('end', () => {
              try {
                resolve(JSON.parse(data))
              } catch (e) {
                reject(e)
              }
            })
          })
      })
    } catch (err) {
      if (attempt === retries) throw err
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
    }
  }
}

/** 实时资金流：一次请求拉 4 个指数（东方财富） */
const fetchRealtime = async () => {
  const secids = INDICES.map((i) => i.secid).join(',')
  const url =
    'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2' +
    `&secids=${secids}` +
    '&fields=f12,f14,f62,f66,f84'
  const json = await fetchJson(url, 4)
  const diff = json?.data?.diff ?? []
  const map = new Map(diff.map((d) => [d.f12, d]))
  return INDICES.map((idx) => {
    const d = map.get(idx.code)
    // 东财收盘后或接口异常时可能返回空数据，此时返回 null 而非 0，避免误导
    if (!d || d.f62 === undefined || d.f62 === null) return null
    return {
      code: idx.code,
      name: idx.name,
      mainNet: Number(d.f62), // 主力净流入（元）
      superLargeNet: Number(d.f66 ?? 0), // 超大单净流入（元）
      smallNet: Number(d.f84 ?? 0), // 小单净流入（元，≈ 散户）
    }
  })
}

/** 实时成交额：腾讯接口，一次拉上证+深证（稳定，不依赖东财） */
const fetchAmountRealtime = async () => {
  const url = 'https://qt.gtimg.cn/q=sh000001,sz399001'
  const text = await new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
      .on('error', reject)
      .on('response', (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve(data))
      })
  })
  // 解析：v_sh000001="1~上证指数~000001~...~成交额(万元)~..."
  const result = { sh: 0, sz: 0 }
  const lines = text.split(';').filter((l) => l.trim())
  for (const line of lines) {
    const m = line.match(/v_(sh|sz)\d+="(.*)"/)
    if (!m) continue
    const parts = m[2].split('~')
    const amountWan = Number(parts[37] ?? 0) // 成交额（万元）
    if (m[1] === 'sh') result.sh = amountWan * 1e4 // 万元 → 元
    else if (m[1] === 'sz') result.sz = amountWan * 1e4
  }
  return result
}

/** 计算最近 N 个自然日的日期字符串（YYYY-MM-DD），从今天往前数 */
const recentDates = (n) => {
  const out = []
  const d = new Date()
  for (let i = 0; i < n; i += 1) {
    const day = new Date(d)
    day.setDate(d.getDate() - i)
    out.push(
      `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`,
    )
  }
  return out
}

/**
 * 分时成交额：取最近 2 个交易日的分时数据，返回「今日累计」和「昨日截至当前时间累计」。
 * 用于与同花顺「较昨」口径一致（同时段对比）。
 * 失败时返回 null，降级到日K线全天对比。
 */
const fetchAmountTrend = async (secid) => {
  const url =
    'https://push2his.eastmoney.com/api/qt/stock/trends2/get' +
    `?secid=${secid}` +
    '&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58' +
    '&iscr=0&ndays=2'
  let json
  try {
    json = await fetchJson(url, 6)
  } catch {
    return null
  }
  const trends = json?.data?.trends ?? []
  if (trends.length === 0) return null
  const [todayStr] = recentDates(1)
  const now = new Date()
  const curHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  let todayAmount = 0
  let yesterdayAmount = 0
  for (const line of trends) {
    const parts = line.split(',')
    const dt = parts[0] // "2026-11-27 14:51"
    const hm = dt.split(' ')[1] ?? ''
    const amount = Number(parts[6] ?? 0)
    if (dt.startsWith(todayStr)) {
      todayAmount += amount
    } else if (hm <= curHM) {
      yesterdayAmount += amount
    }
  }
  return { todayAmount, yesterdayAmount }
}

/** 历史成交额：取最近 8 个交易日，按日期精确匹配昨日与前日（而非固定倒数第二条）。
 *  作为分时接口的降级方案，返回全天成交额。 */
const fetchAmountHistory = async (secid) => {
  const url =
    'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    '?klt=101&fqt=1&lmt=8&end=20500101' +
    '&fields1=f1,f2,f3,f4,f5,f6' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57' +
    `&secid=${secid}`
  let json
  try {
    json = await fetchJson(url, 8)
  } catch {
    return { yesterday: null, dayBefore: null }
  }
  const klines = json?.data?.klines ?? []
  const map = new Map()
  for (const line of klines) {
    if (!line) continue
    const parts = line.split(',')
    // 字段顺序：日期,开盘,收盘,最高,最低,成交量,成交额
    map.set(parts[0], { date: parts[0], amount: Number(parts[6] ?? 0) })
  }
  // 按日期找昨日、前日（从最近自然日往前找，跳过非交易日）
  const [today, yesterday, dayBefore] = recentDates(3)
  const findPrev = (dateStr) => {
    // 优先精确匹配；若当日无数据（非交易日），取该日期之前最近的一条
    if (map.has(dateStr)) return map.get(dateStr)
    const sorted = [...map.keys()].sort().reverse()
    const prev = sorted.find((k) => k < dateStr)
    return prev ? map.get(prev) : null
  }
  return {
    yesterday: findPrev(yesterday),
    dayBefore: findPrev(dayBefore),
  }
}

/**
 * 历史资金流：取最近 8 个交易日，按日期精确匹配昨日与前日（而非固定倒数第二条）。
 * 最新日期用于判断今日是否交易日，避免额外请求。
 */
const fetchHistory = async (secid) => {
  const url =
    'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get' +
    '?lmt=8&klt=101&fields1=f1,f2,f3,f7' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65' +
    `&secid=${secid}`
  const json = await fetchJson(url, 6)
  const klines = json?.data?.klines ?? []
  const map = new Map()
  for (const line of klines) {
    if (!line) continue
    const parts = line.split(',')
    // 字段顺序：日期,主力,超大单,大单,中单,小单,主力净比,...
    map.set(parts[0], {
      date: parts[0],
      mainNet: Number(parts[1] ?? 0),
      superLargeNet: Number(parts[2] ?? 0),
      smallNet: Number(parts[5] ?? 0),
    })
  }
  const sorted = [...map.keys()].sort()
  const latestDate = sorted.length ? sorted[sorted.length - 1] : ''
  // 按日期找昨日、前日（从最近自然日往前找，跳过非交易日）
  const [today, yesterday, dayBefore] = recentDates(3)
  const findPrev = (dateStr) => {
    if (map.has(dateStr)) return map.get(dateStr)
    const prev = sorted.slice().reverse().find((k) => k < dateStr)
    return prev ? map.get(prev) : null
  }
  return {
    latestDate,
    today: map.has(today) ? map.get(today) : null,
    yesterday: findPrev(yesterday),
    dayBefore: findPrev(dayBefore),
  }
}

/**
 * 判断今日是否交易日（周末直接 false；否则用历史最新日期判断）。
 */
const isTodayTradingDay = (latestDate) => {
  const today = new Date()
  const dayOfWeek = today.getDay()
  if (dayOfWeek === 0 || dayOfWeek === 6) return false
  if (!latestDate) return false

  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const todayStr = fmt(today)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = fmt(yesterday)

  return latestDate === todayStr || latestDate === yesterdayStr
}

export const queryCapitalFlow = async () => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value
  }

  // 实时资金流 + 资金流历史（4指数） + 实时成交额（腾讯） + 成交额分时（上证+深证） + 成交额历史（降级）并发拉取，各自独立降级
  const safe = async (p, fallback) => {
    try {
      return await p
    } catch {
      return fallback
    }
  }
  // 成交额只需上证(0)+深证(1)，对应沪深两市
  const amountIndices = INDICES.slice(0, 2)
  const [todayListRaw, historyList, amountRealtime, amountTrendList, amountHistoryList] =
    await Promise.all([
      safe(fetchRealtime(), []),
      safe(
        Promise.all(INDICES.map((idx) => fetchHistory(idx.secid))),
        INDICES.map(() => ({ latestDate: '', yesterday: null, dayBefore: null })),
      ),
      safe(fetchAmountRealtime(), { sh: 0, sz: 0 }),
      safe(
        Promise.all(amountIndices.map((idx) => fetchAmountTrend(idx.secid))),
        amountIndices.map(() => null),
      ),
      safe(
        Promise.all(amountIndices.map((idx) => fetchAmountHistory(idx.secid))),
        amountIndices.map(() => ({ yesterday: null, dayBefore: null })),
      ),
    ])

  // 判断今日是否交易日：优先用历史最新日期；若历史接口失败但实时有数据，也视为交易日
  const tradingDay =
    isTodayTradingDay(historyList[0]?.latestDate ?? '') ||
    (todayListRaw.length > 0 && todayListRaw.some((t) => t.mainNet !== 0)) ||
    amountRealtime.sh > 0 ||
    amountRealtime.sz > 0
  const todayList = tradingDay ? todayListRaw : []

  const yesterdayList = historyList.map((h) => h.yesterday)
  const dayBeforeList = historyList.map((h) => h.dayBefore)
  const todayHistoryList = historyList.map((h) => h.today)
  const amountYesterdayList = amountHistoryList.map((h) => h.yesterday)
  const amountDayBeforeList = amountHistoryList.map((h) => h.dayBefore)

  // 今日成交额：优先用分时接口（与昨日同时段口径一致）；失败则用腾讯实时
  const trendToday = amountTrendList.reduce((s, t) => s + (t?.todayAmount || 0), 0)
  const trendYesterday = amountTrendList.reduce((s, t) => s + (t?.yesterdayAmount || 0), 0)
  const todayAmount = trendToday > 0 ? trendToday : amountRealtime.sh + amountRealtime.sz
  // 昨日成交额：优先用分时「昨日截至当前时间」（与同花顺同时段对比一致）；失败则用日K线昨日全天；均失败则 null
  const yesterdayAmount =
    trendYesterday > 0
      ? trendYesterday
      : (amountYesterdayList[0]?.amount != null && amountYesterdayList[1]?.amount != null)
        ? Number(amountYesterdayList[0].amount) + Number(amountYesterdayList[1].amount)
        : null

  // 今日资金流：优先用实时接口；实时失败时用历史日K线的今日数据兜底（收盘后实时接口常不可用）
  const todayFlowList = todayListRaw.map((t, i) => t || todayHistoryList[i] || null)
  const hasTodayFlow = todayFlowList.some((t) => t !== null)

  const indices = INDICES.map((idx, i) => ({
    code: idx.code,
    name: idx.name,
    today: tradingDay && todayFlowList[i]
      ? {
          mainNet: todayFlowList[i].mainNet,
          superLargeNet: todayFlowList[i].superLargeNet,
          smallNet: todayFlowList[i].smallNet,
        }
      : null,
    yesterday: yesterdayList[i]
      ? {
          date: yesterdayList[i].date,
          mainNet: yesterdayList[i].mainNet,
          superLargeNet: yesterdayList[i].superLargeNet,
          smallNet: yesterdayList[i].smallNet,
        }
      : null,
  }))

  // 全市场合计：4 个指数加总（资金流口径）；成交额仅用上证+深证，避免与创业板/沪深300重复
  // 任一指数数据缺失则返回 null（避免把缺失当成 0 求和，误导对比）
  const sumField = (list, field) => {
    if (list.some((i) => !i || i[field] === null || i[field] === undefined)) return null
    return list.reduce((s, i) => s + Number(i[field]), 0)
  }
  // 三部分合计：主力 + 超大单 + 小单
  const sumCombined = (list) => {
    if (list.some((i) => !i || i.mainNet == null || i.superLargeNet == null || i.smallNet == null)) return null
    return list.reduce(
      (s, i) => s + Number(i.mainNet) + Number(i.superLargeNet) + Number(i.smallNet),
      0,
    )
  }
  // 成交额：仅上证(0) + 深证(1)，对应沪深两市，与同花顺口径一致
  const sumAmount = (list) => {
    if (!list[0] || list[0].amount == null || !list[1] || list[1].amount == null) return null
    return Number(list[0].amount) + Number(list[1].amount)
  }
  const marketTotal = {
    today: tradingDay
      ? {
          mainNet: hasTodayFlow ? sumField(todayFlowList, 'mainNet') : null,
          superLargeNet: hasTodayFlow ? sumField(todayFlowList, 'superLargeNet') : null,
          smallNet: hasTodayFlow ? sumField(todayFlowList, 'smallNet') : null,
          combined: hasTodayFlow ? sumCombined(todayFlowList) : null,
          amount: todayAmount,
        }
      : null,
    yesterday: {
      date: yesterdayList[0]?.date ?? '',
      mainNet: sumField(yesterdayList, 'mainNet'),
      superLargeNet: sumField(yesterdayList, 'superLargeNet'),
      smallNet: sumField(yesterdayList, 'smallNet'),
      combined: sumCombined(yesterdayList),
      amount: yesterdayAmount,
    },
    dayBefore: {
      date: dayBeforeList[0]?.date ?? '',
      mainNet: sumField(dayBeforeList, 'mainNet'),
      superLargeNet: sumField(dayBeforeList, 'superLargeNet'),
      smallNet: sumField(dayBeforeList, 'smallNet'),
      combined: sumCombined(dayBeforeList),
      amount: sumAmount(amountDayBeforeList),
    },
  }

  const today = new Date()
  const value = {
    isTradingDay: tradingDay,
    date: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
    marketTotal,
    indices,
  }

  cache = { at: Date.now(), value }
  return value
}

/** 6 位股票/基金代码 → 东方财富 secid：沪市股票、5 开头 ETF 与沪 B 用 1.，其余用 0. */
const codeToSecid = (code) => {
  const c = String(code).replace(/\D/g, '').slice(0, 6)
  return `${c.startsWith('5') || c.startsWith('6') || c.startsWith('9') ? '1' : '0'}.${c}`
}

/**
 * 按名称搜索 A 股与场内基金候选（东方财富搜索建议接口）。
 * 结果缓存 5 分钟；仅返回可交易的 A 股与场内基金，排除港股等同名标的。
 */
export const searchStocks = async (keyword) => {
  const input = String(keyword ?? '').trim().slice(0, 40)
  if (!input || /^\d{6}$/.test(input)) return { stocks: [] }

  const cached = stockSearchCache.get(input)
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value

  const params = new URLSearchParams({
    input,
    type: '14',
    token: '7f1d3c5a7b9e2f4d6a8c0b1e3d5f7a9c',
    count: '10',
  })
  const json = await fetchJson(
    `https://searchapi.eastmoney.com/api/suggest/get?${params.toString()}`,
    2,
  )
  const data = json?.QuotationCodeTable?.Data ?? []
  const stocks = data
    .filter(
      (item) =>
        ['AStock', 'Fund'].includes(item?.Classify) &&
        /^\d{6}$/.test(String(item?.Code ?? '')) &&
        typeof item?.Name === 'string' &&
        /^[01]\.\d{6}$/.test(String(item?.QuoteID ?? '')),
    )
    .map((item) => ({
      code: String(item.Code),
      name: item.Name,
      category: item.Classify === 'Fund' ? 'ETF/基金' : 'A股',
    }))
    .filter((item, index, all) => all.findIndex((candidate) => candidate.code === item.code) === index)
    .slice(0, 10)
  const value = { stocks }
  if (stockSearchCache.size > 200) stockSearchCache.clear()
  stockSearchCache.set(input, { at: Date.now(), value })
  return value
}

/**
 * 个股实时资金流：一次批量查询多只股票（东方财富 push2，与大盘资金流同源）。
 *
 * 返回每只的：
 * - 主力/超大单/大单/中单/小单净额（元）
 * - 主力净占比（%），以及最新价、涨跌幅
 *
 * 接口异常或收盘后返回空数据时，对应字段返回 null（前端显示「—」）。
 * 结果按查询的股票组合缓存 30 秒。
 */
export const queryStockCapitalFlow = async (codes) => {
  const uniq = [
    ...new Set(
      String(codes ?? '')
        .split(',')
        .map((c) => c.trim().replace(/\D/g, ''))
        .filter((c) => c.length === 6),
    ),
  ].slice(0, MAX_STOCK_QUERY)
  if (uniq.length === 0) return { stocks: [] }

  const secids = uniq.map(codeToSecid).join(',')
  const hit = stockCache.get(secids)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

  let diff = []
  try {
    const json = await fetchJson(
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2' +
        `&secids=${secids}` +
        '&fields=f12,f14,f2,f3,f62,f184,f66,f72,f78,f84',
      4,
    )
    diff = json?.data?.diff ?? []
  } catch {
    diff = []
  }

  const map = new Map(diff.map((d) => [d.f12, d]))
  const num = (v) => (v === undefined || v === null || v === '-' ? null : Number(v))
  const stocks = uniq.map((code) => {
    const d = map.get(code)
    if (!d) {
      return {
        code,
        name: null,
        price: null,
        changePct: null,
        mainNet: null,
        mainPct: null,
        superLargeNet: null,
        largeNet: null,
        mediumNet: null,
        smallNet: null,
      }
    }
    return {
      code,
      name: d.f14 ?? null,
      price: num(d.f2), // 最新价
      changePct: num(d.f3), // 涨跌幅（%）
      mainNet: num(d.f62), // 主力净流入（元）
      mainPct: num(d.f184), // 主力净占比（%）
      superLargeNet: num(d.f66), // 超大单净流入（元）
      largeNet: num(d.f72), // 大单净流入（元）
      mediumNet: num(d.f78), // 中单净流入（元）
      smallNet: num(d.f84), // 小单净流入（元）
    }
  })

  const value = { stocks }
  if (stockCache.size > 200) stockCache.clear()
  stockCache.set(secids, { at: Date.now(), value })
  return value
}
