/**
 * 批次 C 驗收：立沖帳（指定沖銷 → 帳齡精確；超沖 422；未指定收款 FIFO 補沖）＋
 * 明細分類帳（期初/逐筆累計餘額）＋現金流量表（直接法：營業/投資/籌資分類、期初＋淨流＝期末）。
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
let saleOldId: number;
let saleNewId: number;
let bankAccountId: number;

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

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);

  const supplier = await api("/partners", admin, { name: "供應商", isSupplier: true });
  supplierId = supplier.json.id;
  const customer = await api("/partners", admin, { name: "客戶", taxId: "04541302", isCustomer: true });
  customerId = customer.json.id;
  const product = await api("/products", admin, { sku: "P-1", name: "商品" });
  productId = product.json.id;
  bankAccountId = (await api("/accounts", admin)).json.find((a: { code: string }) => a.code === "1103").id;

  // 股東出資 100,000（籌資）→ 進貨 10@100（賒帳）→ 兩張銷貨：舊 3/1 4@300、新 6/1 2@300
  await api("/journal-entries", admin, {
    entryDate: "2026-01-05",
    memo: "股東出資",
    lines: [
      { accountCode: "1103", debit: 100000, credit: 0 },
      { accountCode: "3101", debit: 0, credit: 100000 },
    ],
  });
  await api("/purchases", admin, { partnerId: supplierId, docDate: "2026-02-01", lines: [{ productId, qty: 10, unitPrice: 100 }] });
  const oldSale = await api("/sales", admin, { partnerId: customerId, docDate: "2026-03-01", lines: [{ productId, qty: 4, unitPrice: 300 }] });
  saleOldId = oldSale.json.id; // 總額 1260
  const newSale = await api("/sales", admin, { partnerId: customerId, docDate: "2026-06-01", lines: [{ productId, qty: 2, unitPrice: 300 }] });
  saleNewId = newSale.json.id; // 總額 630
});

describe("立沖帳", () => {
  it("未沖單據查詢：兩張銷貨都在，餘額＝總額", async () => {
    const open = (await api(`/open-documents?partnerId=${customerId}&kind=receipt`, admin)).json;
    expect(open).toHaveLength(2);
    expect(open[0]).toMatchObject({ id: saleOldId, total: 1260, remaining: 1260 });
  });

  it("指定沖『新』銷貨單 630 → 帳齡顯示舊單未收（FIFO 做不到的精確度）", async () => {
    const res = await api("/cash-docs", admin, {
      kind: "receipt",
      partnerId: customerId,
      docDate: "2026-06-05",
      amount: 630,
      accountId: bankAccountId,
      allocations: [{ targetId: saleNewId, amount: 630 }],
    });
    expect(res.status).toBe(201);

    // asOf 6/30：舊單（3/1，91 天）1260 全額未收在 90+ 桶；新單已沖清
    const aging = (await api("/reports/ar-aging?asOf=2026-06-30", admin)).json;
    const row = aging.rows.find((r: { partnerId: number }) => r.partnerId === customerId);
    expect(row).toMatchObject({ d90plus: 1260, total: 1260 });
    // 對照：若是純 FIFO，630 會先沖舊單 → 舊單只剩 630。立沖讓結果不同
  });

  it("超沖被擋：單據餘額不足 422、沖銷合計超過收款金額 422、他人單據 422", async () => {
    expect(
      (
        await api("/cash-docs", admin, {
          kind: "receipt", partnerId: customerId, docDate: "2026-06-06", amount: 700,
          accountId: bankAccountId, allocations: [{ targetId: saleNewId, amount: 700 }],
        })
      ).status,
    ).toBe(422); // 新單已沖畢
    expect(
      (
        await api("/cash-docs", admin, {
          kind: "receipt", partnerId: customerId, docDate: "2026-06-06", amount: 100,
          accountId: bankAccountId, allocations: [{ targetId: saleOldId, amount: 200 }],
        })
      ).status,
    ).toBe(422); // 沖銷合計 > 收款金額
    expect(
      (
        await api("/cash-docs", admin, {
          kind: "receipt", partnerId: customerId, docDate: "2026-06-06", amount: 100,
          accountId: bankAccountId, allocations: [{ targetId: 9999, amount: 100 }],
        })
      ).status,
    ).toBe(422);
  });

  it("未指定沖銷的收款 FIFO 補沖剩餘未收（沖最舊）", async () => {
    await api("/cash-docs", admin, {
      kind: "receipt", partnerId: customerId, docDate: "2026-06-10", amount: 1000, accountId: bankAccountId,
    });
    const aging = (await api("/reports/ar-aging?asOf=2026-06-30", admin)).json;
    const row = aging.rows.find((r: { partnerId: number }) => r.partnerId === customerId);
    expect(row).toMatchObject({ d90plus: 260, total: 260 }); // 1260 - 1000
  });
});

describe("明細分類帳", () => {
  it("銀行存款：期初（出資 100000）＋期間收款兩筆累計餘額正確", async () => {
    const r = (await api("/reports/ledger?accountCode=1103&from=2026-06-01&to=2026-06-30", admin)).json;
    expect(r.opening).toBe(100000);
    expect(r.lines).toHaveLength(2); // 6/5 收 630、6/10 收 1000
    expect(r.lines[0]).toMatchObject({ debit: 630, balance: 100630 });
    expect(r.lines[1]).toMatchObject({ debit: 1000, balance: 101630 });
    expect(r.closing).toBe(101630);
  });

  it("貸餘科目（應付帳款）以貸方為正", async () => {
    const r = (await api("/reports/ledger?accountCode=2144&from=2026-01-01&to=2026-12-31", admin)).json;
    expect(r.closing).toBe(1050); // 進貨 10@100 含稅
    expect(r.lines[0].balance).toBe(1050);
  });
});

describe("現金流量表（直接法）", () => {
  it("出資列籌資、收款列營業、買設備列投資；期初＋淨流＝期末", async () => {
    // 付供應商 500（營業流出）、買設備 20000（投資流出）
    await api("/cash-docs", admin, {
      kind: "payment", partnerId: supplierId, docDate: "2026-06-15", amount: 500, accountId: bankAccountId,
    });
    await api("/journal-entries", admin, {
      entryDate: "2026-06-20",
      memo: "購入伺服器",
      lines: [
        { accountCode: "1421", debit: 20000, credit: 0 },
        { accountCode: "1103", debit: 0, credit: 20000 },
      ],
    });

    const full = (await api("/reports/cash-flow?from=2026-01-01&to=2026-12-31", admin)).json;
    expect(full.opening).toBe(0);
    expect(full.financing).toBe(100000); // 出資
    expect(full.operating).toBe(630 + 1000 - 500); // 收款兩筆 − 付款
    expect(full.investing).toBe(-20000); // 買設備
    expect(full.closing).toBe(full.opening + full.net);
    expect(full.closing).toBe(100000 + 1130 - 20000);

    // 六月視角：期初＝出資後 100000
    const june = (await api("/reports/cash-flow?from=2026-06-01&to=2026-06-30", admin)).json;
    expect(june.opening).toBe(100000);
    expect(june.financing).toBe(0);
    expect(june.closing).toBe(full.closing);
  });

  it("借款與股東往來列籌資、存出保證金列投資（不可混進營業活動）", async () => {
    const before = (await api("/reports/cash-flow?from=2026-01-01&to=2026-12-31", admin)).json;
    // 老闆會看的那條數字：借來的 118 萬不是營業活動賺來的
    await api("/journal-entries", admin, {
      entryDate: "2026-07-01",
      memo: "銀行短期借款撥款",
      lines: [
        { accountCode: "1103", debit: 1000000, credit: 0 },
        { accountCode: "2101", debit: 0, credit: 1000000 },
      ],
    });
    await api("/journal-entries", admin, {
      entryDate: "2026-07-02",
      memo: "長期借款撥款",
      lines: [
        { accountCode: "1103", debit: 100000, credit: 0 },
        { accountCode: "2301", debit: 0, credit: 100000 },
      ],
    });
    await api("/journal-entries", admin, {
      entryDate: "2026-07-03",
      memo: "股東暫借公司周轉",
      lines: [
        { accountCode: "1103", debit: 80000, credit: 0 },
        { accountCode: "2204", debit: 0, credit: 80000 },
      ],
    });
    await api("/journal-entries", admin, {
      entryDate: "2026-07-04",
      memo: "辦公室租賃押金",
      lines: [
        { accountCode: "1811", debit: 60000, credit: 0 },
        { accountCode: "1103", debit: 0, credit: 60000 },
      ],
    });
    // 對照組：應付帳款 2144 是營業活動，不可因為是 2xxx 就被當籌資
    await api("/journal-entries", admin, {
      entryDate: "2026-07-05",
      memo: "支付供應商貨款",
      lines: [
        { accountCode: "2144", debit: 700, credit: 0 },
        { accountCode: "1103", debit: 0, credit: 700 },
      ],
    });

    const after = (await api("/reports/cash-flow?from=2026-01-01&to=2026-12-31", admin)).json;
    expect(after.financing - before.financing).toBe(1000000 + 100000 + 80000);
    expect(after.investing - before.investing).toBe(-60000);
    expect(after.operating - before.operating).toBe(-700);
    expect(after.closing).toBe(after.opening + after.net);
  });

  it("借款直接買設備的混合傳票歸投資，不歸籌資（classify 的判斷順序不可對調）", async () => {
    // 這條測試鎖的是 classify() 裡「投資判斷排在籌資之前」這個順序本身。
    // 同一張傳票同時有 1421 辦公設備（投資）與 2101 短期借款（籌資）兩個對方科目，
    // 兩個條件都成立，先判到哪個就歸哪個——順序一旦對調，這 30000 會從投資活動整批跑到籌資活動，
    // 現金流量表上會變成「這期完全沒有資本支出、卻莫名其妙籌了一筆錢又花掉」，
    // 老闆看到的資本支出直接消失。錢實際的去向是設備，所以投資優先。
    const before = (await api("/reports/cash-flow?from=2026-01-01&to=2026-12-31", admin)).json;
    await api("/journal-entries", admin, {
      entryDate: "2026-08-01",
      memo: "借款 20000 加自有現金 10000 買設備 30000",
      lines: [
        { accountCode: "1421", debit: 30000, credit: 0 },
        { accountCode: "2101", debit: 0, credit: 20000 },
        { accountCode: "1103", debit: 0, credit: 10000 },
      ],
    });

    const after = (await api("/reports/cash-flow?from=2026-01-01&to=2026-12-31", admin)).json;
    expect(after.investing - before.investing).toBe(-10000);
    expect(after.financing - before.financing).toBe(0);
    expect(after.operating - before.operating).toBe(0);
    const entry = after.detail.find((d: { date: string }) => d.date === "2026-08-01");
    expect(entry.activity).toBe("investing");
  });

  it("零用金與使用者自建的銀行科目都算現金（現金流量表不可寫死 1101/1103）", async () => {
    const before = (await api("/reports/cash-flow?from=2026-01-01&to=2026-12-31", admin)).json;

    // 種子科目 1102 零用金：它一直都在科目表裡，卻不在舊的 CASH_CODES 清單內
    await api("/journal-entries", admin, {
      entryDate: "2026-09-01",
      memo: "提銀行存款補零用金",
      lines: [
        { accountCode: "1102", debit: 3000, credit: 0 },
        { accountCode: "1103", debit: 0, credit: 3000 },
      ],
    });
    // 現金科目互轉：整張傳票的現金淨變動為 0，不該在現金流量表上留下任何一行
    const afterTransfer = (await api("/reports/cash-flow?from=2026-01-01&to=2026-12-31", admin)).json;
    expect(afterTransfer.net).toBe(before.net);
    expect(afterTransfer.detail.some((d: { date: string }) => d.date === "2026-09-01")).toBe(false);

    // 零用金付小額費用：現金確實少了 200，現金流量表必須看得到
    await api("/journal-entries", admin, {
      entryDate: "2026-09-02",
      memo: "零用金付郵資",
      lines: [
        { accountCode: "6132", debit: 200, credit: 0 },
        { accountCode: "1102", debit: 0, credit: 200 },
      ],
    });

    // 使用者自建的銀行帳戶科目（勾了現金科目）：收 5000
    const esun = await api("/accounts", admin, {
      code: "1105", name: "銀行存款－玉山", type: "asset", isCash: true,
    });
    expect(esun.status).toBe(201);
    await api("/cash-docs", admin, {
      kind: "receipt", partnerId: customerId, docDate: "2026-09-03", amount: 5000, accountId: esun.json.id,
    });

    const after = (await api("/reports/cash-flow?from=2026-01-01&to=2026-12-31", admin)).json;
    expect(after.operating - before.operating).toBe(5000 - 200);
    expect(after.closing - before.closing).toBe(5000 - 200);

    // 期末現金必須等於資產負債表上所有現金科目的合計（同一份 is_cash 定義，兩張表不可對不起來）
    const bs = (await api("/reports/balance-sheet?asOf=2026-12-31", admin)).json;
    const bsCash = bs.assets
      .filter((r: { code: string }) => ["1101", "1102", "1103", "1105"].includes(r.code))
      .reduce((s: number, r: { amount: number }) => s + r.amount, 0);
    expect(after.closing).toBe(bsCash);
  });
});
