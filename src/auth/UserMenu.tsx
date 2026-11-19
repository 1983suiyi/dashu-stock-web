/**
 * 侧边栏底部的当前用户信息与退出按钮；管理员额外提供管理端入口。
 */
import { useSession } from './session'

export function UserMenu() {
  const { user, logout } = useSession()

  if (!user) return null

  return (
    <div className="user-menu">
      <p className="user-menu-email">{user.email}</p>
      <div className="user-menu-actions">
        {user.role === 'admin' && (
          <a className="user-menu-link" href="/admin.html">
            管理端
          </a>
        )}
        <button type="button" className="button-secondary" onClick={() => void logout()}>
          退出登录
        </button>
      </div>
    </div>
  )
}
