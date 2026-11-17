import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { queryKline } from './server/kline.mjs'
import { getIndustryCycle } from './server/industry-cycle.mjs'
import { getStockValuation } from './server/stock-valuation.mjs'

/**
 * 开发环境复用生产环境的接口逻辑，避免维护两份实现。
 * 生产环境由 server/index.mjs 提供同一接口。
 */
const klineApiPlugin = (): Plugin => ({
  name: 'dashu-kline-api',
  configureServer(server) {
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

      if (req.url.startsWith('/api/industry-cycle')) {
        getIndustryCycle()
          .then((payload) => sendJson(200, payload))
          .catch((error: unknown) =>
            sendJson(500, {
              error: `行业周期计算异常：${error instanceof Error ? error.message : String(error)}`,
            }),
          )
        return
      }

      if (req.url.startsWith('/api/stock-valuation')) {
        const url = new URL(req.url, 'http://localhost')
        getStockValuation(url.searchParams.get('code') ?? '')
          .then((payload) => sendJson(200, payload))
          .catch((error: unknown) =>
            sendJson(500, {
              error: `个股估值历史异常：${error instanceof Error ? error.message : String(error)}`,
            }),
          )
        return
      }

      if (!req.url.startsWith('/api/kline')) {
        next()
        return
      }

      const url = new URL(req.url, 'http://localhost')
      queryKline(url.searchParams.get('codes'), url.searchParams.get('days'))
        .then((payload) => sendJson(200, payload))
        .catch((error: unknown) =>
          sendJson(500, {
            error: `K 线代理异常：${error instanceof Error ? error.message : String(error)}`,
          }),
        )
    })
  },
})

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), klineApiPlugin()],
})
