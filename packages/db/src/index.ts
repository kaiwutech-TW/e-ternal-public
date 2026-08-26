import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export * as schema from "./schema.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * pg 的 Result 與 PGlite 的 Results[] 都帶 rows；多語句時取最後一個結果
 * （呼叫端不必改：16 處都是 pool.query / client.exec，兩種形狀都吃得下）
 */
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const r = Array.isArray(result) ? result[result.length - 1] : result;
  return (r as { rows?: Array<Record<string, unknown>> } | null | undefined)?.rows ?? [];
}

/**
 * 依檔名排序套用 migrations/*.sql（migration 一律為手寫 SQL 檔），已套用的跳過。
 *
 * schema_migrations 是「哪些檔跑過」的唯一事實來源。沒有它就無法冪等——
 * 重跑 0001 會撞 `type "account_type" already exists`，讓每次容器重啟都崩
 * （2026-07-28 內網部署實測踩到；測試沒抓到是因為 PGlite 每次都是全新庫，永遠沒有第二次）。
 */
export async function applyMigrations(exec: (sql: string) => Promise<unknown>): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

  await exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     );`,
  );
  const applied = new Set(
    rowsOf(await exec("SELECT filename FROM schema_migrations;")).map((r) => String(r["filename"])),
  );

  // ledger 全空但 schema 已存在 = ledger 出現前建立的舊庫。這裡不猜「哪幾檔跑過」——
  // 猜錯會漏套 migration 而留下壞 schema，寧可停下來要人工補登（下面訊息給了指令）。
  if (applied.size === 0) {
    const probe = rowsOf(await exec("SELECT to_regclass('public.accounts') IS NOT NULL AS present;"));
    const present = probe[0]?.["present"];
    if (present === true || present === "t") {
      throw new Error(
        "偵測到 schema_migrations 出現前建立的資料庫（accounts 表已存在但無套用紀錄）。\n" +
          "請人工補登已套用的檔名後再啟動，例如全部已套用時：\n" +
          `  INSERT INTO schema_migrations (filename) VALUES\n${files.map((f) => `    ('${f}')`).join(",\n")};\n` +
          "（不確定套到哪一檔時，比對 packages/db/migrations/ 各檔建立的物件是否存在）",
      );
    }
  }

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // 單次 exec 送多語句 = Postgres 隱式單一交易：檔案內任一句失敗就整檔回滾，
    // 不會留下「半套 schema + 已標記套用」的錯位狀態。
    // （不能拆成多次 exec 再包 BEGIN/COMMIT——pg.Pool 每次 query 可能拿到不同連線）
    await exec(`${sql}\n;\nINSERT INTO schema_migrations (filename) VALUES ('${file}');`);
  }
}
