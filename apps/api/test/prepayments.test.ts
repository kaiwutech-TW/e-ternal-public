/**
 * B9 驗收（migration 0027）：溢收／溢付不再是負數應收應付。
 * - 收款超過該對象未沖餘額 → 超出部分掛 2231 預收款項（負債），1144 不為負
 * - 付款溢付 → 掛 1212 預付貨款（資產），2144 不為負
 * - 之後的新單據可用預收/預付餘額沖銷（apply-prepaid：生自己的傳票，借 2231 貸 1144）
 * - partner-balances／open-documents／資產負債表一律分列，不以淨額互抵
 * - 沖用日受關帳鎖；收付款單作廢時沖用傳票一併反向、目標單據未沖餘額回復
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
let customerId: number;
let supplierId: number;
let productId: number;
let bankAccountId: number;

async function api(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const res = await app.request(path, {
    method,
    headers: { ...admin, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const balanceOf = async (partnerId: number) =>
  (await api("/partner-balances")).json.find((b: { partnerId: number }) => b.partnerId === partnerId);
const bsLine = (bs: { assets: { code: string; amount: number }[]; liabilities: { code: string; amount: number }[] }, code: string) =>
  [...bs.assets, ...bs.liabilities].find((r) => r.code === code);

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);

  customerId = (await api("/partners", { name: "訂金客戶", isCustomer: true })).json.id;
  supplierId = (await api("/partners", { name: "訂金供應商", isSupplier: true })).json.id;
  productId = (await api("/products", { sku: "P-PRE", name: "商品" })).json.id;
  bankAccountId = (await api("/accounts")).json.find((a: { code: string }) => a.code === "1103").id;
  // 進 20 件備著賣
  await api("/purchases", { partnerId: supplierId, docDate: "2026-02-01", lines: [{ productId, qty: 20, unitPrice: 100 }] });
  // 先把這張進貨付清，讓供應商側從乾淨狀態開始（2100 = 20×100×1.05）
  await api("/cash-docs", { kind: "payment", partnerId: supplierId, docDate: "2026-02-02", amount: 2100, accountId: bankAccountId });
});

describe("溢收掛預收，應收不為負", () => {
  let receiptId: number;

  it("客戶只欠 630，收 1000 → 370 掛 2231，1144 沖到 0 而不是 -370", async () => {
    const sale = await api("/sales", { partnerId: customerId, docDate: "2026-03-01", lines: [{ productId, qty: 2, unitPrice: 300 }] }); // 630 含稅
    const receipt = await api("/cash-docs", {
      kind: "receipt",
      partnerId: customerId,
      docDate: "2026-03-05",
      amount: 1000,
      accountId: bankAccountId,
      allocations: [{ targetId: sale.json.id, amount: 630 }],
    });
    expect(receipt.status).toBe(201);
    expect(receipt.json.unappliedAmount).toBe(370);
    receiptId = receipt.json.id;

    const balance = await balanceOf(customerId);
    expect(balance).toMatchObject({ ar: 0, prepaidReceived: 370 });

    const bs = (await api("/reports/balance-sheet?asOf=2026-03-31")).json;
    const arLine = bsLine(bs, "1144");
    expect(arLine === undefined || arLine.amount >= 0).toBe(true); // 應收永不為負
    expect(bsLine(bs, "2231")?.amount).toBe(370); // 預收在負債側，分列不互抵
    expect(bs.balanced).toBe(true);
  });

  it("open-documents 以 docType 'prepaid' 分開列預收餘額", async () => {
    const open = (await api(`/open-documents?partnerId=${customerId}&kind=receipt`)).json;
    const prepaid = open.filter((d: { docType: string }) => d.docType === "prepaid");
    expect(prepaid).toHaveLength(1);
    expect(prepaid[0]).toMatchObject({ id: receiptId, total: 370, allocated: 0, remaining: 370 });
    // 銷貨已被沖畢，未沖單據清單裡不該再有 sale
    expect(open.filter((d: { docType: string }) => d.docType === "sale")).toHaveLength(0);
  });

  it("下一張銷貨可沖預收：借 2231 貸 1144，餘額同步遞減", async () => {
    const sale = await api("/sales", { partnerId: customerId, docDate: "2026-04-01", lines: [{ productId, qty: 1, unitPrice: 200 }] }); // 210 含稅
    const apply = await api(`/cash-docs/${receiptId}/apply-prepaid`, {
      applyDate: "2026-04-02",
      allocations: [{ targetId: sale.json.id, amount: 210 }],
    });
    expect(apply.status).toBe(201);
    expect(apply.json).toMatchObject({ applied: 210, remaining: 160 });

    const balance = await balanceOf(customerId);
    expect(balance).toMatchObject({ ar: 0, prepaidReceived: 160 });
    const open = (await api(`/open-documents?partnerId=${customerId}&kind=receipt`)).json;
    expect(open.filter((d: { docType: string }) => d.docType === "sale")).toHaveLength(0); // 銷貨被預收沖畢
    expect(open.find((d: { docType: string }) => d.docType === "prepaid")).toMatchObject({ allocated: 210, remaining: 160 });

    const bs = (await api("/reports/balance-sheet?asOf=2026-04-30")).json;
    expect(bsLine(bs, "2231")?.amount).toBe(160);
    expect(bs.balanced).toBe(true);
    // 沖用有自己的傳票（借 2231 貸 1144），總帳與單據面同步
    const tb = (await api("/trial-balance")).json;
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it("超過剩餘預收餘額 → 422 帶可操作訊息；目標不存在 → 422", async () => {
    const sale = await api("/sales", { partnerId: customerId, docDate: "2026-04-10", lines: [{ productId, qty: 2, unitPrice: 300 }] }); // 630
    const over = await api(`/cash-docs/${receiptId}/apply-prepaid`, {
      applyDate: "2026-04-11",
      allocations: [{ targetId: sale.json.id, amount: 300 }],
    });
    expect(over.status).toBe(422);
    expect(over.json.error).toContain("預收餘額剩 160");
    const ghost = await api(`/cash-docs/${receiptId}/apply-prepaid`, {
      applyDate: "2026-04-11",
      allocations: [{ targetId: 99999, amount: 100 }],
    });
    expect(ghost.status).toBe(422);
  });

  it("應收與預收同時存在時分列，不淨額互抵", async () => {
    // 上一個測試開了 630 的銷貨沒有沖：應收 630、預收 160 要同時列出
    const balance = await balanceOf(customerId);
    expect(balance).toMatchObject({ ar: 630, prepaidReceived: 160 });
    const bs = (await api("/reports/balance-sheet?asOf=2026-04-30")).json;
    expect(bsLine(bs, "1144")?.amount).toBe(630);
    expect(bsLine(bs, "2231")?.amount).toBe(160);
    // 帳齡的預收欄跟著 2231 餘額走，未收單據照常分桶
    const aging = (await api("/reports/ar-aging?asOf=2026-04-30")).json;
    const row = aging.rows.find((r: { partnerId: number }) => r.partnerId === customerId);
    expect(row).toMatchObject({ total: 630, credit: 160 });
  });
});

describe("先前未立沖的收款也要算進『他還欠多少』", () => {
  it("FIFO 沖畢後再收一筆 → 整筆掛預收，應收不會被沖成負數", async () => {
    // 未指定沖銷的收款不留立沖紀錄，open-documents 的 remaining 看不到它——
    // 溢收的計算若只看 remaining，第二張收款會把已收過的 210 再沖一次應收
    const cust = (await api("/partners", { name: "FIFO 客戶", isCustomer: true })).json.id;
    await api("/sales", { partnerId: cust, docDate: "2026-03-10", lines: [{ productId, qty: 1, unitPrice: 200 }] }); // 210 含稅
    const first = await api("/cash-docs", {
      kind: "receipt", partnerId: cust, docDate: "2026-03-11", amount: 210, accountId: bankAccountId,
    });
    expect(first.json.unappliedAmount).toBe(0); // 剛好付清，沒有溢收
    const second = await api("/cash-docs", {
      kind: "receipt", partnerId: cust, docDate: "2026-03-12", amount: 100, accountId: bankAccountId,
    });
    expect(second.json.unappliedAmount).toBe(100); // 已經不欠了：整筆是預收
    expect(await balanceOf(cust)).toMatchObject({ ar: 0, prepaidReceived: 100 });
  });
});

describe("溢付掛預付，應付不為負", () => {
  let paymentId: number;

  it("只欠 210 卻付 500 → 290 掛 1212，2144 不為負", async () => {
    await api("/purchases", { partnerId: supplierId, docDate: "2026-05-01", lines: [{ productId, qty: 2, unitPrice: 100 }] }); // 210 含稅
    const payment = await api("/cash-docs", {
      kind: "payment",
      partnerId: supplierId,
      docDate: "2026-05-05",
      amount: 500,
      accountId: bankAccountId,
    });
    expect(payment.status).toBe(201);
    expect(payment.json.unappliedAmount).toBe(290);
    paymentId = payment.json.id;

    const balance = await balanceOf(supplierId);
    expect(balance).toMatchObject({ ap: 0, prepaidPaid: 290 });
    const bs = (await api("/reports/balance-sheet?asOf=2026-05-31")).json;
    const apLine = bsLine(bs, "2144");
    expect(apLine === undefined || apLine.amount >= 0).toBe(true);
    expect(bsLine(bs, "1212")?.amount).toBe(290); // 預付在資產側
    expect(bs.balanced).toBe(true);
  });

  it("下一張進貨可沖預付：借 2144 貸 1212", async () => {
    const purchase = await api("/purchases", { partnerId: supplierId, docDate: "2026-05-10", lines: [{ productId, qty: 1, unitPrice: 100 }] }); // 105 含稅
    const apply = await api(`/cash-docs/${paymentId}/apply-prepaid`, {
      applyDate: "2026-05-11",
      allocations: [{ targetId: purchase.json.id, amount: 105 }],
    });
    expect(apply.status).toBe(201);
    expect(apply.json).toMatchObject({ applied: 105, remaining: 185 });
    const balance = await balanceOf(supplierId);
    expect(balance).toMatchObject({ ap: 0, prepaidPaid: 185 });
    const bs = (await api("/reports/balance-sheet?asOf=2026-05-31")).json;
    expect(bsLine(bs, "1212")?.amount).toBe(185);
    expect(bs.balanced).toBe(true);
  });
});

describe("關帳鎖與作廢", () => {
  it("沖用日落在已關帳期間 → 409 指路重開", async () => {
    // 2026-01 沒有任何單據，可作為起始關帳月
    const close = await api("/period-closes", { period: "2026-01" });
    expect(close.status).toBe(201);
    // 先開一張 1 月的預收收款單是不可能的（期間已關），直接拿 3 月那張收款單、
    // 硬指定 1 月的沖用日——鎖要擋的是「傳票落進已關期間」
    const receipts = (await api("/cash-docs")).json.filter(
      (d: { kind: string; unappliedAmount: number }) => d.kind === "receipt" && d.unappliedAmount > 0,
    );
    const locked = await api(`/cash-docs/${receipts[0].id}/apply-prepaid`, {
      applyDate: "2026-01-15",
      allocations: [{ targetId: 1, amount: 10 }],
    });
    expect(locked.status).toBe(409);
    expect(locked.json.error).toContain("已關帳");
  });

  it("作廢有預收沖用的收款單：沖用傳票一併反向，被沖單據未沖餘額回復", async () => {
    // 獨立客戶：銷貨 210 → 收 1000（溢收 790）→ 用預收沖一張新銷貨 105
    const cust = (await api("/partners", { name: "作廢預收客戶", isCustomer: true })).json.id;
    await api("/sales", { partnerId: cust, docDate: "2026-06-01", lines: [{ productId, qty: 1, unitPrice: 200 }] });
    const receipt = await api("/cash-docs", {
      kind: "receipt", partnerId: cust, docDate: "2026-06-02", amount: 1000, accountId: bankAccountId,
    });
    expect(receipt.json.unappliedAmount).toBe(790);
    const sale2 = await api("/sales", { partnerId: cust, docDate: "2026-06-03", lines: [{ productId, qty: 1, unitPrice: 100 }] }); // 105
    await api(`/cash-docs/${receipt.json.id}/apply-prepaid`, {
      applyDate: "2026-06-04",
      allocations: [{ targetId: sale2.json.id, amount: 105 }],
    });
    expect(await balanceOf(cust)).toMatchObject({ ar: 0, prepaidReceived: 685 });

    const voided = await api(`/cash-docs/${receipt.json.id}/void`, { reason: "金額打錯" });
    expect(voided.status).toBe(200);

    // 收款當作沒發生：兩張銷貨都回到未收，預收餘額歸零
    expect(await balanceOf(cust)).toMatchObject({ ar: 315, prepaidReceived: 0 });
    const open = (await api(`/open-documents?partnerId=${cust}&kind=receipt`)).json;
    expect(open.filter((d: { docType: string }) => d.docType === "sale")).toHaveLength(2);
    expect(open.filter((d: { docType: string }) => d.docType === "prepaid")).toHaveLength(0);
    // 總帳同步：2231 的這 790 已被反向傳票沖回（餘額只剩其他客戶的），借貸仍平
    const tb = (await api("/trial-balance")).json;
    expect(tb.totalDebit).toBe(tb.totalCredit);
    const bs = (await api("/reports/balance-sheet?asOf=2026-06-30")).json;
    expect(bsLine(bs, "2231")?.amount).toBe(260); // 只剩其他客戶的預收（160 + 100），這 790 已沖回
    expect(bs.balanced).toBe(true);
  });

  it("已作廢的收付款單不能再沖用預收 → 409", async () => {
    const voidedReceipts = (await api("/cash-docs")).json.filter(
      (d: { voidedAt: string | null; unappliedAmount: number }) => d.voidedAt && d.unappliedAmount > 0,
    );
    const res = await api(`/cash-docs/${voidedReceipts[0].id}/apply-prepaid`, {
      applyDate: "2026-06-10",
      allocations: [{ targetId: 1, amount: 10 }],
    });
    expect(res.status).toBe(409);
  });
});
