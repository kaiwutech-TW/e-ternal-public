/**
 * 期初導入驗收（B6）：期初應收付單 → 子帳（對象餘額/未沖清單/帳齡）與總帳（試算表/資產負債表）
 * 同時成立 → 收付款立沖 → 不進 401 → 關帳鎖對期初單生效 → 庫存開帳合計與月結對帳提示。
 * 模擬一家 2026-01-01 導入本系統的既有公司：手上有一筆舊客戶欠款與一筆未付貨款。
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
let customerId: number;
let supplierId: number;
let productId: number;
let cashAccountId: number;
let arOpeningId: number;

async function api(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
  headers: Record<string, string> = admin,
) {
  const res = await app.request(path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
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

  // 401 產檔需要公司稅籍
  await api("/company-profile", {
    name: "導入測試公司",
    taxId: "22099131",
    taxRegistrationNo: "123456789",
    cityCode: "A",
  }, "PUT");
  const customer = await api("/partners", { name: "舊客戶", taxId: "04541302", isCustomer: true });
  customerId = customer.json.id;
  const supplier = await api("/partners", { name: "舊供應商", taxId: "05004058", isSupplier: true });
  supplierId = supplier.json.id;
  const product = await api("/products", { sku: "OB-1", name: "開帳商品" });
  productId = product.json.id;
  cashAccountId = (await api("/accounts")).json.find((a: { code: string }) => a.code === "1101").id;
});

describe("期初應收：建立即同時進總帳與子帳", () => {
  it("建立期初應收 120,000：拋轉傳票（借 1144／貸 3351），對象餘額與未沖清單都看得到", async () => {
    const res = await api("/opening-balances", {
      kind: "receivable",
      partnerId: customerId,
      entryDate: "2026-01-01",
      docDate: "2025-11-15",
      dueDate: "2025-12-15",
      amount: 120000,
      memo: "原銷貨單 S-2025-081",
    });
    expect(res.status).toBe(201);
    expect(res.json.journalEntryId).toBeTruthy();
    arOpeningId = res.json.id;

    // 子帳三處（B6 的核心）：對象餘額、未沖單據、帳齡
    const balances = (await api("/partner-balances")).json;
    expect(balances.find((b: { partnerId: number }) => b.partnerId === customerId)).toMatchObject({
      ar: 120000,
    });
    const open = (await api(`/open-documents?partnerId=${customerId}&kind=receipt`)).json;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      docType: "opening",
      id: arOpeningId,
      docDate: "2025-11-15",
      total: 120000,
      remaining: 120000,
    });

    // 總帳：試算表平衡且 1144/3351 各入 120,000（不需要另一張手工傳票）
    const tb = (await api("/trial-balance")).json;
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.rows.find((r: { code: string }) => r.code === "1144")).toMatchObject({ debit: 120000 });
    expect(tb.rows.find((r: { code: string }) => r.code === "3351")).toMatchObject({ credit: 120000 });
  });

  it("護欄：非客戶不能建期初應收；原單日期晚於開帳日被擋", async () => {
    const notCustomer = await api("/opening-balances", {
      kind: "receivable",
      partnerId: supplierId,
      entryDate: "2026-01-01",
      docDate: "2025-12-01",
      amount: 100,
    });
    expect(notCustomer.status).toBe(422);
    expect(notCustomer.json.error).toContain("不是客戶");

    const badDate = await api("/opening-balances", {
      kind: "receivable",
      partnerId: customerId,
      entryDate: "2026-01-01",
      docDate: "2026-01-15",
      amount: 100,
    });
    expect(badDate.status).toBe(422);
    expect(badDate.json.error).toContain("晚於開帳日");
  });

  it("權限：期初單限 admin/finance——業務角色被擋", async () => {
    await api("/users", { username: "sales1", displayName: "業務", password: "secret-test", role: "sales" });
    const sales = await loginAs(app, "sales1", "secret-test");
    const res = await api("/opening-balances", {
      kind: "receivable",
      partnerId: customerId,
      entryDate: "2026-01-01",
      docDate: "2025-12-01",
      amount: 100,
    }, "POST", sales);
    expect(res.status).toBe(403);
  });
});

describe("收款沖銷期初單", () => {
  it("收款 50,000 立沖期初單：餘額降為 70,000，帳齡照原單到期日列逾期", async () => {
    const receipt = await api("/cash-docs", {
      kind: "receipt",
      partnerId: customerId,
      docDate: "2026-01-05",
      amount: 50000,
      accountId: cashAccountId,
      allocations: [{ targetType: "opening", targetId: arOpeningId, amount: 50000 }],
    });
    expect(receipt.status).toBe(201);

    const balances = (await api("/partner-balances")).json;
    expect(balances.find((b: { partnerId: number }) => b.partnerId === customerId)).toMatchObject({
      ar: 70000, // 不再是 gap-analysis 實測到的 -50000「假預收」
    });
    const open = (await api(`/open-documents?partnerId=${customerId}&kind=receipt`)).json;
    expect(open[0]).toMatchObject({ docType: "opening", allocated: 50000, remaining: 70000 });

    // 帳齡：到期日 2025-12-15 已過 → 全額列逾期（依原單時間軸，不是從開帳日重新起算）
    const aging = (await api("/reports/ar-aging?asOf=2026-01-31")).json;
    expect(aging.totals).toMatchObject({ total: 70000, overdue: 70000 });

    // 儀表板與資產負債表對得起來（gap-analysis 實測的「兩張畫面兩個數字」不再發生）
    const dash = (await api("/reports/dashboard?asOf=2026-01-31")).json;
    expect(dash.ar).toBe(70000);
  });

  it("超沖被擋：期初單未沖餘額 70,000，欲沖 100,000 → 422", async () => {
    const res = await api("/cash-docs", {
      kind: "receipt",
      partnerId: customerId,
      docDate: "2026-01-06",
      amount: 100000,
      accountId: cashAccountId,
      allocations: [{ targetType: "opening", targetId: arOpeningId, amount: 100000 }],
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("期初單");
  });
});

describe("期初應付（對稱路徑）", () => {
  it("建立期初應付 80,000 → 付款全沖：ap 歸零、未沖清單清空", async () => {
    const created = await api("/opening-balances", {
      kind: "payable",
      partnerId: supplierId,
      entryDate: "2026-01-02",
      docDate: "2025-12-20",
      amount: 80000,
    });
    expect(created.status).toBe(201);
    expect(
      (await api("/partner-balances")).json.find((b: { partnerId: number }) => b.partnerId === supplierId),
    ).toMatchObject({ ap: 80000 });

    const payment = await api("/cash-docs", {
      kind: "payment",
      partnerId: supplierId,
      docDate: "2026-01-08",
      amount: 80000,
      accountId: cashAccountId,
      allocations: [{ targetType: "opening", targetId: created.json.id, amount: 80000 }],
    });
    expect(payment.status).toBe(201);
    expect((await api(`/open-documents?partnerId=${supplierId}&kind=payment`)).json).toHaveLength(0);
    expect(
      (await api("/partner-balances")).json.find((b: { partnerId: number }) => b.partnerId === supplierId),
    ).toBeUndefined(); // ar/ap 皆 0 的對象不列
  });

  it("資產負債表平衡：1144=70,000、2144 已付清不列，權益承接期初淨額", async () => {
    const bs = (await api("/reports/balance-sheet?asOf=2026-01-31")).json;
    expect(bs.balanced).toBe(true);
    expect(bs.assets.find((r: { code: string }) => r.code === "1144")).toMatchObject({ amount: 70000 });
    expect(bs.liabilities.find((r: { code: string }) => r.code === "2144")).toBeUndefined();
  });
});

describe("期初不進 401", () => {
  it("該期只有期初單與收付款：401 銷項進項全為零、媒體檔無任何紀錄", async () => {
    const res = await api("/vat-returns/401?period=202601");
    expect(res.status).toBe(200);
    expect(res.json.summary).toMatchObject({
      invoiceCount: 0,
      outputSales: 0,
      outputTax: 0,
      inputExpense: 0,
      inputExpenseTax: 0,
    });
    expect(res.json.mediaFile.records).toBe(0);
  });
});

describe("關帳鎖對期初單生效", () => {
  it("關 2026-01 後，開帳日落在該期的期初單 → 409", async () => {
    expect((await api("/period-closes", { period: "2026-01" })).status).toBe(201);
    const res = await api("/opening-balances", {
      kind: "receivable",
      partnerId: customerId,
      entryDate: "2026-01-20",
      docDate: "2025-12-01",
      amount: 999,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("已關帳");
  });
});

describe("庫存開帳護欄（B6-b）", () => {
  it("開帳回傳合計；月結檢查提示存貨差額（不硬擋）；補傳票後轉綠", async () => {
    const opening = await api("/inventory/opening", {
      docDate: "2026-02-01",
      lines: [{ productId, qty: 100, unitCost: 60 }],
    });
    expect(opening.status).toBe(201);
    expect(opening.json).toMatchObject({ lines: 1, totalAmount: 6000 });

    // 忘了補期初傳票：檢查清單亮黃燈（ok:false 但 blocking:false，不擋關帳）
    const before = (await api("/period-closes/check?period=2026-02")).json;
    const item = before.find((i: { key: string }) => i.key === "inventory");
    expect(item).toMatchObject({ ok: false, blocking: false });
    expect(item.detail).toContain("6000");

    // 照提示補傳票（借 1301／貸 3351）後轉綠
    const entry = await api("/journal-entries", {
      entryDate: "2026-02-01",
      memo: "期初開帳：存貨",
      lines: [
        { accountCode: "1301", debit: 6000, credit: 0 },
        { accountCode: "3351", debit: 0, credit: 6000 },
      ],
    });
    expect(entry.status).toBe(201);
    const after = (await api("/period-closes/check?period=2026-02")).json;
    expect(after.find((i: { key: string }) => i.key === "inventory")).toMatchObject({ ok: true });
  });
});
