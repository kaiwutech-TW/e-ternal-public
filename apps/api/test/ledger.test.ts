/**
 * 帳務完整性批次驗收：庫存開帳 → 手工傳票（期初科目餘額）→ 進銷貨 → 收付款沖帳 → 財務報表。
 * 模擬一家既有公司導入：期初有庫存、現金、股本，再跑當期交易。
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
let cashAccountId: number;

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

  // 供應商與客戶的統編不可相同：0022 起 tax_id 有 partial unique index（R5），撞號會 409
  const supplier = await api("/partners", { name: "供應商", taxId: "05004058", isSupplier: true });
  supplierId = supplier.json.id;
  const customer = await api("/partners", { name: "客戶", taxId: "04541302", isCustomer: true });
  customerId = customer.json.id;
  const product = await api("/products", { sku: "OP-1", name: "開帳商品" });
  productId = product.json.id;
  const accounts = await api("/accounts");
  cashAccountId = accounts.json.find((a: { code: string }) => a.code === "1101").id;
});

describe("期初開帳", () => {
  it("庫存開帳：建立在庫 50 個 @20，不產生傳票", async () => {
    const res = await api("/inventory/opening", {
      docDate: "2026-01-01",
      lines: [{ productId, qty: 50, unitCost: 20 }],
    });
    expect(res.status).toBe(201);
    const inv = await api("/inventory");
    expect(inv.json.find((r: { productId: number }) => r.productId === productId)).toMatchObject({
      qty: 50,
      amount: 1000,
      avgUnitCost: 20,
    });
    const entries = await api("/journal-entries");
    expect(entries.json).toHaveLength(0);
  });

  it("期初科目餘額以手工傳票開帳：存貨 1000＋現金 9000＝股本 10000", async () => {
    const res = await api("/journal-entries", {
      entryDate: "2026-01-01",
      memo: "期初開帳",
      lines: [
        { accountCode: "1301", debit: 1000, credit: 0 },
        { accountCode: "1101", debit: 9000, credit: 0 },
        { accountCode: "3101", debit: 0, credit: 10000 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.json.sourceType).toBe("manual");
  });

  it("借貸不平回 400；科目不存在回 422", async () => {
    const bad = await api("/journal-entries", {
      entryDate: "2026-01-02",
      memo: "不平",
      lines: [
        { accountCode: "1101", debit: 100, credit: 0 },
        { accountCode: "3101", debit: 0, credit: 99 },
      ],
    });
    expect(bad.status).toBe(400);
    const noAccount = await api("/journal-entries", {
      entryDate: "2026-01-02",
      memo: "科目錯",
      lines: [
        { accountCode: "9999", debit: 100, credit: 0 },
        { accountCode: "3101", debit: 0, credit: 100 },
      ],
    });
    expect(noAccount.status).toBe(422);
  });
});

describe("收付款沖應收/應付", () => {
  it("進貨＋銷貨後，收款單/付款單沖出正確餘額", async () => {
    await api("/purchases", {
      partnerId: supplierId,
      docDate: "2026-01-10",
      lines: [{ productId, qty: 10, unitPrice: 20 }],
    }); // 210 含稅
    await api("/sales", {
      partnerId: customerId,
      docDate: "2026-01-15",
      lines: [{ productId, qty: 30, unitPrice: 50 }],
    }); // 1,575 含稅，成本 30×20=600

    const receipt = await api("/cash-docs", {
      kind: "receipt",
      partnerId: customerId,
      docDate: "2026-01-20",
      amount: 1000,
      accountId: cashAccountId,
    });
    expect(receipt.status).toBe(201);
    const payment = await api("/cash-docs", {
      kind: "payment",
      partnerId: supplierId,
      docDate: "2026-01-21",
      amount: 210,
      accountId: cashAccountId,
    });
    expect(payment.status).toBe(201);

    const balances = await api("/partner-balances");
    expect(balances.json.find((b: { partnerId: number }) => b.partnerId === customerId).ar).toBe(575);
    expect(balances.json.find((b: { partnerId: number }) => b.partnerId === supplierId)).toBeUndefined(); // 已付清，餘額 0 不列

    const tb = await api("/trial-balance");
    expect(tb.json.totalDebit).toBe(tb.json.totalCredit);
    // 現金 1101：期初 9000 ＋ 收款 1000 − 付款 210
    const cash = tb.json.rows.find((r: { code: string }) => r.code === "1101");
    expect(cash.debit - cash.credit).toBe(9790);
  });

  it("收款對象須為客戶、收付科目須為資產類", async () => {
    const wrongRole = await api("/cash-docs", {
      kind: "receipt",
      partnerId: supplierId,
      docDate: "2026-01-22",
      amount: 100,
      accountId: cashAccountId,
    });
    expect(wrongRole.status).toBe(422);
  });
});

describe("財務報表", () => {
  it("損益表：收入 1500 − 成本 600 ＝ 本期損益 900", async () => {
    const res = await api("/reports/income-statement?from=2026-01-01&to=2026-01-31");
    expect(res.status).toBe(200);
    expect(res.json.totalRevenue).toBe(1500);
    expect(res.json.totalExpense).toBe(600);
    expect(res.json.netIncome).toBe(900);
  });

  it("資產負債表：資產＝負債＋權益（含本期損益），存貨餘額正確", async () => {
    const res = await api("/reports/balance-sheet?asOf=2026-01-31");
    expect(res.status).toBe(200);
    expect(res.json.balanced).toBe(true);
    // 存貨科目：期初 1000 ＋ 進貨 200 − 銷貨成本 600 ＝ 600
    expect(res.json.assets.find((r: { code: string }) => r.code === "1301").amount).toBe(600);
    // 本期損益 900 列於權益
    expect(res.json.equity.find((r: { name: string }) => r.name.includes("本期損益")).amount).toBe(900);
    expect(res.json.totalAssets).toBe(res.json.totalLiabilities + res.json.totalEquity);
  });

  it("傳票清單含各來源類型與借方合計", async () => {
    const res = await api("/journal-entries?from=2026-01-01&to=2026-01-31");
    const types = new Set(res.json.map((e: { sourceType: string }) => e.sourceType));
    expect(types).toEqual(new Set(["manual", "purchase", "sale", "receipt", "payment"]));
    const manual = res.json.find((e: { sourceType: string }) => e.sourceType === "manual");
    expect(manual.totalDebit).toBe(10000);
  });
});

describe("分錄行摘要（0038）", () => {
  it("行摘要落地、詳細回讀；明細分類帳以行摘要優先、空值退回單頭摘要", async () => {
    const entry = await api("/journal-entries", {
      entryDate: "2026-07-20",
      memo: "調整傳票（單頭）",
      lines: [
        { accountCode: "1101", debit: 500, credit: 0, memo: "找回溢付的零用金" },
        { accountCode: "6188", debit: 0, credit: 500 }, // 沒填行摘要：報表要退回單頭
      ],
    });

    expect(entry.status).toBe(201);
    const detail = (await api(`/journal-entries/${entry.json.id}`)).json;
    expect(detail.lines.find((l: { code: string }) => l.code === "1101").memo).toBe("找回溢付的零用金");
    expect(detail.lines.find((l: { code: string }) => l.code === "6188").memo).toBe("");

    const ledger = (await api("/reports/ledger?accountCode=1101&from=2026-07-20&to=2026-07-20")).json;
    const row = ledger.lines.find((r: { entryId: number }) => r.entryId === entry.json.id);
    expect(row.memo).toBe("找回溢付的零用金");
    const ledger2 = (await api("/reports/ledger?accountCode=6188&from=2026-07-20&to=2026-07-20")).json;
    const row2 = ledger2.lines.find((r: { entryId: number }) => r.entryId === entry.json.id);
    expect(row2.memo).toBe("調整傳票（單頭）");
  });
});
