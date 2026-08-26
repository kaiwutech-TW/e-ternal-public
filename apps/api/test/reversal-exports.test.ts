/**
 * 作廢發票後續處理（沖銷銷貨單／作廢重開）＋記帳士匯出（Phase 4）驗收。
 * 場景：進貨 100 @10 → 兩張銷貨（各 10 @100）→ 一張作廢並沖銷、一張作廢後重開。
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
let customerId: number;
let productId: number;
let saleAId: number; // 作廢並沖銷
let saleBId: number; // 作廢後重開
let invoiceAId: number;
let invoiceBId: number;

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

  await app.request("/company-profile", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "測試賣方", taxId: "22099131" }),
  });
  await api("/invoice-tracks", { period: "202607", track: "KZ", rangeStart: 10000000, rangeEnd: 10000049 });
  // 供應商與客戶的統編不可相同：0022 起 tax_id 有 partial unique index（R5），撞號會 409
  const supplier = await api("/partners", { name: "供應商", taxId: "05004058", isSupplier: true });
  const customer = await api("/partners", { name: "企業客戶", taxId: "04541302", isCustomer: true });
  customerId = customer.json.id;
  const product = await api("/products", { sku: "SKU-200", name: "原子筆" });
  productId = product.json.id;
  const purchase = await api("/purchases", {
    partnerId: supplier.json.id,
    docDate: "2026-07-01",
    lines: [{ productId, qty: 100, unitPrice: 10 }],
  });
  await api(`/purchases/${purchase.json.id}/supplier-invoice`, { track: "AA", no: "12345678" }, "PATCH");

  const saleA = await api("/sales", {
    partnerId: customerId,
    docDate: "2026-07-10",
    lines: [{ productId, qty: 10, unitPrice: 100 }],
  });
  saleAId = saleA.json.id;
  const saleB = await api("/sales", {
    partnerId: customerId,
    docDate: "2026-07-11",
    lines: [{ productId, qty: 10, unitPrice: 100 }],
  });
  saleBId = saleB.json.id;
  const invA = await api(`/sales/${saleAId}/invoice`, { mode: "B2B", randomNumber: "0001" });
  invoiceAId = invA.json.id;
  const invB = await api(`/sales/${saleBId}/invoice`, { mode: "B2B", randomNumber: "0002" });
  invoiceBId = invB.json.id;
});

describe("作廢並沖銷銷貨單", () => {
  it("作廢＋沖銷：回傳迴轉傳票 id，傳票借貸與原傳票互換", async () => {
    const res = await api(`/invoices/${invoiceAId}/cancel`, {
      reason: "交易取消",
      cancelDate: "2026-07-12",
      reverseSale: true,
    });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("canceled");
    expect(res.json.reversalEntryId).toBeTruthy();

    const entry = await api(`/journal-entries/${res.json.reversalEntryId}`);
    expect(entry.status).toBe(200);
    // 0025 起沖銷 memo 統一為「作廢沖轉 …」體例（六種單據同一格式）
    expect(entry.json.memo).toContain(`作廢沖轉 銷貨單 #${saleAId}`);
    expect(entry.json.lines).toHaveLength(5);
    // 原傳票：借 應收 1050／銷貨成本 100；沖銷後借貸互換 → 貸 應收 1050
    const ar = entry.json.lines.find((l: { code: string }) => l.code === "1144");
    expect(ar).toMatchObject({ debit: 0, credit: 1050 });
  });

  it("沖銷後：庫存退回、銷項稅額歸零（帳與 401 對齊）", async () => {
    const inv = await api("/inventory");
    const row = inv.json.find((r: { productId: number }) => r.productId === productId);
    expect(row.qty).toBe(90); // 100 進 − 20 銷 ＋ 10 沖銷退回
    expect(row.amount).toBe(900);

    const tb = await api("/trial-balance");
    const outputTax = tb.json.rows.find((r: { code: string }) => r.code === "2288");
    // 兩張銷貨各貸 50，沖銷 A 借 50 → 淨貸 50，等於在途發票 B 的稅額
    expect(outputTax.credit - outputTax.debit).toBe(50);
    expect(tb.json.totalDebit).toBe(tb.json.totalCredit);
  });

  it("已沖銷的銷貨單不可再開發票（422）、不可重複沖銷", async () => {
    const reissue = await api(`/sales/${saleAId}/invoice`, { mode: "B2B" });
    expect(reissue.status).toBe(422);
  });
});

describe("作廢後重開發票", () => {
  it("僅作廢（不沖銷）後可重開，取得新號碼", async () => {
    const cancel = await api(`/invoices/${invoiceBId}/cancel`, { reason: "買受人統編錯誤" });
    expect(cancel.status).toBe(200);
    expect(cancel.json.reversalEntryId).toBeNull();

    const reissue = await api(`/sales/${saleBId}/invoice`, { mode: "B2B", randomNumber: "0003" });
    expect(reissue.status).toBe(201);
    expect(reissue.json.invoiceNumber).toBe("KZ10000002");
    expect(reissue.json.status).toBe("issued");
  });

  it("已有 issued 發票時再開仍為 409", async () => {
    const res = await api(`/sales/${saleBId}/invoice`, { mode: "B2B" });
    expect(res.status).toBe(409);
  });
});

describe("記帳士匯出", () => {
  it("傳票明細：含 BOM、CRLF、沖銷傳票列；日期範圍過濾生效", async () => {
    const res = await api("/exports/journal?from=2026-07-01&to=2026-07-31");
    expect(res.status).toBe(200);
    expect(res.json.name).toBe("傳票明細_2026-07-01_2026-07-31.csv");
    expect(res.json.content.startsWith("\uFEFF")).toBe(true);
    expect(res.json.content).toContain("\r\n");
    expect(res.json.content).toContain(`作廢沖轉 銷貨單 #${saleAId}`);
    // 進貨 3 分錄＋兩張銷貨各 5＋沖銷 5（重開發票不產生新傳票）
    expect(res.json.rows).toBe(18);
    const empty = await api("/exports/journal?from=2025-01-01&to=2025-12-31");
    expect(empty.json.rows).toBe(0);
  });

  it("銷項發票：三張都列（含兩張作廢與原因）", async () => {
    const res = await api("/exports/sales-invoices?from=2026-07-01&to=2026-07-31");
    expect(res.json.rows).toBe(3);
    expect(res.json.content).toContain("KZ10000000");
    expect(res.json.content).toContain("KZ10000002");
    expect(res.json.content).toContain("已作廢");
    expect(res.json.content).toContain("交易取消");
  });

  it("進項發票：進貨單含發票號碼與金額", async () => {
    const res = await api("/exports/purchases?from=2026-07-01&to=2026-07-31");
    expect(res.json.rows).toBe(1);
    expect(res.json.content).toContain("AA12345678");
    expect(res.json.content).toContain("1000,50,1050");
  });

  it("缺 from/to 回 400", async () => {
    const res = await api("/exports/journal?from=2026-07-01");
    expect(res.status).toBe(400);
  });
});

// 進項 CSV 的發票日期欄與歸期（第三批雜項 ②）：篩選改吃 coalesce(inv_date, doc_date)，
// 與 401 進項歸期（R20）同一條規則——底稿與申報書不同口徑，核對就失去意義
describe("進項 CSV：發票日期欄＋coalesce 歸期篩選", () => {
  let crossMonthId: number;

  beforeAll(async () => {
    // 發票 6/28 開、貨 7/20 才到：401 歸 5-6 月期，CSV 也必須跟著
    const partners = await api("/partners");
    const supplierId = partners.json.find((p: { isSupplier: boolean }) => p.isSupplier).id;
    const p = await api("/purchases", {
      partnerId: supplierId,
      docDate: "2026-07-20",
      lines: [{ productId, qty: 5, unitPrice: 100 }],
    });
    crossMonthId = p.json.id;
    const reg = await api(
      `/purchases/${crossMonthId}/supplier-invoice`,
      { track: "BB", no: "87654321", invDate: "2026-06-28" },
      "PATCH",
    );
    expect(reg.status).toBe(200);
  });

  it("正向：CSV 含「發票日期」欄；跨月發票落在憑證日那一期的檔案，不在進貨月", async () => {
    const june = await api("/exports/purchases?from=2026-06-01&to=2026-06-30");
    expect(june.json.rows).toBe(1);
    expect(june.json.content).toContain("發票日期");
    expect(june.json.content).toContain("BB87654321");
    expect(june.json.content).toContain("2026-06-28"); // 發票日期欄
    expect(june.json.content).toContain("2026-07-20"); // 進貨單日期照列（帳務日與憑證日並存）

    // 7 月的檔不得再出現這張單：同一張單出現在兩期底稿＝可扣抵憑證被數兩次
    const july = await api("/exports/purchases?from=2026-07-01&to=2026-07-31");
    expect(july.json.content).not.toContain("BB87654321");
  });

  it("邊界：沒登發票日期的單以進貨單日期歸期、發票日期欄留空（與 401 的退回同口徑）", async () => {
    // fixture 的 AA12345678（doc_date 7/1、未登 inv_date）仍在 7 月檔，發票日期欄空白
    const july = await api("/exports/purchases?from=2026-07-01&to=2026-07-31");
    expect(july.json.rows).toBe(1);
    const line = july.json.content.split("\r\n").find((l: string) => l.includes("AA12345678"))!;
    expect(line).toContain("AA12345678,,25"); // 發票號碼之後的發票日期欄為空、接格式代號
  });
});
