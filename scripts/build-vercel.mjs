#!/usr/bin/env node
/**
 * Vercel 用：直接產出 Build Output API（.vercel/output/）——
 *   static/                     前端（apps/web/dist 整份複製）
 *   functions/api/index.func/   Hono API 打包成單一 index.mjs（esbuild 連 workspace .ts 一起 bundle）
 *   config.json                 路由：/api/* → function；其餘走檔案系統、找不到回 index.html（SPA）
 *
 * 為什麼不用 api/ 目錄慣例：Vercel 在 build **之前**就用 vercel.json 的 functions pattern 去比對 repo 檔案，
 * 而 api/index.mjs 是 build 才產生的（且不進 git）→ Git 自動部署永遠在第一秒失敗。
 * Build Output API 把「產出什麼」完全交給 build 指令，Git 推送與 CLI 兩條路都一致。
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const OUT = ".vercel/output";
const FN = `${OUT}/functions/api/index.func`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(FN, { recursive: true });

// 1. 前端靜態檔
cpSync("apps/web/dist", `${OUT}/static`, { recursive: true });

// 2. API function（workspace 套件的 .ts 一起 bundle；pg 的選配原生模組留 external）
await build({
  entryPoints: ["server/vercel-entry.ts"],
  outfile: `${FN}/index.mjs`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  external: ["pg-native"],
  banner: {
    js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
  },
  logLevel: "info",
});
writeFileSync(
  `${FN}/.vc-config.json`,
  JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", maxDuration: 30 }, null, 2),
);

// 3. 路由與安全標頭
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
};
writeFileSync(
  `${OUT}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "/(.*)", headers: securityHeaders, continue: true },
        { src: "/api/(.*)", dest: "/api/index" },
        { handle: "filesystem" },
        { src: "/(.*)", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);
console.log(`Build Output ready at ${OUT}/`);
