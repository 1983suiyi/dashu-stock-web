/**
 * 全局会话状态：登录 / 注册 / 找回 / 退出，并维护当前用户。
 * 挂载时调用 /api/auth/me 校验 Cookie 会话，实现「刷新保持登录」。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { apiGet, apiSend } from './api'
import { SessionContext } from './session'
import type { CodePurpose, SessionUser, SessionValue } from './session'
import { syncOnLogin } from './sync'

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const result = await apiGet<{ user: SessionUser }>('/api/auth/me')
    setUser(result.ok ? result.data.user : null)
  }, [])

  useEffect(() => {
    let active = true
    refresh().finally(() => {
      if (active) setLoading(false)
    })
    return () => {
      active = false
    }
  }, [refresh])

  // 登录态建立后触发数据同步：本地旧数据迁移 + 云端拉取覆盖本地
  useEffect(() => {
    if (user) {
      syncOnLogin(user.id).catch(() => {
        // 同步失败不阻断使用，本地缓存仍可用
      })
    }
  }, [user])

  const login = useCallback<SessionValue['login']>(async (email, password) => {
    const result = await apiSend<{ user: SessionUser }>('/api/auth/login', 'POST', {
      email,
      password,
    })
    if (!result.ok) return { ok: false, message: result.error.message }
    setUser(result.data.user)
    return { ok: true }
  }, [])

  const register = useCallback<SessionValue['register']>(
    async (email, code, password, invite) => {
      const result = await apiSend<{ user: SessionUser }>(
        '/api/auth/register',
        'POST',
        { email, code, password, invite },
      )
      if (!result.ok) return { ok: false, message: result.error.message }
      setUser(result.data.user)
      return { ok: true }
    },
    [],
  )

  const sendCode = useCallback<SessionValue['sendCode']>(
    async (email, purpose: CodePurpose) => {
      const result = await apiSend<{ sent: boolean }>(
        '/api/auth/send-code',
        'POST',
        { email, purpose },
      )
      if (!result.ok) return { ok: false, message: result.error.message }
      return { ok: true }
    },
    [],
  )

  const resetPassword = useCallback<SessionValue['resetPassword']>(
    async (email, code, newPassword) => {
      const result = await apiSend<{ reset: boolean }>(
        '/api/auth/reset-password',
        'POST',
        { email, code, newPassword },
      )
      if (!result.ok) return { ok: false, message: result.error.message }
      return { ok: true }
    },
    [],
  )

  const logout = useCallback(async () => {
    await apiSend<{ loggedOut: boolean }>('/api/auth/logout', 'POST')
    setUser(null)
  }, [])

  const value = useMemo<SessionValue>(
    () => ({ user, loading, refresh, login, register, sendCode, resetPassword, logout }),
    [user, loading, refresh, login, register, sendCode, resetPassword, logout],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
