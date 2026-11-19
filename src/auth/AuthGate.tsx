/**
 * 未登录时拦截：校验会话中显示加载提示，未登录显示 AuthPanel，已登录放行。
 */
import type { ReactNode } from 'react'
import { useSession } from './session'
import { AuthPanel } from './AuthPanel'

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading } = useSession()

  if (loading) {
    return (
      <div className="auth-screen">
        <p className="helper-text">正在校验登录状态…</p>
      </div>
    )
  }

  if (!user) return <AuthPanel />

  return <>{children}</>
}
