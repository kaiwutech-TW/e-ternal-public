/**
 * G0401 折讓證明單 XML（第二批）：
 * - GET /sales-returns/:id/g0401-xml 單張下載（MIG 檔名慣例、內容指回原發票）
 * - 產不出來的每一種情況都是可操作的 422：缺證明單號碼/日期、退回單、原銷貨沒開發票
 * - GET /exports/einvoice-xml 批次含 G0401（依證明單日期歸期）＋缺號碼折讓的出聲清單
 * - 明細稅額分攤合計＝單頭稅額（多明細折讓）
 * （XML 逐位元組的欄位序驗證在 packages/einvoice/test/golden.test.ts 的官方範例 golden，
 *  這裡驗的是接線：資料庫的折讓單 → 正確的 G0401 內容與出聲行為）
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
let productId: number;
let penId: number;
let b2bSaleId: number;
let b2bInvoiceNumber: string;
let b2cSaleId: number;
let noInvoiceSaleId: number;

async function api(path: string, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text), text, headers: res.headers };
  } catch {
    return { status: res.status, json: null, text, headers: res.headers };
  }
}

/** 開一張折讓單（在原銷貨的全部明細上各折讓 amounts[i] 元，未稅） */
async function allowance(saleId: number, amounts: number[], cert?: { certNo?: string; certDate?: string }) {
  const info = await api(`/sales/${saleId}/returnable`);
  const res = await api(`/sales/${saleId}/returns`, {
    kind: "allowance",
    docDate: "2026-07-25",
    ...cert,
    lines: amounts.map((amount, i) => ({ sourceLineId: info.json.lines[i].id, amount })),
  });
  expect(res.status).toBe(201);
  return res.json;
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
  const b2b = await api("/partners", { name: "企業客戶", taxId: "04541302", isCustomer: true });
  const b2c = await api("/partners", { name: "散客", isCustomer: true });
  const p1 = await api("/products", { sku: "SKU-1", name: "鉛筆", unit: "打" });
  const p2 = await api("/products", { sku: "SKU-2", name: "鋼筆", unit: "支" });
  productId = p1.json.id;
  penId = p2.json.id;
  await api("/purchases", {
    partnerId: supplier.json.id,
    docDate: "2026-07-01",
    lines: [
      { productId, qty: 100, unitPrice: 10 },
      { productId: penId, qty: 100, unitPrice: 20 },
    ],
  });

  // B2B：兩條明細（驗 OriginalSequenceNumber 與稅額分攤）；B2C：一條；另一張不開發票
  const b2bSale = await api("/sales", {
    partnerId: b2b.json.id,
    docDate: "2026-07-21",
    lines: [
      { productId, qty: 10, unitPrice: 100 },
      { productId: penId, qty: 5, unitPrice: 200 },
    ],
  });
  b2bSaleId = b2bSale.json.id;
  const b2cSale = await api("/sales", {
    partnerId: b2c.json.id,
    docDate: "2026-07-22",
    lines: [{ productId, qty: 3, unitPrice: 33 }],
  });
  b2cSaleId = b2cSale.json.id;
  const plain = await api("/sales", {
    partnerId: b2b.json.id,
    docDate: "2026-07-23",
    lines: [{ productId, qty: 1, unitPrice: 100 }],
  });
  noInvoiceSaleId = plain.json.id;

  await api("/invoice-tracks", { period: "202607", track: "KZ", rangeStart: 10000000, rangeEnd: 10000049 });
  const b2bInv = await api(`/sales/${b2bSaleId}/invoice`, { mode: "B2B", invoiceTime: "10:00:00", randomNumber: "5678" });
  b2bInvoiceNumber = b2bInv.json.invoiceNumber;
  await api(`/sales/${b2cSaleId}/invoice`, { mode: "B2C", invoiceTime: "10:05:00", randomNumber: "0001" });
});

describe("G0401 單張下載", () => {
  it("B2B 折讓（兩明細）：檔名照 MIG 慣例、明細指回原發票與序號、稅額分攤合計＝單頭稅", async () => {
    // 兩明細各折讓 33 元：稅 calcTax(66)=3，逐條分攤 2＋尾差調整 1，合計必須軋回 3
    const doc = await allowance(b2bSaleId, [33, 33], { certNo: "ALW20260001", certDate: "2026-07-26" });
    expect(doc.subtotal).toBe(66);
    expect(doc.tax).toBe(3);

    const res = await app.request(`/sales-returns/${doc.id}/g0401-xml`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="G0401-ALW20260001.xml"');
    const xml = await res.text();
    expect(xml).toContain("urn:GEINV:eInvoiceMessage:G0401:4.1");
    expect(xml).toContain("<AllowanceNumber>ALW20260001</AllowanceNumber>");
    expect(xml).toContain("<AllowanceDate>20260726</AllowanceDate>");
    // 明細指回原發票：號碼、開立日、原明細序號（第 1、2 條 → 001、002）
    expect(xml).toContain(`<OriginalInvoiceNumber>${b2bInvoiceNumber}</OriginalInvoiceNumber>`);
    expect(xml).toContain("<OriginalInvoiceDate>20260721</OriginalInvoiceDate>");
    expect(xml).toContain("<OriginalSequenceNumber>001</OriginalSequenceNumber>");
    expect(xml).toContain("<OriginalSequenceNumber>002</OriginalSequenceNumber>");
    expect(xml).toContain("<OriginalDescription>鉛筆</OriginalDescription>");
    expect(xml).toContain("<OriginalDescription>鋼筆</OriginalDescription>");
    // 買賣方：賣方＝公司統編、買方＝發票上的買方統編快照
    expect(xml).toContain("<Identifier>22099131</Identifier>");
    expect(xml).toContain("<Identifier>04541302</Identifier>");
    expect(xml).toContain("<AllowanceType>2</AllowanceType>");
    // 金額：TotalAmount=未稅合計（G0401 口徑，非含稅）、TaxAmount=單頭稅；
    // 逐明細 Tax 分攤 2＋1，合計軋回 3
    expect(xml).toContain("<TotalAmount>66</TotalAmount>");
    expect(xml).toContain("<TaxAmount>3</TaxAmount>");
    expect(xml).toContain("<Tax>2</Tax>");
    expect(xml).toContain("<Tax>1</Tax>");
  });

  it("B2C 折讓：買方統編 0000000000、金額仍為未稅口徑", async () => {
    const doc = await allowance(b2cSaleId, [50], { certNo: "ALW20260002", certDate: "2026-07-27" });
    const res = await app.request(`/sales-returns/${doc.id}/g0401-xml`, { headers: auth });
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<Identifier>0000000000</Identifier>");
    expect(xml).toContain(`<TotalAmount>${doc.subtotal}</TotalAmount>`);
    expect(xml).toContain(`<TaxAmount>${doc.tax}</TaxAmount>`);
  });

  it("缺證明單號碼的折讓：422 且訊息指路（去哪補登）", async () => {
    const doc = await allowance(b2bSaleId, [10, 0].slice(0, 1)); // 只折第一條明細，未登證明單
    const res = await api(`/sales-returns/${doc.id}/g0401-xml`);
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("還沒登錄證明單號碼");
    expect(res.json.error).toContain("退貨／折讓紀錄");
  });

  it("有號碼、缺日期：422 明說缺的是日期", async () => {
    const doc = await allowance(b2bSaleId, [10], { certNo: "ALW20260003" });
    const res = await api(`/sales-returns/${doc.id}/g0401-xml`);
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("日期");
  });

  it("退回單（kind=return）：422 說明 G0401 僅支援折讓", async () => {
    const info = await api(`/sales/${b2bSaleId}/returnable`);
    const ret = await api(`/sales/${b2bSaleId}/returns`, {
      kind: "return",
      docDate: "2026-07-25",
      certNo: "RET20260001",
      certDate: "2026-07-26",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 1 }],
    });
    expect(ret.status).toBe(201);
    const res = await api(`/sales-returns/${ret.json.id}/g0401-xml`);
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("退回單");
  });

  it("原銷貨沒開電子發票：422 說明折讓證明單必須指回原發票", async () => {
    const doc = await allowance(noInvoiceSaleId, [20], { certNo: "ALW20260004", certDate: "2026-07-28" });
    const res = await api(`/sales-returns/${doc.id}/g0401-xml`);
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("沒有已開立的電子發票");
  });

  it("號碼含檔名放不進的字元：422 指出號碼與允許的字元集", async () => {
    const doc = await allowance(b2cSaleId, [10], { certNo: "折讓 001", certDate: "2026-07-28" });
    const res = await api(`/sales-returns/${doc.id}/g0401-xml`);
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("折讓 001");
    expect(res.json.error).toContain("英數");
  });
});

describe("批次匯出含 G0401（依證明單日期歸期）＋出聲清單", () => {
  it("期間內：F0401 ＋ G0401 齊；缺號碼/日期的折讓逐條出聲；退回單不進折讓批次", async () => {
    const res = await api("/exports/einvoice-xml?from=2026-07-01&to=2026-08-31");
    expect(res.status).toBe(200);
    expect(res.json.invoiceCount).toBe(2);
    // 有完整證明單的折讓兩張（ALW20260001/0002）；0004 原銷貨沒發票 → 進 notes 不進 files
    const names = res.json.files.map((f: { name: string }) => f.name);
    expect(names).toContain("G0401-ALW20260001.xml");
    expect(names).toContain("G0401-ALW20260002.xml");
    expect(names.filter((n: string) => n.startsWith("G0401"))).toHaveLength(2);
    expect(res.json.allowanceCount).toBe(2);
    // 出聲清單：缺號碼×1、缺日期×1、沒發票×1、號碼字元不合法×1——一條都不准靜默
    expect(res.json.notes.some((n: string) => n.includes("還沒登錄證明單號碼與日期"))).toBe(true);
    expect(res.json.notes.some((n: string) => n.includes("還沒登錄證明單日期"))).toBe(true);
    expect(res.json.notes.some((n: string) => n.includes("沒有已開立的電子發票"))).toBe(true);
    expect(res.json.notes.some((n: string) => n.includes("折讓 001"))).toBe(true);
    // 退回單（RET20260001）不會被當成折讓產出
    expect(names).not.toContain("G0401-RET20260001.xml");
  });

  it("依證明單日期篩選：折讓日在期間內但證明單日期在期間外 → 不帶檔", async () => {
    // ALW20260001 證明單日 2026-07-26：把窗口縮到 8 月，折讓檔應消失、也不出聲（歸期不在本期）
    const res = await api("/exports/einvoice-xml?from=2026-08-01&to=2026-08-31");
    expect(res.status).toBe(200);
    const names = res.json.files.map((f: { name: string }) => f.name);
    expect(names.filter((n: string) => n.startsWith("G0401"))).toHaveLength(0);
    expect(res.json.allowanceCount).toBe(0);
    // 缺號碼的折讓單歸期看折讓日（7 月），也不該在 8 月的窗口出聲
    expect(res.json.notes).toHaveLength(0);
  });
});
