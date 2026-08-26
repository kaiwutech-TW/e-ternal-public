/**
 * 銷貨退回／進貨退出（帳務面）驗收。
 *
 * 覆蓋的不變量：
 * 1. 全額退回＝「那次銷貨從未發生」——分錄借貸、庫存量與帳面金額、成本回沖、應收沖回全部歸位。
 * 2. 部分退回按數量比例攤，多次退到全退時金額／稅額／成本三者軋平（不留尾差）。
 * 3. 累計退回量由服務層把關（超量 422），不是只靠前端。
 * 4. 已收款的退貨不得把應收沖成負數：超出的部分掛 2201 其他應付款。
 * 5. 已關帳月份一律 409（assertPeriodOpen），退貨日不得早於原銷貨日。
 * 6. 帳齡表與對象餘額兩張表對退貨的結論一致（既有 reverseSale 的病灶就是兩張表互相矛盾）。
 * 7. 進貨退出對稱，且退出額超過在庫帳面金額時差額回沖 5101、1301 不為負。
 * 8. 折讓不產生任何庫存異動；權限：採購角色不能開銷貨退回。
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
let salesAuth: Record<string, string>;
let purchasingAuth: Record<string, string>;
let customerId: number;
let supplierId: number;
let productId: number;
let cashAccountId: number;
/** 送到 DB 的 SQL（含參數）：併發鎖的測試要驗「取鎖的時機與順序」，那是 SQL 層的事實 */
const sqlLog: { sql: string; params: unknown[] }[] = [];

async function api(
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const res = await app.request(path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

interface EntryLine {
  code: string;
  debit: number;
  credit: number;
}

async function entryLines(entryId: number): Promise<EntryLine[]> {
  const res = await api(`/journal-entries/${entryId}`, admin);
  return res.json.lines as EntryLine[];
}

/** 某科目在一張傳票上的淨借方（借 − 貸） */
function net(lines: EntryLine[], code: string): number {
  return lines.filter((l) => l.code === code).reduce((s, l) => s + l.debit - l.credit, 0);
}

async function trialNet(code: string): Promise<number> {
  const tb = await api("/trial-balance", admin);
  const row = tb.json.rows.find((r: { code: string }) => r.code === code);
  return row ? row.debit - row.credit : 0;
}

async function inventoryOf(pid: number): Promise<{ qty: number; amount: number }> {
  const inv = await api("/inventory", admin);
  const row = inv.json.find((r: { productId: number }) => r.productId === pid);
  return { qty: row.qty, amount: row.amount };
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client, {
    logger: { logQuery: (sql, params) => sqlLog.push({ sql, params }) },
  });
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);
  await api("/users", admin, { username: "sal", displayName: "業務", password: "secret-test", role: "sales" });
  salesAuth = await loginAs(app, "sal", "secret-test");
  await api("/users", admin, { username: "pur", displayName: "採購", password: "secret-test", role: "purchasing" });
  purchasingAuth = await loginAs(app, "pur", "secret-test");

  const supplier = await api("/partners", admin, { name: "供應商甲", isSupplier: true });
  supplierId = supplier.json.id;
  const customer = await api("/partners", admin, { name: "客戶甲", taxId: "04541302", isCustomer: true });
  customerId = customer.json.id;
  const product = await api("/products", admin, { sku: "SKU-R1", name: "螢幕" });
  productId = product.json.id;

  const accounts = await api("/accounts", admin);
  cashAccountId = accounts.json.find((a: { code: string }) => a.code === "1101").id;
});

describe("全額退回：帳、庫存、成本、應收四面歸位", () => {
  let saleId: number;
  let returnId: number;

  it("前置：進貨 100 @ 10、銷貨 40 @ 25", async () => {
    await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2024-07-01",
      lines: [{ productId, qty: 100, unitPrice: 10 }],
    });
    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2024-07-05",
      lines: [{ productId, qty: 40, unitPrice: 25 }],
    });
    expect(sale.status).toBe(201);
    saleId = sale.json.id;
    expect(sale.json).toMatchObject({ subtotal: 1000, tax: 50, total: 1050, cogs: 400 });
    expect(await inventoryOf(productId)).toEqual({ qty: 60, amount: 600 });
  });

  it("可退資訊由伺服器提供：可退量＝原量、已退 0", async () => {
    const info = await api(`/sales/${saleId}/returnable`, salesAuth);
    expect(info.status).toBe(200);
    expect(info.json.lines).toHaveLength(1);
    expect(info.json.lines[0]).toMatchObject({
      qty: 40,
      remainingQty: 40,
      returnedQty: 0,
      remainingAllowance: 1000,
    });
  });

  it("全額退回：借 4109 未稅＋2288 稅額、貸 1144 含稅；借 1301 貸 5101 各為原成本", async () => {
    const info = await api(`/sales/${saleId}/returnable`, salesAuth);
    const res = await api(`/sales/${saleId}/returns`, salesAuth, {
      kind: "return",
      docDate: "2024-07-20",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 40 }],
    });
    expect(res.status).toBe(201);
    returnId = res.json.id;
    expect(res.json).toMatchObject({ subtotal: 1000, tax: 50, total: 1050, cogs: 400, arOffset: 1050, payableAmount: 0 });

    const lines = await entryLines(res.json.journalEntryId);
    expect(net(lines, "4109")).toBe(1000); // 收入減項走 4109，不紅字沖 4101
    expect(net(lines, "4101")).toBe(0);
    expect(net(lines, "2288")).toBe(50);
    expect(net(lines, "1144")).toBe(-1050);
    expect(net(lines, "1301")).toBe(400);
    expect(net(lines, "5101")).toBe(-400);
    expect(lines.reduce((s, l) => s + l.debit, 0)).toBe(lines.reduce((s, l) => s + l.credit, 0));
  });

  it("退回後庫存與成本回到「那次銷貨從未發生」的狀態", async () => {
    expect(await inventoryOf(productId)).toEqual({ qty: 100, amount: 1000 });
    expect(await trialNet("5101")).toBe(0); // 銷貨成本 400 已被全數回沖
    expect(await trialNet("1144")).toBe(0); // 應收沖回，客戶不欠也不溢付
    const tb = await api("/trial-balance", admin);
    expect(tb.json.totalDebit).toBe(tb.json.totalCredit);
  });

  it("損益表：4109 以負數列在收入區，本期營收自動變淨額", async () => {
    const is = await api("/reports/income-statement?from=2024-07-01&to=2024-07-31", admin);
    const ret = is.json.revenue.find((r: { code: string }) => r.code === "4109");
    expect(ret.amount).toBe(-1000);
    expect(is.json.totalRevenue).toBe(0); // 1000 銷貨 − 1000 退回
  });

  it("原銷貨單維持存在（不設 reversal_entry_id），退回單另立一張", async () => {
    const sales = await api("/sales", admin);
    const row = sales.json.find((s: { id: number }) => s.id === saleId);
    expect(row.reversalEntryId).toBeNull();
    expect(row.total).toBe(1050); // 原單金額一個字都不動
    const list = await api("/sales-returns", salesAuth);
    expect(list.json.find((r: { id: number }) => r.id === returnId)).toBeTruthy();
  });

  it("已開退回單的銷貨單不得再走「作廢發票並整單沖銷」（避免雙重沖銷）", async () => {
    await api("/company-profile", admin, {
      name: "測試公司", taxId: "04541302", taxRegistrationNo: "123456789", cityCode: "A",
    }, "PUT");
    await api("/invoice-tracks", admin, { period: "202407", track: "KZ", rangeStart: 10000000, rangeEnd: 10000010 });
    const inv = await api(`/sales/${saleId}/invoice`, admin, { mode: "B2B", randomNumber: "0001" });
    expect(inv.status).toBe(201);
    const cancel = await api(`/invoices/${inv.json.id}/cancel`, admin, {
      reason: "測試", cancelDate: "2024-07-25", reverseSale: true,
    });
    expect(cancel.status).toBe(409);
    expect(cancel.json.error).toContain("已有退回／折讓單");
  });
});

describe("部分退回：比例攤與多次退回的軋平", () => {
  let saleId: number;
  let lineId: number;
  let tinyProductId: number;

  it("前置：一張 qty=3、amount=10、cost=10 的銷貨（單位成本除不盡，專門用來看尾差）", async () => {
    // 另開一個商品，避免沿用前一段的庫存（均價會變，攤不出要測的尾差）
    const product = await api("/products", admin, { sku: "SKU-R9", name: "小零件" });
    tinyProductId = product.json.id;
    await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2024-08-01",
      lines: [{ productId: tinyProductId, qty: 3, unitPrice: 3.34 }],
    });
    // 售價 3 個 × 3.34 = 10 元（未稅），稅額 calcTax(10) = 1（0.5 → 1）
    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2024-08-05",
      lines: [{ productId: tinyProductId, qty: 3, unitPrice: 3.34 }],
    });
    saleId = sale.json.id;
    expect(sale.json).toMatchObject({ subtotal: 10, tax: 1, total: 11 });
    const info = await api(`/sales/${saleId}/returnable`, admin);
    lineId = info.json.lines[0].id;
    // 成本 10 元／3 個：單位成本 3.3333 除不盡，逐次 round 會少回補 1 元
    expect(sale.json.cogs).toBe(10);
    expect(await inventoryOf(tinyProductId)).toEqual({ qty: 0, amount: 0 });
  });

  it("第一次退 1 個：金額與成本各按比例攤（round(10 × 1/3) = 3）", async () => {
    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "return",
      docDate: "2024-08-10",
      lines: [{ sourceLineId: lineId, qty: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ subtotal: 3, cogs: 3 });
    // 未全退：稅額 = calcTax(3) = 0，但不得超過剩餘稅額
    expect(res.json.tax).toBe(0);
  });

  it("第二次退 1 個：同樣攤 3 元", async () => {
    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "return",
      docDate: "2024-08-11",
      lines: [{ sourceLineId: lineId, qty: 1 }],
    });
    expect(res.json).toMatchObject({ subtotal: 3, cogs: 3, tax: 0 });
  });

  it("第三次退到全退：金額／成本／稅額三者軋平，不留尾差", async () => {
    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "return",
      docDate: "2024-08-12",
      lines: [{ sourceLineId: lineId, qty: 1 }],
    });
    // 逐次 round 只會回補 3+3+3=9，軋平後最後一筆是 10−3−3=4
    expect(res.json).toMatchObject({ subtotal: 4, cogs: 4 });
    // 稅額同理：calcTax(3) 三次都是 0，軋平後最後一筆補回原稅額 1
    expect(res.json.tax).toBe(1);

    const info = await api(`/sales/${saleId}/returnable`, admin);
    expect(info.json.lines[0]).toMatchObject({ returnedQty: 3, returnedAmount: 10, remainingQty: 0 });
  });

  it("全退後銷項稅額與成本歸零（沒有 1 元殘留在 2288／5101）", async () => {
    const entries = await api("/journal-entries?from=2024-08-01&to=2024-08-31", admin);
    const ids = entries.json.map((e: { id: number }) => e.id);
    let tax = 0;
    let cogs = 0;
    for (const id of ids) {
      const lines = await entryLines(id);
      tax += net(lines, "2288");
      cogs += net(lines, "5101");
    }
    expect(tax).toBe(0); // 銷貨貸 1、三次退回合計借 0+0+1
    expect(cogs).toBe(0); // 銷貨借 10、三次退回合計貸 3+3+4
    // 庫存回到進貨後的原狀：3 個、10 元（少回補 1 元就會變成 9）
    expect(await inventoryOf(tinyProductId)).toEqual({ qty: 3, amount: 10 });
  });
});

describe("累計退回量的把關（服務層，不是只靠前端）", () => {
  let saleId: number;
  let lineId: number;

  it("前置：銷貨 10 個", async () => {
    await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2024-09-01",
      lines: [{ productId, qty: 10, unitPrice: 50 }],
    });
    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2024-09-02",
      lines: [{ productId, qty: 10, unitPrice: 80 }],
    });
    saleId = sale.json.id;
    const info = await api(`/sales/${saleId}/returnable`, admin);
    lineId = info.json.lines[0].id;
  });

  it("一次退超過原銷貨量 → 422，訊息說得出原量／已退／可退", async () => {
    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "return",
      docDate: "2024-09-10",
      lines: [{ sourceLineId: lineId, qty: 11 }],
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("可退 10");
  });

  it("分兩次累計超量 → 第二次被擋（6 + 5 > 10）", async () => {
    const first = await api(`/sales/${saleId}/returns`, admin, {
      kind: "return",
      docDate: "2024-09-10",
      lines: [{ sourceLineId: lineId, qty: 6 }],
    });
    expect(first.status).toBe(201);
    const second = await api(`/sales/${saleId}/returns`, admin, {
      kind: "return",
      docDate: "2024-09-11",
      lines: [{ sourceLineId: lineId, qty: 5 }],
    });
    expect(second.status).toBe(422);
    expect(second.json.error).toContain("已退 6");
  });

  it("同一張退回單內重複指向同一明細也會累計（4 + 1 > 剩餘 4）", async () => {
    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "return",
      docDate: "2024-09-12",
      lines: [
        { sourceLineId: lineId, qty: 4 },
        { sourceLineId: lineId, qty: 1 },
      ],
    });
    expect(res.status).toBe(422);
  });

  it("別張銷貨單的明細不得混入 → 422", async () => {
    const other = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2024-09-13",
      lines: [{ productId, qty: 1, unitPrice: 80 }],
    });
    const otherInfo = await api(`/sales/${other.json.id}/returnable`, admin);
    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "return",
      docDate: "2024-09-14",
      lines: [{ sourceLineId: otherInfo.json.lines[0].id, qty: 1 }],
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("不屬於銷貨單");
  });

  it("退回日早於原銷貨日 → 422", async () => {
    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "return",
      docDate: "2024-09-01",
      lines: [{ sourceLineId: lineId, qty: 1 }],
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("早於原銷貨日");
  });
});

describe("已收款後退貨：應收不得被沖成負數", () => {
  let saleId: number;
  let lineId: number;
  let payerId: number;

  it("前置：另一客戶買 1050 元、當場收款 1050 元並立沖", async () => {
    const partner = await api("/partners", admin, { name: "付清客戶", isCustomer: true });
    payerId = partner.json.id;
    await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2024-10-01",
      lines: [{ productId, qty: 10, unitPrice: 60 }],
    });
    const sale = await api("/sales", admin, {
      partnerId: payerId,
      docDate: "2024-10-02",
      lines: [{ productId, qty: 10, unitPrice: 100 }],
    });
    saleId = sale.json.id;
    expect(sale.json.total).toBe(1050);
    const info = await api(`/sales/${saleId}/returnable`, admin);
    lineId = info.json.lines[0].id;

    const receipt = await api("/cash-docs", admin, {
      kind: "receipt",
      partnerId: payerId,
      docDate: "2024-10-03",
      amount: 1050,
      accountId: cashAccountId,
      allocations: [{ targetId: saleId, amount: 1050 }],
    });
    expect(receipt.status).toBe(201);
  });

  it("已付清的客戶退 2 個：不沖應收，全額掛 2201 其他應付款", async () => {
    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "return",
      docDate: "2024-10-10",
      lines: [{ sourceLineId: lineId, qty: 2 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ subtotal: 200, tax: 10, total: 210, arOffset: 0, payableAmount: 210 });

    const lines = await entryLines(res.json.journalEntryId);
    expect(net(lines, "1144")).toBe(0);
    expect(net(lines, "2201")).toBe(-210); // 該退給客戶的錢是負債，不是負的應收
  });

  it("應收餘額不為負，帳齡表與對象餘額兩張表結論一致", async () => {
    const balances = await api("/partner-balances", admin);
    const row = balances.json.find((b: { partnerId: number }) => b.partnerId === payerId);
    expect(row === undefined || row.ar === 0).toBe(true); // 全部收訖：不是 −210

    const aging = await api("/reports/ar-aging?asOf=2024-10-31", admin);
    const agingRow = aging.json.rows.find((r: { partnerId: number }) => r.partnerId === payerId);
    // 帳齡與對象餘額同一結論：這個客戶既沒欠款、也沒有預收（那 210 掛在其他應付款）
    expect(agingRow === undefined || (agingRow.total === 0 && agingRow.credit === 0)).toBe(true);
  });

  it("當場退現：指定現金科目，貸現金而不是掛其他應付", async () => {
    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "return",
      docDate: "2024-10-11",
      settlement: "cash",
      cashAccountId,
      lines: [{ sourceLineId: lineId, qty: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ arOffset: 0, payableAmount: 0, cashAmount: 105 });
    const lines = await entryLines(res.json.journalEntryId);
    expect(net(lines, "1101")).toBe(-105);
  });

  it("未收款的客戶退貨則沖應收：帳齡直接降下來", async () => {
    const sale = await api("/sales", admin, {
      partnerId: payerId,
      docDate: "2024-10-15",
      lines: [{ productId, qty: 5, unitPrice: 100 }],
    });
    const info = await api(`/sales/${sale.json.id}/returnable`, admin);
    const before = await api("/reports/ar-aging?asOf=2024-10-31", admin);
    const beforeTotal = before.json.rows.find((r: { partnerId: number }) => r.partnerId === payerId).total;
    expect(beforeTotal).toBe(525);

    const res = await api(`/sales/${sale.json.id}/returns`, admin, {
      kind: "return",
      docDate: "2024-10-20",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 2 }],
    });
    expect(res.json).toMatchObject({ arOffset: 210, payableAmount: 0 });

    const after = await api("/reports/ar-aging?asOf=2024-10-31", admin);
    expect(after.json.rows.find((r: { partnerId: number }) => r.partnerId === payerId).total).toBe(315);
    const open = await api(`/open-documents?partnerId=${payerId}&kind=receipt`, admin);
    const doc = open.json.find((d: { id: number }) => d.id === sale.json.id);
    expect(doc.remaining).toBe(315); // 未沖餘額同步扣掉退回
  });
});

describe("折讓：貨沒退、只少收錢", () => {
  let saleId: number;
  let lineId: number;

  it("折讓只動收入與稅，不產生任何庫存異動", async () => {
    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2024-11-02",
      lines: [{ productId, qty: 2, unitPrice: 100 }],
    });
    saleId = sale.json.id;
    const info = await api(`/sales/${saleId}/returnable`, admin);
    lineId = info.json.lines[0].id;
    const before = await inventoryOf(productId);

    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "allowance",
      docDate: "2024-11-05",
      memo: "外觀刮傷，客戶願意留貨",
      lines: [{ sourceLineId: lineId, amount: 50 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ kind: "allowance", subtotal: 50, tax: 3, cogs: 0 });

    expect(await inventoryOf(productId)).toEqual(before);
    const lines = await entryLines(res.json.journalEntryId);
    expect(net(lines, "4109")).toBe(50);
    expect(net(lines, "1301")).toBe(0);
    expect(net(lines, "5101")).toBe(0);
  });

  it("折讓的金額上限＝原金額 − 已退回 − 已折讓（不得超過原明細金額）", async () => {
    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "allowance",
      docDate: "2024-11-06",
      lines: [{ sourceLineId: lineId, amount: 200 }],
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("可折讓 150");
  });
});

describe("已關帳月份被擋（assertPeriodOpen）", () => {
  it("關帳至 2024-11 後，退回日落在 11 月 → 409；改記 12 月則可入帳", async () => {
    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2024-11-20",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    const info = await api(`/sales/${sale.json.id}/returnable`, admin);
    const lineId = info.json.lines[0].id;

    // 依序關到 2024-11（本測試庫的第一筆交易在 2024-07）
    for (const period of ["2024-07", "2024-08", "2024-09", "2024-10", "2024-11"]) {
      const res = await api("/period-closes", admin, { period });
      expect(res.status).toBe(201);
    }

    const blocked = await api(`/sales/${sale.json.id}/returns`, admin, {
      kind: "return",
      docDate: "2024-11-25",
      lines: [{ sourceLineId: lineId, qty: 1 }],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain("已關帳");

    // 11 月已關就記 12 月：原銷貨單與 11 月的數字一個字都不動
    const ok = await api(`/sales/${sale.json.id}/returns`, admin, {
      kind: "return",
      docDate: "2024-12-01",
      lines: [{ sourceLineId: lineId, qty: 1 }],
    });
    expect(ok.status).toBe(201);
    const dec = await api("/reports/income-statement?from=2024-12-01&to=2024-12-31", admin);
    expect(dec.json.revenue.find((r: { code: string }) => r.code === "4109").amount).toBe(-100);
  });

  it("證明單日期落在已關期間也被擋（進項稅歸期不得追溯）", async () => {
    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2024-12-02",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    const info = await api(`/sales/${sale.json.id}/returnable`, admin);
    const res = await api(`/sales/${sale.json.id}/returns`, admin, {
      kind: "return",
      docDate: "2024-12-05",
      certDate: "2024-11-30",
      certNo: "ALW90000001", // 一次只驗期間鎖：不帶號碼會先被「填了日期就要填號碼」擋成 422
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 1 }],
    });
    expect(res.status).toBe(409);
  });
});

describe("進貨退出（對稱案例）", () => {
  let purchaseId: number;
  let lineId: number;
  let otherProductId: number;

  it("前置：進貨 20 @ 30，退出 5 個", async () => {
    const product = await api("/products", admin, { sku: "SKU-R2", name: "鍵盤" });
    otherProductId = product.json.id;
    const purchase = await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2024-12-03",
      lines: [{ productId: otherProductId, qty: 20, unitPrice: 30 }],
    });
    purchaseId = purchase.json.id;
    expect(purchase.json).toMatchObject({ subtotal: 600, tax: 30, total: 630 });
    const info = await api(`/purchases/${purchaseId}/returnable`, purchasingAuth);
    expect(info.json.lines[0]).toMatchObject({ qty: 20, remainingQty: 20, onHandQty: 20 });
    lineId = info.json.lines[0].id;
  });

  it("退出 5 個：借 2144 應付含稅、貸 1301 未稅＋1288 稅額；庫存與帳面同步減少", async () => {
    const res = await api(`/purchases/${purchaseId}/returns`, purchasingAuth, {
      kind: "return",
      docDate: "2024-12-06",
      lines: [{ sourceLineId: lineId, qty: 5 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      subtotal: 150, tax: 8, total: 158, invCredit: 150, costDiff: 0, apOffset: 158, receivableAmount: 0,
    });

    const lines = await entryLines(res.json.journalEntryId);
    expect(net(lines, "2144")).toBe(158);
    expect(net(lines, "1301")).toBe(-150);
    expect(net(lines, "1288")).toBe(-8);
    expect(lines.reduce((s, l) => s + l.debit, 0)).toBe(lines.reduce((s, l) => s + l.credit, 0));
    expect(await inventoryOf(otherProductId)).toEqual({ qty: 15, amount: 450 });
  });

  it("未付餘額同步扣掉退出：應付餘額 630 − 158", async () => {
    const open = await api(`/open-documents?partnerId=${supplierId}&kind=payment`, admin);
    const doc = open.json.find((d: { id: number }) => d.id === purchaseId);
    expect(doc.remaining).toBe(472);
  });

  it("退出量超過在庫量 → 409（庫存變負之後每一筆銷貨都會在無關單據上炸）", async () => {
    // 先把在庫賣到只剩 2 個
    await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2024-12-07",
      lines: [{ productId: otherProductId, qty: 13, unitPrice: 50 }],
    });
    const res = await api(`/purchases/${purchaseId}/returns`, purchasingAuth, {
      kind: "return",
      docDate: "2024-12-08",
      lines: [{ sourceLineId: lineId, qty: 5 }],
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("庫存不足");
  });

  it("退出額超過在庫帳面金額：1301 不為負，差額回沖 5101", async () => {
    // 目前該商品在庫 2 個、帳面 60 元（30/個）。再進 2 個 @ 5 元把均價拉低到 17.5
    await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2024-12-09",
      lines: [{ productId: otherProductId, qty: 2, unitPrice: 5 }],
    });
    expect(await inventoryOf(otherProductId)).toEqual({ qty: 4, amount: 70 });
    // 賣掉 3 個：成本 3 × 17.5 = 53（在庫剩 1 個／17 元）
    await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2024-12-10",
      lines: [{ productId: otherProductId, qty: 3, unitPrice: 60 }],
    });
    const stock = await inventoryOf(otherProductId);
    expect(stock).toEqual({ qty: 1, amount: 17 });

    // 現在退回原批次 1 個（原進價 30），但帳上只背 17 元
    const res = await api(`/purchases/${purchaseId}/returns`, purchasingAuth, {
      kind: "return",
      docDate: "2024-12-11",
      lines: [{ sourceLineId: lineId, qty: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ subtotal: 30, invCredit: 17, costDiff: 13 });

    const lines = await entryLines(res.json.journalEntryId);
    expect(net(lines, "1301")).toBe(-17);
    expect(net(lines, "5101")).toBe(-13); // 差額回沖銷貨成本，不憑空生一個價差科目
    const after = await inventoryOf(otherProductId);
    expect(after.qty).toBe(0);
    expect(after.amount).toBe(0); // 存貨帳面不為負
    expect(await trialNet("1301")).toBeGreaterThanOrEqual(0);
  });

  it("進貨折讓：qty 不動、只減存貨帳面（總帳與存貨明細不得脫鉤）", async () => {
    const purchase = await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2024-12-12",
      lines: [{ productId: otherProductId, qty: 10, unitPrice: 20 }],
    });
    const info = await api(`/purchases/${purchase.json.id}/returnable`, purchasingAuth);
    const res = await api(`/purchases/${purchase.json.id}/returns`, purchasingAuth, {
      kind: "allowance",
      docDate: "2024-12-13",
      memo: "數量短少，供應商折讓",
      lines: [{ sourceLineId: info.json.lines[0].id, amount: 40 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ subtotal: 40, tax: 2, invCredit: 40, costDiff: 0 });
    // 數量不變、帳面金額減 40：分錄貸了 1301，庫存明細帳必須同步，否則之後每一筆銷貨成本都偏高
    expect(await inventoryOf(otherProductId)).toEqual({ qty: 10, amount: 160 });
  });
});

describe("權限：依 ROLE_PAGES，退回掛在來源單據的頁面權限下", () => {
  it("採購角色不得開銷貨退回（無 sales 頁權限）", async () => {
    const sales = await api("/sales", admin);
    const anySale = sales.json[0];
    const res = await api(`/sales/${anySale.id}/returns`, purchasingAuth, {
      kind: "return",
      docDate: "2024-12-20",
      lines: [{ sourceLineId: 1, qty: 1 }],
    });
    expect(res.status).toBe(403);
  });

  it("業務角色不得開進貨退出（無 purchases 頁權限），也看不到進貨退出清單", async () => {
    const purchases = await api("/purchases", admin);
    const res = await api(`/purchases/${purchases.json[0].id}/returns`, salesAuth, {
      kind: "return",
      docDate: "2024-12-20",
      lines: [{ sourceLineId: 1, qty: 1 }],
    });
    expect(res.status).toBe(403);
    expect((await api("/purchase-returns", salesAuth)).status).toBe(403);
  });

  it("總經理帳號唯讀：看得到退回清單，開不了退回單", async () => {
    await api("/users", admin, { username: "boss", displayName: "總經理", password: "secret-test", role: "gm" });
    const gm = await loginAs(app, "boss", "secret-test");
    expect((await api("/sales-returns", gm)).status).toBe(200);
    const sales = await api("/sales", admin);
    const res = await api(`/sales/${sales.json[0].id}/returns`, gm, {
      kind: "return",
      docDate: "2024-12-20",
      lines: [{ sourceLineId: 1, qty: 1 }],
    });
    expect(res.status).toBe(403);
  });

  it("建立者留痕：created_by 落地供財務事後覆核", async () => {
    const list = await api("/sales-returns", admin);
    expect(list.json.every((r: { createdBy: number | null }) => r.createdBy !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------- 對抗驗證後的修正（2024-07-30）
// 以下每個 describe 對應一個被抓到的缺陷；日期一律用 2025 年（本測試庫已關帳至 2024-11）。

describe("進貨退出的存貨成本基礎：當下移動平均 × 數量（不是退款金額）", () => {
  let productA: number;
  let cheapPurchaseId: number;
  let cheapLineId: number;

  it("前置：進 100@10 ＋ 進 100@2 → 200 個／1200 元／均價 6；賣 100 個 → 100 個／600 元", async () => {
    const product = await api("/products", admin, { sku: "SKU-AVG", name: "均價測試品" });
    productA = product.json.id;
    await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2025-01-05",
      lines: [{ productId: productA, qty: 100, unitPrice: 10 }],
    });
    const cheap = await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2025-01-06",
      lines: [{ productId: productA, qty: 100, unitPrice: 2 }],
    });
    cheapPurchaseId = cheap.json.id;
    expect(cheap.json).toMatchObject({ subtotal: 200, tax: 10, total: 210 });
    expect(await inventoryOf(productA)).toEqual({ qty: 200, amount: 1200 });

    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2025-01-07",
      lines: [{ productId: productA, qty: 100, unitPrice: 30 }],
    });
    expect(sale.json.cogs).toBe(600); // 100 × 均價 6
    expect(await inventoryOf(productA)).toEqual({ qty: 100, amount: 600 });

    const info = await api(`/purchases/${cheapPurchaseId}/returnable`, purchasingAuth);
    cheapLineId = info.json.lines[0].id;
  });

  it("退出「便宜那批」100 個（退款 200）：沖存貨 600（100 × 均價 6）、差額 −400 借回 5101", async () => {
    const res = await api(`/purchases/${cheapPurchaseId}/returns`, purchasingAuth, {
      kind: "return",
      docDate: "2025-01-10",
      lines: [{ sourceLineId: cheapLineId, qty: 100 }],
    });
    expect(res.status).toBe(201);
    // 退款 200（供應商只退我們當初付的），但貨的帳面成本是均價 6 → 沖存貨 600、差額 −400
    expect(res.json).toMatchObject({ subtotal: 200, tax: 10, total: 210, invCredit: 600, costDiff: -400 });

    const lines = await entryLines(res.json.journalEntryId);
    expect(net(lines, "1301")).toBe(-600);
    expect(net(lines, "1288")).toBe(-10);
    expect(net(lines, "5101")).toBe(400); // 借記：已售 100 個的真實成本是 1000（購入 1200 − 退款 200）
    expect(net(lines, "2144")).toBe(210);
    expect(lines.reduce((s, l) => s + l.debit, 0)).toBe(lines.reduce((s, l) => s + l.credit, 0));
  });

  it("存貨歸零（0 個／0 元），不留「0 個卻有帳面金額」的定時炸彈", async () => {
    expect(await inventoryOf(productA)).toEqual({ qty: 0, amount: 0 });
  });

  it("再進 10 個 @1：均價是 1 而不是 41；賣 1 個的成本是 1", async () => {
    await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2025-01-15",
      lines: [{ productId: productA, qty: 10, unitPrice: 1 }],
    });
    const inv = await api("/inventory", admin);
    const row = inv.json.find((r: { productId: number }) => r.productId === productA);
    expect(row).toMatchObject({ qty: 10, amount: 10, avgUnitCost: 1 });

    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2025-01-16",
      lines: [{ productId: productA, qty: 1, unitPrice: 5 }],
    });
    expect(sale.json.cogs).toBe(1);
  });
});

describe("進貨折讓按在庫比例攤（不是先把在庫帳面吃光）", () => {
  let productB: number;
  let purchaseId: number;
  let lineId: number;

  it("前置：進 100@10（1000）→ 賣 50（成本 500）→ 在庫 50 個／500 元", async () => {
    const product = await api("/products", admin, { sku: "SKU-ALW", name: "折讓測試品" });
    productB = product.json.id;
    const purchase = await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2025-02-03",
      lines: [{ productId: productB, qty: 100, unitPrice: 10 }],
    });
    purchaseId = purchase.json.id;
    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2025-02-04",
      lines: [{ productId: productB, qty: 50, unitPrice: 20 }],
    });
    expect(sale.json.cogs).toBe(500);
    expect(await inventoryOf(productB)).toEqual({ qty: 50, amount: 500 });
    const info = await api(`/purchases/${purchaseId}/returnable`, purchasingAuth);
    lineId = info.json.lines[0].id;
  });

  it("折讓 800：比例 50/100 → 貸 1301 400、貸 5101 400（不是沖光 500）", async () => {
    const res = await api(`/purchases/${purchaseId}/returns`, purchasingAuth, {
      kind: "allowance",
      docDate: "2025-02-10",
      memo: "驗收不良，供應商折讓",
      lines: [{ sourceLineId: lineId, amount: 800 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ subtotal: 800, tax: 40, invCredit: 400, costDiff: 400 });
    const lines = await entryLines(res.json.journalEntryId);
    expect(net(lines, "1301")).toBe(-400);
    expect(net(lines, "5101")).toBe(-400);
  });

  it("在庫 50 個／100 元＝均價 2（＝真實淨成本 (1000−800)/100），之後的銷貨成本才對", async () => {
    const inv = await api("/inventory", admin);
    const row = inv.json.find((r: { productId: number }) => r.productId === productB);
    expect(row).toMatchObject({ qty: 50, amount: 100, avgUnitCost: 2 });
    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2025-02-11",
      lines: [{ productId: productB, qty: 1, unitPrice: 20 }],
    });
    expect(sale.json.cogs).toBe(2); // 舊做法會是 0，之後每一筆銷貨的毛利都虛胖
  });
});

describe("併發：鎖的層級對齊「跨單據的在庫量」", () => {
  let productC: number;
  let purchaseA: number;
  let purchaseB: number;
  let lineA: number;
  let lineB: number;

  it("前置：兩張進貨單各進 10 個，賣掉 15 個 → 在庫只剩 5", async () => {
    const product = await api("/products", admin, { sku: "SKU-LOCK", name: "併發測試品" });
    productC = product.json.id;
    const a = await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2025-03-01",
      lines: [{ productId: productC, qty: 10, unitPrice: 10 }],
    });
    const b = await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2025-03-02",
      lines: [{ productId: productC, qty: 10, unitPrice: 10 }],
    });
    purchaseA = a.json.id;
    purchaseB = b.json.id;
    await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2025-03-03",
      lines: [{ productId: productC, qty: 15, unitPrice: 20 }],
    });
    expect(await inventoryOf(productC)).toEqual({ qty: 5, amount: 50 });
    lineA = (await api(`/purchases/${purchaseA}/returnable`, purchasingAuth)).json.lines[0].id;
    lineB = (await api(`/purchases/${purchaseB}/returnable`, purchasingAuth)).json.lines[0].id;
  });

  it("鎖在讀在庫之前取得：products 的 FOR UPDATE 早於第一次讀 inventory_movements", async () => {
    sqlLog.length = 0;
    const res = await api(`/purchases/${purchaseA}/returns`, purchasingAuth, {
      kind: "return",
      docDate: "2025-03-10",
      lines: [{ sourceLineId: lineA, qty: 1 }],
    });
    expect(res.status).toBe(201);
    const lockAt = sqlLog.findIndex((q) => /from "products".*for update/is.test(q.sql));
    const onHandAt = sqlLog.findIndex((q) => /from "inventory_movements"/i.test(q.sql));
    expect(lockAt).toBeGreaterThanOrEqual(0); // 有取鎖（不是只鎖 purchases 那一列）
    expect(lockAt).toBeLessThan(onHandAt); // 且在讀在庫之前
  });

  it("同一交易涉及多個商品時依 product_id 由小到大取鎖（避免與另一交易互等成死鎖）", async () => {
    // 一張進貨單同時進兩個商品，退出時故意把 id 大的那筆放在明細第一列
    const extra = await api("/products", admin, { sku: "SKU-LOCK2", name: "併發測試品2" });
    const multi = await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2025-03-11",
      lines: [
        { productId: productC, qty: 2, unitPrice: 10 },
        { productId: extra.json.id, qty: 2, unitPrice: 10 },
      ],
    });
    const info = await api(`/purchases/${multi.json.id}/returnable`, purchasingAuth);
    const byProduct = new Map<number, number>(
      info.json.lines.map((l: { productId: number; id: number }) => [l.productId, l.id]),
    );
    sqlLog.length = 0;
    const res = await api(`/purchases/${multi.json.id}/returns`, purchasingAuth, {
      kind: "return",
      docDate: "2025-03-12",
      lines: [
        { sourceLineId: byProduct.get(extra.json.id)!, qty: 1 }, // id 大的先送
        { sourceLineId: byProduct.get(productC)!, qty: 1 },
      ],
    });
    expect(res.status).toBe(201);
    const lockedIds = sqlLog
      .filter((q) => /from "products".*for update/is.test(q.sql))
      .map((q) => Number(q.params[0]));
    expect(lockedIds).toEqual([...lockedIds].sort((a, b) => a - b));
    expect(lockedIds).toContain(productC);
    expect(lockedIds).toContain(extra.json.id);
  });

  it("兩張不同進貨單並行退出同一商品：不會超賣，庫存不為負", async () => {
    const before = await inventoryOf(productC);
    const [ra, rb] = await Promise.all([
      api(`/purchases/${purchaseA}/returns`, purchasingAuth, {
        kind: "return",
        docDate: "2025-03-20",
        lines: [{ sourceLineId: lineA, qty: before.qty }],
      }),
      api(`/purchases/${purchaseB}/returns`, purchasingAuth, {
        kind: "return",
        docDate: "2025-03-20",
        lines: [{ sourceLineId: lineB, qty: before.qty }],
      }),
    ]);
    // 兩張都要退掉「全部在庫」，只有一張能成立
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([201, 409]);
    const failed = ra.status === 409 ? ra : rb;
    expect(failed.json.error).toContain("庫存不足");
    const after = await inventoryOf(productC);
    expect(after.qty).toBe(0);
    expect(after.amount).toBe(0);
    expect(after.qty).toBeGreaterThanOrEqual(0);
  });

  it("並行的銷貨退回不會繞過累計上限（同一張銷貨單的 FOR UPDATE 序列化）", async () => {
    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2025-03-25",
      lines: [{ productId, qty: 2, unitPrice: 100 }],
    });
    const info = await api(`/sales/${sale.json.id}/returnable`, admin);
    const lineId = info.json.lines[0].id;
    const results = await Promise.all([
      api(`/sales/${sale.json.id}/returns`, admin, {
        kind: "return",
        docDate: "2025-03-26",
        lines: [{ sourceLineId: lineId, qty: 2 }],
      }),
      api(`/sales/${sale.json.id}/returns`, admin, {
        kind: "return",
        docDate: "2025-03-26",
        lines: [{ sourceLineId: lineId, qty: 2 }],
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    const after = await api(`/sales/${sale.json.id}/returnable`, admin);
    expect(after.json.lines[0]).toMatchObject({ returnedQty: 2, remainingQty: 0 });
  });
});

describe("防呆：攤分後 0 元的退出回 422，不是讓 DB constraint 擋成 500", () => {
  it("原明細 3 個 1 元，退 1 個攤到 0 元 → 照樣受理（貨已經退回去了，擋下來使用者無法記錄事實）", async () => {
    // 這裡原本斷言 422「無需開單」。那是錯的：整數元下單位成本不足 1 元時攤分必然出現 0，
    // 但實體那 1 個貨已經離開倉庫，擋掉等於帳與實際脫節。
    // prorateByQty 的軋平會在退到最後一個單位時補足原額，所以金額最終仍會收斂到 1。
    const product = await api("/products", admin, { sku: "SKU-TINY", name: "微額品" });
    const purchase = await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2025-03-05",
      lines: [{ productId: product.json.id, qty: 3, unitPrice: 0.34 }],
    });
    expect(purchase.json.subtotal).toBe(1);
    const info = await api(`/purchases/${purchase.json.id}/returnable`, purchasingAuth);
    const lineId = info.json.lines[0].id;
    const first = await api(`/purchases/${purchase.json.id}/returns`, purchasingAuth, {
      kind: "return",
      docDate: "2025-03-06",
      lines: [{ sourceLineId: lineId, qty: 1 }],
    });
    expect(first.status).toBe(201);
    expect(first.json.subtotal).toBe(0);

    // 把剩下 2 個也退完：軋平補足，累計退款額剛好等於原額 1 元
    const second = await api(`/purchases/${purchase.json.id}/returns`, purchasingAuth, {
      kind: "return",
      docDate: "2025-03-07",
      lines: [{ sourceLineId: lineId, qty: 2 }],
    });
    expect(second.status).toBe(201);
    expect(first.json.subtotal + second.json.subtotal).toBe(1);
  });
});

describe("退回與折讓是兩個獨立的額度池", () => {
  let saleId: number;
  let lineId: number;

  it("前置：銷貨 10 個 × 100 元", async () => {
    await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2025-04-01",
      lines: [{ productId, qty: 10, unitPrice: 40 }],
    });
    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2025-04-02",
      lines: [{ productId, qty: 10, unitPrice: 100 }],
    });
    saleId = sale.json.id;
    lineId = (await api(`/sales/${saleId}/returnable`, admin)).json.lines[0].id;
  });

  it("先退一半（5 個／500 元）", async () => {
    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "return",
      docDate: "2025-04-05",
      lines: [{ sourceLineId: lineId, qty: 5 }],
    });
    expect(res.status).toBe(201);
    expect(res.json.subtotal).toBe(500);
  });

  it("再給折讓 300（上限＝原金額 − 已退回 ＝ 500）", async () => {
    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "allowance",
      docDate: "2025-04-06",
      lines: [{ sourceLineId: lineId, amount: 300 }],
    });
    expect(res.status).toBe(201);
    const info = await api(`/sales/${saleId}/returnable`, admin);
    // 兩個上限分別表達：貨還可退 5 個，錢還可折讓 200
    expect(info.json.lines[0]).toMatchObject({
      returnedQty: 5,
      returnedAmount: 500,
      allowanceAmount: 300,
      remainingQty: 5,
      remainingAllowance: 200,
    });
  });

  it("折讓超過剩餘額度 → 422（訊息分別講出已退回與已折讓）", async () => {
    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "allowance",
      docDate: "2025-04-07",
      lines: [{ sourceLineId: lineId, amount: 201 }],
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("已退回 500");
    expect(res.json.error).toContain("已折讓 300");
    expect(res.json.error).toContain("可折讓 200");
  });

  it("剩下那一半貨真的退回來時不被折讓額度擋死，但退款受總上限（原額 1000）約束", async () => {
    // 原病灶：共用一個金額池 → 這一步被 422 擋死，貨在倉庫裡卻記不了帳。
    // 拆兩池之後貨退得回來，但只拆池不設總上限是另一個 bug：
    // 退 500 ＋ 折讓 300 ＋ 再退 500 = 1300，同一筆金額被沖第二次。
    // 正解：貨照退（數量池），退款受「原額 − 已退 − 已折讓」上限 → 這次只能退 200。
    const before = await inventoryOf(productId);
    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "return",
      docDate: "2025-04-10",
      lines: [{ sourceLineId: lineId, qty: 5 }],
    });
    expect(res.status).toBe(201);
    expect(res.json.subtotal).toBe(200); // 1000 − 已退 500 − 已折讓 300
    // 貨真的回到庫存（舊行為是 422，貨在倉庫裡但帳上沒有）
    expect((await inventoryOf(productId)).qty).toBe(before.qty + 5);
    const info = await api(`/sales/${saleId}/returnable`, admin);
    expect(info.json.lines[0]).toMatchObject({ remainingQty: 0, remainingAllowance: 0 });
  });

  it("累計退款不得超過原明細金額（退回＋折讓合計）", async () => {
    const info = await api(`/sales/${saleId}/returnable`, admin);
    const line = info.json.lines[0];
    // 這張明細已經全數退回並折讓完畢，累計退款剛好等於原額，不多不少
    expect(line.returnedAmount + line.allowanceAmount).toBe(line.amount);
  });
});

describe("應收帳齡依基準日篩退回單日期", () => {
  let agingCustomer: number;
  let saleId: number;
  let lineId: number;

  it("前置：新客戶 2025-06-01 銷貨 1050，未收款", async () => {
    const partner = await api("/partners", admin, { name: "帳齡客戶", isCustomer: true });
    agingCustomer = partner.json.id;
    await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2025-06-01",
      lines: [{ productId, qty: 10, unitPrice: 50 }],
    });
    const sale = await api("/sales", admin, {
      partnerId: agingCustomer,
      docDate: "2025-06-01",
      lines: [{ productId, qty: 10, unitPrice: 100 }],
    });
    saleId = sale.json.id;
    lineId = (await api(`/sales/${saleId}/returnable`, admin)).json.lines[0].id;
    const aging = await api("/reports/ar-aging?asOf=2025-06-30", admin);
    expect(aging.json.rows.find((r: { partnerId: number }) => r.partnerId === agingCustomer).total).toBe(1050);
  });

  it("退貨日在基準日之後：6/30 的帳齡不受影響，7/31 才反映", async () => {
    const res = await api(`/sales/${saleId}/returns`, admin, {
      kind: "return",
      docDate: "2025-07-05",
      lines: [{ sourceLineId: lineId, qty: 4 }],
    });
    expect(res.status).toBe(201);
    expect(res.json.arOffset).toBe(420);

    const june = await api("/reports/ar-aging?asOf=2025-06-30", admin);
    expect(june.json.rows.find((r: { partnerId: number }) => r.partnerId === agingCustomer).total).toBe(1050);
    const july = await api("/reports/ar-aging?asOf=2025-07-31", admin);
    expect(july.json.rows.find((r: { partnerId: number }) => r.partnerId === agingCustomer).total).toBe(630);
  });

  it("未沖單據的「單據金額」是退回後淨額，並另外回傳 returned 供前端顯示", async () => {
    const open = await api(`/open-documents?partnerId=${agingCustomer}&kind=receipt`, admin);
    const doc = open.json.find((d: { id: number }) => d.id === saleId);
    expect(doc).toMatchObject({ total: 630, returned: 420, remaining: 630 });
  });
});

describe("退回單的退現路徑要有 cash 頁權限（六個角色）", () => {
  let saleId: number;
  let lineId: number;
  let financeAuth: Record<string, string>;
  let employeeAuth: Record<string, string>;
  let gmAuth: Record<string, string>;

  it("前置：建立 finance / employee / gm 三個角色與一張可退的銷貨單", async () => {
    await api("/users", admin, { username: "fin", displayName: "財務", password: "secret-test", role: "finance" });
    financeAuth = await loginAs(app, "fin", "secret-test");
    await api("/users", admin, { username: "emp", displayName: "員工", password: "secret-test", role: "employee" });
    employeeAuth = await loginAs(app, "emp", "secret-test");
    await api("/users", admin, { username: "gm2", displayName: "總經理2", password: "secret-test", role: "gm" });
    gmAuth = await loginAs(app, "gm2", "secret-test");

    await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2025-05-01",
      lines: [{ productId, qty: 20, unitPrice: 50 }],
    });
    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2025-05-02",
      lines: [{ productId, qty: 20, unitPrice: 100 }],
    });
    saleId = sale.json.id;
    lineId = (await api(`/sales/${saleId}/returnable`, admin)).json.lines[0].id;
  });

  const cashReturn = (docDate: string, qty: number) => ({
    kind: "return" as const,
    docDate,
    settlement: "cash" as const,
    cashAccountId,
    lines: [{ sourceLineId: lineId, qty }],
  });

  it("業務：開得了退回單，但不得指定現金科目（403，訊息含脫困路徑）", async () => {
    const res = await api(`/sales/${saleId}/returns`, salesAuth, cashReturn("2025-05-10", 1));
    expect(res.status).toBe(403);
    expect(res.json.error).toContain("收付款");
    expect(res.json.error).toContain("取消勾選"); // 講得出他可以怎麼做
    // 同一個人不走退現就開得成
    const ok = await api(`/sales/${saleId}/returns`, salesAuth, {
      kind: "return",
      docDate: "2025-05-10",
      lines: [{ sourceLineId: lineId, qty: 1 }],
    });
    expect(ok.status).toBe(201);
    expect(ok.json.cashAmount).toBe(0);
  });

  it("採購：進貨退出的退現同樣被擋", async () => {
    const purchases = await api("/purchases", admin);
    const target = purchases.json.find((p: { docDate: string }) => p.docDate === "2025-05-01");
    const info = await api(`/purchases/${target.id}/returnable`, purchasingAuth);
    const res = await api(`/purchases/${target.id}/returns`, purchasingAuth, {
      kind: "return",
      docDate: "2025-05-11",
      settlement: "cash",
      cashAccountId,
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 1 }],
    });
    expect(res.status).toBe(403);
    expect(res.json.error).toContain("收付款");
  });

  it("員工：連退回單都開不了（無 sales 頁權限），理由是頁面權限而不是現金", async () => {
    const res = await api(`/sales/${saleId}/returns`, employeeAuth, cashReturn("2025-05-12", 1));
    expect(res.status).toBe(403);
    expect(res.json.error).toContain("無此頁面");
  });

  it("總經理：唯讀，退現與非退現都擋", async () => {
    expect((await api(`/sales/${saleId}/returns`, gmAuth, cashReturn("2025-05-13", 1))).status).toBe(403);
  });

  it("財務與管理者：退現可以過（他們本來就進得了收付款頁）", async () => {
    const fin = await api(`/sales/${saleId}/returns`, financeAuth, cashReturn("2025-05-14", 1));
    expect(fin.status).toBe(201);
    const adm = await api(`/sales/${saleId}/returns`, admin, cashReturn("2025-05-15", 1));
    expect(adm.status).toBe(201);
    expect(adm.json.cashAmount + adm.json.arOffset + adm.json.payableAmount).toBe(adm.json.total);
  });
});

describe("已作廢發票的銷貨單不得再開退回（與 reverseSale 那條路對稱）", () => {
  it("作廢後再開退回 → 409，訊息指出「重新開立發票」這條路", async () => {
    await api("/invoice-tracks", admin, {
      period: "202507",
      track: "KA",
      rangeStart: 20000000,
      rangeEnd: 20000010,
    });
    await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2025-07-01",
      lines: [{ productId, qty: 5, unitPrice: 50 }],
    });
    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2025-07-02",
      lines: [{ productId, qty: 5, unitPrice: 100 }],
    });
    const info = await api(`/sales/${sale.json.id}/returnable`, admin);
    const inv = await api(`/sales/${sale.json.id}/invoice`, admin, { mode: "B2B", randomNumber: "0002" });
    expect(inv.status).toBe(201);
    const cancel = await api(`/invoices/${inv.json.id}/cancel`, admin, {
      reason: "買受人統編錯誤",
      cancelDate: "2025-07-03",
    });
    expect(cancel.status).toBe(200);

    const res = await api(`/sales/${sale.json.id}/returns`, admin, {
      kind: "return",
      docDate: "2025-07-04",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 1 }],
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("已作廢");
    expect(res.json.error).toContain("重新開立發票");

    // 重開發票之後就退得了（脫困路徑真的存在，不是話術）
    const reissued = await api(`/sales/${sale.json.id}/invoice`, admin, { mode: "B2B", randomNumber: "0003" });
    expect(reissued.status).toBe(201);
    const ok = await api(`/sales/${sale.json.id}/returns`, admin, {
      kind: "return",
      docDate: "2025-07-04",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 1 }],
    });
    expect(ok.status).toBe(201);
  });
});

describe("作廢發票的關帳鎖看的是發票日期（既有 bug）", () => {
  it("發票在已關帳月份、作廢日在未關帳月份 → 409，訊息指向退回／折讓單", async () => {
    // 本測試庫已關帳至 2024-11；找一張 11 月的銷貨單開發票（issueInvoice 依原單日期定期別）。
    // B13 之後開立本身也吃關帳鎖，所以 fixture 得照真實情境走：
    // 先重開 2024-11 → 開立發票 → 關回，得到一張「關帳前就開好」的 11 月發票
    const sales = await api("/sales", admin);
    const novSale = sales.json.find(
      (s: { docDate: string; reversalEntryId: number | null }) =>
        s.docDate.startsWith("2024-11") && s.reversalEntryId === null,
    );
    expect(novSale).toBeTruthy();
    await api("/invoice-tracks", admin, {
      period: "202411",
      track: "KB",
      rangeStart: 30000000,
      rangeEnd: 30000010,
    });
    // 關帳中開立會被 B13 的鎖擋下（順帶驗證鎖真的在）
    const lockedOut = await api(`/sales/${novSale.id}/invoice`, admin, { mode: "B2B", randomNumber: "0004" });
    expect(lockedOut.status).toBe(409);
    const reopen = await api("/period-closes/latest", admin, undefined, "DELETE");
    expect(reopen.json).toEqual({ reopened: "2024-11" });
    const inv = await api(`/sales/${novSale.id}/invoice`, admin, { mode: "B2B", randomNumber: "0004" });
    expect(inv.status).toBe(201);
    expect(inv.json.invoiceDate).toBe(novSale.docDate);
    expect((await api("/period-closes", admin, { period: "2024-11" })).status).toBe(201);

    // 作廢日落在未關帳的 2025-08，舊實作只檢查作廢日 → 放行，11 月已申報的銷項被無聲改掉
    const res = await api(`/invoices/${inv.json.id}/cancel`, admin, {
      reason: "測試跨期作廢",
      cancelDate: "2025-08-01",
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("已關帳期間");
    expect(res.json.error).toContain("退貨／折讓");

    // 發票仍是 issued（沒有被改掉）
    const invoices = await api("/invoices", admin);
    expect(invoices.json.find((i: { id: number }) => i.id === inv.json.id).status).toBe("issued");
  });
});

describe("401 申報：缺證明單的退回折讓不列入減項，但要誠實揭露", () => {
  /**
   * 2024-08（B11b）之後減項取數已實作：**有證明單號碼**的退回才列入申報書減項
   * （詳細驗收在 vat-401-gaps.test.ts）。本區塊守的是揭露面的老規矩——
   * 揭露只計「原單有進到申報範圍」的退回：銷項的申報基礎是已開立的電子發票、
   * 進項是已登錄供應商發票的進貨單。把沒開發票的銷貨單退回也算進來，
   * 會計會照著填出過大的減項而少繳稅——那比不揭露更糟。
   */
  it("進項：已登錄供應商發票的進貨單退回才計入", async () => {
    const res = await api("/vat-returns/401?period=202501", admin);
    expect(res.status).toBe(200);
    // 2025-01～02 的進貨退出／折讓都建在「未登錄供應商發票」的進貨單上 → 不計入
    expect(res.json.returnsNotReflected.purchases).toEqual({ count: 0, subtotal: 0, tax: 0 });
    expect(res.json.returnsNotReflected.sales.count).toBe(0);
  });

  it("沒開發票的銷貨單退回不計入（會計照著填減項會少繳稅）", async () => {
    const res = await api("/vat-returns/401?period=202503", admin);
    expect(res.status).toBe(200);
    // 4 月那批退回的原銷貨單沒有開立發票，不在申報範圍內
    expect(res.json.returnsNotReflected.sales).toEqual({ count: 0, subtotal: 0, tax: 0 });
  });

  it("已開立發票但缺證明單的退回：不進減項欄、列在警示並指向補登路徑", async () => {
    // 造一張有發票的銷貨單再退貨
    // 統編不可與前面的「客戶甲」重複：0022 起 tax_id 有 partial unique index（R5），撞號會 409
    const partner = await api("/partners", admin, { name: "揭露測試客戶", taxId: "04639890", isCustomer: true });
    await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2025-05-01",
      lines: [{ productId, qty: 10, unitPrice: 100 }],
    });
    const sale = await api("/sales", admin, {
      partnerId: partner.json.id,
      docDate: "2025-05-10",
      lines: [{ productId, qty: 10, unitPrice: 200 }],
    });
    await api("/invoice-tracks", admin, {
      period: "202505", track: "KC", rangeStart: 40000000, rangeEnd: 40000010,
    });
    const inv = await api(`/sales/${sale.json.id}/invoice`, admin, { mode: "B2B", randomNumber: "0005" });
    expect(inv.status).toBe(201);

    const info = await api(`/sales/${sale.json.id}/returnable`, admin);
    const ret = await api(`/sales/${sale.json.id}/returns`, admin, {
      kind: "return",
      docDate: "2025-05-20",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 4 }],
    });
    expect(ret.status).toBe(201);

    const res = await api("/vat-returns/401?period=202505", admin);
    expect(res.json.returnsNotReflected.sales).toMatchObject({ count: 1, subtotal: 800 });
    // 缺證明單＝沒有列報依據：減項欄不動（銷項仍毛額），警示要指出補登路徑
    expect(res.json.returnsInFiling.sales.count).toBe(0);
    expect(res.json.returnsNotReflected.note).toContain("未列入本申報檔的減項");
    expect(res.json.returnsNotReflected.note).toContain("補登證明單");
  });

  it("沒有退回的期別：筆數與金額都是 0（畫面就不會顯示警告，不製造雜訊）", async () => {
    const res = await api("/vat-returns/401?period=202509", admin);
    expect(res.json.returnsNotReflected.sales).toEqual({ count: 0, subtotal: 0, tax: 0 });
    expect(res.json.returnsNotReflected.purchases).toEqual({ count: 0, subtotal: 0, tax: 0 });
  });
});

describe("路徑參數不是數字時回 400，不是 500", () => {
  it("GET /sales/abc/returnable → 400", async () => {
    const res = await api("/sales/abc/returnable", admin);
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("正整數");
  });

  it("POST /purchases/abc/returns → 400（不會把 NaN 送進 SQL）", async () => {
    const res = await api("/purchases/abc/returns", admin, {
      kind: "return",
      docDate: "2025-09-01",
      lines: [{ sourceLineId: 1, qty: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it("GET /purchases/0/returnable → 400（0 與負數同樣不是有效單號）", async () => {
    expect((await api("/purchases/0/returnable", admin)).status).toBe(400);
  });

  it("不存在的單號仍然是 404（400 只給格式錯誤）", async () => {
    const res = await api("/sales/999999/returnable", admin);
    expect(res.status).toBe(404);
  });
});

describe("證明單資訊：cert_date 有輸入通道、列表看得到", () => {
  it("開單時的 certDate／certNo 會落地並出現在退回清單", async () => {
    await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2025-09-01",
      lines: [{ productId, qty: 3, unitPrice: 50 }],
    });
    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2025-09-02",
      lines: [{ productId, qty: 3, unitPrice: 100 }],
    });
    const info = await api(`/sales/${sale.json.id}/returnable`, admin);
    const res = await api(`/sales/${sale.json.id}/returns`, admin, {
      kind: "allowance",
      docDate: "2025-09-05",
      certDate: "2025-09-20",
      certNo: "ALW10000001",
      lines: [{ sourceLineId: info.json.lines[0].id, amount: 100 }],
    });
    expect(res.status).toBe(201);
    const list = await api("/sales-returns", admin);
    const row = list.json.find((r: { id: number }) => r.id === res.json.id);
    expect(row).toMatchObject({ certNo: "ALW10000001", certDate: "2025-09-20" });
  });
});

describe("進貨退出／折讓的成本基礎（2024-07-30 對抗驗證推翻先前規則後的迴歸鎖）", () => {
  /**
   * 這兩個情境是「進貨退出改用當下移動平均」那版規則的反例，也是最終規則的依據：
   * 退回＝撤銷原單的一部分，沖回原單成本，不追溯改寫另一端已完成的交易；
   * 唯一例外是退光庫存時殘值必須清掉（否則「0 個卻有帳面金額」汙染下一次進貨的均價）。
   */
  async function freshProduct(sku: string) {
    const p = await api("/products", admin, { sku, name: sku });
    return p.json.id as number;
  }
  const buy = (pid: number, qty: number, price: number, docDate: string) =>
    api("/purchases", admin, { partnerId: supplierId, docDate, lines: [{ productId: pid, qty, unitPrice: price }] });
  const sell = (pid: number, qty: number, price: number, docDate: string) =>
    api("/sales", admin, { partnerId: customerId, docDate, lines: [{ productId: pid, qty, unitPrice: price }] });
  const firstLineId = async (path: string) => {
    const info = await api(path, admin);
    return info.json.lines[0].id as number;
  };

  it("零銷貨時退出不得產生任何損益（曾經憑空長出 200 元淨利）", async () => {
    const pid = await freshProduct("SKU-COST-A");
    await buy(pid, 50, 10, "2025-06-01");
    const cheap = await buy(pid, 50, 2, "2025-06-02");
    const res = await api(`/purchases/${cheap.json.id}/returns`, admin, {
      kind: "return",
      docDate: "2025-06-10",
      lines: [{ sourceLineId: await firstLineId(`/purchases/${cheap.json.id}/returnable`), qty: 50 }],
    });
    expect(res.status).toBe(201);
    // 沖回原成本 100（50 × 2），不是當下均價 6 × 50 = 300
    expect(res.json.invCredit).toBe(100);
    expect(res.json.costDiff).toBe(0);
    expect(await inventoryOf(pid)).toMatchObject({ qty: 50, amount: 500 }); // 均價 10
  });

  it("退光庫存時把殘值清到 5101，避免「0 個卻有帳面金額」汙染下一次進貨的均價", async () => {
    const pid = await freshProduct("SKU-COST-B");
    await buy(pid, 100, 10, "2025-06-01");
    const cheap = await buy(pid, 100, 2, "2025-06-02");
    await sell(pid, 100, 20, "2025-06-05"); // 均價 6、成本 600
    const res = await api(`/purchases/${cheap.json.id}/returns`, admin, {
      kind: "return",
      docDate: "2025-06-10",
      lines: [{ sourceLineId: await firstLineId(`/purchases/${cheap.json.id}/returnable`), qty: 100 }],
    });
    expect(res.status).toBe(201);
    expect(res.json.invCredit).toBe(600); // 退光 → 沖掉整個帳面
    expect(res.json.costDiff).toBe(-400); // 借 5101，銷貨成本由 600 補到 1000＝1200 − 200
    expect(await inventoryOf(pid)).toMatchObject({ qty: 0, amount: 0 });
    // 汙染檢查：舊 bug 留下 400 元殘值，再進 10 個 @1 均價會變 41
    await buy(pid, 10, 1, "2025-06-20");
    expect(await inventoryOf(pid)).toMatchObject({ qty: 10, amount: 10 });
  });

  it("那批貨賣光之後才來的折讓不得沖存貨（分子是這批貨的未售量，不是商品當下在庫）", async () => {
    const pid = await freshProduct("SKU-COST-C");
    const first = await buy(pid, 100, 10, "2025-06-01");
    await sell(pid, 100, 20, "2025-06-05"); // A 批賣光
    await buy(pid, 100, 1, "2025-06-08"); // 又進了便宜的 B 批
    const res = await api(`/purchases/${first.json.id}/returns`, admin, {
      kind: "allowance",
      docDate: "2025-06-10",
      lines: [{ sourceLineId: await firstLineId(`/purchases/${first.json.id}/returnable`), amount: 800 }],
    });
    expect(res.status).toBe(201);
    // 用「商品當下在庫 100 ÷ 原量 100 = 1」會沖光 B 批帳面 → 均價 0、之後銷貨成本全是 0
    expect(res.json.invCredit).toBe(0);
    expect(await inventoryOf(pid)).toMatchObject({ qty: 100, amount: 100 }); // 均價 1
  });

  it("賣一半後折讓按未售比例攤：一半沖存貨、一半回沖銷貨成本", async () => {
    const pid = await freshProduct("SKU-COST-D");
    const first = await buy(pid, 100, 10, "2025-06-01");
    await sell(pid, 50, 20, "2025-06-05");
    const res = await api(`/purchases/${first.json.id}/returns`, admin, {
      kind: "allowance",
      docDate: "2025-06-10",
      lines: [{ sourceLineId: await firstLineId(`/purchases/${first.json.id}/returnable`), amount: 800 }],
    });
    expect(res.status).toBe(201);
    expect(res.json.invCredit).toBe(400);
    // 均價 2 ＝ 真實淨成本 (1000 − 800) / 100
    expect(await inventoryOf(pid)).toMatchObject({ qty: 50, amount: 100 });
  });

  it("銷貨退回仍用原銷貨成本回補，沒有被這批改動波及", async () => {
    const pid = await freshProduct("SKU-COST-E");
    await buy(pid, 100, 10, "2025-06-01");
    const sale = await sell(pid, 40, 30, "2025-06-05"); // 成本 400
    await buy(pid, 60, 20, "2025-06-08"); // 當下均價變 15
    const res = await api(`/sales/${sale.json.id}/returns`, admin, {
      kind: "return",
      docDate: "2025-06-10",
      lines: [{ sourceLineId: await firstLineId(`/sales/${sale.json.id}/returnable`), qty: 40 }],
    });
    expect(res.status).toBe(201);
    // 回補原成本 400（不是當下均價 15 × 40 = 600）→ 均價 13.75
    expect(await inventoryOf(pid)).toMatchObject({ qty: 160, amount: 2200 });
  });
});

describe("小數計量商品的退光判斷（浮點容差）", () => {
  it("公斤計量：分次退光後不留「0 個卻有帳面金額」", async () => {
    // 原本用 qty === state.qty 嚴格等值：state.qty 由 numeric 字串逐列 Number() 相加，
    // 0.1 + 0.2 !== 0.3，於是「退光就把帳面歸零」這道保險對小數商品永不生效，
    // 留下的殘值會汙染下一次進貨的均價
    const p = await api("/products", admin, { sku: "SKU-KG", name: "散裝料", unit: "公斤" });
    const pid = p.json.id as number;
    const buy1 = await api("/purchases", admin, {
      partnerId: supplierId, docDate: "2025-07-01",
      lines: [{ productId: pid, qty: 0.1, unitPrice: 100 }],
    });
    expect(buy1.status).toBe(201);
    const buy2 = await api("/purchases", admin, {
      partnerId: supplierId, docDate: "2025-07-02",
      lines: [{ productId: pid, qty: 0.2, unitPrice: 100 }],
    });
    expect(buy2.status).toBe(201);
    expect((await inventoryOf(pid)).qty).toBeCloseTo(0.3, 3);

    for (const b of [buy1, buy2]) {
      const info = await api(`/purchases/${b.json.id}/returnable`, admin);
      const res = await api(`/purchases/${b.json.id}/returns`, admin, {
        kind: "return", docDate: "2025-07-10",
        lines: [{ sourceLineId: info.json.lines[0].id, qty: Number(info.json.lines[0].remainingQty) }],
      });
      expect(res.status).toBe(201);
    }
    const after = await inventoryOf(pid);
    expect(after.qty).toBeCloseTo(0, 3);
    expect(after.amount).toBe(0); // 關鍵：不得留下殘值

    // 汙染檢查：再進 1 公斤 @10 → 均價必須是 10
    await api("/purchases", admin, {
      partnerId: supplierId, docDate: "2025-07-20",
      lines: [{ productId: pid, qty: 1, unitPrice: 10 }],
    });
    expect(await inventoryOf(pid)).toMatchObject({ amount: 10 });
  });
});

describe("證明單欄位：只擋「填了日期沒填號碼」", () => {
  it("只填證明單日期、沒填號碼 → 422（之後追「哪些退回缺證明單」會漏掉它）", async () => {
    const sale = await api("/sales", admin, {
      partnerId: customerId, docDate: "2025-08-02",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    const info = await api(`/sales/${sale.json.id}/returnable`, admin);
    const res = await api(`/sales/${sale.json.id}/returns`, admin, {
      kind: "return", docDate: "2025-08-05", certDate: "2025-08-06",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 1 }],
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("號碼");
  });

  it("證明單日期早於退回日不被擋（先議定折讓、貨後來才退是可能的時序，不拿自編假設擋人）", async () => {
    const sale = await api("/sales", admin, {
      partnerId: customerId, docDate: "2025-08-02",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    const info = await api(`/sales/${sale.json.id}/returnable`, admin);
    const res = await api(`/sales/${sale.json.id}/returns`, admin, {
      kind: "return", docDate: "2025-08-20", certDate: "2025-08-10", certNo: "ALW90000002",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 1 }],
    });
    expect(res.status).toBe(201);
  });
});

describe("立沖清單以收付款日為基準（未來日期的退回單不該讓當天收不了款）", () => {
  let cust: number;
  let saleId: number;
  let lineId: number;

  it("前置：6/01 銷貨 1050，8/15 開一張退回單（未來日期）", async () => {
    const partner = await api("/partners", admin, { name: "立沖基準客戶", isCustomer: true });
    cust = partner.json.id;
    await api("/purchases", admin, {
      partnerId: supplierId, docDate: "2025-06-01",
      lines: [{ productId, qty: 10, unitPrice: 50 }],
    });
    const sale = await api("/sales", admin, {
      partnerId: cust, docDate: "2025-06-01",
      lines: [{ productId, qty: 10, unitPrice: 100 }],
    });
    saleId = sale.json.id;
    expect(sale.json.total).toBe(1050);
    const info = await api(`/sales/${saleId}/returnable`, admin);
    lineId = info.json.lines[0].id;
    const ret = await api(`/sales/${saleId}/returns`, admin, {
      kind: "return", docDate: "2025-08-15",
      lines: [{ sourceLineId: lineId, qty: 10 }],
    });
    expect(ret.status).toBe(201);
  });

  it("以 7/31 為基準：那張單仍可立沖全額（退回單還沒發生）", async () => {
    const open = await api(`/open-documents?partnerId=${cust}&kind=receipt&asOf=2025-07-31`, admin);
    const row = open.json.find((d: { id: number }) => d.id === saleId);
    expect(row).toBeTruthy();
    expect(row.remaining).toBe(1050);
  });

  it("以 8/31 為基準：退回已生效，該單不再出現在待沖清單", async () => {
    const open = await api(`/open-documents?partnerId=${cust}&kind=receipt&asOf=2025-08-31`, admin);
    expect(open.json.find((d: { id: number }) => d.id === saleId)).toBeUndefined();
  });

  it("7/20 真的收得到款：立沖以收款日為基準，不會被 8/15 的退回單擋住", async () => {
    const cash = ((await api("/accounts?includeInactive=1", admin)).json as { code: string; id: number }[])
      .find((a) => a.code === "1101")!;
    const res = await api("/cash-docs", admin, {
      kind: "receipt", partnerId: cust, docDate: "2025-07-20", amount: 1050,
      accountId: cash.id, allocations: [{ targetId: saleId, amount: 1050 }],
    });
    expect(res.status).toBe(201);
  });
});
