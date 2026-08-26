/**
 * B13 驗收：關帳鎖的三個漏洞——同一條規則（已關帳期間的申報數字不可被無聲改動）
 * 原本只做了一半，這裡驗證三條補上的路徑都會 409、且對開放期間不過度封鎖：
 * 1. issueInvoice：作廢擋、開立原本不擋——已關帳期間的銷貨單開發票會憑空改掉該期 401 銷項
 * 2. PATCH /purchases/:id/supplier-invoice：原本是 blind update——已關帳期間補登發票會改掉該期進項稅額
 * 3. payClaim 的 payDate：API 端本來就有鎖，但前端不送日期就天然繞過；此處驗證明確送已關帳日期必 409
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let admin: Record<string, string>;
let closedSaleId: number; // 銷貨單日期落在已關帳期間、尚未開發票
let openSaleId: number; // 開放期間的銷貨單（正向對照）
let closedPurchaseId: number; // 進貨單日期落在已關帳期間、尚未登錄供應商發票
let openPurchaseId: number; // 開放期間的進貨單（正向對照）
let claimId: number; // 已核准待付款的報銷單
let cashAccountId: number;

async function api(path: string, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...admin, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);

  await app.request("/company-profile", {
    method: "PUT",
    headers: { ...admin, "content-type": "application/json" },
    // taxRegistrationNo 與 cityCode 是查 401 的必要欄位（測試裡要驗證嘗試被擋後該期數字不變）
    body: JSON.stringify({ name: "測試賣方公司", taxId: "22099131", address: "台北市測試路1號", taxRegistrationNo: "123456789", cityCode: "A" }),
  });
  const supplier = await api("/partners", { name: "供應商", isSupplier: true });
  const customer = await api("/partners", { name: "企業客戶", taxId: "04541302", isCustomer: true });
  const product = await api("/products", { sku: "P-B13", name: "商品" });
  const productId = product.json.id;

  // 4 月進貨備庫存（之後成為「已關帳期間、待補登發票」的那張單）
  const p1 = await api("/purchases", {
    partnerId: supplier.json.id,
    docDate: "2026-04-01",
    lines: [{ productId, qty: 100, unitPrice: 10 }],
  });
  closedPurchaseId = p1.json.id;
  // 4 月銷貨、未開發票（之後成為「忘了開發票、期已關」的那張單）
  const s1 = await api("/sales", {
    partnerId: customer.json.id,
    docDate: "2026-04-13",
    lines: [{ productId, qty: 10, unitPrice: 100 }],
  });
  closedSaleId = s1.json.id;
  // 8 月的進貨與銷貨：關帳後仍應正常運作的對照組
  const p2 = await api("/purchases", {
    partnerId: supplier.json.id,
    docDate: "2026-08-03",
    lines: [{ productId, qty: 10, unitPrice: 10 }],
  });
  openPurchaseId = p2.json.id;
  const s2 = await api("/sales", {
    partnerId: customer.json.id,
    docDate: "2026-08-05",
    lines: [{ productId, qty: 2, unitPrice: 100 }],
  });
  openSaleId = s2.json.id;
  // 8 月銷貨開發票要用的字軌（2026-08 屬期別 202607）
  await api("/invoice-tracks", { period: "202607", track: "KZ", rangeStart: 10000000, rangeEnd: 10000049 });

  // 報銷單：7 月送件並在關帳前核准，成為「已核准待付款」
  const emp = await api("/employees", { name: "王小明" });
  const claim = await api("/expense-claims", {
    employeeId: emp.json.id,
    claimDate: "2026-07-28",
    items: [{ accountCode: "6131", description: "計程車", docType: "receipt", amount: 300, deductible: false }],
  });
  claimId = claim.json.id;
  expect((await api(`/expense-claims/${claimId}/approve`, {})).status).toBe(200);
  cashAccountId = (await api("/accounts")).json.find((a: { code: string }) => a.code === "1101").id;

  // 關帳至 2026-07（起始關帳月可任選，之後依序；此處一次關到位）
  const close = await api("/period-closes", { period: "2026-07" });
  expect(close.status).toBe(201);
});

describe("B13：關帳鎖補上開立發票／供應商發票登錄／報銷付款日", () => {
  it("已關帳期間的銷貨單開立發票 → 409，並指引改開當期單據或重開期間", async () => {
    const res = await api(`/sales/${closedSaleId}/invoice`, { mode: "B2B" });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("已關帳");
    expect(res.json.error).toContain("401");
    // 該期 401 的銷項不得因這次嘗試而變動（4 月屬 202603 期）
    const vat = await api("/vat-returns/401?period=202603");
    expect(vat.json.summary.invoiceCount).toBe(0);
  });

  it("開放期間的銷貨單仍可正常開立（鎖不過度封鎖）", async () => {
    const res = await api(`/sales/${openSaleId}/invoice`, { mode: "B2B" });
    expect(res.status).toBe(201);
    expect(res.json.invoiceDate).toBe("2026-08-05");
  });

  it("已關帳期間的進貨單補登供應商發票 → 409；發票欄位不得落地", async () => {
    const res = await api(`/purchases/${closedPurchaseId}/supplier-invoice`, { track: "AB", no: "12345678" }, "PATCH");
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("已關帳");
    // 進項不得因這次嘗試而出現在已申報期別（4 月屬 202603 期）
    const vat = await api("/vat-returns/401?period=202603");
    expect(vat.json.summary.inputExpense).toBe(0);
    expect(vat.json.summary.inputExpenseTax).toBe(0);
  });

  it("開放期間的進貨單仍可登錄供應商發票；單號不存在維持 404", async () => {
    const ok = await api(`/purchases/${openPurchaseId}/supplier-invoice`, { track: "AB", no: "12345678" }, "PATCH");
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ invTrack: "AB", invNo: "12345678" });
    expect((await api("/purchases/99999/supplier-invoice", { track: "AB", no: "00000001" }, "PATCH")).status).toBe(404);
  });

  it("報銷付款：明確送已關帳期間的付款日 → 409；改送開放期間日期可付", async () => {
    const blocked = await api(`/expense-claims/${claimId}/pay`, { accountId: cashAccountId, payDate: "2026-07-30" });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain("已關帳");

    const paid = await api(`/expense-claims/${claimId}/pay`, { accountId: cashAccountId, payDate: "2026-08-05" });
    expect(paid.status).toBe(200);
    expect(paid.json.status).toBe("paid");
  });
});
