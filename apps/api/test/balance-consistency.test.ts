/**
 * R6 餘額口徑統一驗收（第四批，services/balances.ts）：
 * - 溢付存在時退出單的 apOffset 不再被壓低（returns.ts 曾以付款「全額」扣應付，
 *   把掛 1212 的溢付也當成沖應付——與 0027「只沖 amount − unapplied」不一致）；
 *   銷退側 arOffset 對稱，且期初應收付單計入對象餘額。
 * - partner-balances／ar-aging／open-documents 對同一組資料回答同一個數字
 *   （open-documents 曾只認立沖紀錄，未指定沖銷的收款完全不扣）。
 * - GET /cash-docs/:id 回沖銷明細：沖了哪幾張、各沖多少、那些單現在還剩多少。
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
let productId: number;
let bankAccountId: number;

async function api(path: string, body?: unknown, method = body ? "POST" : "GET") {
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
const agingRowOf = async (partnerId: number, asOf: string) =>
  (await api(`/reports/ar-aging?asOf=${asOf}`)).json.rows.find(
    (r: { partnerId: number }) => r.partnerId === partnerId,
  );

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);
  productId = (await api("/products", { sku: "P-BAL", name: "口徑商品" })).json.id;
  bankAccountId = (await api("/accounts")).json.find((a: { code: string }) => a.code === "1103").id;
});

describe("溢付存在時，退出單的沖應付上限用 0027 口徑（第三批 misc 實測發現的 bug）", () => {
  it("溢付 950 掛 1212 之後再進貨：整張退出的 apOffset＝應付全額，不再錯掛其他應收", async () => {
    const supplier = (await api("/partners", { name: "溢付供應商", isSupplier: true })).json.id;
    // 進貨 A：1000 + 50 稅 = 1050；付 2000 → 沖 1050、溢付 950 掛 1212
    await api("/purchases", { partnerId: supplier, docDate: "2026-05-01", lines: [{ productId, qty: 10, unitPrice: 100 }] });
    const pay = await api("/cash-docs", { kind: "payment", partnerId: supplier, docDate: "2026-05-02", amount: 2000, accountId: bankAccountId });
    expect(pay.json.unappliedAmount).toBe(950);
    expect(await balanceOf(supplier)).toMatchObject({ ap: 0, prepaidPaid: 950 });

    // 進貨 B：又欠 1050。舊算法把付款「全額 2000」扣應付 → 對象應付只剩 100，
    // 整張退出 1050 只有 100 沖應付、950 錯掛其他應收
    const purchaseB = (await api("/purchases", { partnerId: supplier, docDate: "2026-05-10", lines: [{ productId, qty: 10, unitPrice: 100 }] })).json;
    expect(await balanceOf(supplier)).toMatchObject({ ap: 1050, prepaidPaid: 950 });

    const returnable = (await api(`/purchases/${purchaseB.id}/returnable`)).json;
    const doc = await api(`/purchases/${purchaseB.id}/returns`, {
      kind: "return",
      docDate: "2026-05-15",
      lines: [{ sourceLineId: returnable.lines[0].id, qty: 10 }],
    });
    expect(doc.status).toBe(201);
    expect(doc.json.apOffset).toBe(1050); // 修正前：100
    expect(doc.json.receivableAmount).toBe(0); // 修正前：950 錯掛 1288 其他應收
    // 退完應付歸零，溢付餘額原封不動（那是 1212 的錢，不歸應付管）
    expect(await balanceOf(supplier)).toMatchObject({ ap: 0, prepaidPaid: 950 });
  });

  it("銷退側對稱：溢收存在時退回單的 arOffset 也用同一份對象餘額", async () => {
    const customer = (await api("/partners", { name: "溢收客戶", isCustomer: true })).json.id;
    // 備庫存
    const sup = (await api("/partners", { name: "備貨供應商A", isSupplier: true })).json.id;
    await api("/purchases", { partnerId: sup, docDate: "2026-05-01", lines: [{ productId, qty: 30, unitPrice: 100 }] });

    await api("/sales", { partnerId: customer, docDate: "2026-05-03", lines: [{ productId, qty: 5, unitPrice: 200 }] }); // 1050
    const receipt = await api("/cash-docs", { kind: "receipt", partnerId: customer, docDate: "2026-05-04", amount: 2000, accountId: bankAccountId });
    expect(receipt.json.unappliedAmount).toBe(950);

    const saleB = (await api("/sales", { partnerId: customer, docDate: "2026-05-10", lines: [{ productId, qty: 5, unitPrice: 200 }] })).json;
    const returnable = (await api(`/sales/${saleB.id}/returnable`)).json;
    const doc = await api(`/sales/${saleB.id}/returns`, {
      kind: "return",
      docDate: "2026-05-12",
      lines: [{ sourceLineId: returnable.lines[0].id, qty: 5 }],
    });
    expect(doc.status).toBe(201);
    expect(doc.json.arOffset).toBe(1050); // 修正前：付款全額扣 → 對象應收只剩 100
    expect(doc.json.payableAmount).toBe(0);
    expect(await balanceOf(customer)).toMatchObject({ ar: 0, prepaidReceived: 950 });
  });

  it("期初應收單也計入對象餘額：退回沖應收的上限看得到舊欠款", async () => {
    const customer = (await api("/partners", { name: "期初客戶", isCustomer: true })).json.id;
    const sup = (await api("/partners", { name: "備貨供應商B", isSupplier: true })).json.id;
    await api("/purchases", { partnerId: sup, docDate: "2026-05-01", lines: [{ productId, qty: 10, unitPrice: 100 }] });
    // 期初應收 500（導入的舊欠款）＋新銷貨 1050，收款 1050 未指定沖銷
    await api("/opening-balances", { kind: "receivable", partnerId: customer, entryDate: "2026-05-01", docDate: "2026-04-01", amount: 500 });
    const sale = (await api("/sales", { partnerId: customer, docDate: "2026-05-05", lines: [{ productId, qty: 5, unitPrice: 200 }] })).json;
    await api("/cash-docs", { kind: "receipt", partnerId: customer, docDate: "2026-05-06", amount: 1050, accountId: bankAccountId });

    // 對象還欠 500（期初單）。舊算法漏掉期初 → 對象餘額 0 → 整張退回 1050 全數
    // 錯掛 2201 其他應付（明明客戶還欠著錢）
    const returnable = (await api(`/sales/${sale.id}/returnable`)).json;
    const doc = await api(`/sales/${sale.id}/returns`, {
      kind: "return",
      docDate: "2026-05-10",
      lines: [{ sourceLineId: returnable.lines[0].id, qty: 5 }],
    });
    expect(doc.status).toBe(201);
    expect(doc.json.arOffset).toBe(500);
    expect(doc.json.payableAmount).toBe(550);
    // 全部結清（ar/ap/預收/預付皆 0）的對象不出現在 partner-balances 清單
    expect(await balanceOf(customer)).toBeUndefined();
  });
});

describe("R6：同一個客戶，三個地方同一個答案", () => {
  let customer: number;
  let saleA: number;
  let saleB: number;

  beforeAll(async () => {
    customer = (await api("/partners", { name: "三處一致客戶", isCustomer: true })).json.id;
    const sup = (await api("/partners", { name: "備貨供應商C", isSupplier: true })).json.id;
    await api("/purchases", { partnerId: sup, docDate: "2026-06-01", lines: [{ productId, qty: 40, unitPrice: 100 }] });
    saleA = (await api("/sales", { partnerId: customer, docDate: "2026-06-02", lines: [{ productId, qty: 5, unitPrice: 200 }] })).json.id; // 1050
    saleB = (await api("/sales", { partnerId: customer, docDate: "2026-06-05", lines: [{ productId, qty: 10, unitPrice: 200 }] })).json.id; // 2100
    // 收 1000，未指定沖銷（R6 實測場景：open-documents 曾完全不扣這一筆）
    await api("/cash-docs", { kind: "receipt", partnerId: customer, docDate: "2026-06-10", amount: 1000, accountId: bankAccountId });
  });

  it("partner-balances＝ar-aging＝open-documents 合計，未指定沖銷的收款三處都扣", async () => {
    expect((await balanceOf(customer)).ar).toBe(2150); // 3150 − 1000

    const aging = await agingRowOf(customer, "2026-06-30");
    expect(aging.total).toBe(2150);
    expect(aging.credit).toBe(0);

    const open = (await api(`/open-documents?partnerId=${customer}&kind=receipt`)).json;
    const docs = open.filter((d: { docType: string }) => d.docType === "sale");
    // FIFO 沖最舊：A（1050）被抵 1000 剩 50，B 原封不動——與帳齡同一條規則
    expect(docs.find((d: { id: number }) => d.id === saleA)).toMatchObject({ fifoApplied: 1000, remaining: 50 });
    expect(docs.find((d: { id: number }) => d.id === saleB)).toMatchObject({ fifoApplied: 0, remaining: 2100 });
    const openTotal = docs.reduce((s: number, d: { remaining: number }) => s + d.remaining, 0);
    expect(openTotal).toBe(2150); // 修正前：3150（會計照它開單就會再收一次）
  });

  it("溢收的切分以三處共同的 outstanding 為界；之後三處同步歸零", async () => {
    const receipt = await api("/cash-docs", { kind: "receipt", partnerId: customer, docDate: "2026-06-15", amount: 3000, accountId: bankAccountId });
    expect(receipt.json.unappliedAmount).toBe(850); // 3000 − 2150

    expect(await balanceOf(customer)).toMatchObject({ ar: 0, prepaidReceived: 850 });
    const aging = await agingRowOf(customer, "2026-06-30");
    expect(aging).toMatchObject({ total: 0, credit: 850 });
    const open = (await api(`/open-documents?partnerId=${customer}&kind=receipt`)).json;
    expect(open.filter((d: { docType: string }) => d.docType === "sale")).toHaveLength(0);
    expect(open.find((d: { docType: string }) => d.docType === "prepaid")).toMatchObject({ remaining: 850 });
  });

  it("已被 FIFO 沖畢的單不能再立沖（口徑統一後畫面與驗證同一份，也擋住重複收款）", async () => {
    const res = await api("/cash-docs", {
      kind: "receipt",
      partnerId: customer,
      docDate: "2026-06-20",
      amount: 100,
      accountId: bankAccountId,
      allocations: [{ targetId: saleA, amount: 50 }],
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("已沖畢");
  });
});

describe("GET /cash-docs/:id：沖了哪幾張、各沖多少、那些單現在還剩多少", () => {
  let customer: number;
  let saleA: number;
  let saleB: number;
  let saleC: number;
  let receipt1: number;
  let receipt2: number;

  beforeAll(async () => {
    customer = (await api("/partners", { name: "明細客戶", isCustomer: true })).json.id;
    const sup = (await api("/partners", { name: "備貨供應商D", isSupplier: true })).json.id;
    await api("/purchases", { partnerId: sup, docDate: "2026-07-01", lines: [{ productId, qty: 40, unitPrice: 100 }] });
    saleA = (await api("/sales", { partnerId: customer, docDate: "2026-07-02", lines: [{ productId, qty: 5, unitPrice: 200 }] })).json.id; // 1050
    saleB = (await api("/sales", { partnerId: customer, docDate: "2026-07-03", lines: [{ productId, qty: 10, unitPrice: 200 }] })).json.id; // 2100
    receipt1 = (
      await api("/cash-docs", {
        kind: "receipt",
        partnerId: customer,
        docDate: "2026-07-05",
        amount: 1550,
        accountId: bankAccountId,
        allocations: [
          { targetId: saleA, amount: 1050 },
          { targetId: saleB, amount: 500 },
        ],
      })
    ).json.id;
  });

  it("立沖明細帶目標單號、金額與該單目前未沖餘額", async () => {
    const res = await api(`/cash-docs/${receipt1}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: receipt1, kind: "receipt", partnerName: "明細客戶", unappliedAmount: 0, prepaidRemaining: 0 });
    expect(res.json.allocations).toHaveLength(2);
    expect(res.json.allocations[0]).toMatchObject({
      targetType: "sale",
      targetId: saleA,
      amount: 1050,
      fromPrepaid: false,
      allocDate: null,
      targetRemaining: 0, // A 已沖畢
    });
    expect(res.json.allocations[1]).toMatchObject({ targetId: saleB, amount: 500, targetRemaining: 1600 });
  });

  it("事後沖用預收的明細帶沖用日與自己的傳票；預收餘額同步遞減", async () => {
    // 溢收 400：1600 立沖 B 之後，多收的部分掛 2231
    receipt2 = (
      await api("/cash-docs", {
        kind: "receipt",
        partnerId: customer,
        docDate: "2026-07-06",
        amount: 2000,
        accountId: bankAccountId,
        allocations: [{ targetId: saleB, amount: 1600 }],
      })
    ).json.id;
    saleC = (await api("/sales", { partnerId: customer, docDate: "2026-07-08", lines: [{ productId, qty: 5, unitPrice: 200 }] })).json.id; // 1050
    const applied = await api(`/cash-docs/${receipt2}/apply-prepaid`, {
      applyDate: "2026-07-10",
      allocations: [{ targetId: saleC, amount: 300 }],
    });
    expect(applied.status).toBe(201);

    const res = await api(`/cash-docs/${receipt2}`);
    expect(res.json).toMatchObject({ unappliedAmount: 400, prepaidRemaining: 100 });
    const prepaidRow = res.json.allocations.find((a: { fromPrepaid: boolean }) => a.fromPrepaid);
    expect(prepaidRow).toMatchObject({ targetType: "sale", targetId: saleC, amount: 300, allocDate: "2026-07-10", targetRemaining: 750 });
    expect(prepaidRow.journalEntryId).toBeGreaterThan(0);
  });

  it("此時三處餘額仍是同一個答案（立沖＋FIFO＋預收混用）", async () => {
    // 4200 銷貨 − 1550 − 1600 − 300 預收沖用 = 750；預收剩 100
    expect(await balanceOf(customer)).toMatchObject({ ar: 750, prepaidReceived: 100 });
    const aging = await agingRowOf(customer, "2026-07-31");
    expect(aging).toMatchObject({ total: 750, credit: 100 });
    const open = (await api(`/open-documents?partnerId=${customer}&kind=receipt`)).json;
    const docs = open.filter((d: { docType: string }) => d.docType === "sale");
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ id: saleC, remaining: 750 });
    expect(open.find((d: { docType: string }) => d.docType === "prepaid")).toMatchObject({ id: receipt2, remaining: 100 });
  });

  it("不存在的單 404，訊息帶單號", async () => {
    const res = await api("/cash-docs/99999");
    expect(res.status).toBe(404);
    expect(res.json.error).toContain("99999");
  });
});
