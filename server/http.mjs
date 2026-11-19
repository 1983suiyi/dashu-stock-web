/**
 * HTTP 小工具：统一 JSON 响应、请求体读取、Cookie 解析/序列化。
 * 被 server/index.mjs（生产）与 vite.config.ts（开发中间件）共用，保证两端行为一致。
 */

/** 请求体上限，防止超大 body 打爆内存 */
const MAX_BODY_BYTES = 16 * 1024

export const sendJson = (res, status, payload) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 成功响应：{ ok: true, data } */
export const ok = (res, data) => sendJson(res, 200, { ok: true, data })

/** 失败响应：{ ok: false, error: { code, message } } */
export const fail = (res, status, code, message) =>
  sendJson(res, status, { ok: false, error: { code, message } })

/** 读取并解析 JSON 请求体；空 body 返回 {} */
export const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('BODY_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('INVALID_JSON'))
      }
    })
    req.on('error', reject)
  })

/** 解析 Cookie 头为普通对象 */
export const parseCookies = (req) => {
  const header = req.headers.cookie
  const jar = {}
  if (!header) return jar
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) jar[key] = decodeURIComponent(value)
  }
  return jar
}

/** 序列化 Set-Cookie 值；maxAgeSec 为 0 表示立即失效 */
export const serializeCookie = (name, value, { maxAgeSec, secure } = {}) => {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (typeof maxAgeSec === 'number') parts.push(`Max-Age=${maxAgeSec}`)
  if (secure) parts.push('Secure')
  return parts.join('; ')
}
