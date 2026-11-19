/**
 * 账号相关接口统一入口：/api/auth/* 与 /api/admin/*。
 * 生产（server/index.mjs）与开发（vite.config.ts 中间件）共用同一份实现，避免两端漂移。
 */
import { handleAuthRoute, getSessionUser } from './auth.mjs'
import { handleAdminRoute } from './admin.mjs'

/**
 * 尝试处理账号类接口。
 * @returns {Promise<boolean>} 命中并已响应返回 true；未命中返回 false，交由后续路由处理。
 */
export const handleAccountApi = async (req, res, url) => {
  if (await handleAuthRoute(req, res, url)) return true

  if (url.pathname.startsWith('/api/admin/')) {
    const session = getSessionUser(req)
    return handleAdminRoute(req, res, url, session)
  }

  return false
}
