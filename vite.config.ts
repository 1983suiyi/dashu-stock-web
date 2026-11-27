import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { queryIndexSnapshot, queryKline } from './server/kline.mjs'
import { getIndustryCycle } from './server/industry-cycle.mjs'
import { getStockValuation } from './server/stock-valuation.mjs'
import { queryIndexHistory } from './server/index-history.mjs'
import { queryCapitalFlow } from './server/capital-flow.mjs'

/**
 * 开发环境复用生产环境的接口逻辑，避免维护两份实现。
 * 生产环境由 server/index.mjs 提供同一接口。
 */
const klineApiPlugin = (): Plugin => ({
  name: 'dashu-kline-api',
  configureServer(server) {
    let stopDailyMarketScheduler: (() => void) | undefined
    server.middlewares.use((req, res, next) => {
      if (!req.url) {
        next()
        return
      }

      const sendJson = (status: number, payload: unknown) => {
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(payload))
      }

      const url = new URL(req.url, 'http://localhost')

      if (url.pathname === '/api/market-data') {
        import(/* @vite-ignore */ dailyMarketUrl())
          .then(({ handleDailyMarketRoute }) =>
            handleDailyMarketRoute(req as never, res as never, url),
          )
          .catch((error: unknown) => {
            sendJson(500, {
              error: error instanceof Error ? error.message : String(error),
            })
          })
        return
      }

      // 账号与数据接口（/api/auth/* /api/admin/* /api/user-data/* /api/market-temperature）：
      // 与生产共用 server/api.mjs
      // 动态 import：该模块链会用到 node:sqlite，延迟到实际请求时再加载，
      // 避免构建期被 esbuild 预解析配置时报 ERR_UNKNOWN_BUILTIN_MODULE。
      if (
        url.pathname.startsWith('/api/auth/') ||
        url.pathname.startsWith('/api/admin/') ||
        url.pathname.startsWith('/api/user-data/') ||
        url.pathname === '/api/market-temperature'
      ) {
        import(/* @vite-ignore */ serverApiUrl())
          .then(({ handleAccountApi }) =>
            handleAccountApi(req as never, res as never, url),
          )
          .catch((error: unknown) => {
            sendJson(500, {
              ok: false,
              error: {
                code: 'INTERNAL',
                message: error instanceof Error ? error.message : String(error),
              },
            })
          })
        return
      }

      if (url.pathname.startsWith('/api/industry-cycle')) {
        getIndustryCycle()
          .then((payload) => sendJson(200, payload))
          .catch((error: unknown) =>
            sendJson(500, {
              error: `行业周期计算异常：${error instanceof Error ? error.message : String(error)}`,
            }),
          )
        return
      }

      if (url.pathname.startsWith('/api/stock-valuation')) {
        getStockValuation(url.searchParams.get('code') ?? '')
          .then((payload) => sendJson(200, payload))
          .catch((error: unknown) =>
            sendJson(500, {
              error: `个股估值历史异常：${error instanceof Error ? error.message : String(error)}`,
            }),
          )
        return
      }

      if (url.pathname.startsWith('/api/index-history')) {
        queryIndexHistory(
          url.searchParams.get('symbol') ?? 'sh000001',
          url.searchParams.get('years') ?? undefined,
        )
          .then((payload) => sendJson(200, payload))
          .catch((error: unknown) =>
            sendJson(500, {
              error: `指数历史异常：${error instanceof Error ? error.message : String(error)}`,
            }),
          )
        return
      }

      if (url.pathname.startsWith('/api/index-snapshot')) {
        queryIndexSnapshot(url.searchParams.get('symbol') ?? 'sh000001')
          .then((payload) => sendJson(200, payload))
          .catch((error: unknown) =>
            sendJson(500, {
              error: `指数快照异常：${error instanceof Error ? error.message : String(error)}`,
            }),
          )
        return
      }

      if (url.pathname.startsWith('/api/capital-flow')) {
        queryCapitalFlow()
          .then((payload) => sendJson(200, payload))
          .catch((error: unknown) =>
            sendJson(500, {
              error: `资金流向异常：${error instanceof Error ? error.message : String(error)}`,
            }),
          )
        return
      }

      if (!url.pathname.startsWith('/api/kline')) {
        next()
        return
      }

      queryKline(url.searchParams.get('codes'), url.searchParams.get('days'))
        .then((payload) => sendJson(200, payload))
        .catch((error: unknown) =>
          sendJson(500, {
            error: `K 线代理异常：${error instanceof Error ? error.message : String(error)}`,
          }),
        )
    })

    if (process.env.DAILY_MARKET_SCHEDULER_ENABLED === '1') {
      void (async () => {
        const [{ fetchRealMarketData }, { startDailyMarketScheduler }] =
          await Promise.all([
            server.ssrLoadModule('/src/lib/eastmoney.ts'),
            import(/* @vite-ignore */ dailyMarketUrl()),
          ])
        stopDailyMarketScheduler = startDailyMarketScheduler({
          fetchMarketData: fetchRealMarketData,
        })
      })().catch((error: unknown) => {
        console.error('[daily-market] 开发环境调度器启动失败', error)
      })
    }

    server.httpServer?.once('close', () => stopDailyMarketScheduler?.())
  },
})

const entry = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url))

// 通过运行时变量解析路径，避免 esbuild 在打包配置时静态跟随该动态 import
// （其模块链依赖 node:sqlite，构建期不应加载）。
const serverApiUrl = () => new URL('./server/api.mjs', import.meta.url).href
const dailyMarketUrl = () => new URL('./server/daily-market.mjs', import.meta.url).href

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), klineApiPlugin()],
  build: {
    rollupOptions: {
      // 多入口（MPA）：用户端 index.html + 管理端 admin.html，产出两个独立 bundle
      input: {
        index: entry('index.html'),
        admin: entry('admin.html'),
      },
    },
  },
})
