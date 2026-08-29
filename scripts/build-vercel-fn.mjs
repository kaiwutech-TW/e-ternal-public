#!/usr/bin/env node
/**
 * Vercel 用：把 server/vercel-entry.ts（連同 @tw-erp/* workspace 套件的 .ts 原始碼）打包成
 * 單一 api/index.mjs。為什麼要多這一步：Vercel 的 Node builder 只轉譯 function 檔本身，
 * node_modules 裡 workspace 套件的 .ts 不會被編譯，執行期會 Cannot find module。
 * 只在 Vercel build 時跑（見 vercel.json buildCommand）；產物 api/ 已列入 .gitignore。
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("api", { recursive: true });
await build({
  entryPoints: ["server/vercel-entry.ts"],
  outfile: "api/index.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  // pg 會嘗試 require 選配的原生模組；沒裝就走純 JS，標為 external 讓它保持選配
  external: ["pg-native"],
  banner: {
    js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
  },
  logLevel: "info",
});
