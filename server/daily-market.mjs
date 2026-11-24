/**
 * 全站共享的每日行情任务。
 * 工作日 15:00（Asia/Shanghai）拉取市场快照和全量 K 线；失败代码只重试自身。
 */
import { db } from './db.mjs'
import { queryKline } from './kline.mjs'

const TIME_ZONE = 'Asia/Shanghai'
const SCHEDULE_HOUR = 15
const RETRY_DELAY_MS = 5 * 60 * 1000
const MAX_RETRIES = 3
const KLINE_BATCH_SIZE = 120
const SYMBOL_PATTERN = /^(sh|sz|bj)\d{6}$/

let schedulerStarted = false
let schedulerTimer = null
let jobInFlight = false
let marketDataFetcher = null
let klineBatchFetcher = queryKline

const getStateRow = () => db.prepare('SELECT * FROM daily_market_state WHERE id = 1').get()

const parseState = (row) => {
  if (!row) return null
  return {
    runDate: row.run_date,
    status: row.status,
    phase: row.phase,
    stocks: row.stocks_json ? JSON.parse(row.stocks_json) : null,
    meta: row.meta_json ? JSON.parse(row.meta_json) : null,
    failedCodes: JSON.parse(row.failed_codes || '[]'),
    retryCount: row.retry_count,
    retryAt: row.retry_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  }
}

const writeState = (state) => {
  db.prepare(`
    INSERT INTO daily_market_state
      (id, run_date, status, phase, stocks_json, meta_json, failed_codes,
       retry_count, retry_at, last_error, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      run_date = excluded.run_date,
      status = excluded.status,
      phase = excluded.phase,
      stocks_json = excluded.stocks_json,
      meta_json = excluded.meta_json,
      failed_codes = excluded.failed_codes,
      retry_count = excluded.retry_count,
      retry_at = excluded.retry_at,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run(
    state.runDate,
    state.status,
    state.phase,
    state.stocks ? JSON.stringify(state.stocks) : null,
    state.meta ? JSON.stringify(state.meta) : null,
    JSON.stringify(state.failedCodes ?? []),
    state.retryCount ?? 0,
    state.retryAt ?? null,
    state.lastError ?? null,
    Date.now(),
  )
}

const updateState = (changes) => {
  const current = parseState(getStateRow()) ?? {
    runDate: chinaDate(),
    status: 'waiting',
    phase: 'market',
    stocks: null,
    meta: null,
    failedCodes: [],
    retryCount: 0,
    retryAt: null,
    lastError: null,
  }
  const next = { ...current, ...changes, updatedAt: Date.now() }
  writeState(next)
  return next
}

const chinaDate = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${values.year}-${values.month}-${values.day}`
}

const chinaClock = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return { hour: Number(values.hour), minute: Number(values.minute) }
}

const isChinaWeekend = () => {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    weekday: 'short',
  }).format(new Date())
  return weekday === 'Sat' || weekday === 'Sun'
}

const stockSymbol = (code) => {
  if (/^[69]\d{5}$/.test(code)) return `sh${code}`
  if (/^[023]\d{5}$/.test(code)) return `sz${code}`
  if (/^[48]\d{5}$/.test(code)) return `bj${code}`
  return null
}

const getMarketDataFetcher = async () => {
  if (marketDataFetcher) return marketDataFetcher
  const bundleUrl = new URL('../dist/server/eastmoney-data.mjs', import.meta.url)
  const { fetchRealMarketData } = await import(bundleUrl.href)
  return fetchRealMarketData
}

const saveKlineEntries = (runDate, entries) => {
  const insert = db.prepare(`
    INSERT INTO daily_market_klines (run_date, symbol, payload)
    VALUES (?, ?, ?)
    ON CONFLICT(run_date, symbol) DO UPDATE SET payload = excluded.payload
  `)
  db.exec('BEGIN')
  try {
    for (const [symbol, entry] of Object.entries(entries)) {
      if (SYMBOL_PATTERN.test(symbol)) {
        insert.run(runDate, symbol, JSON.stringify(entry))
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const scheduleRetry = (state, failedCodes, error = null) => {
  const retryAt = Date.now() + RETRY_DELAY_MS
  const status = state.retryCount < MAX_RETRIES ? 'retry_wait' : 'complete_with_errors'
  const next = updateState({
    ...state,
    status,
    failedCodes,
    retryAt: status === 'retry_wait' ? retryAt : null,
    lastError: error,
  })
  console.log(
    `[daily-market] ${state.runDate} ${state.phase} ${status}; ` +
      `${failedCodes.length} 个失败项，${status === 'retry_wait' ? '5 分钟后重试' : '已达重试上限'}` +
      (error ? `；${error}` : ''),
  )
  return next
}

const runKlinePhase = async (state) => {
  const stocks = state.stocks ?? []
  let failed = new Set(state.failedCodes)
  if (failed.size === 0 && state.status !== 'retry_wait') {
    failed = new Set(
      stocks.map((stock) => stockSymbol(stock.code)).filter(Boolean),
    )
  }

  updateState({
    ...state,
    status: 'fetching_klines',
    phase: 'kline',
    failedCodes: [...failed],
    retryAt: null,
    lastError: null,
  })

  const targets = [...failed]
  let completed = 0
  let lastError = null
  for (let index = 0; index < targets.length; index += KLINE_BATCH_SIZE) {
    const batch = targets.slice(index, index + KLINE_BATCH_SIZE)
    try {
      const result = await klineBatchFetcher(batch.join(','), '1100')
      saveKlineEntries(state.runDate, result.data ?? {})
      const batchFailed = new Set(result.failed ?? [])
      for (const symbol of batch) {
        if (!Object.hasOwn(result.data ?? {}, symbol)) batchFailed.add(symbol)
        if (batchFailed.has(symbol)) failed.add(symbol)
        else failed.delete(symbol)
      }
      lastError = null
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      batch.forEach((symbol) => failed.add(symbol))
    }

    completed += batch.length
    updateState({
      ...parseState(getStateRow()),
      status: 'fetching_klines',
      phase: 'kline',
      failedCodes: [...failed],
      lastError,
    })
    if (completed % 600 === 0 || completed === targets.length) {
      console.log(
        `[daily-market] ${state.runDate} K 线进度 ${completed}/${targets.length}，失败 ${failed.size}`,
      )
    }
  }

  const latest = parseState(getStateRow())
  if (failed.size > 0) {
    scheduleRetry(latest, [...failed], lastError)
    return
  }
  updateState({
    ...latest,
    status: 'complete',
    phase: 'done',
    failedCodes: [],
    retryAt: null,
    lastError: null,
  })
  console.log(`[daily-market] ${state.runDate} 全市场行情和 K 线拉取完成`)
}

const runMarketPhase = async (runDate, retryCount = 0) => {
  const current = parseState(getStateRow())
  if (jobInFlight || (current?.runDate === runDate && current.status === 'complete')) {
    return
  }
  jobInFlight = true
  try {
    const previousSnapshot = getDailyMarketPayload()
    updateState({
      runDate,
      status: 'fetching_market',
      phase: 'market',
      stocks: previousSnapshot.stocks.length
        ? previousSnapshot.stocks
        : current?.stocks ?? null,
      meta: previousSnapshot.meta ?? current?.meta ?? null,
      failedCodes: [],
      retryCount,
      retryAt: null,
      lastError: null,
    })
    const fetchRealMarketData = await getMarketDataFetcher()
    const { stocks, meta } = await fetchRealMarketData((message) =>
      console.log(`[daily-market] ${message}`),
    )

    if (meta.tradeDate !== runDate) {
      updateState({
        runDate,
        status: 'no_new_trading_day',
        phase: 'done',
        stocks: previousSnapshot.stocks.length ? previousSnapshot.stocks : stocks,
        meta: previousSnapshot.meta ?? meta,
        failedCodes: [],
        retryCount,
        retryAt: null,
        lastError: null,
      })
      console.log(
        `[daily-market] ${runDate} 未发现当日交易数据（最新交易日 ${meta.tradeDate}），跳过 K 线拉取`,
      )
      return
    }

    db.prepare('DELETE FROM daily_market_klines').run()
    const state = updateState({
      runDate,
      status: 'fetching_klines',
      phase: 'kline',
      stocks,
      meta,
      failedCodes: stocks.map((stock) => stockSymbol(stock.code)).filter(Boolean),
      retryCount,
      retryAt: null,
      lastError: null,
    })
    await runKlinePhase(state)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const state = parseState(getStateRow())
    scheduleRetry(state, state?.failedCodes ?? [], message)
  } finally {
    jobInFlight = false
  }
}

const runKlineRetry = async (state) => {
  if (jobInFlight) return
  jobInFlight = true
  try {
    const retryCount = state.retryCount + 1
    updateState({ ...state, retryCount, retryAt: null })
    await runKlinePhase({ ...state, retryCount })
  } finally {
    jobInFlight = false
  }
}

const tick = async () => {
  if (jobInFlight || isChinaWeekend()) return
  const { hour, minute } = chinaClock()
  if (hour < SCHEDULE_HOUR) return

  const runDate = chinaDate()
  const state = parseState(getStateRow())
  if (!state || state.runDate !== runDate) {
    await runMarketPhase(runDate)
    return
  }

  if (state.status === 'retry_wait' && state.retryAt && Date.now() >= state.retryAt) {
    if (state.phase === 'market') {
      await runMarketPhase(runDate, state.retryCount + 1)
    } else {
      await runKlineRetry(state)
    }
    return
  }

  if (
    ['fetching_market', 'fetching_klines'].includes(state.status) &&
    Date.now() - state.updatedAt > RETRY_DELAY_MS
  ) {
    scheduleRetry(state, state.failedCodes, '检测到任务中断，等待恢复重试')
  }

  void minute
}

export const startDailyMarketScheduler = ({
  fetchMarketData,
  fetchKlineBatch,
} = {}) => {
  if (process.env.DAILY_MARKET_SCHEDULER_ENABLED === '0') {
    console.log('[daily-market] 定时任务已通过环境变量关闭')
    return () => {}
  }
  if (schedulerStarted) return () => {}
  schedulerStarted = true
  marketDataFetcher = fetchMarketData ?? null
  klineBatchFetcher = fetchKlineBatch ?? queryKline
  const safeTick = () => {
    void tick().catch((error) => {
      console.error('[daily-market] 调度器异常', error)
    })
  }
  safeTick()
  schedulerTimer = setInterval(safeTick, 15_000)
  schedulerTimer.unref?.()
  return () => {
    if (schedulerTimer) clearInterval(schedulerTimer)
    schedulerTimer = null
    schedulerStarted = false
  }
}

export const getDailyMarketPayload = ({ statusOnly = false } = {}) => {
  const state = parseState(getStateRow())
  if (!state) {
    return {
      stocks: [],
      meta: null,
      status: 'waiting',
      phase: 'market',
      runDate: null,
      failedCount: 0,
      retryAt: null,
      lastError: null,
      updatedAt: null,
    }
  }

  const klineCount = db
    .prepare('SELECT COUNT(*) AS count FROM daily_market_klines WHERE run_date = ?')
    .get(state.runDate).count
  const meta = state.meta
    ? { ...state.meta, klineCount }
    : null
  if (statusOnly) {
    return {
      stocks: [],
      meta,
      status: state.status,
      phase: state.phase,
      runDate: state.runDate,
      failedCount: state.failedCodes.length,
      retryAt: state.retryAt,
      lastError: state.lastError,
      updatedAt: state.updatedAt,
    }
  }

  const rows = db
    .prepare('SELECT symbol, payload FROM daily_market_klines WHERE run_date = ?')
    .all(state.runDate)
  const entries = new Map(
    rows.map((row) => [row.symbol, JSON.parse(row.payload)]),
  )
  const stocks = (state.stocks ?? []).map((stock) => {
    const symbol = stockSymbol(stock.code)
    const entry = symbol ? entries.get(symbol) : null
    if (!entry) return stock
    return {
      ...stock,
      price:
        entry.lastClose !== null && entry.lastClose > 0
          ? entry.lastClose
          : stock.price,
      highPrice1y: entry.high1y ?? stock.highPrice1y,
      lowPrice1y: entry.low1y ?? stock.lowPrice1y,
      lowPrice3y: entry.low3y ?? stock.lowPrice3y,
    }
  })

  return {
    stocks,
    meta: state.meta ? { ...state.meta, klineCount: rows.length } : meta,
    status: state.status,
    phase: state.phase,
    runDate: state.runDate,
    failedCount: state.failedCodes.length,
    retryAt: state.retryAt,
    lastError: state.lastError,
    updatedAt: state.updatedAt,
  }
}

export const handleDailyMarketRoute = async (req, res, url) => {
  if (url.pathname !== '/api/market-data') return false
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET', 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return true
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(
    JSON.stringify(
      getDailyMarketPayload({ statusOnly: url.searchParams.get('status') === '1' }),
    ),
  )
  return true
}
