import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { queryKline } from './server/kline.mjs'

/**
 * 开发环境复用生产环境的 K 线代理逻辑，避免维护两份实现。
 * 生产环境由 server/index.mjs 提供同一接口。
 */
const klineApiPlugin = (): Plugin => ({
  name: 'dashu-kline-api',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url || !req.url.startsWith('/api/kline')) {
        next()
        return
      }

      const url = new URL(req.url, 'http://localhost')
      queryKline(url.searchParams.get('codes'), url.searchParams.get('days'))
        .then((payload) => {
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(payload))
        })
        .catch((error: unknown) => {
          res.statusCode = 500
          res.end(
            JSON.stringify({
              error: `K 线代理异常：${error instanceof Error ? error.message : String(error)}`,
            }),
          )
        })
    })
  },
})

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), klineApiPlugin()],
})
