# 大数选股工具生产镜像
# 服务端只用 Node 内置模块（node:sqlite 需 Node >= 22.13），运行层无需 node_modules。

# ---------- 构建层：编译前端（tsc -b && vite build）----------
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---------- 运行层：Node 运行时 + 前端产物 + 服务端源码 ----------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/data/dashu.db
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
EXPOSE 8787
CMD ["node", "server/index.mjs"]
