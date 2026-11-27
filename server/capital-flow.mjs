/**
 * 大盘资金流向代理。
 *
 * 数据源：东方财富 push2 公开接口（无鉴权）。
 * - 实时：  push2.eastmoney.com/api/qt/ulist.np/get  一次拉 4 个指数
 * - 历史：  push2his.eastmoney.com/api/qt/stock/fflow/daykline/get
 *
 * 返回结构（供前端"市场概况"面板消费）：
 * {
 *   isTradingDay: boolean,
 *   date: 'YYYY-MM-DD',
 *   indices: [{ code, name, today:{mainNet,superLargeNet,smallNet}, yesterday:{...} }]
 * }
 */
import https from 'node:https'

const INDICES = [
  { secid: '1.000001', code: '000001', name: '上证指数' },
  { secid: '0.399001', code: '399001', name: '深证成指' },
  { secid: '0.399006', code: '399006', name: '创业板指' },
  { secid: '1.000300', code: '000300', name: '沪深300' },
]

const CACHE_TTL_MS = 15_000
let cache = null

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

/** 实时资金流：一次请求拉 4 个指数 */
const fetchRealtime = async () => {
  const secids = INDICES.map((i) => i.secid).join(',')
  const url =
    'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2' +
    `&secids=${secids}` +
    '&fields=f12,f14,f62,f66,f84'
  const json = await fetchJson(url)
  const diff = json?.data?.diff ?? []
  const map = new Map(diff.map((d) => [d.f12, d]))
  return INDICES.map((idx) => {
    const d = map.get(idx.code) ?? {}
    return {
      code: idx.code,
      name: idx.name,
      mainNet: Number(d.f62 ?? 0), // 主力净流入（元）
      superLargeNet: Number(d.f66 ?? 0), // 超大单净流入（元）
      smallNet: Number(d.f84 ?? 0), // 小单净流入（元，≈ 散户）
    }
  })
}

/** 历史资金流：取最近 2 个交易日，倒数第 2 个即"昨日" */
const fetchYesterday = async (secid) => {
  const url =
    'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get' +
    '?lmt=2&klt=101&fields1=f1,f2,f3,f7' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65' +
    `&secid=${secid}`
  const json = await fetchJson(url)
  const klines = json?.data?.klines ?? []
  // 最近一条是今日（若已收盘则是今日最终值），倒数第二条是昨日
  const line = klines[klines.length - 2]
  if (!line) return null
  const parts = line.split(',')
  // 字段顺序：日期,主力,超大单,大单,中单,小单,主力净比,...
  return {
    date: parts[0],
    mainNet: Number(parts[1] ?? 0),
    superLargeNet: Number(parts[2] ?? 0),
    smallNet: Number(parts[5] ?? 0),
  }
}

/**
 * 判断今日是否交易日。
 * 逻辑：历史接口取最近 2 个交易日，若最近日期 >= 昨天 且今天不是周末，
 * 则认为今日为交易日（盘中时历史数据可能尚未更新到今天）。
 */
const isTodayTradingDay = async (secid) => {
  const today = new Date()
  const dayOfWeek = today.getDay()
  // 周六(6) 周日(0) 必然休市
  if (dayOfWeek === 0 || dayOfWeek === 6) return false

  const url =
    'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get' +
    '?lmt=2&klt=101&fields1=f1,f2,f3,f7' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65' +
    `&secid=${secid}`
  const json = await fetchJson(url)
  const klines = json?.data?.klines ?? []
  if (!klines.length) return false
  const latestDate = klines[klines.length - 1].split(',')[0]

  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const todayStr = fmt(today)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = fmt(yesterday)

  // 历史最新日期 >= 昨天 → 今日为交易日（含盘中、盘后）
  return latestDate === todayStr || latestDate === yesterdayStr
}

export const queryCapitalFlow = async () => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value
  }

  // 用上证指数判断今日是否交易日
  const tradingDay = await isTodayTradingDay('1.000001')

  const todayList = tradingDay ? await fetchRealtime() : []

  // 昨日数据：并发拉取 4 个指数
  const yesterdayList = await Promise.all(
    INDICES.map((idx) => fetchYesterday(idx.secid)),
  )

  const indices = INDICES.map((idx, i) => ({
    code: idx.code,
    name: idx.name,
    today: tradingDay
      ? todayList[i]
        ? {
            mainNet: todayList[i].mainNet,
            superLargeNet: todayList[i].superLargeNet,
            smallNet: todayList[i].smallNet,
          }
        : null
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

  const today = new Date()
  const value = {
    isTradingDay: tradingDay,
    date: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
    indices,
  }

  cache = { at: Date.now(), value }
  return value
}
