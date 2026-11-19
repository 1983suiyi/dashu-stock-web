/**
 * 侧边栏底部的当前用户信息与退出按钮；管理员额外提供管理端入口。
 * P3 增加「删除账号与数据」入口（需密码二次确认）。
 *
 * 删除账号弹窗通过 Portal 渲染到 document.body，避免被侧边栏的
 * sticky 定位 / 溢出上下文遮挡，保证遮罩覆盖整个视口。
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useSession } from './session'

export function UserMenu() {
  const { user, logout, deleteAccount } = useSession()
  const [showDelete, setShowDelete] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!user) return null

  const isAdmin = user.role === 'admin'

  const handleDelete = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!password.trim()) {
      setError('请输入当前密码以确认')
      return
    }
    setBusy(true)
    setError(null)
    const result = await deleteAccount(password)
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setShowDelete(false)
    setPassword('')
    window.location.reload()
  }

  return (
    <div className="user-menu">
      <p className="user-menu-email">{user.email}</p>
      <div className="user-menu-actions">
        {isAdmin && (
          <a className="user-menu-link" href="/admin.html">
            管理端
          </a>
        )}
        <button type="button" className="button-secondary" onClick={() => void logout()}>
          退出登录
        </button>
        <button
          type="button"
          className="button-secondary"
          style={{ color: '#ff8a8a' }}
          onClick={() => {
            setError(null)
            setPassword('')
            setShowDelete(true)
          }}
        >
          删除账号
        </button>
      </div>

      {showDelete &&
        createPortal(
          <div
            className="admin-modal-overlay"
            onClick={() => !busy && setShowDelete(false)}
          >
            <form
              className="panel admin-modal"
              onClick={(e) => e.stopPropagation()}
              onSubmit={handleDelete}
            >
              <h3>删除账号与数据</h3>
              <p className="helper-text" style={{ color: '#ffb4b4' }}>
                此操作不可恢复。你的账号、持仓、资金、市场温度校正等所有数据将被永久删除。
                {isAdmin && '管理员账号不可自助删除，请联系其他管理员。'}
              </p>
              <label className="auth-field">
                <span>输入当前密码确认</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 8 位"
                  required
                  autoFocus
                  disabled={isAdmin || busy}
                />
              </label>
              {error && <p className="auth-error">{error}</p>}
              <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setShowDelete(false)}
                  disabled={busy}
                >
                  取消
                </button>
                <button type="submit" disabled={isAdmin || busy}>
                  {busy ? '处理中…' : '确认删除'}
                </button>
              </div>
            </form>
          </div>,
          document.body,
        )}
    </div>
  )
}
