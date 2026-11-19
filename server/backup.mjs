/**
 * SQLite 数据库备份脚本（P3 安全加固）。
 * 使用 VACUUM INTO 生成一致快照，WAL 模式下也安全。
 *
 * 用法：
 *   node server/backup.mjs                  # 备份到 server/backups/dashu-YYYYMMDD-HHmmss.db
 *   BACKUP_DIR=/tmp/dashu-backups node server/backup.mjs
 *   BACKUP_FILE=custom.db node server/backup.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = fileURLToPath(new URL('.', import.meta.url))
const DB_PATH = process.env.DB_PATH
  ? resolve(process.env.DB_PATH)
  : resolve(SERVER_DIR, 'dashu.db')

const ts = new Date()
  .toISOString()
  .replace(/[-:T]/g, '')
  .slice(0, 14)

const defaultBackupDir = resolve(SERVER_DIR, 'backups')
const backupDir = process.env.BACKUP_DIR ? resolve(process.env.BACKUP_DIR) : defaultBackupDir
mkdirSync(backupDir, { recursive: true })

const backupFile = process.env.BACKUP_FILE
  ? resolve(backupDir, process.env.BACKUP_FILE)
  : resolve(backupDir, `dashu-${ts}.db`)

console.log(`[backup] 源库: ${DB_PATH}`)
console.log(`[backup] 目标: ${backupFile}`)

// 以只读方式打开，避免备份过程中影响主库写入
const db = new DatabaseSync(DB_PATH, { readOnly: true })
try {
  db.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`)
  console.log(`[backup] 完成 ✓`)
} finally {
  db.close()
}
