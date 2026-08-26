/**
 * Migration 冪等性：同一個資料庫重複套用不得失敗。
 *
 * 其他測試都用「每次全新的 PGlite」，永遠跑不到第二次套用，所以 2026-07-28 之前
 * 這一格是空的——直到內網 docker 部署重啟時炸出 `type "account_type" already exists`
 * （容器 restart: unless-stopped，等於主機重開機就整個服務起不來）。
 * 這支測試守的就是「重啟 / 升級」這條路徑。
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { describe, expect, it } from "vitest";

const rowsOf = (r: unknown) => (Array.isArray(r) ? r[r.length - 1] : r) as { rows: Array<Record<string, unknown>> };

describe("migrations", () => {
  it("重複套用不失敗，且不重複記錄（模擬容器重啟）", async () => {
    const client = new PGlite();
    await applyMigrations((sql) => client.exec(sql));
    const first = rowsOf(await client.exec("SELECT filename FROM schema_migrations ORDER BY filename;")).rows;
    expect(first.length).toBeGreaterThan(0);

    await applyMigrations((sql) => client.exec(sql)); // 第二次：全部應跳過
    const second = rowsOf(await client.exec("SELECT filename FROM schema_migrations ORDER BY filename;")).rows;
    expect(second).toEqual(first);

    await applyMigrations((sql) => client.exec(sql)); // 第三次也一樣（升級路徑會反覆走）
    const third = rowsOf(await client.exec("SELECT filename FROM schema_migrations ORDER BY filename;")).rows;
    expect(third).toEqual(first);
  });

  it("每個 migration 檔都留下套用紀錄", async () => {
    const client = new PGlite();
    await applyMigrations((sql) => client.exec(sql));
    const rows = rowsOf(await client.exec("SELECT filename FROM schema_migrations ORDER BY filename;")).rows;
    const names = rows.map((r) => String(r["filename"]));
    expect(names).toEqual([...names].sort()); // 依檔名排序套用
    expect(names.every((n) => /^\d{4}_.*\.sql$/.test(n))).toBe(true);
  });

  it("ledger 空但 schema 已存在時停下來要求人工補登，不硬套", async () => {
    const client = new PGlite();
    await applyMigrations((sql) => client.exec(sql));
    // 模擬 ledger 出現前建立的舊庫：schema 在，套用紀錄不在
    await client.exec("DROP TABLE schema_migrations;");
    await expect(applyMigrations((sql) => client.exec(sql))).rejects.toThrow(/人工補登/);
  });
});
