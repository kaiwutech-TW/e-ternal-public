/**
 * 應付帳齡（0033，第三批雜項 ①）驗收：
 * 1. 進貨單付款到期日：供應商付款條件自動推算／逐單覆寫／到期日早於單據日 422
 * 2. GET /reports/ap-aging 照 ar-aging 形狀：付款 FIFO 沖最舊、按到期日分桶、溢付列 credit
 * 3. 邊界：未約定付款條件退回單據日估算（notes 出聲）、作廢進貨單排除、
 *    期初應付單按原單日期進桶、進貨退出沖減未付
 * 4. 權限：掛進貨頁——採購看得到、業務 403
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { loginAs, setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let auth: Record<string, string>;
let termedSupplierId: number; // 月結 30 天
let looseSupplierId: number; // 未約定付款條件
let productId: number;
let cashAccountId: number;

async function api(path: string, body?: unknown, method = body ? "POST" : "GET", headers = auth) {
  const res = await app.request(path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text), text };
  } catch {
    return { status: res.status, json: null, text };
  }
}

const rowOf = (aging: { rows: { partnerId: number }[] }, partnerId: number) =>
  aging.rows.find((r) => r.partnerId === partnerId) as Record<string, number> | undefined;

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  auth = await setupAdmin(app);

  const s1 = await api("/partners", { name: "月結供應商", taxId: "96979933", isSupplier: true, paymentTermDays: 30 });
  termedSupplierId = s1.json.id;
  const s2 = await api("/partners", { name: "未約定供應商", taxId: "05004058", isSupplier: true });
  looseSupplierId = s2.json.id;
  const product = await api("/products", { sku: "AP-SKU-1", name: "帳齡商品" });
  productId = product.json.id;
  const accounts = await api("/accounts");
  cashAccountId = accounts.json.find((a: { code: string }) => a.code === "1101").id;
});

describe("進貨單付款到期日（0033）", () => {
  it("正向：依供應商付款條件自動推算（docDate＋30 天）；逐單覆寫優先", async () => {
    const auto = await api("/purchases", {
      partnerId: termedSupplierId,
      docDate: "2026-07-01",
      lines: [{ productId, qty: 100, unitPrice: 10 }],
    });
    expect(auto.status).toBe(201);
    expect(auto.json.dueDate).toBe("2026-07-31");

    // 晚一天（7/2）：FIFO 沖最舊時排序才有唯一答案（帳齡按 docDate 排）
    const overridden = await api("/purchases", {
      partnerId: termedSupplierId,
      docDate: "2026-07-02",
      dueDate: "2026-09-30",
      lines: [{ productId, qty: 10, unitPrice: 10 }],
    });
    expect(overridden.status).toBe(201);
    expect(overridden.json.dueDate).toBe("2026-09-30");
  });

  it("邊界：到期日早於單據日 422（一定是打錯）；未約定的供應商為 NULL", async () => {
    const bad = await api("/purchases", {
      partnerId: termedSupplierId,
      docDate: "2026-07-01",
      dueDate: "2026-06-30",
      lines: [{ productId, qty: 1, unitPrice: 10 }],
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error).toContain("不可早於單據日期");

    const loose = await api("/purchases", {
      partnerId: looseSupplierId,
      docDate: "2026-07-05",
      lines: [{ productId, qty: 20, unitPrice: 10 }],
    });
    expect(loose.status).toBe(201);
    expect(loose.json.dueDate).toBeNull();
  });
});

describe("GET /reports/ap-aging", () => {
  it("正向：付款 FIFO 沖最舊進貨單；未付餘額按到期日分桶；溢付列 credit", async () => {
    // 目前月結供應商未付：7/1 進貨 1050（到期 7/31）＋ 7/2 進貨 105（到期 9/30，覆寫）
    // 付 1050（未指定沖銷）→ FIFO 沖掉最舊那張
    const pay = await api("/cash-docs", {
      kind: "payment",
      partnerId: termedSupplierId,
      docDate: "2026-08-05",
      amount: 1050,
      accountId: cashAccountId,
    });
    expect(pay.status).toBe(201);

    // asOf 9/15：剩 105 那張到期日 9/30 還沒到 → notDue，不逾期
    //（有到期日的月結單不會再被「單據日 30 天」的舊算法誤判逾期）
    const before = (await api("/reports/ap-aging?asOf=2026-09-15")).json;
    expect(rowOf(before, termedSupplierId)).toMatchObject({ notDue: 105, total: 105, overdue: 0, credit: 0 });

    // asOf 10/20：過了 9/30 到期日 20 天 → d0_30、計入 overdue
    const after = (await api("/reports/ap-aging?asOf=2026-10-20")).json;
    expect(rowOf(after, termedSupplierId)).toMatchObject({ d0_30: 105, total: 105, overdue: 105 });

    // 溢付：再付 500（未付只剩 105）→ 105 沖掉、395 掛預付列 credit
    const over = await api("/cash-docs", {
      kind: "payment",
      partnerId: termedSupplierId,
      docDate: "2026-10-25",
      amount: 500,
      accountId: cashAccountId,
    });
    expect(over.status).toBe(201);
    expect(over.json.unappliedAmount).toBe(395);
    const settled = (await api("/reports/ap-aging?asOf=2026-10-31")).json;
    expect(rowOf(settled, termedSupplierId)).toMatchObject({ total: 0, overdue: 0, credit: 395 });
    // totals 是 rows 的合計（形狀與 ar-aging 一致）
    expect(settled.totals.credit).toBeGreaterThanOrEqual(395);
  });

  it("邊界：未約定付款條件退回單據日估算並在 notes 出聲；期初應付按原單日期進桶；作廢進貨單排除", async () => {
    // 期初應付單（舊系統導入的舊欠款）：原單日期 2026-01-10，asOf 8/1 已超過 90 天
    const opening = await api("/opening-balances", {
      kind: "payable",
      partnerId: looseSupplierId,
      entryDate: "2026-06-30",
      docDate: "2026-01-10",
      amount: 3000,
    });
    expect(opening.status).toBe(201);

    const aging = (await api("/reports/ap-aging?asOf=2026-08-01")).json;
    const row = rowOf(aging, looseSupplierId)!;
    // 7/5 進貨 210（無到期日）→ 以單據日估算 27 天 → d0_30 但不算逾期（回退不斷言逾期）
    expect(row["d0_30"]).toBe(210);
    // 期初單 1/10 → 90+ 桶（按它真正的帳齡，不是按開帳日重新起算）
    expect(row["d90plus"]).toBe(3000);
    expect(row["total"]).toBe(3210);
    // 回退要出聲（兩張回退單：進貨＋期初），措辭指路補供應商付款條件
    expect(aging.notes.length).toBe(1);
    expect(aging.notes[0]).toContain("付款到期日");
    expect(aging.notes[0]).toContain("供應商");

    // 作廢進貨單排除：作廢 7/5 那張（在庫足夠），未付餘額自動消失
    const purchases = (await api("/purchases")).json;
    const loosePurchase = purchases.find(
      (p: { partnerId: number; voidedAt: string | null }) => p.partnerId === looseSupplierId && !p.voidedAt,
    );
    const voided = await api(`/purchases/${loosePurchase.id}/void`, { reason: "打錯供應商，作廢重開" });
    expect(voided.status).toBe(200);
    const afterVoid = (await api("/reports/ap-aging?asOf=2026-08-01")).json;
    expect(rowOf(afterVoid, looseSupplierId)!["total"]).toBe(3000);
    expect(rowOf(afterVoid, looseSupplierId)!["d0_30"]).toBe(0);
  });

  it("邊界：進貨退出沖減未付餘額（只認基準日之前的退出單）", async () => {
    // 用乾淨的第三家供應商：前面測試的溢付會讓退出單的 apOffset 被對象餘額壓低
    //（supplierApBalance 以全額付款計），混在一起就測不出「退出沖減帳齡」這一件事
    const s3 = await api("/partners", { name: "退貨供應商", taxId: "20828393", isSupplier: true, paymentTermDays: 30 });
    // 進貨 2026-08-10：50×10＝500＋稅 25＝525（月結 30 天 → 到期 9/9）
    const p = await api("/purchases", {
      partnerId: s3.json.id,
      docDate: "2026-08-10",
      lines: [{ productId, qty: 50, unitPrice: 10 }],
    });
    expect(p.status).toBe(201);
    const lineId = (await api(`/purchases/${p.json.id}/returnable`)).json.lines[0].id;
    // 8/20 退出 20 個：200＋稅 10＝210 沖應付
    const ret = await api(`/purchases/${p.json.id}/returns`, {
      kind: "return",
      docDate: "2026-08-20",
      lines: [{ sourceLineId: lineId, qty: 20 }],
    });
    expect(ret.status).toBe(201);
    expect(ret.json.apOffset).toBe(210);

    // asOf 8/15（退出前）：整張 525 未付；asOf 8/31（退出後）：剩 315——
    // 8/15 的視角不受 8/20 的退出回頭改寫（與資產負債表同日對得起來）
    const before = (await api("/reports/ap-aging?asOf=2026-08-15")).json;
    expect(rowOf(before, s3.json.id)!["notDue"]).toBe(525);
    const after = (await api("/reports/ap-aging?asOf=2026-08-31")).json;
    expect(rowOf(after, s3.json.id)!["notDue"]).toBe(315);
  });

  it("權限：採購角色看得到（掛進貨頁）、業務 403；缺 asOf 400", async () => {
    await api("/users", { username: "pur-ap", displayName: "採購", password: "secret-test", role: "purchasing" });
    const pur = await loginAs(app, "pur-ap", "secret-test");
    expect((await api("/reports/ap-aging?asOf=2026-08-01", undefined, "GET", pur)).status).toBe(200);

    await api("/users", { username: "sales-ap", displayName: "業務", password: "secret-test", role: "sales" });
    const sales = await loginAs(app, "sales-ap", "secret-test");
    expect((await api("/reports/ap-aging?asOf=2026-08-01", undefined, "GET", sales)).status).toBe(403);

    expect((await api("/reports/ap-aging")).status).toBe(400);
  });
});
