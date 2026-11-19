/**
 * 市场温度（公共数据，全站共用一份，按日期一行）。
 * 任意登录用户写入同一份；管理员可在校正接口覆盖。
 *
 * 路由（需登录）：
 *   GET  /api/market-temperature       按日期倒序列出（默认最多 240 条）
 *   POST /api/market-temperature       按日期幂等 upsert 当日一条
 */
import { db, now } from './db.mjs'
import { fail, ok, readJsonBody } from './http.mjs'
import { getSessionUser } from './auth.mjs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_LIMIT = 240
const MAX_LIMIT = 1000

const toRow = (record) => ({
  date: record.date,
  index_level: record.indexLevel == null ? null : Number(record.indexLevel),
  exposure_pct: record.exposurePct == null ? null : Number(record.exposurePct),
  pb_median: record.pbMedian == null ? null : Number(record.pbMedian),
  pe_median: record.peMedian == null ? null : Number(record.peMedian),
  below_net_count: Number(record.belowNetCount ?? 0),
  three_low_count: Number(record.threeLowCount ?? 0),
  risk_passed_count: Number(record.riskPassedCount ?? 0),
})

const fromRow = (row) => ({
  date: row.date,
  indexLevel: row.index_level == null ? null : Number(row.index_level),
  exposurePct: row.exposure_pct == null ? null : Number(row.exposure_pct),
  pbMedian: row.pb_median == null ? null : Number(row.pb_median),
  peMedian: row.pe_median == null ? null : Number(row.pe_median),
  belowNetCount: Number(row.below_net_count),
  threeLowCount: Number(row.three_low_count),
  riskPassedCount: Number(row.risk_passed_count),
})

export const upsertMarketTemperature = (record) => {
  const r = toRow(record)
  db.prepare(
    `INSERT INTO market_temperature
       (date, index_level, exposure_pct, pb_median, pe_median, below_net_count, three_low_count, risk_passed_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       index_level = excluded.index_level,
       exposure_pct = excluded.exposure_pct,
       pb_median = excluded.pb_median,
       pe_median = excluded.pe_median,
       below_net_count = excluded.below_net_count,
       three_low_count = excluded.three_low_count,
       risk_passed_count = excluded.risk_passed_count,
       updated_at = excluded.updated_at`,
  ).run(
    r.date,
    r.index_level,
    r.exposure_pct,
    r.pb_median,
    r.pe_median,
    r.below_net_count,
    r.three_low_count,
    r.risk_passed_count,
    now(),
  )
}

/** 处理 /api/market-temperature；命中返回 true，未命中返回 false。 */
export const handleMarketTemperatureRoute = async (req, res, url) => {
  if (url.pathname !== '/api/market-temperature') return false

  const session = getSessionUser(req)
  if (!session) {
    fail(res, 401, 'UNAUTHORIZED', '未登录')
    return true
  }

  const method = (req.method ?? 'GET').toUpperCase()

  if (method === 'GET') {
    const limit = Math.min(
      DEFAULT_LIMIT,
      Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT),
    )
    const rows = db
      .prepare('SELECT * FROM market_temperature ORDER BY date DESC LIMIT ?')
      .all(Math.min(limit, MAX_LIMIT))
    ok(res, { records: rows.map(fromRow) })
    return true
  }

  if (method === 'POST') {
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
      fail(res, 403, 'FORBIDDEN', '缺少 CSRF 校验头')
      return true
    }
    const body = await readJsonBody(req)
    const record = body.record
    if (!record || typeof record !== 'object') {
      fail(res, 400, 'INVALID_INPUT', '缺少 record')
      return true
    }
    if (!DATE_RE.test(record.date)) {
      fail(res, 400, 'INVALID_INPUT', 'date 需为 YYYY-MM-DD')
      return true
    }
    upsertMarketTemperature(record)
    ok(res, { updated: true, date: record.date })
    return true
  }

  fail(res, 405, 'INVALID_INPUT', '方法不支持')
  return true
}
