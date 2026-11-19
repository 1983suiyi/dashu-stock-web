/**
 * 用户数据云端同步层。
 *
 * 语义：
 * - 登录后：以服务端为准拉取并覆盖本地（云端是多设备共享的真相源）。
 *   若本地存在尚未迁移的旧数据，会先询问用户是否导入到账号。
 * - 日常写入：先写本地缓存（离线可用），再异步 PUT 到云端。
 * - 冲突：最后写入胜出（updated_at 较大者），本期不做复杂合并。
 */
import { apiGet, apiSend } from './api'

/** localStorage key → user_data.kind */
const KEY_TO_KIND: Record<string, string> = {
  'dashu-user-holdings': 'holdings',
  'dashu-cash-balance': 'cash',
  'dashu-total-assets': 'totalAssets',
  'dashu-capital-events': 'capitalEvents',
  'dashu-workspace-archives': 'archives',
}

const ALL_KINDS = Object.values(KEY_TO_KIND)

const migratedFlag = (userId: number) => `dashu-migrated:${userId}`

/** 读取本地某类数据的原始字符串 */
export const readLocalRaw = (kind: string): string | null => {
  const entry = Object.entries(KEY_TO_KIND).find(([, k]) => k === kind)
  if (!entry) return null
  try {
    return localStorage.getItem(entry[0])
  } catch {
    return null
  }
}

/** 写入本地某类数据（接受任意值，自动 JSON 序列化） */
export const writeLocal = (kind: string, value: unknown): void => {
  const entry = Object.entries(KEY_TO_KIND).find(([, k]) => k === kind)
  if (!entry) return
  try {
    if (value === null || value === undefined) {
      localStorage.removeItem(entry[0])
    } else {
      localStorage.setItem(entry[0], JSON.stringify(value))
    }
  } catch {
    // localStorage 超限或不可用时静默，云端仍是真相源
  }
}

/** 本地是否存在尚未迁移的用户私有数据 */
const hasLocalUserData = (): boolean =>
  Object.keys(KEY_TO_KIND).some((key) => {
    try {
      const raw = localStorage.getItem(key)
      return raw !== null && raw !== '' && raw !== '[]' && raw !== 'null'
    } catch {
      return false
    }
  })

/** 从云端拉取某类数据 */
const pullKind = async (kind: string): Promise<{ payload: unknown; updatedAt: number } | null> => {
  const result = await apiGet<{ kind: string; payload: unknown; updatedAt: number }>(
    `/api/user-data/${kind}`,
  )
  if (!result.ok) return null
  return result.data.payload == null ? null : result.data
}

/** 推送某类数据到云端 */
const pushKind = async (kind: string, value: unknown): Promise<boolean> => {
  const result = await apiSend<{ updatedAt: number }>(`/api/user-data/${kind}`, 'PUT', {
    payload: value,
  })
  return result.ok
}

/**
 * 登录后同步入口：
 * 1. 若本地有未迁移数据，询问是否导入账号；
 * 2. 拉取云端所有种类覆盖本地；
 * 3. 若本次拉取覆盖了本地（非刷新恢复场景），刷新页面让 App 重新读取。
 */
export const syncOnLogin = async (userId: number): Promise<void> => {
  // sessionStorage 标记：本次会话已完成一次同步刷新，避免无限重载
  const SYNCED_FLAG = 'dashu-synced'
  const alreadyReloaded = sessionStorage.getItem(SYNCED_FLAG) === '1'

  const flag = migratedFlag(userId)
  const alreadyMigrated = localStorage.getItem(flag) === '1'

  if (!alreadyMigrated && hasLocalUserData()) {
    const confirmed = window.confirm(
      '检测到浏览器本地已有持仓/资金数据，是否导入到当前账号？（仅执行一次，导入后可在多设备同步）',
    )
    if (confirmed) {
      for (const kind of ALL_KINDS) {
        const raw = readLocalRaw(kind)
        if (raw != null) {
          try {
            await pushKind(kind, JSON.parse(raw))
          } catch {
            // 单类失败不影响其他类
          }
        }
      }
    }
    localStorage.setItem(flag, '1')
  } else if (alreadyMigrated) {
    localStorage.setItem(flag, '1')
  }

  // 以云端为准拉取覆盖本地
  let pulledAny = false
  for (const kind of ALL_KINDS) {
    const cloud = await pullKind(kind)
    if (cloud) {
      writeLocal(kind, cloud.payload)
      pulledAny = true
    }
  }

  // 仅在首次同步（非刷新恢复）时重载，让 App 从已被云端覆盖的 localStorage 重新读取
  if (pulledAny && !alreadyReloaded) {
    sessionStorage.setItem(SYNCED_FLAG, '1')
    window.location.reload()
  }
}

/**
 * 保存用户数据：写本地 + 异步同步云端。
 * 供 App.tsx 在数据变更时调用。
 */
export const syncSave = (kind: string, value: unknown): void => {
  writeLocal(kind, value)
  // 异步推送，失败不影响本地体验
  pushKind(kind, value).catch(() => {})
}
