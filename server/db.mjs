/**
 * SQLite 连接与建表迁移。
 * 使用 Node 内置 node:sqlite（零第三方依赖），需 Node >= 22.13（推荐 >= 24.15）。
 *
 * 表结构与 docs/账号与多用户数据方案.md 第 3.2 节保持一致。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_DB_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'dashu.db',
)

const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : DEFAULT_DB_PATH

mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new DatabaseSync(DB_PATH)

// WAL 提升并发读性能；外键约束默认关闭，需显式开启
db.exec('PRAGMA journal_mode = WAL;')
db.exec('PRAGMA foreign_keys = ON;')

db.exec(`
  -- 用户
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    phone         TEXT    UNIQUE,
    password_hash TEXT    NOT NULL,
    password_salt TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'active',
    role          TEXT    NOT NULL DEFAULT 'user',
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );

  -- 验证码（邮箱/短信统一）
  CREATE TABLE IF NOT EXISTS verification_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target      TEXT    NOT NULL,
    channel     TEXT    NOT NULL,
    purpose     TEXT    NOT NULL,
    code_hash   TEXT    NOT NULL,
    expires_at  INTEGER NOT NULL,
    consumed_at INTEGER,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_codes_target ON verification_codes(target, purpose, created_at);

  -- 会话
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash   TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER,
    ip           TEXT,
    user_agent   TEXT
  );

  -- 用户业务数据（通用 KV）
  CREATE TABLE IF NOT EXISTS user_data (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,
    payload    TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind)
  );

  -- 市场温度（公共）
  CREATE TABLE IF NOT EXISTS market_temperature (
    date              TEXT    PRIMARY KEY,
    index_level       REAL,
    exposure_pct      REAL,
    pb_median         REAL,
    pe_median         REAL,
    below_net_count   INTEGER,
    three_low_count   INTEGER,
    risk_passed_count INTEGER,
    updated_at        INTEGER NOT NULL
  );

  -- 限流
  CREATE TABLE IF NOT EXISTS rate_limits (
    key          TEXT    NOT NULL,
    window_start INTEGER NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, window_start)
  );

  -- 邀请码
  CREATE TABLE IF NOT EXISTS invites (
    code       TEXT    PRIMARY KEY,
    created_by INTEGER REFERENCES users(id),
    max_uses   INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    status     TEXT    NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
  );

  -- 审计日志
  CREATE TABLE IF NOT EXISTS audit_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER REFERENCES users(id),
    action        TEXT    NOT NULL,
    target        TEXT,
    detail        TEXT,
    ip            TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
`)

export const now = () => Date.now()

export const DB_FILE = DB_PATH

/** 进程启动时清理过期数据，避免表无限增长 */
export const cleanupExpired = () => {
  const ts = now()
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(ts)
  db.prepare(
    'DELETE FROM verification_codes WHERE created_at < ?',
  ).run(ts - 24 * 60 * 60 * 1000)
  db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(
    ts - 2 * 24 * 60 * 60 * 1000,
  )
}

cleanupExpired()
