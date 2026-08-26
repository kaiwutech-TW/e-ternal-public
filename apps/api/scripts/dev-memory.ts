/** 開發用：以 PGlite（記憶體 Postgres）啟動——免安裝資料庫，重啟即清空。
 * 若 apps/web/dist 已建置，單埠即可跑全站（API /api＋前端 /）；未建置則配合 vite dev 使用。 */
import { serve } from "@hono/node-server";
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { buildServerApp } from "../src/server-app.ts";
import { seedAccounts } from "../src/services/seed.ts";

const client = new PGlite();
await applyMigrations((sql) => client.exec(sql));
const db = drizzle(client);
await seedAccounts(db);

const app = buildServerApp(db);
const port = Number(process.env["PORT"] ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`tw-erp (in-memory PGlite) listening on :${port} — 資料不會保存，重啟即清空`);
