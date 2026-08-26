/**
 * MCP 工具端對端：fetchImpl 注入 Hono app.fetch（不走網路），
 * 驗證登入/cookie/401 重登、報價→轉單→出貨、報表工具、權限錯誤傳遞。
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, schema } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "@tw-erp/api/app";
import { seedAccounts } from "@tw-erp/api/seed";
import { TwErpClient } from "../src/client.ts";
import { defineTools, type ToolDef } from "../src/tools.ts";

let tools: Map<string, ToolDef>;
let salesTools: Map<string, ToolDef>;
let db: ReturnType<typeof drizzle>;
let productId = 0;
let customerId = 0;

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  db = drizzle(client);
  await seedAccounts(db);
  const app = buildApp(db);

  // fetch 注入：把完整 URL 轉回 app.request 的 path
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace("http://test/api", "");
    return app.request(path, init);
  };

  // 建 admin＋業務帳號、基礎主檔與庫存
  await app.request("/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", displayName: "管理者", password: "secret-test" }),
  });
  const admin = new TwErpClient({ baseUrl: "http://test/api", username: "admin", password: "secret-test", fetchImpl });
  await admin.post("/users", { username: "sal", displayName: "業務", password: "secret-test", role: "sales" });
  const supplier = await admin.post<{ id: number }>("/partners", { name: "供應商", isSupplier: true });
  const customer = await admin.post<{ id: number }>("/partners", { name: "客戶", taxId: "04541302", isCustomer: true });
  customerId = customer.id;
  const product = await admin.post<{ id: number }>("/products", { sku: "M-1", name: "商品" });
  productId = product.id;
  await admin.post("/purchases", {
    partnerId: supplier.id,
    docDate: "2026-07-01",
    lines: [{ productId, qty: 10, unitPrice: 100 }],
  });

  tools = new Map(defineTools(admin).map((t) => [t.name, t]));
  const sales = new TwErpClient({ baseUrl: "http://test/api", username: "sal", password: "secret-test", fetchImpl });
  salesTools = new Map(defineTools(sales).map((t) => [t.name, t]));
});

const call = async (map: Map<string, ToolDef>, name: string, args: Record<string, unknown> = {}) => {
  const raw = await map.get(name)!.handler(args);
  return JSON.parse(raw);
};

describe("MCP 工具端對端", () => {
  it("主檔/庫存工具（含自動登入）", async () => {
    const partners = await call(tools, "list_partners");
    expect(partners).toHaveLength(2);
    const inv = await call(tools, "inventory_status");
    expect(inv[0]).toMatchObject({ qty: 10 });
  });

  it("報價→轉單→出貨全流程（業務帳號）", async () => {
    const quote = await call(salesTools, "create_quote", {
      partnerId: customerId,
      quoteDate: "2026-07-20",
      lines: [{ productId, qty: 5, unitPrice: 300 }],
    });
    expect(quote).toMatchObject({ status: "open", total: 1575 });

    const order = await call(salesTools, "convert_quote", { quoteId: quote.id, orderDate: "2026-07-21" });
    const shipped = await call(salesTools, "ship_order", { orderId: order.id, docDate: "2026-07-22" });
    expect(shipped.order.status).toBe("closed");

    const aging = await call(salesTools, "ar_aging", { asOf: "2026-07-27" });
    expect(aging.totals.total).toBe(1575);
  });

  it("報表工具（admin）：損益/儀表板", async () => {
    const pl = await call(tools, "income_statement", { from: "2026-07-01", to: "2026-07-31" });
    expect(pl.totalRevenue).toBe(1500);
    const dash = await call(tools, "dashboard", { asOf: "2026-07-27" });
    expect(dash.ar).toBe(1575);
  });

  it("權限錯誤如實傳遞：業務帳號呼叫儀表板工具 → 403 訊息", async () => {
    await expect(call(salesTools, "dashboard", { asOf: "2026-07-27" })).rejects.toThrow(/403/);
  });

  it("session 失效自動重登：清掉伺服端 session 後工具仍可用", async () => {
    await db.delete(schema.sessions);
    const partners = await call(tools, "list_partners");
    expect(partners).toHaveLength(2);
  });
});
