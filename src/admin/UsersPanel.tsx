/**
 * 用户管理（P2）：列表、禁用/启用、删除、重置密码。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiSend } from '../auth/api'

type AdminUser = {
  id: number
  email: string
  status: string
  role: string
  realtimeEnabled: boolean
  createdAt: number
  lastLoginAt: number | null
}

const formatTime = (value: number | null) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'

export function UsersPanel() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(50)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [emailFilter, setEmailFilter] = useState('')
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null)
  const [resetPassword, setResetPassword] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    })
    if (statusFilter) params.set('status', statusFilter)
    if (emailFilter.trim()) params.set('email', emailFilter.trim())
    const result = await apiGet<{ users: AdminUser[]; total: number }>(
      `/api/admin/users?${params.toString()}`,
    )
    setLoading(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setError(null)
    setUsers(result.data.users)
    setTotal(result.data.total)
  }, [page, pageSize, statusFilter, emailFilter])

  useEffect(() => {
    void load()
  }, [load])

  const toggleStatus = async (user: AdminUser) => {
    const next = user.status === 'active' ? 'disabled' : 'active'
    setError(null)
    const result = await apiSend<{ updated: boolean }>(
      `/api/admin/users/${user.id}`,
      'PATCH',
      { status: next },
    )
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    await load()
  }

  const toggleRealtime = async (user: AdminUser) => {
    setError(null)
    const result = await apiSend<{ updated: boolean }>(
      `/api/admin/users/${user.id}`,
      'PATCH',
      { realtimeEnabled: !user.realtimeEnabled },
    )
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    await load()
  }

  const removeUser = async (user: AdminUser) => {
    if (!window.confirm(`确认删除用户 ${user.email}？该操作不可恢复，其数据将被级联清除。`)) return
    setError(null)
    const result = await apiSend<{ deleted: boolean }>(`/api/admin/users/${user.id}`, 'DELETE')
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setNotice(`已删除 ${user.email}`)
    await load()
  }

  const handleResetPassword = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!resetTarget) return
    setError(null)
    const result = await apiSend<{ reset: boolean }>(
      `/api/admin/users/${resetTarget.id}/reset-password`,
      'POST',
      { newPassword: resetPassword },
    )
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setNotice(`已重置 ${resetTarget.email} 的密码`)
    setResetTarget(null)
    setResetPassword('')
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <section className="panel">
      <div className="section-title">
        <h2>用户管理</h2>
        <p>查看注册用户、禁用/启用账号、开通实时行情、重置密码、删除账号。</p>
      </div>

      <div className="admin-form" style={{ marginBottom: 12 }}>
        <label className="auth-field">
          <span>邮箱筛选</span>
          <input
            value={emailFilter}
            onChange={(e) => setEmailFilter(e.target.value)}
            placeholder="输入邮箱关键词"
          />
        </label>
        <label className="auth-field">
          <span>状态</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">全部</option>
            <option value="active">正常</option>
            <option value="disabled">已禁用</option>
          </select>
        </label>
        <button type="button" className="button-secondary" onClick={() => { setPage(1); void load() }}>
          查询
        </button>
      </div>

      {error && <p className="auth-error">{error}</p>}
      {notice && <p className="auth-success">{notice}</p>}

      {loading ? (
        <p className="helper-text">加载中…</p>
      ) : users.length === 0 ? (
        <p className="helper-text">暂无用户。</p>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>邮箱</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>实时行情</th>
                  <th>注册时间</th>
                  <th>最后登录</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>{user.id}</td>
                    <td>{user.email}</td>
                    <td>{user.role === 'admin' ? '管理员' : '用户'}</td>
                    <td>
                      <span
                        className={
                          user.status === 'active' ? 'status status-active' : 'status status-muted'
                        }
                      >
                        {user.status === 'active' ? '正常' : '已禁用'}
                      </span>
                    </td>
                    <td>
                      <span
                        className={
                          user.realtimeEnabled ? 'status status-active' : 'status status-muted'
                        }
                      >
                        {user.realtimeEnabled ? '已开通' : '未开通'}
                      </span>
                    </td>
                    <td>{formatTime(user.createdAt)}</td>
                    <td>{formatTime(user.lastLoginAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => setResetTarget(user)}
                        >
                          重置密码
                        </button>
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => void toggleStatus(user)}
                        >
                          {user.status === 'active' ? '禁用' : '启用'}
                        </button>
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => void toggleRealtime(user)}
                        >
                          {user.realtimeEnabled ? '关闭实时行情' : '开通实时行情'}
                        </button>
                        <button
                          type="button"
                          className="button-secondary"
                          style={{ color: '#ff6b6b' }}
                          onClick={() => void removeUser(user)}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="row-actions" style={{ marginTop: 12, gap: 8 }}>
              <button
                type="button"
                className="button-secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </button>
              <span className="helper-text">
                第 {page} / {totalPages} 页，共 {total} 条
              </span>
              <button
                type="button"
                className="button-secondary"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}

      {resetTarget && (
        <div className="admin-modal-overlay" onClick={() => setResetTarget(null)}>
          <form className="panel admin-modal" onClick={(e) => e.stopPropagation()} onSubmit={handleResetPassword}>
            <h3>重置密码</h3>
            <p className="helper-text">为 {resetTarget.email} 设置新密码（至少 8 位）。重置后该用户所有会话将失效。</p>
            <label className="auth-field">
              <span>新密码</span>
              <input
                type="text"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                placeholder="至少 8 位"
                minLength={8}
                required
                autoFocus
              />
            </label>
            <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="button-secondary" onClick={() => setResetTarget(null)}>
                取消
              </button>
              <button type="submit">确认重置</button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}
