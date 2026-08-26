import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { resolveDatabaseUrl } from "../src/db-url.ts";
import { seedAccounts } from "../src/services/seed.ts";

const pool = new pg.Pool({ connectionString: resolveDatabaseUrl() });
await applyMigrations(async (sql) => pool.query(sql));
await seedAccounts(drizzle(pool));
await pool.end();
console.log("migrations + seed 完成");
