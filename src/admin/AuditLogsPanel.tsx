/**
 * 审计日志（P3）：分页展示所有登录与管理操作记录。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGet } from '../auth/api'

type AuditLog = {
  id: number
  actorUserId: number | null
  action: string
  target: string | null
  detail: unknown
  ip: string | null
  createdAt: number
}

const ACTION_LABELS: Record<string, string> = {
  register: '注册',
  login: '登录',
  login_failed: '登录失败',
  login_blocked: '登录被拒(已禁用)',
  reset_password: '重置密码',
  account_delete: '注销账号',
  invite_create: '生成邀请码',
  invite_update: '修改邀请码',
  user_status_update: '修改用户状态',
  user_delete: '删除用户',
  user_reset_password: '管理员重置密码',
  market_temperature_correct: '校正市场温度',
}

const formatTime = (value: number) =>
  new Date(value).toLocaleString('zh-CN', { hour12: false })

const formatDetail = (detail: unknown) => {
  if (detail == null) return ''
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

export function AuditLogsPanel() {
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(50)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionFilter, setActionFilter] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    })
    if (actionFilter) params.set('action', actionFilter)
    const result = await apiGet<{ logs: AuditLog[]; total: number }>(
      `/api/admin/audit-logs?${params.toString()}`,
    )
    setLoading(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setError(null)
    setLogs(result.data.logs)
    setTotal(result.data.total)
  }, [page, pageSize, actionFilter])

  useEffect(() => {
    void load()
  }, [load])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const allActions = Object.keys(ACTION_LABELS)

  return (
    <section className="panel">
      <div className="section-title">
        <h2>审计日志</h2>
        <p>记录所有登录事件与管理操作，便于追溯。</p>
      </div>

      <div className="admin-form" style={{ marginBottom: 12 }}>
        <label className="auth-field">
          <span>操作类型</span>
          <select value={actionFilter} onChange={(e) => { setActionFilter(e.target.value); setPage(1) }}>
            <option value="">全部</option>
            {allActions.map((a) => (
              <option key={a} value={a}>{ACTION_LABELS[a] ?? a}</option>
            ))}
          </select>
        </label>
        <button type="button" className="button-secondary" onClick={() => { setPage(1); void load() }}>
          查询
        </button>
      </div>

      {error && <p className="auth-error">{error}</p>}

      {loading ? (
        <p className="helper-text">加载中…</p>
      ) : logs.length === 0 ? (
        <p className="helper-text">暂无日志。</p>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作者 ID</th>
                  <th>操作</th>
                  <th>目标</th>
                  <th>详情</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatTime(log.createdAt)}</td>
                    <td>{log.actorUserId ?? '—'}</td>
                    <td>
                      <span className="status status-active" style={{ whiteSpace: 'nowrap' }}>
                        {ACTION_LABELS[log.action] ?? log.action}
                      </span>
                    </td>
                    <td>{log.target ?? '—'}</td>
                    <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {formatDetail(log.detail) || '—'}
                    </td>
                    <td>{log.ip ?? '—'}</td>
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
    </section>
  )
}
