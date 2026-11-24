# 大数选股工具生产镜像
# 服务端只用 Node 内置模块（node:sqlite 需 Node >= 22.13），运行层无需 node_modules。

# ---------- 构建层：编译前端（tsc -b && vite build）----------
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# package-lock.json 中的 resolved URL 可能指向私有镜像，统一替换为官方 npm registry
RUN sed -i 's|repo.huaweicloud.com/repository/npm|registry.npmjs.org|g' package-lock.json \
    && npm config set registry https://registry.npmjs.org/ \
    && npm ci
COPY . .
# 显式输出构建日志，失败时也能看到 tsc/vite 的具体报错
RUN bash -c 'set -o pipefail; (npx tsc -b 2>&1 && npx vite build 2>&1) | tee /tmp/build.log'

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
