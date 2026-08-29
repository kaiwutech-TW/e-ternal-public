/**
 * Vercel 部署入口（demo 站用）：Hono app → 標準 Node `(req, res)` handler。
 *
 * 與 apps/api/src/server.ts 的差別只有「誰在聽埠」——那支用 @hono/node-server 自己開 3000 埠並順便
 * serve 前端；這裡前端由 Vercel 靜態託管，function 只吃 /api/*。
 * pg.Pool 放模組頂層讓同一個 function 實例跨請求重用連線；連線字串請用 Supabase 的
 * transaction pooler（6543 埠），serverless 下直連 5432 會把連線數撐爆。
 *
 * 為什麼是 default export 的 (req, res)：這是 Vercel Node launcher 最保守、無歧義的簽名
 * （Build Output API 的 launcherType "Nodejs"）。用 getRequestListener 把 Hono 的 fetch 轉成它，
 * 不再依賴 Vercel 對具名 `fetch` 匯出的特殊路徑。
 * 打包：scripts/build-vercel.mjs 把這支連同 workspace 套件 bundle 進 .vercel/output/functions/。
 */
import { getRequestListener } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import pg from "pg";
import { buildApp } from "@tw-erp/api/app";

// 缺環境變數不在模組載入時 throw（那會變成 Vercel 的 FUNCTION_INVOCATION_FAILED、看不到原因），
// 改成每個請求回 503 JSON——preview 環境沒設 DATABASE_URL 時也能一眼看出是設定問題而不是程式問題
const url = process.env["DATABASE_URL"];
let root: Hono | null = null;
if (url) {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  root = new Hono();
  root.route("/api", buildApp(drizzle(pool)));
}

export default getRequestListener((req) =>
  root
    ? root.fetch(req)
    : Response.json({ error: "DATABASE_URL is not set for this environment" }, { status: 503 }),
);
