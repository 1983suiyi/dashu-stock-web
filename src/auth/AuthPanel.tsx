/**
 * 登录 / 注册 / 找回密码面板。
 * 注册需邀请码（内测白名单）；发送验证码有 60 秒重发倒计时。
 */
import { useEffect, useRef, useState } from 'react'
import { useSession } from './session'
import type { CodePurpose } from './session'

type Mode = 'login' | 'register' | 'reset'

const MODE_LABEL: Record<Mode, string> = {
  login: '登录',
  register: '注册',
  reset: '重置密码',
}

const PURPOSE_BY_MODE: Record<Mode, CodePurpose> = {
  login: 'login',
  register: 'register',
  reset: 'reset',
}

const RESEND_SECONDS = 60

export function AuthPanel({
  title = '大数选股',
  hint,
  initialMode = 'login',
}: {
  title?: string
  hint?: string
  initialMode?: Mode
}) {
  const { login, register, sendCode, resetPassword } = useSession()
  const [mode, setMode] = useState<Mode>(initialMode)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [code, setCode] = useState('')
  const [invite, setInvite] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (countdown <= 0) return
    timerRef.current = window.setTimeout(() => setCountdown((n) => n - 1), 1000)
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [countdown])

  const switchMode = (next: Mode) => {
    setMode(next)
    setMessage(null)
    setError(null)
    setCode('')
  }

  const handleSendCode = async () => {
    setError(null)
    setMessage(null)
    if (!email.trim()) {
      setError('请先填写邮箱')
      return
    }
    setBusy(true)
    const result = await sendCode(email.trim(), PURPOSE_BY_MODE[mode])
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setMessage('验证码已发送，请查收邮箱（内测期验证码会打印在服务端日志）。')
    setCountdown(RESEND_SECONDS)
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setMessage(null)
    setBusy(true)
    try {
      if (mode === 'login') {
        const result = await login(email.trim(), password)
        if (!result.ok) setError(result.message)
        return
      }
      if (mode === 'register') {
        const result = await register(email.trim(), code.trim(), password, invite.trim())
        if (!result.ok) setError(result.message)
        return
      }
      const result = await resetPassword(email.trim(), code.trim(), newPassword)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setMessage('密码已重置，请使用新密码登录。')
      switchMode('login')
    } finally {
      setBusy(false)
    }
  }

  const needsCode = mode === 'register' || mode === 'reset'

  return (
    <div className="auth-screen">
      <form className="panel auth-card" onSubmit={handleSubmit}>
        <div className="auth-head">
          <span className="eyebrow">账号</span>
          <h1>{title}</h1>
          <p className="helper-text">
            {hint ?? '登录后可管理个人持仓与资金数据（数据将在后续版本上云）。'}
          </p>
        </div>

        <div className="auth-tabs">
          {(['login', 'register', 'reset'] as Mode[]).map((item) => (
            <button
              key={item}
              type="button"
              className={mode === item ? 'auth-tab active' : 'auth-tab'}
              onClick={() => switchMode(item)}
            >
              {MODE_LABEL[item]}
            </button>
          ))}
        </div>

        <label className="auth-field">
          <span>邮箱</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            required
          />
        </label>

        {needsCode && (
          <label className="auth-field">
            <span>邮箱验证码</span>
            <div className="auth-inline">
              <input
                inputMode="numeric"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="6 位数字"
                required
              />
              <button
                type="button"
                className="button-secondary"
                onClick={handleSendCode}
                disabled={busy || countdown > 0}
              >
                {countdown > 0 ? `${countdown}s 后重发` : '发送验证码'}
              </button>
            </div>
          </label>
        )}

        {mode === 'register' && (
          <label className="auth-field">
            <span>邀请码</span>
            <input
              value={invite}
              onChange={(event) => setInvite(event.target.value)}
              placeholder="内测邀请码（管理员邮箱可留空）"
            />
          </label>
        )}

        {mode === 'login' && (
          <label className="auth-field">
            <span>密码</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 8 位"
              required
            />
          </label>
        )}

        {mode === 'register' && (
          <label className="auth-field">
            <span>设置密码</span>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 8 位"
              required
            />
          </label>
        )}

        {mode === 'reset' && (
          <label className="auth-field">
            <span>新密码</span>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="至少 8 位"
              required
            />
          </label>
        )}

        {error && <p className="auth-error">{error}</p>}
        {message && <p className="auth-success">{message}</p>}

        <button type="submit" disabled={busy}>
          {busy ? '处理中…' : MODE_LABEL[mode]}
        </button>

        {mode === 'register' && (
          <p className="helper-text" style={{ textAlign: 'center', fontSize: '0.82rem', marginTop: '0.75rem' }}>
            注册即表示你已阅读并同意
            <a href="/terms.html" target="_blank" rel="noopener noreferrer">《用户协议》</a>
            与
            <a href="/privacy.html" target="_blank" rel="noopener noreferrer">《隐私政策》</a>
          </p>
        )}
      </form>
    </div>
  )
}
