/**
 * 處分發票登錄（0034，B14(b) 尾款）驗收：
 * 1. 處分時勾「開立發票」：發票金額＝處分價款、稅額＝處分稅額（取處分落地值，不重算），
 *    401 銷項自然涵蓋（原本 2288 只有 taxNotes 出聲，不進 401）
 * 2. 作廢連動與銷貨發票同規則：處分已開票不可直接作廢處分（先廢發票）；
 *    發票「僅作廢」帳不動、可補開重開；「作廢並沖回處分」資產回到使用中
 * 3. 防呆：報廢（價款 0）／不計稅處分／B2B 缺統編／尚未處分——都開不了發票，
 *    且處分＋開票是同一交易（開票失敗整筆處分回滾）
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
let b2bBuyerId: number;
let b2cBuyerId: number;

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

/** 登錄資產＋補取得傳票（處分前置：成本未入帳會被 422 擋，見 B14(a)） */
async function registerAsset(input: Record<string, unknown>, assetCode = "1421") {
  const res = await api("/fixed-assets", input);
  expect(res.status).toBe(201);
  const entry = await api("/journal-entries", {
    entryDate: input["startDate"],
    memo: `購入 ${input["name"]}`,
    lines: [
      { accountCode: assetCode, debit: input["cost"], credit: 0 },
      { accountCode: "1103", debit: 0, credit: input["cost"] },
    ],
  });
  expect(entry.status).toBe(201);
  return res.json.id as number;
}

async function assetById(id: number) {
  const rows = (await api("/fixed-assets")).json as {
    id: number;
    status: string;
    disposalVoidedAt: string | null;
    disposalTax: number | null;
  }[];
  return rows.find((a) => a.id === id)!;
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
    body: JSON.stringify({ name: "測試賣方公司", taxId: "22099131", taxRegistrationNo: "123456789", cityCode: "A" }),
  });
  b2bBuyerId = (await api("/partners", { name: "二手設備商", taxId: "04541302", isCustomer: true })).json.id;
  b2cBuyerId = (await api("/partners", { name: "個人買家", isCustomer: true })).json.id;
  // 處分日落在 2026-07 → 期別 202607
  const track = await api("/invoice-tracks", { period: "202607", track: "KZ", rangeStart: 10000000, rangeEnd: 10000049 });
  expect(track.status).toBe(201);
});

describe("處分＋同時開立發票 → 401 銷項自然涵蓋", () => {
  let assetB2B: number;
  let assetB2C: number;
  let b2bInvoiceId: number;

  it("B2B：處分 42,000 含稅（未稅 40,000＋稅 2,000）同時開票，金額＝處分落地值", async () => {
    // 36,000／3 年 → 殘值 9,000、月折 750；1〜7 月補提 7 期＝5,250、帳面 30,750
    assetB2B = await registerAsset({ name: "工作站", category: "computer", cost: 36000, startDate: "2026-01-10" });
    const res = await api(`/fixed-assets/${assetB2B}/dispose`, {
      date: "2026-07-15",
      proceeds: 42000,
      accountCode: "1103",
      invoice: { mode: "B2B", partnerId: b2bBuyerId, invoiceTime: "10:00:00", randomNumber: "1234" },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ netProceeds: 40000, tax: 2000, gain: 40000 - 30750 });
    expect(res.json.invoice).toMatchObject({
      invoiceNumber: "KZ10000000",
      assetId: assetB2B,
      saleId: null,
      invoiceDate: "2026-07-15", // 發票日期＝處分日（銷項歸期跟著處分那一期）
      mode: "B2B",
      buyerTaxId: "04541302",
      salesAmount: 40000,
      taxAmount: 2000,
      totalAmount: 42000,
      taxType: "1",
      status: "issued",
    });
    b2bInvoiceId = res.json.invoice.id;
    // 已開票就不再出「請開立統一發票」的提醒，改出「已開立」的確認
    const notes = (res.json.taxNotes as string[]).join("\n");
    expect(notes).toContain("已開立發票 KZ10000000");
    expect(notes).not.toContain("要開立統一發票才會進 401");
    // XML：B2B 稅額分離
    const xml = (await api(`/invoices/${b2bInvoiceId}/xml`)).text;
    expect(xml).toContain("<SalesAmount>40000</SalesAmount>");
    expect(xml).toContain("<TaxAmount>2000</TaxAmount>");
    expect(xml).toContain("<TotalAmount>42000</TotalAmount>");
    expect(xml).toContain("處分固定資產：工作站");
  });

  it("B2C：發票依 MIG 慣例存含稅總額（salesAmount＝totalAmount、taxAmount=0）", async () => {
    assetB2C = await registerAsset({ name: "公務機車", category: "vehicle", cost: 63000, startDate: "2026-06-05" }, "1431");
    const res = await api(`/fixed-assets/${assetB2C}/dispose`, {
      date: "2026-07-20",
      proceeds: 10500,
      accountCode: "1103",
      invoice: { mode: "B2C", partnerId: b2cBuyerId, invoiceTime: "11:00:00", randomNumber: "5678" },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ netProceeds: 10000, tax: 500 });
    expect(res.json.invoice).toMatchObject({
      invoiceNumber: "KZ10000001",
      mode: "B2C",
      buyerTaxId: null,
      salesAmount: 10500,
      taxAmount: 0,
      totalAmount: 10500,
    });
  });

  it("401（202607）：兩張處分發票都進銷項——B2B 直取、B2C 依快照費率拆算", async () => {
    const res = await api("/vat-returns/401?period=202607");
    expect(res.status).toBe(200);
    expect(res.json.summary.outputSales).toBe(40000 + 10000);
    expect(res.json.summary.outputTax).toBe(2000 + 500);
  });

  it("處分已開票：直接作廢處分 409 指路先廢發票（發票是對外憑證，處分不能先於憑證消失）", async () => {
    const res = await api(`/fixed-assets/${assetB2B}/dispose/void`, { reason: "測試不該過" });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("KZ10000000");
    expect(res.json.error).toContain("先");
  });

  it("發票「僅作廢」：帳不動、資產維持已處分；401 少掉這張；可補開重開", async () => {
    const cancel = await api(`/invoices/${b2bInvoiceId}/cancel`, { reason: "統編打錯，作廢重開" });
    expect(cancel.status).toBe(200);
    expect(cancel.json.reversalEntryId).toBeNull();
    expect((await assetById(assetB2B)).status).toBe("disposed");
    const after = await api("/vat-returns/401?period=202607");
    expect(after.json.summary.outputSales).toBe(10000); // 只剩 B2C 那張
    expect(after.json.summary.outputTax).toBe(500);
    // 補開（作廢重開的入口）：金額仍＝處分落地值、拿下一個號碼
    const reissue = await api(`/fixed-assets/${assetB2B}/invoice`, { mode: "B2B", partnerId: b2bBuyerId });
    expect(reissue.status).toBe(201);
    expect(reissue.json).toMatchObject({ invoiceNumber: "KZ10000002", salesAmount: 40000, taxAmount: 2000 });
    b2bInvoiceId = reissue.json.id;
    // 同一筆處分至多一張 issued：再開 409
    expect((await api(`/fixed-assets/${assetB2B}/invoice`, { mode: "B2B", partnerId: b2bBuyerId })).status).toBe(409);
  });

  it("「作廢並沖回處分」：反向傳票、資產回到使用中；帶錯旗標（reverseSale）422", async () => {
    const wrong = await api(`/invoices/${b2bInvoiceId}/cancel`, { reason: "測試", reverseSale: true });
    expect(wrong.status).toBe(422);
    expect(wrong.json.error).toContain("reverseDisposal");
    const res = await api(`/invoices/${b2bInvoiceId}/cancel`, { reason: "根本沒賣，處分是誤操作", reverseDisposal: true });
    expect(res.status).toBe(200);
    expect(res.json.reversalEntryId).not.toBeNull();
    const asset = await assetById(assetB2B);
    expect(asset.status).toBe("active");
    expect(asset.disposalVoidedAt).not.toBeNull();
    // 沖回後 401 只剩 B2C；作廢的兩張發票都以課稅別 F 留在媒體檔（不重述金額）
    const after = await api("/vat-returns/401?period=202607");
    expect(after.json.summary.outputSales).toBe(10000);
    expect(after.json.summary.outputTax).toBe(500);
  });

  it("銷貨發票帶 reverseDisposal 也 422（旗標與來源對不上不能靜默）", async () => {
    const product = await api("/products", { sku: "DI-SKU", name: "測試品" });
    const supplier = await api("/partners", { name: "供應商", isSupplier: true });
    await api("/purchases", {
      partnerId: supplier.json.id,
      docDate: "2026-07-01",
      lines: [{ productId: product.json.id, qty: 10, unitPrice: 10 }],
    });
    const sale = await api("/sales", {
      partnerId: b2bBuyerId,
      docDate: "2026-07-21",
      lines: [{ productId: product.json.id, qty: 1, unitPrice: 100 }],
    });
    const inv = await api(`/sales/${sale.json.id}/invoice`, { mode: "B2B" });
    expect(inv.status).toBe(201);
    const res = await api(`/invoices/${inv.json.id}/cancel`, { reason: "測試", reverseDisposal: true });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("reverseSale");
  });
});

describe("防呆：開不了發票的處分", () => {
  it("報廢（價款 0）：不需發票，422；不開票的計稅處分 taxNotes 照樣出聲提醒", async () => {
    const scrapped = await registerAsset({ name: "報廢冰箱", category: "office", cost: 12000, startDate: "2026-06-01" }, "1421");
    const dispose = await api(`/fixed-assets/${scrapped}/dispose`, { date: "2026-07-25", proceeds: 0 });
    expect(dispose.status).toBe(200);
    expect((await api(`/fixed-assets/${scrapped}/invoice`, { mode: "B2B", partnerId: b2bBuyerId })).status).toBe(422);

    const sold = await registerAsset({ name: "未開票貨架", category: "office", cost: 21000, startDate: "2026-06-01" }, "1421");
    const soldRes = await api(`/fixed-assets/${sold}/dispose`, { date: "2026-07-26", proceeds: 2100, accountCode: "1103" });
    expect(soldRes.status).toBe(200);
    expect((soldRes.json.taxNotes as string[]).join("\n")).toContain("要開立統一發票才會進 401");
  });

  it("不計稅處分：開票 422；處分＋開票同一交易——開票失敗整筆處分回滾", async () => {
    const id = await registerAsset({ name: "免稅處分測試", category: "office", cost: 30000, startDate: "2026-06-01" }, "1421");
    const combined = await api(`/fixed-assets/${id}/dispose`, {
      date: "2026-07-27",
      proceeds: 5000,
      accountCode: "1103",
      taxable: false,
      invoice: { mode: "B2B", partnerId: b2bBuyerId },
    });
    expect(combined.status).toBe(422);
    expect(combined.json.error).toContain("不計稅");
    // 回滾驗證：資產仍在使用中（沒有「帳已沖轉、發票沒開成」的中間態）
    expect((await assetById(id)).status).toBe("active");
  });

  it("B2B 買方缺統編 422（整筆處分回滾）；尚未處分的資產開票 422", async () => {
    const id = await registerAsset({ name: "統編測試", category: "office", cost: 30000, startDate: "2026-06-01" }, "1421");
    const res = await api(`/fixed-assets/${id}/dispose`, {
      date: "2026-07-28",
      proceeds: 10500,
      accountCode: "1103",
      invoice: { mode: "B2B", partnerId: b2cBuyerId }, // 個人買家沒統編
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("統編");
    expect((await assetById(id)).status).toBe("active");
    const notDisposed = await api(`/fixed-assets/${id}/invoice`, { mode: "B2B", partnerId: b2bBuyerId });
    expect(notDisposed.status).toBe(422);
    expect(notDisposed.json.error).toContain("不是已處分狀態");
  });
});
