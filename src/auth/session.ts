/**
 * 会话类型、React Context 与 useSession 钩子。
 * 组件（SessionProvider）单独放在 SessionContext.tsx，避免 react-refresh 告警。
 */
import { createContext, useContext } from 'react'

export type SessionUser = {
  id: number
  email: string
  role: 'user' | 'admin'
  status: string
  createdAt: number
  lastLoginAt: number | null
}

export type CodePurpose = 'register' | 'login' | 'reset'

/** 简单的成功/失败结果（失败只带可展示文案） */
export type ActionResult = { ok: true } | { ok: false; message: string }

export type SessionValue = {
  user: SessionUser | null
  loading: boolean
  refresh: () => Promise<void>
  login: (email: string, password: string) => Promise<ActionResult>
  register: (
    email: string,
    code: string,
    password: string,
    invite: string,
  ) => Promise<ActionResult>
  sendCode: (email: string, purpose: CodePurpose) => Promise<ActionResult>
  resetPassword: (
    email: string,
    code: string,
    newPassword: string,
  ) => Promise<ActionResult>
  logout: () => Promise<void>
}

export const SessionContext = createContext<SessionValue | null>(null)

export const useSession = () => {
  const value = useContext(SessionContext)
  if (!value) {
    throw new Error('useSession 必须在 SessionProvider 内使用')
  }
  return value
}
