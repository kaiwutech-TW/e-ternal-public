/**
 * 銷售前段驗收：報價（open→won/lost、一次性轉單）→ 訂單（部分出貨 partial → 出清 closed、
 * 超量出貨 422、已出貨不可取消）→ 出貨開銷貨單（庫存/傳票沿用既有邏輯、order_id 回連）；
 * 應收帳齡（收款 FIFO 沖最舊、分桶、預收）；權限（採購 403、業務可用）。
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
let customerId: number;
let productId: number;
let quoteId: number;
let orderId: number;

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
  await api("/users", admin, { username: "sal", displayName: "業務", password: "secret-test", role: "sales" });
  salesAuth = await loginAs(app, "sal", "secret-test");

  const supplier = await api("/partners", admin, { name: "供應商", isSupplier: true });
  const customer = await api("/partners", admin, { name: "客戶甲", taxId: "04541302", isCustomer: true });
  customerId = customer.json.id;
  const product = await api("/products", admin, { sku: "SKU-300", name: "路由器" });
  productId = product.json.id;
  // 進貨 20 個 @ 500 備庫存
  await api("/purchases", admin, {
    partnerId: supplier.json.id,
    docDate: "2026-07-01",
    lines: [{ productId, qty: 20, unitPrice: 500 }],
  });
});

describe("報價單", () => {
  it("業務建立報價（未稅 8000＋稅 400）；非客戶 422", async () => {
    const res = await api("/quotes", salesAuth, {
      partnerId: customerId,
      quoteDate: "2026-07-20",
      memo: "十台路由器",
      lines: [{ productId, qty: 10, unitPrice: 800 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ status: "open", subtotal: 8000, tax: 400, total: 8400 });
    quoteId = res.json.id;

    const supplier = (await api("/partners", salesAuth)).json.find((p: { name: string }) => p.name === "供應商");
    const bad = await api("/quotes", salesAuth, {
      partnerId: supplier.id,
      quoteDate: "2026-07-20",
      lines: [{ productId, qty: 1, unitPrice: 800 }],
    });
    expect(bad.status).toBe(422);
  });

  it("轉訂單：報價變 won 並回連；再轉一次 409；lost 只能從 open", async () => {
    const res = await api(`/quotes/${quoteId}/convert`, salesAuth, { orderDate: "2026-07-21" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ status: "open", quoteId, total: 8400 });
    orderId = res.json.id;

    const quotes = (await api("/quotes", salesAuth)).json;
    expect(quotes.find((q: { id: number }) => q.id === quoteId)).toMatchObject({ status: "won", orderId });

    expect((await api(`/quotes/${quoteId}/convert`, salesAuth, { orderDate: "2026-07-21" })).status).toBe(409);
    expect((await api(`/quotes/${quoteId}/lost`, salesAuth, {})).status).toBe(409);
  });
});

describe("訂單出貨", () => {
  it("部分出貨 4 台 → partial、開銷貨單回連訂單、庫存扣減", async () => {
    const lines = (await api("/orders", salesAuth)).json.find((o: { id: number }) => o.id === orderId).lines;
    const res = await api(`/orders/${orderId}/ship`, salesAuth, {
      docDate: "2026-07-22",
      lines: [{ orderLineId: lines[0].id, qty: 4 }],
    });
    expect(res.status).toBe(201);
    expect(res.json.order.status).toBe("partial");

    const sale = (await api("/sales", salesAuth)).json.find((s: { id: number }) => s.id === res.json.saleId);
    expect(sale).toMatchObject({ orderId, subtotal: 3200, tax: 160, total: 3360, cogs: 2000 });

    const inv = (await api("/inventory", salesAuth)).json.find(
      (r: { productId: number }) => r.productId === productId,
    );
    expect(inv.qty).toBe(16);
  });

  it("超量出貨 422；已出貨訂單不可取消 409", async () => {
    const lines = (await api("/orders", salesAuth)).json.find((o: { id: number }) => o.id === orderId).lines;
    expect(
      (
        await api(`/orders/${orderId}/ship`, salesAuth, {
          docDate: "2026-07-23",
          lines: [{ orderLineId: lines[0].id, qty: 7 }],
        })
      ).status,
    ).toBe(422);
    expect((await api(`/orders/${orderId}/cancel`, salesAuth, {})).status).toBe(409);
  });

  it("剩餘全出（未指定明細）→ closed；再出貨 409", async () => {
    const res = await api(`/orders/${orderId}/ship`, salesAuth, { docDate: "2026-07-24" });
    expect(res.status).toBe(201);
    expect(res.json.order.status).toBe("closed");
    const order = (await api("/orders", salesAuth)).json.find((o: { id: number }) => o.id === orderId);
    expect(order.lines[0].remainingQty).toBe(0);
    expect(order.saleIds).toHaveLength(2);
    expect((await api(`/orders/${orderId}/ship`, salesAuth, { docDate: "2026-07-25" })).status).toBe(409);
  });

  it("直接下單（不經報價）可取消（未出貨）", async () => {
    const res = await api("/orders", salesAuth, {
      partnerId: customerId,
      orderDate: "2026-07-25",
      lines: [{ productId, qty: 2, unitPrice: 900 }],
    });
    expect(res.status).toBe(201);
    const cancel = await api(`/orders/${res.json.id}/cancel`, salesAuth, {});
    expect(cancel.status).toBe(200);
    expect(cancel.json.status).toBe("canceled");
  });
});

describe("應收帳齡", () => {
  it("收款 FIFO 沖最舊銷貨；未沖餘額依單據日分桶；預收列 credit", async () => {
    // 目前客戶甲應收：7/22 銷貨 3360 ＋ 7/24 銷貨 5040（6 台 @800＋稅）＝ 8400
    // 收 3360 → 沖掉 7/22 那張；asOf 9/1：7/24 剩 5040，帳齡 31-60 天
    const accounts = (await api("/accounts", admin)).json;
    const cash = accounts.find((a: { code: string }) => a.code === "1101");
    await api("/cash-docs", admin, {
      kind: "receipt",
      partnerId: customerId,
      docDate: "2026-07-30",
      amount: 3360,
      accountId: cash.id,
    });

    const aging = (await api("/reports/ar-aging?asOf=2026-09-01", salesAuth)).json;
    const row = aging.rows.find((r: { partnerId: number }) => r.partnerId === customerId);
    expect(row).toMatchObject({ d0_30: 0, d31_60: 5040, d61_90: 0, d90plus: 0, total: 5040, credit: 0 });
    expect(aging.totals.total).toBe(5040);

    // asOf 12/1：同一張掉進 90+ 桶
    const old = (await api("/reports/ar-aging?asOf=2026-12-01", salesAuth)).json;
    expect(old.rows.find((r: { partnerId: number }) => r.partnerId === customerId).d90plus).toBe(5040);

    // 超收 → 預收：再收 10000
    await api("/cash-docs", admin, {
      kind: "receipt",
      partnerId: customerId,
      docDate: "2026-09-02",
      amount: 10000,
    accountId: cash.id,
    });
    const after = (await api("/reports/ar-aging?asOf=2026-12-01", salesAuth)).json;
    const rowAfter = after.rows.find((r: { partnerId: number }) => r.partnerId === customerId);
    expect(rowAfter).toMatchObject({ total: 0, credit: 4960 });
  });
});

describe("權限", () => {
  it("採購角色進不了報價/訂單/帳齡；總經理唯讀可看訂單但不能出貨", async () => {
    await api("/users", admin, { username: "pur2", displayName: "採購", password: "secret-test", role: "purchasing" });
    const pur = await loginAs(app, "pur2", "secret-test");
    expect((await api("/quotes", pur)).status).toBe(403);
    expect((await api("/orders", pur)).status).toBe(403);
    expect((await api("/reports/ar-aging?asOf=2026-09-01", pur)).status).toBe(403);

    await api("/users", admin, { username: "boss2", displayName: "總經理", password: "secret-test", role: "gm" });
    const gm = await loginAs(app, "boss2", "secret-test");
    expect((await api("/orders", gm)).status).toBe(200);
    expect((await api("/reports/ar-aging?asOf=2026-09-01", gm)).status).toBe(200);
    expect((await api(`/orders/${orderId}/ship`, gm, { docDate: "2026-07-25" })).status).toBe(403);
  });
});
