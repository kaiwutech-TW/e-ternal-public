/**
 * 伺服端 i18n 機制：AppError 依 Accept-Language 翻譯；沒帶／帶不認得的語言回中文；
 * 缺翻譯的 key fallback 回中文；參數化的訊息兩種語言都套得到值。
 * 這裡守機制，不守任何一句翻得對不對。
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { AppError } from "../src/db.ts";
import { setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let admin: Record<string, string>;

beforeAll(async () => {
  const pg = new PGlite();
  await applyMigrations((sql) => pg.exec(sql));
  app = buildApp(drizzle(pg));
  admin = await setupAdmin(app);
});

const hit = (lang?: string) =>
  app.request("/expense-categories/suggestions?sellerTaxId=abc", {
    headers: { ...admin, ...(lang ? { "accept-language": lang } : {}) },
  });

describe("AppError", () => {
  it("message 是套好參數的中文；key／params 另存給翻譯用", () => {
    const e = new AppError(400, "{name} 須在 {min}–{max} 之間（收到 {n}）", { name: "稅率", min: 0, max: 100, n: 101 });
    expect(e.message).toBe("稅率 須在 0–100 之間（收到 101）");
    expect(e.key).toBe("{name} 須在 {min}–{max} 之間（收到 {n}）");
    expect(e.params).toEqual({ name: "稅率", min: 0, max: 100, n: 101 });
  });
  it("舊寫法（固定句子、無參數）完全相容", () => {
    const e = new AppError(422, "直屬主管不能是自己");
    expect(e.message).toBe("直屬主管不能是自己");
    expect(e.key).toBe("直屬主管不能是自己");
    expect(e.params).toBeUndefined();
  });
});

describe("app.onError 依 Accept-Language 翻譯", () => {
  it("沒帶標頭 → 中文", async () => {
    const res = await hit();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("sellerTaxId 須為 8 位數字（收到「abc」）");
  });
  it("en-US → 英文，參數有套進去", async () => {
    const res = await hit("en-US,en;q=0.9");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('sellerTaxId must be 8 digits (got "abc")');
  });
  it("不認得的語言（ja）→ 中文", async () => {
    expect((await (await hit("ja-JP")).json()).error).toContain("須為 8 位數字");
  });
  it("en 但字典沒這句 → 原句中文，不是空白", async () => {
    // 未登入走 401 那條（auth 守衛的訊息沒翻）
    const res = await app.request("/expense-claims", { headers: { "accept-language": "en" } });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });
});
