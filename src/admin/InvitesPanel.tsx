/**
 * 邀请码管理（P1）：生成、失效/恢复、复制。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiSend } from '../auth/api'

type Invite = {
  code: string
  createdBy: number | null
  maxUses: number
  usedCount: number
  expiresAt: number | null
  status: string
  createdAt: number
}

const formatTime = (value: number | null) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '不过期'

export function InvitesPanel() {
  const [invites, setInvites] = useState<Invite[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [count, setCount] = useState('1')
  const [maxUses, setMaxUses] = useState('1')
  const [expiresInDays, setExpiresInDays] = useState('30')

  const load = useCallback(async () => {
    setLoading(true)
    const result = await apiGet<{ invites: Invite[] }>('/api/admin/invites')
    setLoading(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setError(null)
    setInvites(result.data.invites)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    const result = await apiSend<{ codes: string[] }>('/api/admin/invites', 'POST', {
      count: Number(count),
      maxUses: Number(maxUses),
      expiresInDays: expiresInDays === '' ? null : Number(expiresInDays),
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setNotice(`已生成：${result.data.codes.join('、')}`)
    await load()
  }

  const toggleStatus = async (invite: Invite) => {
    const nextStatus = invite.status === 'active' ? 'revoked' : 'active'
    setError(null)
    const result = await apiSend<{ updated: boolean }>(
      `/api/admin/invites/${encodeURIComponent(invite.code)}`,
      'PATCH',
      { status: nextStatus },
    )
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    await load()
  }

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setNotice(`已复制邀请码：${code}`)
    } catch {
      setError('复制失败，请手动选择文本')
    }
  }

  return (
    <section className="panel">
      <div className="section-title">
        <h2>邀请码管理</h2>
        <p>内测期注册需要邀请码；管理员邮箱注册时自动成为管理员，无需邀请码。</p>
      </div>

      <form className="admin-form" onSubmit={handleCreate}>
        <label className="auth-field">
          <span>生成数量</span>
          <input
            type="number"
            min="1"
            max="20"
            value={count}
            onChange={(event) => setCount(event.target.value)}
          />
        </label>
        <label className="auth-field">
          <span>每个可用次数</span>
          <input
            type="number"
            min="1"
            max="1000"
            value={maxUses}
            onChange={(event) => setMaxUses(event.target.value)}
          />
        </label>
        <label className="auth-field">
          <span>有效期（天，留空不过期）</span>
          <input
            type="number"
            min="1"
            max="3650"
            value={expiresInDays}
            onChange={(event) => setExpiresInDays(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? '生成中…' : '生成邀请码'}
        </button>
      </form>

      {error && <p className="auth-error">{error}</p>}
      {notice && <p className="auth-success">{notice}</p>}

      {loading ? (
        <p className="helper-text">加载中…</p>
      ) : invites.length === 0 ? (
        <p className="helper-text">暂无邀请码。</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>邀请码</th>
                <th>使用次数</th>
                <th>状态</th>
                <th>有效期</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => (
                <tr key={invite.code}>
                  <td>
                    <code>{invite.code}</code>
                  </td>
                  <td>
                    {invite.usedCount} / {invite.maxUses}
                  </td>
                  <td>
                    <span
                      className={
                        invite.status === 'active'
                          ? 'status status-active'
                          : 'status status-muted'
                      }
                    >
                      {invite.status === 'active' ? '可用' : '已失效'}
                    </span>
                  </td>
                  <td>{formatTime(invite.expiresAt)}</td>
                  <td>{formatTime(invite.createdAt)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => void copyCode(invite.code)}
                      >
                        复制
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => void toggleStatus(invite)}
                      >
                        {invite.status === 'active' ? '失效' : '恢复'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
