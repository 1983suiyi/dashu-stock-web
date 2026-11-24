/**
 * 生产环境服务器：对外提供 K 线代理接口 + 托管前端静态产物。
 * 零第三方依赖，直接 `node server/index.mjs` 即可运行。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { queryIndexSnapshot, queryKline } from './kline.mjs'
import { getPbFloors } from './pb-floor.mjs'
import { getIndustryCycle } from './industry-cycle.mjs'
import { getStockValuation } from './stock-valuation.mjs'
import { queryIndexHistory } from './index-history.mjs'
import { handleAccountApi } from './api.mjs'
import {
  handleDailyMarketRoute,
  startDailyMarketScheduler,
} from './daily-market.mjs'

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '0.0.0.0'
const DIST_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.csv': 'text/csv; charset=utf-8',
}

const sendJson = (res, status, payload) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

const serveStatic = async (res, pathname) => {
  // 多入口（MPA）：/admin 系列走管理端，其余走用户端
  const isAdminPath =
    pathname === '/admin' ||
    pathname === '/admin.html' ||
    pathname.startsWith('/admin/')
  const relative = isAdminPath
    ? '/admin.html'
    : pathname === '/'
      ? '/index.html'
      : pathname
  const target = join(DIST_DIR, relative)

  // 阻断路径穿越
  if (!target.startsWith(DIST_DIR)) {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }

  const fallbackPage = isAdminPath ? '/admin.html' : '/index.html'
  const candidates = [target, join(DIST_DIR, fallbackPage)]
  for (const candidate of candidates) {
    try {
      const body = await readFile(candidate)
      const isFallback = candidate.endsWith(fallbackPage) && candidate !== target
      res.writeHead(200, {
        'Content-Type':
          MIME_TYPES[extname(candidate)] ?? 'application/octet-stream',
        'Cache-Control': isFallback ? 'no-store' : 'public, max-age=3600',
      })
      res.end(body)
      return
    } catch {
      // 继续尝试下一个候选
    }
  }

  sendJson(res, 404, { error: 'not found' })
}

const server = createServer(async (req, res) => {
  const start = Date.now()
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  res.on('finish', () => {
    const ms = Date.now() - start
    const tag = res.statusCode >= 500 ? 'ERR' : res.statusCode >= 400 ? 'WARN' : 'OK'
    console.log(`[${tag}] ${req.method} ${url.pathname} -> ${res.statusCode} (${ms}ms)`)
  })

  // 账号相关接口（/api/auth/* 与 /api/admin/*）
  if (await handleAccountApi(req, res, url)) return

  if (await handleDailyMarketRoute(req, res, url)) return

  if (url.pathname === '/api/kline') {
    try {
      const payload = await queryKline(
        url.searchParams.get('codes'),
        url.searchParams.get('days'),
      )
      sendJson(res, 200, payload)
    } catch (error) {
      sendJson(res, 500, {
        error: `K 线代理异常：${error instanceof Error ? error.message : String(error)}`,
      })
    }
    return
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, dist: DIST_DIR })
    return
  }

  if (url.pathname === '/api/pb-floor') {
    try {
      const result = await getPbFloors()
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, {
        error: `PB 底计算异常：${error instanceof Error ? error.message : String(error)}`,
      })
    }
    return
  }

  if (url.pathname === '/api/industry-cycle') {
    try {
      const result = await getIndustryCycle()
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, {
        error: `行业周期计算异常：${error instanceof Error ? error.message : String(error)}`,
      })
    }
    return
  }

  if (url.pathname === '/api/stock-valuation') {
    try {
      const result = await getStockValuation(url.searchParams.get('code') ?? '')
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, {
        error: `个股估值历史异常：${error instanceof Error ? error.message : String(error)}`,
      })
    }
    return
  }

  if (url.pathname === '/api/index-history') {
    try {
      const result = await queryIndexHistory(
        url.searchParams.get('symbol') ?? 'sh000001',
        url.searchParams.get('years'),
      )
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, {
        error: `指数历史异常：${error instanceof Error ? error.message : String(error)}`,
      })
    }
    return
  }

  if (url.pathname === '/api/index-snapshot') {
    try {
      const result = await queryIndexSnapshot(
        url.searchParams.get('symbol') ?? 'sh000001',
      )
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, {
        error: `指数快照异常：${error instanceof Error ? error.message : String(error)}`,
      })
    }
    return
  }

  await serveStatic(res, url.pathname)
})

startDailyMarketScheduler()

server.listen(PORT, HOST, () => {
  console.log(`大数选股服务已启动: http://${HOST}:${PORT}`)
  console.log(`静态目录: ${DIST_DIR}`)
  console.log(`用户端: http://${HOST}:${PORT}/  管理端: http://${HOST}:${PORT}/admin`)
})
