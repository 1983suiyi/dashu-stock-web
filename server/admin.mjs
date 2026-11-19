/**
 * 管理端接口（P1：邀请码管理）。
 * 所有接口强制 role=admin；写操作一律记入 audit_logs。
 * 后续阶段在此追加：用户管理、市场温度校正、审计日志查询（P2/P3）。
 */
import { randomBytes } from 'node:crypto'
import { db, now } from './db.mjs'
import { fail, ok, readJsonBody } from './http.mjs'
import { recordAudit } from './auth.mjs'

const clampInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

const generateInviteCode = () =>
  `DS${randomBytes(6).toString('hex').toUpperCase()}`

const toInvite = (row) => ({
  code: row.code,
  createdBy: row.created_by == null ? null : Number(row.created_by),
  maxUses: Number(row.max_uses),
  usedCount: Number(row.used_count),
  expiresAt: row.expires_at == null ? null : Number(row.expires_at),
  status: row.status,
  createdAt: Number(row.created_at),
})

/** 处理 /api/admin/*；命中返回 true，未命中返回 false。session 由调用方解析。 */
export const handleAdminRoute = async (req, res, url, session) => {
  const { pathname } = url
  if (!pathname.startsWith('/api/admin/')) return false

  const method = (req.method ?? 'GET').toUpperCase()
  const ip = req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? null

  if (!session) {
    fail(res, 401, 'UNAUTHORIZED', '未登录')
    return true
  }
  if (session.user.role !== 'admin') {
    fail(res, 403, 'FORBIDDEN', '需要管理员权限')
    return true
  }
  if (method !== 'GET' && req.headers['x-requested-with'] !== 'XMLHttpRequest') {
    fail(res, 403, 'FORBIDDEN', '缺少 CSRF 校验头')
    return true
  }

  try {
    if (pathname === '/api/admin/invites' && method === 'GET') {
      const rows = db
        .prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT 200')
        .all()
      ok(res, { invites: rows.map(toInvite) })
      return true
    }

    if (pathname === '/api/admin/invites' && method === 'POST') {
      const body = await readJsonBody(req)
      const maxUses = clampInt(body.maxUses, 1, 1, 1000)
      const count = clampInt(body.count, 1, 1, 20)
      const expiresInDays =
        body.expiresInDays == null || body.expiresInDays === ''
          ? null
          : clampInt(body.expiresInDays, 30, 1, 3650)
      const expiresAt = expiresInDays == null ? null : now() + expiresInDays * 24 * 60 * 60 * 1000

      const insert = db.prepare(
        `INSERT INTO invites (code, created_by, max_uses, used_count, expires_at, status, created_at)
         VALUES (?, ?, ?, 0, ?, 'active', ?)`,
      )
      const created = []
      for (let i = 0; i < count; i += 1) {
        const code = generateInviteCode()
        insert.run(code, session.user.id, maxUses, expiresAt, now())
        created.push(code)
      }

      recordAudit({
        actorUserId: session.user.id,
        action: 'invite_create',
        target: created.join(','),
        detail: { maxUses, expiresInDays, count },
        ip,
      })
      ok(res, { codes: created })
      return true
    }

    if (pathname.startsWith('/api/admin/invites/') && method === 'PATCH') {
      const code = decodeURIComponent(
        pathname.slice('/api/admin/invites/'.length),
      ).toUpperCase()
      const body = await readJsonBody(req)
      const status = body.status === 'revoked' ? 'revoked' : body.status === 'active' ? 'active' : null
      if (!status) {
        fail(res, 400, 'INVALID_INPUT', 'status 需为 active 或 revoked')
        return true
      }
      const info = db.prepare('UPDATE invites SET status = ? WHERE code = ?').run(status, code)
      if (Number(info.changes) === 0) {
        fail(res, 404, 'INVALID_INVITE', '邀请码不存在')
        return true
      }
      recordAudit({
        actorUserId: session.user.id,
        action: 'invite_update',
        target: code,
        detail: { status },
        ip,
      })
      ok(res, { updated: true })
      return true
    }

    fail(res, 404, 'INVALID_INPUT', '接口不存在')
    return true
  } catch (error) {
    if (error instanceof Error && error.message === 'BODY_TOO_LARGE') {
      fail(res, 400, 'INVALID_INPUT', '请求体过大')
      return true
    }
    if (error instanceof Error && error.message === 'INVALID_JSON') {
      fail(res, 400, 'INVALID_INPUT', 'JSON 解析失败')
      return true
    }
    console.error('[admin] 处理异常:', error)
    fail(res, 500, 'INTERNAL', '服务异常，请稍后再试')
    return true
  }
}
