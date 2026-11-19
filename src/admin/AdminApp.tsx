/**
 * 管理端外壳：会话校验 + 管理员权限判定 + 多面板切换。
 * 面板：邀请码管理（P1）、用户管理（P2）、市场温度校正（P2）、审计日志（P3）。
 */
import { useState } from 'react'
import { useSession } from '../auth/session'
import { AuthPanel } from '../auth/AuthPanel'
import { InvitesPanel } from './InvitesPanel'
import { UsersPanel } from './UsersPanel'
import { MarketTemperaturePanel } from './MarketTemperaturePanel'
import { AuditLogsPanel } from './AuditLogsPanel'

type Tab = 'invites' | 'users' | 'temperature' | 'audit'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'invites', label: '邀请码' },
  { key: 'users', label: '用户管理' },
  { key: 'temperature', label: '市场温度' },
  { key: 'audit', label: '审计日志' },
]

export function AdminApp() {
  const { user, loading, logout } = useSession()
  const [tab, setTab] = useState<Tab>('invites')

  if (loading) {
    return (
      <div className="auth-screen">
        <p className="helper-text">正在校验登录状态…</p>
      </div>
    )
  }

  if (!user) {
    return (
      <AuthPanel
        title="管理端登录"
        hint="请使用管理员账号登录，普通账号无法访问管理端。"
      />
    )
  }

  if (user.role !== 'admin') {
    return (
      <div className="auth-screen">
        <div className="panel auth-card">
          <h1>无访问权限</h1>
          <p className="helper-text">当前账号不是管理员，无法进入管理端。</p>
          <div className="user-menu-actions">
            <a className="user-menu-link" href="/">
              返回用户端
            </a>
            <button type="button" className="button-secondary" onClick={() => void logout()}>
              退出登录
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div>
          <strong>大数选股 · 管理端</strong>
          <p className="helper-text">{user.email}</p>
        </div>
        <div className="user-menu-actions">
          <a className="user-menu-link" href="/">
            用户端
          </a>
          <button type="button" className="button-secondary" onClick={() => void logout()}>
            退出登录
          </button>
        </div>
      </header>

      <nav className="admin-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={tab === t.key ? 'admin-tab active' : 'admin-tab'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="admin-main">
        {tab === 'invites' && <InvitesPanel />}
        {tab === 'users' && <UsersPanel />}
        {tab === 'temperature' && <MarketTemperaturePanel />}
        {tab === 'audit' && <AuditLogsPanel />}
      </main>
    </div>
  )
}
