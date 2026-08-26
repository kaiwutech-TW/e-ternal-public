/**
 * Phase 1 驗收測試：一條「進貨 → 銷貨 → 庫存 → 傳票」流程端到端走通，全程走 API。
 * 資料庫用 PGlite（記憶體 Postgres），套用與正式環境相同的 SQL migrations。
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let auth: Record<string, string>;
let supplierId: number;
let customerId: number;
let productId: number;

async function api(path: string, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json() };
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  auth = await setupAdmin(app);
});

describe("Phase 1 端到端：進貨→銷貨→庫存→傳票", () => {
  it("建立主檔：供應商、客戶（統編驗證）、商品", async () => {
    const supplier = await api("/partners", { name: "測試供應商", taxId: "22099131", isSupplier: true });
    expect(supplier.status).toBe(201);
    supplierId = supplier.json.id;

    const badTaxId = await api("/partners", { name: "檢查碼錯誤", taxId: "22099132", isCustomer: true });
    expect(badTaxId.status).toBe(400);

    const customer = await api("/partners", { name: "測試客戶", taxId: "04541302", isCustomer: true });
    expect(customer.status).toBe(201);
    customerId = customer.json.id;

    const product = await api("/products", { sku: "SKU-001", name: "測試商品", unit: "箱" });
    expect(product.status).toBe(201);
    productId = product.json.id;
  });

  it("進貨 10 箱 @100：稅額 5%、自動拋轉傳票借貸平", async () => {
    const res = await api("/purchases", {
      partnerId: supplierId,
      docDate: "2026-07-21",
      lines: [{ productId, qty: 10, unitPrice: 100 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ subtotal: 1000, tax: 50, total: 1050 });

    const entry = await api(`/journal-entries/${res.json.journalEntryId}`);
    expect(entry.status).toBe(200);
    const debit = entry.json.lines.reduce((s: number, l: { debit: number }) => s + l.debit, 0);
    const credit = entry.json.lines.reduce((s: number, l: { credit: number }) => s + l.credit, 0);
    expect(debit).toBe(1050);
    expect(credit).toBe(1050);
  });

  it("銷貨 6 箱 @200：移動平均成本 600、五筆傳票明細", async () => {
    const res = await api("/sales", {
      partnerId: customerId,
      docDate: "2026-07-21",
      lines: [{ productId, qty: 6, unitPrice: 200 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ subtotal: 1200, tax: 60, total: 1260, cogs: 600 });

    const entry = await api(`/journal-entries/${res.json.journalEntryId}`);
    expect(entry.json.lines).toHaveLength(5);
  });

  it("庫存：在庫 4 箱、平均成本 100", async () => {
    const res = await api("/inventory");
    expect(res.json).toEqual([
      expect.objectContaining({ productId, qty: 4, amount: 400, avgUnitCost: 100 }),
    ]);
  });

  it("超賣被拒（409）", async () => {
    const res = await api("/sales", {
      partnerId: customerId,
      docDate: "2026-07-21",
      lines: [{ productId, qty: 100, unitPrice: 200 }],
    });
    expect(res.status).toBe(409);
  });

  it("角色防呆：向客戶進貨被拒（422）", async () => {
    const res = await api("/purchases", {
      partnerId: customerId,
      docDate: "2026-07-21",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    expect(res.status).toBe(422);
  });

  it("試算表借貸總額相等且數字正確", async () => {
    const res = await api("/trial-balance");
    expect(res.json.totalDebit).toBe(res.json.totalCredit);
    expect(res.json.totalDebit).toBe(2910); // 1050(進貨) + 1860(銷貨)
    const inventory = res.json.rows.find((r: { code: string }) => r.code === "1301");
    expect(inventory).toMatchObject({ debit: 1000, credit: 600 }); // 帳上存貨淨額 400 = 庫存金額
  });
});
