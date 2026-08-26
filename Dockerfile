# tw-erp 單一映像：build 前端 → 以 Node 直跑 TS（--experimental-strip-types，與開發同路徑）
FROM node:22-alpine

WORKDIR /app
ENV CI=true
RUN corepack enable

# 先鋪 manifest 讓相依安裝可快取
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/einvoice/package.json packages/einvoice/
COPY packages/vat/package.json packages/vat/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @tw-erp/web build

EXPOSE 3000
# 啟動：先套 migration＋seed（冪等），再起單埠服務（API /api＋前端 /）
CMD ["sh", "-c", "node --experimental-strip-types apps/api/scripts/migrate.ts && node --experimental-strip-types apps/api/src/server.ts"]
