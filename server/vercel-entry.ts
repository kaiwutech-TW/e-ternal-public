/**
 * Vercel 部署入口（demo 站 et-demo.kaiwu.com.tw 用）：把 Hono app 以 Web 標準 fetch 簽名交給 Vercel。
 *
 * 與 apps/api/src/server.ts 的差別只有「誰在聽埠」——那支用 @hono/node-server 自己開 3000 埠並順便
 * serve 前端；這裡前端由 Vercel 靜態託管（vercel.json 的 outputDirectory），function 只吃 /api/*。
 * pg.Pool 放模組頂層讓同一個 function 實例跨請求重用連線；連線字串請用 Supabase 的
 * transaction pooler（6543 埠），serverless 下直連 5432 會把連線數撐爆。
 *
 * 不用 default export：Vercel 對 default export 的預期是 (req, res) => void，回傳的 Response 會被丟掉
 * （實測會吊到 timeout）；具名 `fetch` 匯出才是 Web 標準路徑。
 * 這支不放在 api/ 下：scripts/build-vercel-fn.mjs 會把它連同 workspace 套件打包成 api/index.mjs。
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import pg from "pg";
import { buildApp } from "@tw-erp/api/app";

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL 未設定");

const pool = new pg.Pool({ connectionString: url, max: 3 });
const root = new Hono();
root.route("/api", buildApp(drizzle(pool)));

export const fetch = (req: Request): Response | Promise<Response> => root.fetch(req);
