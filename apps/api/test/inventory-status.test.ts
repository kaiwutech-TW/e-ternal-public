/**
 * GET /inventory 的迴歸驗收（第三批雜項 ③）：實作從「逐商品 onHand」改成一次 join＋聚合
 * （原本 1＋N 條查詢、每條都整表掃 inventory_movements），**行為不得變**——
 * 這兩條測試鎖的是回應形狀與數字：欄位名、平均成本四捨五入到 4 位、服務項目不列、
 * 零異動商品照列 qty 0、低於安全庫存旗標。
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
let stockedId: number; // 有進有出
let serviceId: number; // 服務項目：不入庫存
let untouchedId: number; // 建了主檔、從沒進過貨

async function api(path: string, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text), text };
  } catch {
    return { status: res.status, json: null, text };
  }
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  auth = await setupAdmin(app);

  supplierId = (await api("/partners", { name: "供應商", taxId: "96979933", isSupplier: true })).json.id;
  customerId = (await api("/partners", { name: "客戶", taxId: "04541302", isCustomer: true })).json.id;
  stockedId = (await api("/products", { sku: "INV-A", name: "常備品", minStock: 100 })).json.id;
  serviceId = (await api("/products", { sku: "INV-SVC", name: "運費", isService: true })).json.id;
  untouchedId = (await api("/products", { sku: "INV-B", name: "新商品" })).json.id;

  // 兩批不同單價進貨 → 移動平均 10.5；賣 30 個 → 在庫 90（低於安全庫存 100）
  await api("/purchases", { partnerId: supplierId, docDate: "2026-07-01", lines: [{ productId: stockedId, qty: 100, unitPrice: 10 }] });
  await api("/purchases", { partnerId: supplierId, docDate: "2026-07-02", lines: [{ productId: stockedId, qty: 20, unitPrice: 13 }] });
  await api("/sales", { partnerId: customerId, docDate: "2026-07-10", lines: [{ productId: stockedId, qty: 30, unitPrice: 50 }] });
});

describe("GET /inventory（一次查詢後的迴歸）", () => {
  it("正向：移動平均成本、帳面金額、低於安全庫存旗標——整列形狀逐欄鎖定", async () => {
    const res = await api("/inventory");
    expect(res.status).toBe(200);
    const row = res.json.find((r: { productId: number }) => r.productId === stockedId);
    // 進 100@10＋20@13＝1260／120＝avg 10.5；出 30×10.5＝315 → 在庫 90、帳面 945
    expect(row).toEqual({
      productId: stockedId,
      sku: "INV-A",
      name: "常備品",
      qty: 90,
      amount: 945,
      avgUnitCost: 10.5,
      minStock: 100,
      belowMinStock: true, // 90 < 100
    });
  });

  it("邊界：服務項目不列；零異動商品照列（qty 0、平均成本 null、不算低於安全庫存）", async () => {
    const res = await api("/inventory");
    expect(res.json.find((r: { productId: number }) => r.productId === serviceId)).toBeUndefined();
    const untouched = res.json.find((r: { productId: number }) => r.productId === untouchedId);
    expect(untouched).toEqual({
      productId: untouchedId,
      sku: "INV-B",
      name: "新商品",
      qty: 0,
      amount: 0,
      avgUnitCost: null, // qty 0 沒有平均成本，不能除以零假裝有
      minStock: null,
      belowMinStock: false, // 未設安全庫存＝不警示
    });
    // 依商品 id 穩定排序（原實作照 products 表序，聚合版明定 order by id）
    const ids = res.json.map((r: { productId: number }) => r.productId);
    expect(ids).toEqual([...ids].sort((a: number, b: number) => a - b));
  });
});
