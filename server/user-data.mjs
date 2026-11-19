/**
 * 用户私有数据读写（持仓 / 现金 / 总资产 / 资金流水 / 归档）。
 * 采用通用 KV：每种 kind 存一块 JSON，与既有 localStorage 语义等价。
 *
 * 路由（需登录）：
 *   GET  /api/user-data/:kind   读取当前用户某类数据
 *   PUT  /api/user-data/:kind   覆盖写入当前用户某类数据
 */
import { db, now } from './db.mjs'
import { fail, getSessionUser, ok, readJsonBody } from './http.mjs'

const ALLOWED_KINDS = new Set([
  'holdings',
  'cash',
  'totalAssets',
  'capitalEvents',
  'archives',
])

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 // 单类数据 2MB 上限

const getUserData = (userId, kind) =>
  db
    .prepare('SELECT payload, updated_at FROM user_data WHERE user_id = ? AND kind = ?')
    .get(userId, kind)

const putUserData = (userId, kind, payload) => {
  db.prepare(
    `INSERT INTO user_data (user_id, kind, payload, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  ).run(userId, kind, payload, now())
}

/** 处理 /api/user-data/:kind；命中返回 true，未命中返回 false。 */
export const handleUserDataRoute = async (req, res, url) => {
  const { pathname } = url
  const prefix = '/api/user-data/'
  if (!pathname.startsWith(prefix)) return false

  const session = getSessionUser(req)
  if (!session) {
    fail(res, 401, 'UNAUTHORIZED', '未登录')
    return true
  }

  const kind = decodeURIComponent(pathname.slice(prefix.length))
  if (!ALLOWED_KINDS.has(kind)) {
    fail(res, 400, 'INVALID_INPUT', `不支持的数据类型：${kind}`)
    return true
  }

  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET') {
    const row = getUserData(session.user.id, kind)
    ok(res, {
      kind,
      payload: row ? JSON.parse(row.payload) : null,
      updatedAt: row ? Number(row.updated_at) : 0,
    })
    return true
  }

  if (method === 'PUT') {
    if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
      fail(res, 403, 'FORBIDDEN', '缺少 CSRF 校验头')
      return true
    }
    const body = await readJsonBody(req)
    const serialized = JSON.stringify(body.payload ?? null)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
      fail(res, 413, 'INVALID_INPUT', '数据过大')
      return true
    }
    putUserData(session.user.id, kind, serialized)
    ok(res, { kind, updatedAt: now() })
    return true
  }

  fail(res, 405, 'INVALID_INPUT', '方法不支持')
  return true
}
