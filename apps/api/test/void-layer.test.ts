/**
 * B4 驗收（migration 0025）：單據的作廢／更正層——「更正＝作廢＋重開，不是就地改」。
 * 每種單據驗三件事：①作廢後反向傳票把總帳沖平 ②彙總（餘額／帳齡／401／年度彙總）排除
 * ③原單留痕（voided_at／void_reason／reversal_entry_id，永不刪除）。
 * 另驗：發票未作廢不得作廢銷貨、關帳期間 409 並指路、作廢不可再作廢、
 * 理由必填、作廢限財務／管理者、訂單出貨量隨銷貨作廢退回。
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { loginAs, setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let admin: Record<string, string>;
let supplierId: number;
let customerId: number;
let landlordId: number; // 個人房東（扣繳）
let productId: number;
let product2Id: number;
let cashAccountId: number;

async function api(path: string, body?: unknown, method = body ? "POST" : "GET", headers = admin) {
  const res = await app.request(path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** 某科目在試算表上的淨額（借−貸） */
async function accountNet(code: string): Promise<number> {
  const tb = await api("/trial-balance");
  const row = tb.json.rows.find((r: { code: string }) => r.code === code);
  return row ? row.debit - row.credit : 0;
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
    body: JSON.stringify({
      name: "測試公司",
      taxId: "22099131",
      address: "台北市測試路1號",
      taxRegistrationNo: "123456789",
      cityCode: "A",
    }),
  });
  supplierId = (await api("/partners", { name: "供應商甲", taxId: "04541302", isSupplier: true })).json.id;
  customerId = (await api("/partners", { name: "客戶乙", taxId: "12345675", isCustomer: true })).json.id;
  landlordId = (await api("/partners", { name: "王房東", isIndividual: true, idNo: "TEST000001" })).json.id;
  productId = (await api("/products", { sku: "V-001", name: "商品一" })).json.id;
  product2Id = (await api("/products", { sku: "V-002", name: "商品二" })).json.id;
  cashAccountId = (await api("/accounts")).json.find((a: { code: string }) => a.code === "1101").id;
  // 備庫存：商品一 100 個 @10
  await api("/purchases", { partnerId: supplierId, docDate: "2026-08-01", lines: [{ productId, qty: 100, unitPrice: 10 }] });
  // 開發票用字軌（2026-08 屬期別 202607）
  await api("/invoice-tracks", { period: "202607", track: "VD", rangeStart: 20000000, rangeEnd: 20000049 });
});

describe("收付款單作廢", () => {
  let saleId: number;
  let receiptId: number;
  let reversalEntryId: number;

  it("收款單（含立沖）作廢：反向傳票沖平、餘額與帳齡回復、立沖釋放", async () => {
    const sale = await api("/sales", { partnerId: customerId, docDate: "2026-08-05", lines: [{ productId, qty: 10, unitPrice: 100 }] });
    expect(sale.status).toBe(201);
    saleId = sale.json.id;
    const receipt = await api("/cash-docs", {
      kind: "receipt",
      partnerId: customerId,
      docDate: "2026-08-06",
      amount: 600,
      accountId: cashAccountId,
      allocations: [{ targetId: saleId, amount: 600 }],
    });
    expect(receipt.status).toBe(201);
    receiptId = receipt.json.id;
    const before = (await api("/partner-balances")).json.find((b: { partnerId: number }) => b.partnerId === customerId);
    expect(before.ar).toBe(450); // 1050 − 600

    const voided = await api(`/cash-docs/${receiptId}/void`, { reason: "金額打錯，應為 6000" });
    expect(voided.status).toBe(200);
    expect(voided.json.reversalEntryId).toBeTruthy();
    reversalEntryId = voided.json.reversalEntryId;

    // ① 反向傳票沖平：借 1144（原貸），貸 1101（原借）
    const entry = await api(`/journal-entries/${reversalEntryId}`);
    expect(entry.json.memo).toContain(`作廢沖轉 收款單 #${receiptId}`);
    expect(entry.json.memo).toContain("金額打錯");
    const ar = entry.json.lines.find((l: { code: string }) => l.code === "1144");
    expect(ar).toMatchObject({ debit: 600, credit: 0 });

    // ② 彙總排除：餘額回到 1050、帳齡回到 1050、未沖清單的立沖釋放
    const after = (await api("/partner-balances")).json.find((b: { partnerId: number }) => b.partnerId === customerId);
    expect(after.ar).toBe(1050);
    const aging = await api("/reports/ar-aging?asOf=2026-08-31");
    const agingRow = aging.json.rows.find((r: { partnerId: number }) => r.partnerId === customerId);
    expect(agingRow.total).toBe(1050);
    const open = await api(`/open-documents?partnerId=${customerId}&kind=receipt`);
    const openSale = open.json.find((d: { docType: string; id: number }) => d.docType === "sale" && d.id === saleId);
    expect(openSale.allocated).toBe(0);
    expect(openSale.remaining).toBe(1050);

    // ③ 原單留痕：單據還在、標記齊全
    const rows = await api("/cash-docs");
    const row = rows.json.find((d: { id: number }) => d.id === receiptId);
    expect(row.voidedAt).toBeTruthy();
    expect(row.voidReason).toBe("金額打錯，應為 6000");
    expect(row.reversalEntryId).toBe(reversalEntryId);
  });

  it("作廢不可再作廢（409）；理由必填（400）", async () => {
    const again = await api(`/cash-docs/${receiptId}/void`, { reason: "再廢一次" });
    expect(again.status).toBe(409);
    expect(again.json.error).toContain("已於");
    const noReason = await api(`/cash-docs/${receiptId + 999}/void`, { reason: "" });
    expect(noReason.status).toBe(400);
  });
});

describe("手工傳票作廢", () => {
  let entryId: number;

  it("手工傳票作廢：反向傳票沖平、原傳票留痕", async () => {
    const entry = await api("/journal-entries", {
      entryDate: "2026-08-06",
      memo: "測試調整分錄",
      lines: [
        { accountCode: "6131", debit: 300, credit: 0 },
        { accountCode: "1101", debit: 0, credit: 300 },
      ],
    });
    expect(entry.status).toBe(201);
    entryId = entry.json.id;
    const netBefore = await accountNet("6131");

    const voided = await api(`/journal-entries/${entryId}/void`, { reason: "科目選錯" });
    expect(voided.status).toBe(200);
    // ① 總帳沖平：6131 淨額回到作廢前建立這張傳票之前
    expect(await accountNet("6131")).toBe(netBefore - 300);
    // 反向傳票也是手工傳票、sourceId 指向原傳票
    const rev = await api(`/journal-entries/${voided.json.reversalEntryId}`);
    expect(rev.json.sourceType).toBe("manual");
    expect(rev.json.sourceId).toBe(entryId);
    // ③ 原單留痕
    const orig = await api(`/journal-entries/${entryId}`);
    expect(orig.json.voidedAt).toBeTruthy();
    expect(orig.json.voidReason).toBe("科目選錯");
  });

  it("系統拋轉的傳票不可直接作廢（422 並指路來源單據）；已作廢不可再作廢", async () => {
    // 銷貨傳票（sourceType=sale）
    const sales = await api("/sales");
    const systemEntryId = sales.json[0].journalEntryId;
    const res = await api(`/journal-entries/${systemEntryId}/void`, { reason: "test" });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("系統自動拋轉");
    const again = await api(`/journal-entries/${entryId}/void`, { reason: "再廢" });
    expect(again.status).toBe(409);
  });

  it("作廢時產生的反向沖轉傳票不可再被作廢（否則形同悄悄復活原傳票）", async () => {
    const entry = await api("/journal-entries", {
      entryDate: "2026-08-06",
      memo: "測試 un-void 縫隙",
      lines: [
        { accountCode: "6131", debit: 70, credit: 0 },
        { accountCode: "1101", debit: 0, credit: 70 },
      ],
    });
    expect(entry.status).toBe(201);
    const voided = await api(`/journal-entries/${entry.json.id}/void`, { reason: "打錯" });
    expect(voided.status).toBe(200);
    // 二階：作廢那張反向傳票——放行的話原傳票標著已作廢、數字卻活回來
    const unvoid = await api(`/journal-entries/${voided.json.reversalEntryId}/void`, { reason: "其實原傳票是對的" });
    expect(unvoid.status).toBe(422);
    expect(unvoid.json.error).toContain("反向沖轉傳票");
    expect(unvoid.json.error).toContain("重開");
  });
});

describe("扣繳支出單作廢（B4 最貴的一格）", () => {
  let wrongId: number;

  it("打錯一個零的單作廢後：年度彙總排除、2211 沖平、原單留痕", async () => {
    const cat = await api("/withholding-categories", {
      label: "租金測試",
      expenseAccountCode: "6111",
      taxRateBp: 1000,
      sourceNote: "測試用中性數字",
    });
    expect(cat.status).toBe(201);
    const wrong = await api("/withholding-payments", {
      partnerId: landlordId,
      categoryId: cat.json.id,
      payDate: "2026-08-10",
      grossAmount: 380000, // 打錯一個零
      cashAccountId,
    });
    expect(wrong.status).toBe(201);
    wrongId = wrong.json.id;
    expect(wrong.json.taxWithheld).toBe(38000);

    const voided = await api(`/withholding-payments/${wrongId}/void`, { reason: "多打一個零，作廢重開" });
    expect(voided.status).toBe(200);
    // 重開正確的單
    const correct = await api("/withholding-payments", {
      partnerId: landlordId,
      categoryId: cat.json.id,
      payDate: "2026-08-10",
      grossAmount: 38000,
      cashAccountId,
    });
    expect(correct.status).toBe(201);

    // ① 2211 沖平：只剩正確單的 3800
    expect(await accountNet("2211")).toBe(-3800);
    // ② 年度彙總排除：受領人不會被掛上不存在的 380,000 所得
    const summary = await api("/withholding-payments/summary?year=2026");
    expect(summary.json.total.grossAmount).toBe(38000);
    expect(summary.json.total.taxWithheld).toBe(3800);
    const liability = summary.json.liabilities.find((l: { code: string }) => l.code === "2211");
    expect(liability.balance).toBe(3800);
    // ③ 原單留痕：清單仍看得到、帶作廢標記
    const list = await api("/withholding-payments");
    const row = list.json.find((p: { id: number }) => p.id === wrongId);
    expect(row.voidedAt).toBeTruthy();
    expect(row.voidReason).toContain("多打一個零");
  });

  it("已作廢不可再作廢（409）", async () => {
    const again = await api(`/withholding-payments/${wrongId}/void`, { reason: "再廢" });
    expect(again.status).toBe(409);
  });
});

describe("銷貨單作廢", () => {
  let saleId: number;
  let invoiceId: number;

  it("有 issued 發票的銷貨單不得作廢（409 指路先作廢發票）", async () => {
    const sale = await api("/sales", { partnerId: customerId, docDate: "2026-08-07", lines: [{ productId, qty: 5, unitPrice: 100 }] });
    saleId = sale.json.id;
    const inv = await api(`/sales/${saleId}/invoice`, { mode: "B2B" });
    expect(inv.status).toBe(201);
    invoiceId = inv.json.id;

    const res = await api(`/sales/${saleId}/void`, { reason: "下錯單" });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("先");
    expect(res.json.error).toContain("作廢");
  });

  it("發票作廢後可作廢銷貨單：傳票沖平、庫存回補、彙總排除、原單留痕", async () => {
    const cancel = await api(`/invoices/${invoiceId}/cancel`, { reason: "交易取消", cancelDate: "2026-08-07" });
    expect(cancel.status).toBe(200);
    const invBefore = (await api("/inventory")).json.find((r: { productId: number }) => r.productId === productId);

    const voided = await api(`/sales/${saleId}/void`, { reason: "整筆交易取消" });
    expect(voided.status).toBe(200);
    expect(voided.json.reversalEntryId).toBeTruthy();

    // ① 反向傳票沖平：4101 該單的 500 收入被貸借互換沖掉
    const entry = await api(`/journal-entries/${voided.json.reversalEntryId}`);
    expect(entry.json.memo).toContain(`作廢沖轉 銷貨單 #${saleId}`);
    const revenue = entry.json.lines.find((l: { code: string }) => l.code === "4101");
    expect(revenue).toMatchObject({ debit: 500, credit: 0 });
    // 庫存回補 5 個
    const invAfter = (await api("/inventory")).json.find((r: { productId: number }) => r.productId === productId);
    expect(invAfter.qty).toBe(invBefore.qty + 5);
    // ② 彙總排除：餘額與帳齡不再包含這張 525
    const balance = (await api("/partner-balances")).json.find((b: { partnerId: number }) => b.partnerId === customerId);
    expect(balance.ar).toBe(1050); // 只剩第一張未收的銷貨
    // ③ 原單留痕
    const rows = await api("/sales");
    const row = rows.json.find((d: { id: number }) => d.id === saleId);
    expect(row.voidedAt).toBeTruthy();
    expect(row.voidReason).toBe("整筆交易取消");
    expect(row.reversalEntryId).toBe(voided.json.reversalEntryId);
  });

  it("已作廢（沖銷）的銷貨單不可再作廢、不可開退回單", async () => {
    const again = await api(`/sales/${saleId}/void`, { reason: "再廢" });
    expect(again.status).toBe(409);
    const ret = await api(`/sales/${saleId}/returns`, {
      kind: "return",
      docDate: "2026-08-08",
      lines: [{ sourceLineId: 1, qty: 1 }],
    });
    expect(ret.status).toBe(409);
  });

  it("有退回單掛著的銷貨單不得作廢（409）", async () => {
    const sale = await api("/sales", { partnerId: customerId, docDate: "2026-08-08", lines: [{ productId, qty: 4, unitPrice: 100 }] });
    const returnable = await api(`/sales/${sale.json.id}/returnable`);
    const lineId = returnable.json.lines[0].id;
    const ret = await api(`/sales/${sale.json.id}/returns`, {
      kind: "return",
      docDate: "2026-08-09",
      lines: [{ sourceLineId: lineId, qty: 1 }],
    });
    expect(ret.status).toBe(201);
    const res = await api(`/sales/${sale.json.id}/void`, { reason: "test" });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("退回");
  });

  it("由訂單出貨的銷貨單作廢：出貨量退回訂單、狀態重推", async () => {
    const order = await api("/orders", { partnerId: customerId, orderDate: "2026-08-09", lines: [{ productId, qty: 3, unitPrice: 100 }] });
    expect(order.status).toBe(201);
    const shipped = await api(`/orders/${order.json.id}/ship`, { docDate: "2026-08-09" });
    expect(shipped.status).toBe(201);
    expect(shipped.json.order.status).toBe("closed");
    const shippedSaleId = shipped.json.saleId;

    const voided = await api(`/sales/${shippedSaleId}/void`, { reason: "客戶取消整筆訂單" });
    expect(voided.status).toBe(200);
    const orders = await api("/orders");
    const after = orders.json.find((o: { id: number }) => o.id === order.json.id);
    expect(after.status).toBe("open");
    expect(Number(after.lines[0].shippedQty)).toBe(0);
  });
});

describe("進貨單作廢", () => {
  it("已登錄發票的進貨單作廢：401 進項排除、庫存沖出、餘額排除、原單留痕", async () => {
    const purchase = await api("/purchases", { partnerId: supplierId, docDate: "2026-08-11", lines: [{ productId, qty: 10, unitPrice: 10 }] });
    const purchaseId = purchase.json.id;
    const reg = await api(`/purchases/${purchaseId}/supplier-invoice`, { track: "AB", no: "12345678" }, "PATCH");
    expect(reg.status).toBe(200);
    const vatBefore = await api("/vat-returns/401?period=202607");
    const inputTaxBefore = vatBefore.json.summary.inputExpenseTax;
    const invBefore = (await api("/inventory")).json.find((r: { productId: number }) => r.productId === productId);
    const apBefore = (await api("/partner-balances")).json.find((b: { partnerId: number }) => b.partnerId === supplierId);

    const voided = await api(`/purchases/${purchaseId}/void`, { reason: "重複建單" });
    expect(voided.status).toBe(200);
    expect(voided.json.reversalEntryId).toBeTruthy();

    // ① 反向傳票沖平：貸 存貨 100、借 應付 105
    const entry = await api(`/journal-entries/${voided.json.reversalEntryId}`);
    expect(entry.json.memo).toContain(`作廢沖轉 進貨單 #${purchaseId}`);
    const inventory = entry.json.lines.find((l: { code: string }) => l.code === "1301");
    expect(inventory).toMatchObject({ debit: 0, credit: 100 });
    // 庫存沖出 10 個
    const invAfter = (await api("/inventory")).json.find((r: { productId: number }) => r.productId === productId);
    expect(invAfter.qty).toBe(invBefore.qty - 10);
    // ② 彙總排除：401 進項稅額回到作廢前（未含這張的 5 元）、應付餘額回復
    const vatAfter = await api("/vat-returns/401?period=202607");
    expect(vatAfter.json.summary.inputExpenseTax).toBe(inputTaxBefore - 5);
    const apAfter = (await api("/partner-balances")).json.find((b: { partnerId: number }) => b.partnerId === supplierId);
    expect(apAfter.ap).toBe(apBefore.ap - 105);
    // 進項發票 CSV 不再列出這張
    const csv = await api("/exports/purchases?from=2026-08-01&to=2026-08-31");
    expect(csv.json.content).not.toContain("AB12345678");
    // ③ 原單留痕＋不可再作廢＋不可再退出
    const rows = await api("/purchases");
    const row = rows.json.find((d: { id: number }) => d.id === purchaseId);
    expect(row.voidedAt).toBeTruthy();
    expect(row.voidReason).toBe("重複建單");
    expect((await api(`/purchases/${purchaseId}/void`, { reason: "再廢" })).status).toBe(409);
    const returnable = await api(`/purchases/${purchaseId}/returnable`);
    expect(returnable.json.voided).toBe(true);
  });

  it("在庫不足（貨已賣出）不得作廢：409 指路進貨退出單", async () => {
    const purchase = await api("/purchases", { partnerId: supplierId, docDate: "2026-08-12", lines: [{ productId: product2Id, qty: 5, unitPrice: 20 }] });
    const sold = await api("/sales", { partnerId: customerId, docDate: "2026-08-12", lines: [{ productId: product2Id, qty: 3, unitPrice: 50 }] });
    expect(sold.status).toBe(201);
    const res = await api(`/purchases/${purchase.json.id}/void`, { reason: "test" });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("不足以沖回");
    expect(res.json.error).toContain("退出");
  });

  it("有退出單掛著的進貨單不得作廢（409）", async () => {
    const purchase = await api("/purchases", { partnerId: supplierId, docDate: "2026-08-13", lines: [{ productId, qty: 6, unitPrice: 10 }] });
    const returnable = await api(`/purchases/${purchase.json.id}/returnable`);
    const ret = await api(`/purchases/${purchase.json.id}/returns`, {
      kind: "return",
      docDate: "2026-08-13",
      lines: [{ sourceLineId: returnable.json.lines[0].id, qty: 2 }],
    });
    expect(ret.status).toBe(201);
    const res = await api(`/purchases/${purchase.json.id}/void`, { reason: "test" });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("退出");
  });
});

describe("報價單作廢", () => {
  it("open 報價可作廢並留痕；won 不可作廢", async () => {
    const quote = await api("/quotes", { partnerId: customerId, quoteDate: "2026-08-14", lines: [{ productId, qty: 1, unitPrice: 100 }] });
    const voided = await api(`/quotes/${quote.json.id}/void`, { reason: "重複建單" });
    expect(voided.status).toBe(200);
    expect(voided.json.voidedAt).toBeTruthy();
    expect(voided.json.voidReason).toBe("重複建單");
    // 狀態不變（作廢與失單是兩件事）、清單仍看得到
    const list = await api("/quotes");
    const row = list.json.find((q: { id: number }) => q.id === quote.json.id);
    expect(row.voidedAt).toBeTruthy();
    expect((await api(`/quotes/${quote.json.id}/void`, { reason: "再廢" })).status).toBe(409);

    const quote2 = await api("/quotes", { partnerId: customerId, quoteDate: "2026-08-14", lines: [{ productId, qty: 1, unitPrice: 100 }] });
    const converted = await api(`/quotes/${quote2.json.id}/convert`, { orderDate: "2026-08-14" });
    expect(converted.status).toBe(201);
    const res = await api(`/quotes/${quote2.json.id}/void`, { reason: "test" });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("訂單");
  });
});

describe("作廢 vs 立沖/預收的懸空檢查（第三批①）", () => {
  it("已被收款單立沖的銷貨單不得作廢（409 指路）；先作廢收款單後即可作廢（解鎖路徑通）", async () => {
    const c2 = (await api("/partners", { name: "懸空客戶甲", isCustomer: true })).json.id;
    const sale = await api("/sales", { partnerId: c2, docDate: "2026-08-15", lines: [{ productId, qty: 2, unitPrice: 500 }] });
    expect(sale.status).toBe(201); // 1050 含稅
    const receipt = await api("/cash-docs", {
      kind: "receipt",
      partnerId: c2,
      docDate: "2026-08-15",
      amount: 1050,
      accountId: cashAccountId,
      allocations: [{ targetId: sale.json.id, amount: 1050 }],
    });
    expect(receipt.status).toBe(201);

    // 懸空 409：收款單還活著就不能廢它沖過的銷貨單
    const blocked = await api(`/sales/${sale.json.id}/void`, { reason: "下錯單" });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain(`收款單 #${receipt.json.id}`);
    expect(blocked.json.error).toContain("先作廢");

    // 解鎖路徑：先作廢收款單，銷貨單就廢得掉
    expect((await api(`/cash-docs/${receipt.json.id}/void`, { reason: "連同銷貨一起取消" })).status).toBe(200);
    const ok = await api(`/sales/${sale.json.id}/void`, { reason: "下錯單" });
    expect(ok.status).toBe(200);
    // 兩張都廢掉後餘額歸零（不是變負）
    const balance = (await api("/partner-balances")).json.find((b: { partnerId: number }) => b.partnerId === c2);
    expect(balance).toBeUndefined();
  });

  it("已被預收沖用的銷貨單不得作廢（409）；作廢收款單（連同沖用反向）後可作廢", async () => {
    const c3 = (await api("/partners", { name: "懸空客戶乙", isCustomer: true })).json.id;
    // 純預收：沒有未沖單據，整筆掛 2231
    const receipt = await api("/cash-docs", { kind: "receipt", partnerId: c3, docDate: "2026-08-15", amount: 2000, accountId: cashAccountId });
    expect(receipt.status).toBe(201);
    expect(receipt.json.unappliedAmount).toBe(2000);
    const sale = await api("/sales", { partnerId: c3, docDate: "2026-08-16", lines: [{ productId, qty: 2, unitPrice: 500 }] });
    const applied = await api(`/cash-docs/${receipt.json.id}/apply-prepaid`, {
      applyDate: "2026-08-16",
      allocations: [{ targetId: sale.json.id, amount: 1050 }],
    });
    expect(applied.status).toBe(201);

    const blocked = await api(`/sales/${sale.json.id}/void`, { reason: "test" });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain("預收");
    expect(blocked.json.error).toContain(`收款單 #${receipt.json.id}`);

    expect((await api(`/cash-docs/${receipt.json.id}/void`, { reason: "整筆退回" })).status).toBe(200);
    expect((await api(`/sales/${sale.json.id}/void`, { reason: "交易取消" })).status).toBe(200);
    const balance = (await api("/partner-balances")).json.find((b: { partnerId: number }) => b.partnerId === c3);
    expect(balance).toBeUndefined();
  });

  it("已被付款單立沖的進貨單不得作廢（409）；先作廢付款單後可作廢", async () => {
    const p3 = (await api("/products", { sku: "V-003", name: "商品三" })).json.id;
    const purchase = await api("/purchases", { partnerId: supplierId, docDate: "2026-08-15", lines: [{ productId: p3, qty: 5, unitPrice: 100 }] });
    expect(purchase.status).toBe(201); // 525 含稅
    const payment = await api("/cash-docs", {
      kind: "payment",
      partnerId: supplierId,
      docDate: "2026-08-15",
      amount: 525,
      accountId: cashAccountId,
      allocations: [{ targetId: purchase.json.id, amount: 525 }],
    });
    expect(payment.status).toBe(201);

    const blocked = await api(`/purchases/${purchase.json.id}/void`, { reason: "重複建單" });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain(`付款單 #${payment.json.id}`);
    expect(blocked.json.error).toContain("先作廢");

    expect((await api(`/cash-docs/${payment.json.id}/void`, { reason: "款項退回" })).status).toBe(200);
    expect((await api(`/purchases/${purchase.json.id}/void`, { reason: "重複建單" })).status).toBe(200);
  });

  it("發票作廢連動沖銷也擋懸空（檢查在共用核心）：409 且發票維持 issued", async () => {
    const sale = await api("/sales", { partnerId: customerId, docDate: "2026-08-16", lines: [{ productId, qty: 1, unitPrice: 1000 }] });
    const inv = await api(`/sales/${sale.json.id}/invoice`, { mode: "B2B" });
    expect(inv.status).toBe(201);
    const receipt = await api("/cash-docs", {
      kind: "receipt",
      partnerId: customerId,
      docDate: "2026-08-16",
      amount: 1050,
      accountId: cashAccountId,
      allocations: [{ targetId: sale.json.id, amount: 1050 }],
    });
    expect(receipt.status).toBe(201);

    const blocked = await api(`/invoices/${inv.json.id}/cancel`, { reason: "交易取消", cancelDate: "2026-08-16", reverseSale: true });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain("先作廢");
    // 整個交易回滾：發票沒有被半途標成作廢
    const row = (await api("/invoices")).json.find((i: { id: number }) => i.id === inv.json.id);
    expect(row.status).toBe("issued");

    // 解鎖：先作廢收款單，連動沖銷就走得通
    expect((await api(`/cash-docs/${receipt.json.id}/void`, { reason: "交易取消" })).status).toBe(200);
    const ok = await api(`/invoices/${inv.json.id}/cancel`, { reason: "交易取消", cancelDate: "2026-08-16", reverseSale: true });
    expect(ok.status).toBe(200);
    expect(ok.json.reversalEntryId).toBeTruthy();
  });
});

describe("voidDate 不得早於原單日期", () => {
  it("收付款單：voidDate 早於原單 422，訊息講清楚期間餘額會暫時反向", async () => {
    const receipt = await api("/cash-docs", { kind: "receipt", partnerId: customerId, docDate: "2026-08-18", amount: 100, accountId: cashAccountId });
    expect(receipt.status).toBe(201);
    const res = await api(`/cash-docs/${receipt.json.id}/void`, { reason: "打錯", voidDate: "2026-08-17" });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("早於原單日期");
    expect(res.json.error).toContain("反向");
    // 原單日期當天沖轉照常可行
    expect((await api(`/cash-docs/${receipt.json.id}/void`, { reason: "打錯", voidDate: "2026-08-18" })).status).toBe(200);
  });

  it("手工傳票：voidDate 早於原單 422", async () => {
    const entry = await api("/journal-entries", {
      entryDate: "2026-08-18",
      memo: "測試日期順序",
      lines: [
        { accountCode: "6131", debit: 50, credit: 0 },
        { accountCode: "1101", debit: 0, credit: 50 },
      ],
    });
    expect(entry.status).toBe(201);
    const res = await api(`/journal-entries/${entry.json.id}/void`, { reason: "打錯", voidDate: "2026-08-01" });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("早於原單日期");
  });
});

describe("訂單/採購單關聯連結排除作廢單", () => {
  it("訂單頁 saleIds：作廢的銷貨單消失，出貨量與剩餘量同步回復", async () => {
    const order = await api("/orders", { partnerId: customerId, orderDate: "2026-08-17", lines: [{ productId, qty: 2, unitPrice: 100 }] });
    const shipped = await api(`/orders/${order.json.id}/ship`, { docDate: "2026-08-17" });
    expect(shipped.status).toBe(201);
    const saleId = shipped.json.saleId;
    const before = (await api("/orders")).json.find((o: { id: number }) => o.id === order.json.id);
    expect(before.saleIds).toContain(saleId);

    expect((await api(`/sales/${saleId}/void`, { reason: "客戶取消" })).status).toBe(200);
    const after = (await api("/orders")).json.find((o: { id: number }) => o.id === order.json.id);
    expect(after.saleIds).not.toContain(saleId);
    expect(after.saleIds).toHaveLength(0);
    // 已出貨量的計算不受影響：量已隨作廢退回，剩餘量回到全量
    expect(Number(after.lines[0].shippedQty)).toBe(0);
    expect(after.lines[0].remainingQty).toBe(2);
    expect(after.status).toBe("open");
  });

  it("採購單頁 purchaseIds：作廢的進貨單消失，收貨量同步回復", async () => {
    const p4 = (await api("/products", { sku: "V-004", name: "商品四" })).json.id;
    const po = await api("/purchase-orders", { partnerId: supplierId, orderDate: "2026-08-17", lines: [{ productId: p4, qty: 3, unitPrice: 50 }] });
    const received = await api(`/purchase-orders/${po.json.id}/receive`, { docDate: "2026-08-17" });
    expect(received.status).toBe(201);
    const purchaseId = received.json.purchaseId;
    const before = (await api("/purchase-orders")).json.find((o: { id: number }) => o.id === po.json.id);
    expect(before.purchaseIds).toContain(purchaseId);

    expect((await api(`/purchases/${purchaseId}/void`, { reason: "廠商送錯貨整批退" })).status).toBe(200);
    const after = (await api("/purchase-orders")).json.find((o: { id: number }) => o.id === po.json.id);
    expect(after.purchaseIds).not.toContain(purchaseId);
    expect(after.purchaseIds).toHaveLength(0);
    expect(Number(after.lines[0].receivedQty)).toBe(0);
    expect(after.lines[0].remainingQty).toBe(3);
    expect(after.status).toBe("open");
  });
});

describe("權限與關帳鎖", () => {
  let lockedReceiptId: number;
  let lockedSaleId: number;
  let lockedPurchaseId: number;

  beforeAll(async () => {
    // 關帳前先建好之後要作廢的單據
    lockedSaleId = (await api("/sales", { partnerId: customerId, docDate: "2026-08-20", lines: [{ productId, qty: 2, unitPrice: 100 }] })).json.id;
    lockedPurchaseId = (await api("/purchases", { partnerId: supplierId, docDate: "2026-08-20", lines: [{ productId, qty: 2, unitPrice: 10 }] })).json.id;
    lockedReceiptId = (await api("/cash-docs", { kind: "receipt", partnerId: customerId, docDate: "2026-08-21", amount: 100, accountId: cashAccountId })).json.id;
  });

  it("作廢限財務／管理者：sales 角色 403", async () => {
    await api("/users", { username: "seller", displayName: "業務", password: "secret-test", role: "sales" });
    const seller = await loginAs(app, "seller", "secret-test");
    const res = await api(`/sales/${lockedSaleId}/void`, { reason: "test" }, "POST", seller);
    expect(res.status).toBe(403);
  });

  it("關帳後：收付款單預設沖轉日 409 並指路 voidDate；帶開放期間日期可沖", async () => {
    expect((await api("/period-closes", { period: "2026-08" })).status).toBe(201);

    const blocked = await api(`/cash-docs/${lockedReceiptId}/void`, { reason: "打錯" });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain("voidDate");
    expect(blocked.json.error).toContain("重開");

    const ok = await api(`/cash-docs/${lockedReceiptId}/void`, { reason: "打錯", voidDate: "2026-09-01" });
    expect(ok.status).toBe(200);
    // 反向傳票落在 9 月：8 月（已關帳）的帳一個位元都沒動
    const entry = await api(`/journal-entries/${ok.json.reversalEntryId}`);
    expect(entry.json.entryDate).toBe("2026-09-01");
  });

  it("關帳後：銷貨單／進貨單不可作廢（409 指路退回單或重開），不收 voidDate", async () => {
    const sale = await api(`/sales/${lockedSaleId}/void`, { reason: "test" });
    expect(sale.status).toBe(409);
    expect(sale.json.error).toContain("已關帳");
    expect(sale.json.error).toContain("退回");
    const purchase = await api(`/purchases/${lockedPurchaseId}/void`, { reason: "test" });
    expect(purchase.status).toBe(409);
    expect(purchase.json.error).toContain("已關帳");
    expect(purchase.json.error).toContain("退出");
  });
});
