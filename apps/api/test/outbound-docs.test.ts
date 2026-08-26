/**
 * B5 對外文件的最小集：
 * - GET /sales/:id 單筆銷貨單（列印出貨單／證明聯的資料來源）——資料完整性在 API 層驗
 * - GET /invoices/:id/xml、/invoices/:id/cancel-xml 的下載標頭（MIG 檔名慣例）
 * - GET /exports/einvoice-xml 批次匯出（F0401＋F0501、日期篩選、內容對落地 XML）
 * - 權限：sales 角色印得了出貨單但拿不到匯出；XML 內容與 golden 驗證過的 buildF0401 一致
 *   （golden 逐欄比對在 packages/einvoice/test/golden.test.ts，這裡驗匯出內容＝落地內容）
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { loginAs, setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let auth: Record<string, string>;
let salesAuth: Record<string, string>;
let productId: number;
let b2bSaleId: number;
let b2cSaleId: number;
let b2bInvoiceId: number;
let b2cInvoiceId: number;

async function api(path: string, body?: unknown, method = body ? "POST" : "GET", headers = auth) {
  const res = await app.request(path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text), text, headers: res.headers };
  } catch {
    return { status: res.status, json: null, text, headers: res.headers };
  }
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  auth = await setupAdmin(app);

  await api("/company-profile", { name: "測試賣方公司", taxId: "22099131", address: "台北市測試路1號" }, "PUT");
  const supplier = await api("/partners", { name: "供應商", isSupplier: true });
  const b2b = await api("/partners", {
    name: "企業客戶",
    taxId: "04541302",
    isCustomer: true,
    contactPerson: "王小明",
    phone: "02-1234-5678",
    address: "台北市中山北路 100 號",
    shipToAddress: "新北市林口區倉庫路 5 號",
  });
  const b2c = await api("/partners", { name: "散客", isCustomer: true });
  const product = await api("/products", { sku: "SKU-100", name: "鉛筆", unit: "打" });
  productId = product.json.id;
  await api("/purchases", {
    partnerId: supplier.json.id,
    docDate: "2026-07-01",
    lines: [{ productId, qty: 100, unitPrice: 10 }],
  });
  const b2bSale = await api("/sales", {
    partnerId: b2b.json.id,
    docDate: "2026-07-21",
    lines: [{ productId, qty: 10, unitPrice: 100 }],
  });
  b2bSaleId = b2bSale.json.id;
  const b2cSale = await api("/sales", {
    partnerId: b2c.json.id,
    docDate: "2026-07-22",
    lines: [{ productId, qty: 3, unitPrice: 33 }],
  });
  b2cSaleId = b2cSale.json.id;

  await api("/invoice-tracks", { period: "202607", track: "KZ", rangeStart: 10000000, rangeEnd: 10000049 });
  const b2bInv = await api(`/sales/${b2bSaleId}/invoice`, { mode: "B2B", invoiceTime: "10:00:00", randomNumber: "5678" });
  b2bInvoiceId = b2bInv.json.id;
  const b2cInv = await api(`/sales/${b2cSaleId}/invoice`, { mode: "B2C", invoiceTime: "10:05:00", randomNumber: "0001" });
  b2cInvoiceId = b2cInv.json.id;
  // B2C 那張作廢：批次匯出要能同時帶出 F0401 與 F0501
  await api(`/invoices/${b2cInvoiceId}/cancel`, { reason: "品項錯誤", cancelDate: "2026-07-23", cancelTime: "09:00:00" });

  // sales 角色：印得了出貨單（sales 頁），但 exports 頁拿不到
  await api("/users", { username: "seller", displayName: "業務", password: "secret-test", role: "sales" });
  salesAuth = await loginAs(app, "seller", "secret-test");
});

describe("B5：單筆銷貨單（列印資料來源）", () => {
  it("回單頭＋明細（含品名/單位）＋客戶抬頭（白名單欄位），列印視圖要的資料一次到位", async () => {
    const res = await api(`/sales/${b2bSaleId}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: b2bSaleId,
      docDate: "2026-07-21",
      subtotal: 1000,
      tax: 50,
      total: 1050,
      partnerName: "企業客戶",
    });
    expect(res.json.partner).toEqual({
      name: "企業客戶",
      taxId: "04541302",
      contactPerson: "王小明",
      phone: "02-1234-5678",
      address: "台北市中山北路 100 號",
      shipToAddress: "新北市林口區倉庫路 5 號",
    });
    // 白名單而非整列 partners：id_no（PII）之類的欄位絕不可跟著列印回應流出去
    expect(res.json.partner).not.toHaveProperty("idNo");
    expect(res.json.lines).toHaveLength(1);
    expect(res.json.lines[0]).toMatchObject({
      productId,
      productName: "鉛筆",
      sku: "SKU-100",
      unit: "打",
      amount: 1000,
    });
  });

  it("不存在回 404、非數字 id 回 400（都是可讀的訊息，不是 internal error）", async () => {
    const missing = await api("/sales/99999");
    expect(missing.status).toBe(404);
    expect(missing.json.error).toContain("銷貨單不存在");
    const bad = await api("/sales/abc");
    expect(bad.status).toBe(400);
  });

  it("sales 角色看得到（列印是業務的日常），employee 角色被擋", async () => {
    const ok = await api(`/sales/${b2bSaleId}`, undefined, "GET", salesAuth);
    expect(ok.status).toBe(200);
    await api("/users", { username: "worker", displayName: "員工", password: "secret-test", role: "employee" });
    const workerAuth = await loginAs(app, "worker", "secret-test");
    const denied = await api(`/sales/${b2bSaleId}`, undefined, "GET", workerAuth);
    expect(denied.status).toBe(403);
  });
});

describe("B5：發票 XML 單張下載（MIG 檔名慣例）", () => {
  it("F0401 帶 content-disposition，檔名 F0401-<發票號碼>.xml", async () => {
    const res = await app.request(`/invoices/${b2bInvoiceId}/xml`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="F0401-KZ10000000.xml"');
    expect(await res.text()).toContain("urn:GEINV:eInvoiceMessage:F0401:4.1");
  });

  it("F0501 作廢訊息可單張下載；未作廢的發票回 422 並指路", async () => {
    const canceled = await app.request(`/invoices/${b2cInvoiceId}/cancel-xml`, { headers: auth });
    expect(canceled.status).toBe(200);
    expect(canceled.headers.get("content-disposition")).toBe('attachment; filename="F0501-KZ10000001.xml"');
    expect(await canceled.text()).toContain("urn:GEINV:eInvoiceMessage:F0501:4.1");

    const notCanceled = await api(`/invoices/${b2bInvoiceId}/cancel-xml`);
    expect(notCanceled.status).toBe(422);
    expect(notCanceled.json.error).toContain("未作廢");
  });
});

describe("B5：電子發票 XML 批次匯出", () => {
  it("期間內全部 F0401＋已作廢者的 F0501，內容與落地 XML 一字不差", async () => {
    const res = await api("/exports/einvoice-xml?from=2026-07-01&to=2026-08-31");
    expect(res.status).toBe(200);
    expect(res.json.invoiceCount).toBe(2);
    expect(res.json.cancelCount).toBe(1);
    const names = res.json.files.map((f: { name: string }) => f.name);
    expect(names).toEqual(["F0401-KZ10000000.xml", "F0401-KZ10000001.xml", "F0501-KZ10000001.xml"]);

    // 匯出內容必須就是開立當下落地的 XML（golden 逐欄比對在 einvoice 套件；這裡守「不重算不變形」）。
    // 0029 批之後 GET /invoices 清單瘦身、刻意不含 xml/cancelXml——落地 XML 的正式出口
    // 是單張端點，比對改抓它（斷言的目的不變：匯出＝落地內容，不重算不變形）
    const invoices = await api("/invoices");
    const idByNumber = new Map<string, number>(
      invoices.json.map((i: { invoiceNumber: string; id: number }) => [i.invoiceNumber, i.id]),
    );
    for (const f of res.json.files) {
      const number = f.name.slice(6, 16);
      const single = await app.request(
        `/invoices/${idByNumber.get(number)}/${f.name.startsWith("F0501") ? "cancel-xml" : "xml"}`,
        { headers: auth },
      );
      expect(f.content).toBe(await single.text());
    }
    // 內容抽驗：F0401 有發票號碼與買方統編、F0501 有作廢號碼
    expect(res.json.files[0].content).toContain("<InvoiceNumber>KZ10000000</InvoiceNumber>");
    expect(res.json.files[0].content).toContain("<Identifier>04541302</Identifier>");
    expect(res.json.files[2].content).toContain("<CancelInvoiceNumber>KZ10000001</CancelInvoiceNumber>");
  });

  it("依發票日期篩選：範圍外的一張都不帶；範圍縮到只剩 7/21 就只有 B2B 那張", async () => {
    const none = await api("/exports/einvoice-xml?from=2026-09-01&to=2026-09-30");
    expect(none.status).toBe(200);
    expect(none.json.files).toEqual([]);
    const one = await api("/exports/einvoice-xml?from=2026-07-21&to=2026-07-21");
    expect(one.json.invoiceCount).toBe(1);
    expect(one.json.files.map((f: { name: string }) => f.name)).toEqual(["F0401-KZ10000000.xml"]);
  });

  it("缺 from/to 回 400；sales 角色無 exports 頁權限回 403", async () => {
    const bad = await api("/exports/einvoice-xml");
    expect(bad.status).toBe(400);
    const denied = await api("/exports/einvoice-xml?from=2026-07-01&to=2026-08-31", undefined, "GET", salesAuth);
    expect(denied.status).toBe(403);
  });
});
