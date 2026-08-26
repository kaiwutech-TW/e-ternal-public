/**
 * 月結關帳＋年度結轉驗收：折舊未提擋關帳 → 補提後關帳 → 關帳期間所有拋轉路徑 409 →
 * 依序關帳強制 → 重開後可入帳 → 12 個月全關 → 年度結轉（收入費用歸零至 3351、
 * 損益表不受結轉影響、資產負債表平衡）→ 重複結轉 409、結轉後重開 12 月 409。
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
let cashAccountId: number;

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
  cashAccountId = (await api("/accounts", admin)).json.find((a: { code: string }) => a.code === "1101").id;

  // 2025-01 活動：進貨 10@100、銷貨 4@300（毛利 4×200=800）＋一台資產
  await api("/purchases", admin, { partnerId: supplierId, docDate: "2025-01-05", lines: [{ productId, qty: 10, unitPrice: 100 }] });
  await api("/sales", admin, { partnerId: customerId, docDate: "2025-01-10", lines: [{ productId, qty: 4, unitPrice: 300 }] });
  await api("/fixed-assets", admin, { name: "筆電", category: "computer", cost: 36000, startDate: "2025-01-01" });
});

describe("月結關帳", () => {
  it("折舊未提 → 檢查清單擋、關帳 422；補提後關帳成功", async () => {
    const check = (await api("/period-closes/check?period=2025-01", admin)).json;
    const depItem = check.find((i: { key: string }) => i.key === "depreciation");
    expect(depItem).toMatchObject({ ok: false, blocking: true });

    expect((await api("/period-closes", admin, { period: "2025-01" })).status).toBe(422);

    await api("/depreciations/run", admin, { period: "2025-01" });
    const close = await api("/period-closes", admin, { period: "2025-01" });
    expect(close.status).toBe(201);
    expect((await api("/period-closes", admin)).json.closedThrough).toBe("2025-01");
  });

  it("關帳期間所有拋轉路徑 409：銷貨/進貨/手工傳票/收付款/折舊重提/資產處分", async () => {
    const blocked = [
      api("/sales", admin, { partnerId: customerId, docDate: "2025-01-20", lines: [{ productId, qty: 1, unitPrice: 300 }] }),
      api("/purchases", admin, { partnerId: supplierId, docDate: "2025-01-21", lines: [{ productId, qty: 1, unitPrice: 100 }] }),
      api("/journal-entries", admin, {
        entryDate: "2025-01-31",
        memo: "遲來的調整",
        lines: [
          { accountCode: "6188", debit: 100, credit: 0 },
          { accountCode: "1101", debit: 0, credit: 100 },
        ],
      }),
      api("/cash-docs", admin, { kind: "receipt", partnerId: customerId, docDate: "2025-01-25", amount: 100, accountId: cashAccountId }),
    ];
    for (const p of blocked) expect((await p).status).toBe(409);

    // 折舊重跑已關期間（雖然冪等會跳過，日期檢查在前一律 409）
    expect((await api("/depreciations/run", admin, { period: "2025-01" })).status).toBe(409);
    const asset = (await api("/fixed-assets", admin)).json[0];
    expect((await api(`/fixed-assets/${asset.id}/dispose`, admin, { date: "2025-01-15" })).status).toBe(409);

    // 開帳後日期不受影響
    const ok = await api("/sales", admin, { partnerId: customerId, docDate: "2025-02-01", lines: [{ productId, qty: 1, unitPrice: 300 }] });
    expect(ok.status).toBe(201);
  });

  it("依序關帳：跳關 2025-03 → 422；重開後可再入帳", async () => {
    expect((await api("/period-closes", admin, { period: "2025-03" })).status).toBe(422);

    const reopen = await api("/period-closes/latest", admin, undefined, "DELETE");
    expect(reopen.json).toEqual({ reopened: "2025-01" });
    const late = await api("/journal-entries", admin, {
      entryDate: "2025-01-31",
      memo: "重開後補調整",
      lines: [
        { accountCode: "6188", debit: 100, credit: 0 },
        { accountCode: "1101", debit: 0, credit: 100 },
      ],
    });
    expect(late.status).toBe(201);
    // 收尾：關回 2025-01
    expect((await api("/period-closes", admin, { period: "2025-01" })).status).toBe(201);
  });
});

describe("年度結轉", () => {
  it("未關至 12 月 → 422；關完 12 個月後結轉：收入費用歸零、3351 收本期損益", async () => {
    expect((await api("/year-closes", admin, { year: 2025 })).status).toBe(422);

    // 依序關 2025-02 .. 2025-12（各月折舊先提）
    for (let m = 2; m <= 12; m++) {
      const period = `2025-${String(m).padStart(2, "0")}`;
      await api("/depreciations/run", admin, { period });
      const close = await api("/period-closes", admin, { period });
      expect(close.status).toBe(201);
    }

    const before = (await api("/reports/income-statement?from=2025-01-01&to=2025-12-31", admin)).json;
    expect(before.netIncome).not.toBe(0);

    const yc = await api("/year-closes", admin, { year: 2025 });
    expect(yc.status).toBe(201);
    expect(yc.json.netIncome).toBe(before.netIncome);

    // 損益表排除結轉分錄 → 年度數字不變
    const after = (await api("/reports/income-statement?from=2025-01-01&to=2025-12-31", admin)).json;
    expect(after.netIncome).toBe(before.netIncome);

    // 試算表：收入/費用歸零、3351 = 本期損益、借貸平衡
    const tb = (await api("/trial-balance", admin)).json;
    const sales = tb.rows.find((r: { code: string }) => r.code === "4101");
    expect(sales.debit).toBe(sales.credit); // 結清
    const re = tb.rows.find((r: { code: string }) => r.code === "3351");
    expect(re.credit - re.debit).toBe(before.netIncome);
    expect(tb.totalDebit).toBe(tb.totalCredit);

    // 資產負債表：結轉後仍平衡、本期損益調節項歸零
    const bs = (await api("/reports/balance-sheet?asOf=2025-12-31", admin)).json;
    expect(bs.balanced).toBe(true);
    expect(bs.equity.find((e: { name: string }) => e.name.includes("本期損益")).amount).toBe(0);
  });

  it("重複結轉 409；結轉後重開 12 月 409", async () => {
    expect((await api("/year-closes", admin, { year: 2025 })).status).toBe(409);
    expect((await api("/period-closes/latest", admin, undefined, "DELETE")).status).toBe(409);
  });
});
