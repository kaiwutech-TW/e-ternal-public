/**
 * Phase 2 里程碑 2a 驗收：銷貨單 → 開立 F0401 發票（字軌配號、B2B 稅額分離/B2C 內含稅）→ 作廢 F0501。
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
let b2bCustomerId: number;
let b2cCustomerId: number;
let b2bSaleId: number;
let b2cSaleId: number;
let b2bInvoiceId: number;

async function api(path: string, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text), text };
  } catch {
    return { status: res.status, json: null, text };
  }
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  auth = await setupAdmin(app);

  // 場景資料：公司檔、供應商、B2B/B2C 客戶、商品、進貨、兩張銷貨單
  await app.request("/company-profile", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "測試賣方公司", taxId: "22099131", address: "台北市測試路1號" }),
  });
  const supplier = await api("/partners", { name: "供應商", isSupplier: true });
  const b2b = await api("/partners", { name: "企業客戶", taxId: "04541302", isCustomer: true });
  b2bCustomerId = b2b.json.id;
  const b2c = await api("/partners", { name: "散客", isCustomer: true });
  b2cCustomerId = b2c.json.id;
  const product = await api("/products", { sku: "SKU-100", name: "鉛筆" });
  await api("/purchases", {
    partnerId: supplier.json.id,
    docDate: "2026-07-01",
    lines: [{ productId: product.json.id, qty: 100, unitPrice: 10 }],
  });
  const b2bSale = await api("/sales", {
    partnerId: b2bCustomerId,
    docDate: "2026-07-21",
    lines: [{ productId: product.json.id, qty: 10, unitPrice: 100 }],
  });
  b2bSaleId = b2bSale.json.id;
  const b2cSale = await api("/sales", {
    partnerId: b2cCustomerId,
    docDate: "2026-07-21",
    lines: [{ productId: product.json.id, qty: 3, unitPrice: 33 }],
  });
  b2cSaleId = b2cSale.json.id;
});

describe("Phase 2a：開立與作廢電子發票", () => {
  it("未建字軌時開立回 409", async () => {
    const res = await api(`/sales/${b2bSaleId}/invoice`, { mode: "B2B" });
    expect(res.status).toBe(409);
  });

  it("建立字軌區間（期別 202607）", async () => {
    const res = await api("/invoice-tracks", { period: "202607", track: "KZ", rangeStart: 10000000, rangeEnd: 10000049 });
    expect(res.status).toBe(201);
    expect(res.json.nextNo).toBe(10000000);
  });

  it("B2B 開立：字軌取號、稅額分離、XML 含正確欄位", async () => {
    const res = await api(`/sales/${b2bSaleId}/invoice`, { mode: "B2B", invoiceTime: "10:00:00", randomNumber: "5678" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      invoiceNumber: "KZ10000000",
      mode: "B2B",
      salesAmount: 1000,
      taxAmount: 50,
      totalAmount: 1050,
      buyerTaxId: "04541302",
      status: "issued",
    });
    b2bInvoiceId = res.json.id;
    expect(res.json.xml).toContain("<InvoiceNumber>KZ10000000</InvoiceNumber>");
    expect(res.json.xml).toContain("<Identifier>22099131</Identifier>"); // 賣方
    expect(res.json.xml).toContain("<Identifier>04541302</Identifier>"); // 買方
    expect(res.json.xml).toContain("<TaxAmount>50</TaxAmount>");
    expect(res.json.xml).toContain("<InvoiceDate>20260721</InvoiceDate>");
  });

  it("B2C 開立：號碼遞增、金額內含稅（TaxAmount=0、明細含稅含尾差調整）", async () => {
    const res = await api(`/sales/${b2cSaleId}/invoice`, { mode: "B2C", invoiceTime: "10:05:00", randomNumber: "0001" });
    expect(res.status).toBe(201);
    // 銷貨: 3×33=99 未稅, 稅 5, 總額 104
    expect(res.json).toMatchObject({
      invoiceNumber: "KZ10000001",
      mode: "B2C",
      salesAmount: 104,
      taxAmount: 0,
      totalAmount: 104,
      buyerTaxId: null,
    });
    expect(res.json.xml).toContain("<Identifier>0000000000</Identifier>");
    expect(res.json.xml).toContain("<TaxAmount>0</TaxAmount>");
    expect(res.json.xml).toContain("<Amount>104</Amount>"); // 明細含稅（99×1.05=103.95→104）
  });

  it("同一銷貨單重複開立回 409", async () => {
    const res = await api(`/sales/${b2bSaleId}/invoice`, { mode: "B2B" });
    expect(res.status).toBe(409);
  });

  it("XML 端點回傳 application/xml", async () => {
    const res = await app.request(`/invoices/${b2bInvoiceId}/xml`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    expect(await res.text()).toContain("urn:GEINV:eInvoiceMessage:F0401:4.1");
  });

  it("作廢：產生 F0501、狀態轉 canceled、重複作廢 409", async () => {
    const res = await api(`/invoices/${b2bInvoiceId}/cancel`, {
      reason: "品項錯誤",
      cancelDate: "2026-07-22",
      cancelTime: "09:00:00",
    });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("canceled");
    expect(res.json.cancelXml).toContain("<CancelInvoiceNumber>KZ10000000</CancelInvoiceNumber>");
    expect(res.json.cancelXml).toContain("urn:GEINV:eInvoiceMessage:F0501:4.1");

    const again = await api(`/invoices/${b2bInvoiceId}/cancel`, { reason: "再一次" });
    expect(again.status).toBe(409);
  });

  it("字軌用罄回 409：耗盡剩餘號碼後再開立被拒", async () => {
    // 區間 10000000-10000049，已用 2 個；剩 48 個一次驗證邊界：直接建一個只剩 0 個的區間場景
    const small = await api("/invoice-tracks", { period: "202609", track: "AB", rangeStart: 1, rangeEnd: 1 });
    expect(small.status).toBe(201);
    const sale = await api("/sales", {
      partnerId: b2bCustomerId,
      docDate: "2026-09-01",
      lines: [{ productId: 1, qty: 1, unitPrice: 10 }],
    });
    const first = await api(`/sales/${sale.json.id}/invoice`, { mode: "B2B", randomNumber: "1111" });
    expect(first.status).toBe(201);
    expect(first.json.invoiceNumber).toBe("AB00000001");

    const sale2 = await api("/sales", {
      partnerId: b2bCustomerId,
      docDate: "2026-09-02",
      lines: [{ productId: 1, qty: 1, unitPrice: 10 }],
    });
    const second = await api(`/sales/${sale2.json.id}/invoice`, { mode: "B2B" });
    expect(second.status).toBe(409);
    expect(second.json.error).toContain("設定");
  });
});

describe("B7：字軌的三個尖角（期別驗證、刪除、用罄與撞號不再 500）", () => {
  it("偶數月期別回 422 並指路（配號永遠走奇數月起算，偶數月是死區間）", async () => {
    const res = await api("/invoice-tracks", { period: "202608", track: "XA", rangeStart: 1, rangeEnd: 100 });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("奇數月");
  });

  it("不存在的月份（202613／000000）回 422", async () => {
    const bad = await api("/invoice-tracks", { period: "202613", track: "XB", rangeStart: 1, rangeEnd: 100 });
    expect(bad.status).toBe(422);
    const zero = await api("/invoice-tracks", { period: "000000", track: "XC", rangeStart: 1, rangeEnd: 100 });
    expect(zero.status).toBe(422);
  });

  it("迄號超過 8 位回 422（超長區間會讓該期別每次開票都在 XML 驗證炸掉）", async () => {
    const res = await api("/invoice-tracks", { period: "202611", track: "XD", rangeStart: 1, rangeEnd: 999999999 });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("8");
  });

  it("起號大於迄號回 422", async () => {
    const res = await api("/invoice-tracks", { period: "202611", track: "XE", rangeStart: 50, rangeEnd: 10 });
    expect(res.status).toBe(422);
  });

  it("重建同一組區間回 409 不是 500（使用者以為沒存進去而重按）", async () => {
    const res = await api("/invoice-tracks", { period: "202607", track: "KZ", rangeStart: 10000000, rangeEnd: 10000049 });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("已存在");
  });

  it("一張都沒開的區間可以刪除（填錯的救濟途徑）", async () => {
    const created = await api("/invoice-tracks", { period: "202611", track: "EF", rangeStart: 1, rangeEnd: 30 });
    expect(created.status).toBe(201);
    const del = await api(`/invoice-tracks/${created.json.id}`, undefined, "DELETE");
    expect(del.status).toBe(200);
    const list = await api("/invoice-tracks");
    expect(list.json.some((t: { id: number }) => t.id === created.json.id)).toBe(false);
  });

  it("配過號的區間刪除回 409 並說明只能逐張作廢發票", async () => {
    const list = await api("/invoice-tracks");
    const used = list.json.find((t: { period: string; track: string }) => t.period === "202607" && t.track === "KZ");
    const res = await api(`/invoice-tracks/${used.id}`, undefined, "DELETE");
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("作廢");
  });

  it("剩餘低於門檻時開票回應出聲（taxNotes 管道＋trackRemaining）", async () => {
    const track = await api("/invoice-tracks", { period: "202611", track: "GH", rangeStart: 1, rangeEnd: 10 });
    expect(track.status).toBe(201);
    const sale = await api("/sales", {
      partnerId: b2bCustomerId,
      docDate: "2026-11-05",
      lines: [{ productId: 1, qty: 1, unitPrice: 10 }],
    });
    const res = await api(`/sales/${sale.json.id}/invoice`, { mode: "B2B", randomNumber: "2222" });
    expect(res.status).toBe(201);
    expect(res.json.trackRemaining).toBe(9);
    expect(res.json.taxNotes.join("")).toContain("只剩 9 張");
    expect(res.json.taxNotes.join("")).toContain("設定");
  });

  it("剩餘還很多時不出聲（門檻的另一側）", async () => {
    const sale = await api("/sales", {
      partnerId: b2bCustomerId,
      docDate: "2026-07-25",
      lines: [{ productId: 1, qty: 1, unitPrice: 10 }],
    });
    const res = await api(`/sales/${sale.json.id}/invoice`, { mode: "B2B", randomNumber: "3333" });
    expect(res.status).toBe(201);
    expect(res.json.trackRemaining).toBeGreaterThanOrEqual(20);
    expect(res.json.taxNotes).toEqual([]);
  });
});
