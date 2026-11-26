/**
 * 账号鉴权：密码哈希、会话、邮箱验证码、限流、审计。
 *
 * 设计要点（见 docs/账号与多用户数据方案.md 第 4 节）：
 * - 密码：scrypt + 每用户随机盐，timingSafeEqual 常数时间比较
 * - 会话：32 字节随机 token，仅存 sha256(token)，前端拿 HttpOnly Cookie
 * - 验证码：6 位数字，哈希存储，5 分钟有效、单次消费、最多校验 5 次
 */
import {
  createHash,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import { db, now } from './db.mjs'
import { sendVerificationCode } from './mailer.mjs'
import {
  fail,
  ok,
  parseCookies,
  readJsonBody,
  serializeCookie,
} from './http.mjs'

export const SESSION_COOKIE = 'dashu_session'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const CODE_TTL_MS = 5 * 60 * 1000
const CODE_MAX_ATTEMPTS = 5
const MIN_PASSWORD_LENGTH = 8

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const ERROR_STATUS = {
  INVALID_EMAIL: 400,
  INVALID_INPUT: 400,
  CODE_EXPIRED: 400,
  CODE_MISMATCH: 400,
  INVALID_INVITE: 400,
  EMAIL_TAKEN: 409,
  BAD_CREDENTIALS: 401,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
}

const ERROR_MESSAGE = {
  INVALID_EMAIL: '邮箱格式不正确',
  INVALID_INPUT: '输入不合法',
  CODE_EXPIRED: '验证码已过期或不存在',
  CODE_MISMATCH: '验证码不正确',
  INVALID_INVITE: '邀请码无效或已用尽',
  EMAIL_TAKEN: '该邮箱已注册',
  BAD_CREDENTIALS: '邮箱或密码不正确',
  UNAUTHORIZED: '未登录',
  FORBIDDEN: '没有权限',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase()
const isSecureCookie = () =>
  process.env.COOKIE_SECURE === '1' || process.env.NODE_ENV === 'production'

const adminEmail = () => normalizeEmail(process.env.ADMIN_EMAIL)

export const sessionCookie = (token) =>
  serializeCookie(SESSION_COOKIE, token, {
    maxAgeSec: Math.floor(SESSION_TTL_MS / 1000),
    secure: isSecureCookie(),
  })

export const clearSessionCookie = () =>
  serializeCookie(SESSION_COOKIE, '', { maxAgeSec: 0, secure: isSecureCookie() })

// ---------- 密码 ----------

export const hashPassword = (password) => {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return { hash, salt }
}

const verifyPassword = (password, hash, salt) => {
  const expected = Buffer.from(hash, 'hex')
  const actual = scryptSync(password, salt, 64)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

// ---------- 限流 ----------

/** 固定窗口计数；返回 true 表示未超限 */
const bumpRateLimit = (key, windowMs, max) => {
  const bucket = Math.floor(now() / windowMs) * windowMs
  const row = db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .get(key, bucket)
  return Number(row.count) <= max
}

// ---------- 审计 ----------

export const recordAudit = ({
  actorUserId = null,
  action,
  target = null,
  detail = null,
  ip = null,
}) => {
  db.prepare(
    `INSERT INTO audit_logs (actor_user_id, action, target, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    actorUserId,
    action,
    target,
    detail ? JSON.stringify(detail) : null,
    ip,
    now(),
  )
}

// ---------- 用户 ----------

const toUser = (row) => ({
  id: Number(row.id),
  email: row.email,
  role: row.role,
  status: row.status,
  createdAt: Number(row.created_at),
  lastLoginAt: row.last_login_at == null ? null : Number(row.last_login_at),
})

export const getUserById = (userId) => {
  const row = db
    .prepare('SELECT id, email, role, status, created_at, last_login_at FROM users WHERE id = ?')
    .get(userId)
  return row ? toUser(row) : null
}

/**
 * 删除用户并清理其关联数据。
 * sessions / user_data 通过外键 ON DELETE CASCADE 自动清理；
 * audit_logs.actor_user_id 与 invites.created_by 无级联，先置空避免外键阻塞删除。
 * 返回实际删除的行数。
 */
export const deleteUserCascade = (userId) => {
  db.prepare('UPDATE audit_logs SET actor_user_id = NULL WHERE actor_user_id = ?').run(userId)
  db.prepare('UPDATE invites SET created_by = NULL WHERE created_by = ?').run(userId)
  return Number(db.prepare('DELETE FROM users WHERE id = ?').run(userId).changes)
}

// ---------- 会话 ----------

const createSession = (userId, ip, userAgent) => {
  const token = randomBytes(32).toString('hex')
  const created = now()
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sha256(token),
    userId,
    created,
    created + SESSION_TTL_MS,
    created,
    ip ?? null,
    userAgent ?? null,
  )
  return token
}

const destroySession = (token) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
}

/** 从请求 Cookie 解析当前会话；返回 { user } 或 null */
export const getSessionUser = (req) => {
  const token = parseCookies(req)[SESSION_COOKIE]
  if (!token) return null
  const tokenHash = sha256(token)
  const row = db
    .prepare(
      `SELECT s.expires_at, u.id, u.email, u.role, u.status, u.created_at, u.last_login_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash)
  if (!row) return null
  if (Number(row.expires_at) < now() || row.status !== 'active') {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
    return null
  }
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now(), tokenHash)
  return { user: toUser(row) }
}

// ---------- 邀请码 ----------

const findUsableInvite = (code) => {
  const normalized = String(code ?? '').trim().toUpperCase()
  if (!normalized) return null
  const row = db.prepare('SELECT * FROM invites WHERE code = ?').get(normalized)
  if (!row) return null
  if (row.status !== 'active') return null
  if (row.expires_at != null && Number(row.expires_at) < now()) return null
  if (Number(row.used_count) >= Number(row.max_uses)) return null
  return row
}

// ---------- 验证码 ----------

const issueCode = async (email, purpose, ip) => {
  if (!bumpRateLimit(`code:gap:${email}`, 60 * 1000, 1)) {
    return { ok: false, code: 'RATE_LIMITED' }
  }
  if (!bumpRateLimit(`code:day:${email}`, 24 * 60 * 60 * 1000, 10)) {
    return { ok: false, code: 'RATE_LIMITED' }
  }
  if (ip && !bumpRateLimit(`code:ip:${ip}`, 24 * 60 * 60 * 1000, 30)) {
    return { ok: false, code: 'RATE_LIMITED' }
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  db.prepare(
    `INSERT INTO verification_codes (target, channel, purpose, code_hash, expires_at, attempts, created_at)
     VALUES (?, 'email', ?, ?, ?, 0, ?)`,
  ).run(email, purpose, sha256(code), now() + CODE_TTL_MS, now())

  await sendVerificationCode(email, purpose, code, Math.round(CODE_TTL_MS / 60000))
  return { ok: true }
}

/** 校验并消费验证码（单次有效、最多尝试 5 次） */
const consumeCode = (email, purpose, code) => {
  const row = db
    .prepare(
      `SELECT id, code_hash, expires_at, attempts FROM verification_codes
       WHERE target = ? AND purpose = ? AND consumed_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(email, purpose)
  if (!row) return { ok: false, code: 'CODE_EXPIRED' }
  if (Number(row.expires_at) < now()) return { ok: false, code: 'CODE_EXPIRED' }
  if (Number(row.attempts) >= CODE_MAX_ATTEMPTS) return { ok: false, code: 'CODE_EXPIRED' }

  db.prepare('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id)
  if (sha256(String(code ?? '')) !== row.code_hash) {
    return { ok: false, code: 'CODE_MISMATCH' }
  }
  db.prepare('UPDATE verification_codes SET consumed_at = ? WHERE id = ?').run(now(), row.id)
  return { ok: true }
}

// ---------- 业务动作 ----------

const registerUser = async (
  { email, code, password, invite },
  ip,
  userAgent,
) => {
  const mail = normalizeEmail(email)
  if (!EMAIL_RE.test(mail)) return { ok: false, code: 'INVALID_EMAIL' }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `密码至少 ${MIN_PASSWORD_LENGTH} 位`,
    }
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(mail)) {
    return { ok: false, code: 'EMAIL_TAKEN' }
  }

  // 管理员邮箱免邀请码，解决「首个管理员无法注册」的先有鸡还是先有蛋问题
  const isAdminEmail = Boolean(adminEmail()) && mail === adminEmail()
  if (!isAdminEmail && !findUsableInvite(invite)) {
    return { ok: false, code: 'INVALID_INVITE' }
  }

  const codeResult = consumeCode(mail, 'register', code)
  if (!codeResult.ok) return codeResult

  const { hash, salt } = hashPassword(password)
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, password_salt, status, role, created_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    )
    .run(mail, hash, salt, isAdminEmail ? 'admin' : 'user', now())
  const userId = Number(info.lastInsertRowid)

  if (!isAdminEmail && invite) {
    db.prepare('UPDATE invites SET used_count = used_count + 1 WHERE code = ?').run(
      String(invite).trim().toUpperCase(),
    )
  }

  recordAudit({
    actorUserId: userId,
    action: 'register',
    target: String(userId),
    detail: { role: isAdminEmail ? 'admin' : 'user' },
    ip,
  })

  return {
    ok: true,
    data: { user: getUserById(userId), token: createSession(userId, ip, userAgent) },
  }
}

const loginUser = ({ email, password }, ip, userAgent) => {
  const mail = normalizeEmail(email)
  if (!bumpRateLimit(`login:ip:${ip ?? 'unknown'}`, 15 * 60 * 1000, 20)) {
    recordAudit({ action: 'login_failed', target: mail, detail: { reason: 'rate_limited' }, ip })
    return { ok: false, code: 'RATE_LIMITED' }
  }

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(mail)
  const badCredentials = { ok: false, code: 'BAD_CREDENTIALS' }
  if (!row) {
    recordAudit({ action: 'login_failed', target: mail, detail: { reason: 'user_not_found' }, ip })
    return badCredentials
  }
  if (!verifyPassword(String(password ?? ''), row.password_hash, row.password_salt)) {
    recordAudit({ actorUserId: Number(row.id), action: 'login_failed', target: mail, detail: { reason: 'wrong_password' }, ip })
    return badCredentials
  }
  if (row.status !== 'active') {
    recordAudit({ actorUserId: Number(row.id), action: 'login_blocked', target: mail, ip })
    return { ok: false, code: 'FORBIDDEN', message: '账号已被禁用' }
  }

  // ADMIN_EMAIL 匹配时自动提升为管理员，便于既有账号升级
  if (adminEmail() && mail === adminEmail() && row.role !== 'admin') {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(row.id)
  }

  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), row.id)
  recordAudit({ actorUserId: Number(row.id), action: 'login', target: String(row.id), ip })

  return {
    ok: true,
    data: {
      user: getUserById(Number(row.id)),
      token: createSession(Number(row.id), ip, userAgent),
    },
  }
}

const resetPassword = ({ email, code, newPassword }, ip) => {
  const mail = normalizeEmail(email)
  if (!EMAIL_RE.test(mail)) return { ok: false, code: 'INVALID_EMAIL' }
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `密码至少 ${MIN_PASSWORD_LENGTH} 位`,
    }
  }

  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(mail)
  if (!row) return { ok: false, code: 'USER_NOT_FOUND', message: '该邮箱未注册，请先注册账号。' }

  const codeResult = consumeCode(mail, 'reset', code)
  if (!codeResult.ok) return codeResult

  const { hash, salt } = hashPassword(newPassword)
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(
    hash,
    salt,
    row.id,
  )
  // 重置后强制所有会话下线
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id)
  recordAudit({
    actorUserId: Number(row.id),
    action: 'reset_password',
    target: String(row.id),
    ip,
  })
  return { ok: true, data: { reset: true } }
}

// ---------- 路由 ----------

const clientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim()
  return req.socket?.remoteAddress ?? null
}

const hasCsrfHeader = (req) => req.headers['x-requested-with'] === 'XMLHttpRequest'

const reject = (res, code, message) => {
  fail(res, ERROR_STATUS[code] ?? 400, code, message ?? ERROR_MESSAGE[code] ?? '请求失败')
}

/**
 * 处理 /api/auth/*；命中返回 true，未命中返回 false。
 * 供 server/index.mjs（生产）与 vite.config.ts（开发中间件）共用。
 */
export const handleAuthRoute = async (req, res, url) => {
  const { pathname } = url
  if (!pathname.startsWith('/api/auth/')) return false

  const method = (req.method ?? 'GET').toUpperCase()
  const ip = clientIp(req)
  const userAgent = req.headers['user-agent'] ?? null

  try {
    if (method !== 'GET' && !hasCsrfHeader(req)) {
      reject(res, 'FORBIDDEN', '缺少 CSRF 校验头')
      return true
    }

    if (pathname === '/api/auth/send-code' && method === 'POST') {
      const body = await readJsonBody(req)
      const email = normalizeEmail(body.email)
      const purpose = String(body.purpose ?? '').trim()
      if (!EMAIL_RE.test(email)) {
        reject(res, 'INVALID_EMAIL')
        return true
      }
      if (!['register', 'login', 'reset'].includes(purpose)) {
        reject(res, 'INVALID_INPUT', 'purpose 不合法')
        return true
      }
      const result = await issueCode(email, purpose, ip)
      if (!result.ok) {
        reject(res, result.code)
        return true
      }
      ok(res, { sent: true })
      return true
    }

    if (pathname === '/api/auth/register' && method === 'POST') {
      const body = await readJsonBody(req)
      const result = await registerUser(body, ip, userAgent)
      if (!result.ok) {
        reject(res, result.code, result.message)
        return true
      }
      res.setHeader('Set-Cookie', sessionCookie(result.data.token))
      ok(res, { user: result.data.user })
      return true
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readJsonBody(req)
      const result = loginUser(body, ip, userAgent)
      if (!result.ok) {
        reject(res, result.code, result.message)
        return true
      }
      res.setHeader('Set-Cookie', sessionCookie(result.data.token))
      ok(res, { user: result.data.user })
      return true
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const token = parseCookies(req)[SESSION_COOKIE]
      if (token) destroySession(token)
      res.setHeader('Set-Cookie', clearSessionCookie())
      ok(res, { loggedOut: true })
      return true
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      const session = getSessionUser(req)
      if (!session) {
        reject(res, 'UNAUTHORIZED')
        return true
      }
      ok(res, { user: session.user })
      return true
    }

    if (pathname === '/api/auth/reset-password' && method === 'POST') {
      const body = await readJsonBody(req)
      const result = resetPassword(body, ip)
      if (!result.ok) {
        reject(res, result.code, result.message)
        return true
      }
      ok(res, result.data)
      return true
    }

    if (pathname === '/api/auth/delete-account' && method === 'POST') {
      const session = getSessionUser(req)
      if (!session) {
        reject(res, 'UNAUTHORIZED')
        return true
      }
      const user = session.user
      if (user.role === 'admin') {
        reject(res, 'FORBIDDEN', '管理员账号不可自助删除，请联系其他管理员处理')
        return true
      }
      const body = await readJsonBody(req)
      const row = db
        .prepare('SELECT password_hash, password_salt FROM users WHERE id = ?')
        .get(user.id)
      if (!row || !verifyPassword(String(body.password ?? ''), row.password_hash, row.password_salt)) {
        reject(res, 'BAD_CREDENTIALS', '密码不正确')
        return true
      }
      // 先记审计（actor 置空，删除后该列会被置空，无外键阻塞）
      recordAudit({
        action: 'account_delete',
        target: String(user.id),
        detail: { email: user.email },
        ip,
      })
      deleteUserCascade(user.id)
      res.setHeader('Set-Cookie', clearSessionCookie())
      ok(res, { deleted: true })
      return true
    }

    reject(res, 'INVALID_INPUT', '接口不存在')
    return true
  } catch (error) {
    if (error instanceof Error && error.message === 'BODY_TOO_LARGE') {
      reject(res, 'INVALID_INPUT', '请求体过大')
      return true
    }
    if (error instanceof Error && error.message === 'INVALID_JSON') {
      reject(res, 'INVALID_INPUT', 'JSON 解析失败')
      return true
    }
    console.error('[auth] 处理异常:', error)
    fail(res, 500, 'INTERNAL', '服务异常，请稍后再试')
    return true
  }
}
