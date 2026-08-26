import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { resolveDatabaseUrl } from "./db-url.ts";
import { buildServerApp } from "./server-app.ts";
import { warnIfPiiUnprotected } from "./services/pii.ts";

warnIfPiiUnprotected();

const pool = new pg.Pool({ connectionString: resolveDatabaseUrl() });
const app = buildServerApp(drizzle(pool));
const port = Number(process.env["PORT"] ?? 3000);
serve({ fetch: app.fetch, port, hostname: process.env["HOST"] ?? "0.0.0.0" });
console.log(`tw-erp listening on :${port}（API 於 /api，前端於 /）`);
