/**
 * 管理端接口：邀请码管理（P1）、用户管理 + 市场温度校正（P2）、审计日志查询（P3）。
 * 所有接口强制 role=admin；写操作一律记入 audit_logs。
 */
import { randomBytes } from 'node:crypto'
import { db, now } from './db.mjs'
import { fail, ok, readJsonBody } from './http.mjs'
import { deleteUserCascade, hashPassword, recordAudit } from './auth.mjs'
import { upsertMarketTemperature } from './market-temperature.mjs'

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

    // ---------- 用户管理 ----------

    if (pathname === '/api/admin/users' && method === 'GET') {
      const page = clampInt(url.searchParams.get('page'), 1, 1, 100000)
      const pageSize = clampInt(url.searchParams.get('pageSize'), 50, 1, 200)
      const statusFilter = url.searchParams.get('status') || ''
      const emailKeyword = (url.searchParams.get('email') || '').trim().toLowerCase()

      const where = []
      const params = []
      if (statusFilter) {
        where.push('status = ?')
        params.push(statusFilter)
      }
      if (emailKeyword) {
        where.push('email LIKE ?')
        params.push(`%${emailKeyword}%`)
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

      const total = Number(
        db.prepare(`SELECT COUNT(*) AS c FROM users ${whereSql}`).get(...params).c,
      )
      const offset = (page - 1) * pageSize
      const rows = db
        .prepare(
          `SELECT id, email, status, role, realtime_enabled, created_at, last_login_at
           FROM users ${whereSql}
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, offset)

      ok(res, {
        users: rows.map((row) => ({
          id: Number(row.id),
          email: row.email,
          status: row.status,
          role: row.role,
          realtimeEnabled: Number(row.realtime_enabled ?? 0) === 1,
          createdAt: Number(row.created_at),
          lastLoginAt: row.last_login_at ? Number(row.last_login_at) : null,
        })),
        total,
        page,
        pageSize,
      })
      return true
    }

    if (pathname.startsWith('/api/admin/users/') && method === 'PATCH') {
      const userId = Number.parseInt(
        decodeURIComponent(pathname.slice('/api/admin/users/'.length)),
        10,
      )
      if (!Number.isFinite(userId)) {
        fail(res, 400, 'INVALID_INPUT', '用户 ID 不合法')
        return true
      }
      const body = await readJsonBody(req)
      const nextStatus =
        body.status === 'disabled' ? 'disabled' : body.status === 'active' ? 'active' : null
      const hasRealtime = typeof body.realtimeEnabled === 'boolean'
      if (!nextStatus && !hasRealtime) {
        fail(res, 400, 'INVALID_INPUT', 'status 或 realtimeEnabled 至少提供一项')
        return true
      }
      if (nextStatus && userId === session.user.id) {
        fail(res, 400, 'INVALID_INPUT', '不能修改自己的账号状态')
        return true
      }
      const sets = []
      const values = []
      if (nextStatus) {
        sets.push('status = ?')
        values.push(nextStatus)
      }
      if (hasRealtime) {
        sets.push('realtime_enabled = ?')
        values.push(body.realtimeEnabled ? 1 : 0)
      }
      const info = db
        .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
        .run(...values, userId)
      if (Number(info.changes) === 0) {
        fail(res, 404, 'INVALID_INPUT', '用户不存在')
        return true
      }
      recordAudit({
        actorUserId: session.user.id,
        action: 'user_update',
        target: String(userId),
        detail: {
          ...(nextStatus ? { status: nextStatus } : {}),
          ...(hasRealtime ? { realtimeEnabled: body.realtimeEnabled } : {}),
        },
        ip,
      })
      ok(res, { updated: true })
      return true
    }

    if (pathname.startsWith('/api/admin/users/') && method === 'DELETE') {
      const userId = Number.parseInt(
        decodeURIComponent(pathname.slice('/api/admin/users/'.length)),
        10,
      )
      if (!Number.isFinite(userId)) {
        fail(res, 400, 'INVALID_INPUT', '用户 ID 不合法')
        return true
      }
      if (userId === session.user.id) {
        fail(res, 400, 'INVALID_INPUT', '不能删除自己')
        return true
      }
      const changes = deleteUserCascade(userId)
      if (changes === 0) {
        fail(res, 404, 'INVALID_INPUT', '用户不存在')
        return true
      }
      recordAudit({
        actorUserId: session.user.id,
        action: 'user_delete',
        target: String(userId),
        ip,
      })
      ok(res, { deleted: true })
      return true
    }

    if (pathname.startsWith('/api/admin/users/') && pathname.endsWith('/reset-password') && method === 'POST') {
      const userId = Number.parseInt(
        decodeURIComponent(
          pathname.slice('/api/admin/users/'.length, -'/reset-password'.length),
        ),
        10,
      )
      if (!Number.isFinite(userId)) {
        fail(res, 400, 'INVALID_INPUT', '用户 ID 不合法')
        return true
      }
      const body = await readJsonBody(req)
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
      if (newPassword.length < 8) {
        fail(res, 400, 'INVALID_INPUT', '密码至少 8 位')
        return true
      }
      const { hash, salt } = hashPassword(newPassword)
      const info = db
        .prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
        .run(hash, salt, userId)
      if (Number(info.changes) === 0) {
        fail(res, 404, 'INVALID_INPUT', '用户不存在')
        return true
      }
      // 重置密码后清除该用户所有会话，强制重新登录
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
      recordAudit({
        actorUserId: session.user.id,
        action: 'user_reset_password',
        target: String(userId),
        ip,
      })
      ok(res, { reset: true })
      return true
    }

    // ---------- 市场温度校正 ----------

    if (pathname.startsWith('/api/admin/market-temperature/') && method === 'PUT') {
      const date = decodeURIComponent(pathname.slice('/api/admin/market-temperature/'.length))
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        fail(res, 400, 'INVALID_INPUT', 'date 需为 YYYY-MM-DD')
        return true
      }
      const body = await readJsonBody(req)
      const record = { date, ...(body.record || body) }
      upsertMarketTemperature(record)
      recordAudit({
        actorUserId: session.user.id,
        action: 'market_temperature_correct',
        target: date,
        detail: record,
        ip,
      })
      ok(res, { updated: true, date })
      return true
    }

    // ---------- 审计日志 ----------

    if (pathname === '/api/admin/audit-logs' && method === 'GET') {
      const page = clampInt(url.searchParams.get('page'), 1, 1, 100000)
      const pageSize = clampInt(url.searchParams.get('pageSize'), 50, 1, 200)
      const action = (url.searchParams.get('action') || '').trim()

      const where = []
      const params = []
      if (action) {
        where.push('action = ?')
        params.push(action)
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

      const total = Number(
        db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${whereSql}`).get(...params).c,
      )
      const offset = (page - 1) * pageSize
      const rows = db
        .prepare(
          `SELECT id, actor_user_id, action, target, detail, ip, created_at
           FROM audit_logs ${whereSql}
           ORDER BY created_at DESC, id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, offset)

      ok(res, {
        logs: rows.map((row) => ({
          id: Number(row.id),
          actorUserId: row.actor_user_id == null ? null : Number(row.actor_user_id),
          action: row.action,
          target: row.target,
          detail: row.detail ? JSON.parse(row.detail) : null,
          ip: row.ip,
          createdAt: Number(row.created_at),
        })),
        total,
        page,
        pageSize,
      })
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
