/**
 * 採購前段＋儀表板驗收：採購單（部分收貨 partial → 收清 closed、超量 422、已收貨不可取消）→
 * 收貨開進貨單（庫存入庫、傳票、purchase_order_id 回連）；總經理儀表板各數字對帳；
 * 權限（業務 403 採購單、採購 403 儀表板、gm 可看儀表板）。
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
let purAuth: Record<string, string>;
let supplierId: number;
let customerId: number;
let productId: number;
let poId: number;

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
  await api("/users", admin, { username: "pur", displayName: "採購", password: "secret-test", role: "purchasing" });
  purAuth = await loginAs(app, "pur", "secret-test");

  const supplier = await api("/partners", admin, { name: "供應商乙", isSupplier: true });
  supplierId = supplier.json.id;
  const customer = await api("/partners", admin, { name: "客戶甲", taxId: "04541302", isCustomer: true });
  customerId = customer.json.id;
  const product = await api("/products", admin, { sku: "SKU-400", name: "交換器" });
  productId = product.json.id;
});

describe("採購單", () => {
  it("採購角色建採購單（20 台 @600：未稅 12000＋稅 600）；非供應商 422", async () => {
    const res = await api("/purchase-orders", purAuth, {
      partnerId: supplierId,
      orderDate: "2026-07-10",
      memo: "補貨",
      lines: [{ productId, qty: 20, unitPrice: 600 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ status: "open", subtotal: 12000, tax: 600, total: 12600 });
    poId = res.json.id;

    const bad = await api("/purchase-orders", purAuth, {
      partnerId: customerId,
      orderDate: "2026-07-10",
      lines: [{ productId, qty: 1, unitPrice: 600 }],
    });
    expect(bad.status).toBe(422);
  });

  it("部分收貨 8 台 → partial、開進貨單回連、庫存入庫", async () => {
    const lines = (await api("/purchase-orders", purAuth)).json.find((p: { id: number }) => p.id === poId).lines;
    const res = await api(`/purchase-orders/${poId}/receive`, purAuth, {
      docDate: "2026-07-12",
      lines: [{ poLineId: lines[0].id, qty: 8 }],
    });
    expect(res.status).toBe(201);
    expect(res.json.purchaseOrder.status).toBe("partial");

    const purchase = (await api("/purchases", purAuth)).json.find(
      (p: { id: number }) => p.id === res.json.purchaseId,
    );
    expect(purchase).toMatchObject({ purchaseOrderId: poId, subtotal: 4800, tax: 240, total: 5040 });

    const inv = (await api("/inventory", purAuth)).json.find(
      (r: { productId: number }) => r.productId === productId,
    );
    expect(inv.qty).toBe(8);
  });

  it("超量收貨 422；已收貨不可取消 409；剩餘全收 → closed", async () => {
    const lines = (await api("/purchase-orders", purAuth)).json.find((p: { id: number }) => p.id === poId).lines;
    expect(
      (
        await api(`/purchase-orders/${poId}/receive`, purAuth, {
          docDate: "2026-07-13",
          lines: [{ poLineId: lines[0].id, qty: 13 }],
        })
      ).status,
    ).toBe(422);
    expect((await api(`/purchase-orders/${poId}/cancel`, purAuth, {})).status).toBe(409);

    const res = await api(`/purchase-orders/${poId}/receive`, purAuth, { docDate: "2026-07-14" });
    expect(res.status).toBe(201);
    expect(res.json.purchaseOrder.status).toBe("closed");
    const po = (await api("/purchase-orders", purAuth)).json.find((p: { id: number }) => p.id === poId);
    expect(po.lines[0].remainingQty).toBe(0);
    expect(po.purchaseIds).toHaveLength(2);
  });

  it("未收貨的採購單可取消", async () => {
    const res = await api("/purchase-orders", purAuth, {
      partnerId: supplierId,
      orderDate: "2026-07-15",
      lines: [{ productId, qty: 5, unitPrice: 600 }],
    });
    const cancel = await api(`/purchase-orders/${res.json.id}/cancel`, purAuth, {});
    expect(cancel.status).toBe(200);
    expect(cancel.json.status).toBe("canceled");
  });
});

describe("總經理儀表板", () => {
  it("營收/毛利/現金/應收應付/在手訂單/未到貨/報銷待核各數字對帳", async () => {
    // 場景：賣 10 台 @900（銷貨 7/20）、開在手訂單 6 台 @900、下未到貨採購 4 台 @600、
    // 收款 3000、報銷 800 待核
    await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2026-07-20",
      lines: [{ productId, qty: 10, unitPrice: 900 }],
    });
    await api("/orders", admin, {
      partnerId: customerId,
      orderDate: "2026-07-21",
      lines: [{ productId, qty: 6, unitPrice: 900 }],
    });
    await api("/purchase-orders", admin, {
      partnerId: supplierId,
      orderDate: "2026-07-21",
      lines: [{ productId, qty: 4, unitPrice: 600 }],
    });
    const accounts = (await api("/accounts", admin)).json;
    const bank = accounts.find((a: { code: string }) => a.code === "1103");
    await api("/cash-docs", admin, {
      kind: "receipt",
      partnerId: customerId,
      docDate: "2026-07-22",
      amount: 3000,
      accountId: bank.id,
    });
    const emp = await api("/employees", admin, { name: "王小明" });
    const me = (await api("/auth/me", admin)).json;
    await api(`/users/${me.id}`, admin, { employeeId: emp.json.id }, "PATCH");
    await api("/expense-claims", admin, {
      claimDate: "2026-07-23",
      items: [{ accountCode: "6132", docType: "receipt", amount: 800 }],
    });

    const d = (await api("/reports/dashboard?asOf=2026-07-27", admin)).json;
    // 營收：本月銷貨 10×900=9000；毛利 9000-成本（20 台 @600 進 → 賣 10 台成本 6000）=3000
    expect(d.revenue).toMatchObject({ subtotal: 9000, grossProfit: 3000, count: 1 });
    // 現金：收款 +3000（進貨銷貨都是賒帳，不動現金）
    expect(d.cash).toBe(3000);
    // 應收：銷貨 9450 含稅 − 收款 3000 = 6450；應付：兩批收貨進貨 12600
    expect(d.ar).toBe(6450);
    expect(d.ap).toBe(12600);
    // 在手訂單 6×900=5400；未到貨採購 4×600=2400
    expect(d.backlog).toMatchObject({ count: 1, amount: 5400 });
    expect(d.inbound).toMatchObject({ count: 1, amount: 2400 });
    expect(d.pendingClaims).toMatchObject({ count: 1, amount: 800 });
    // 逾期應收：銷貨 7/20 距 7/27 僅 7 天 → 0
    expect(d.overdueAr).toBe(0);
    // 換到 9 月視角：9450-3000=6450 全數逾期
    const sept = (await api("/reports/dashboard?asOf=2026-09-27", admin)).json;
    expect(sept.overdueAr).toBe(6450);
    expect(sept.revenue.count).toBe(0); // 9 月無銷貨
  });
});

describe("權限", () => {
  it("業務 403 採購單；採購 403 儀表板；總經理可看儀表板（唯讀）", async () => {
    await api("/users", admin, { username: "sal", displayName: "業務", password: "secret-test", role: "sales" });
    const sal = await loginAs(app, "sal", "secret-test");
    expect((await api("/purchase-orders", sal)).status).toBe(403);
    expect((await api("/reports/dashboard?asOf=2026-07-27", purAuth)).status).toBe(403);

    await api("/users", admin, { username: "boss", displayName: "總經理", password: "secret-test", role: "gm" });
    const gm = await loginAs(app, "boss", "secret-test");
    expect((await api("/reports/dashboard?asOf=2026-07-27", gm)).status).toBe(200);
    expect((await api("/purchase-orders", gm)).status).toBe(200);
    expect((await api(`/purchase-orders/${poId}/receive`, gm, { docDate: "2026-07-27" })).status).toBe(403);
  });
});
