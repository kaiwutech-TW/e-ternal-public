/**
 * B8 驗收（migration 0026）：庫存調整單——盤盈／盤虧／報廢的入口。
 * 驗四件事：①盤虧後在庫量與存貨科目同步減、移動平均成本不變 ②報廢進損失科目（7521）
 * 而不是銷貨成本 ③盤點差異由系統算（實盤量整批建單、一致不建單）④調整單可被 B4 的
 * 作廢機制沖轉（反向傳票＋庫存以原成本回補；盤盈的貨已賣掉 409）。
 * 另驗：關帳期間 409、服務項目 422、報廢不收正數 422、無成本基礎的盤盈 422、sales 角色 403。
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
let supplierId: number;
let customerId: number;
let productId: number; // 商品A：期初進貨 100 @10
let product2Id: number; // 商品B：盤盈作廢的在庫不足情境用
let product3Id: number; // 商品C：無庫存（盤盈無成本基礎情境用）
let serviceId: number; // 服務項目

async function api(path: string, body?: unknown, method = body ? "POST" : "GET", headers = admin) {
  const res = await app.request(path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** 某科目在試算表上的淨額（借−貸） */
async function accountNet(code: string): Promise<number> {
  const tb = await api("/trial-balance");
  const row = tb.json.rows.find((r: { code: string }) => r.code === code);
  return row ? row.debit - row.credit : 0;
}

/** 商品在庫（庫存頁取數）：qty／amount／avgUnitCost */
async function stockOf(id: number) {
  const inv = await api("/inventory");
  return inv.json.find((r: { productId: number }) => r.productId === id);
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);

  supplierId = (await api("/partners", { name: "供應商甲", taxId: "04541302", isSupplier: true })).json.id;
  customerId = (await api("/partners", { name: "客戶乙", taxId: "12345675", isCustomer: true })).json.id;
  productId = (await api("/products", { sku: "ADJ-001", name: "冷凍水餃" })).json.id;
  product2Id = (await api("/products", { sku: "ADJ-002", name: "罐頭" })).json.id;
  product3Id = (await api("/products", { sku: "ADJ-003", name: "新品未進貨" })).json.id;
  serviceId = (await api("/products", { sku: "ADJ-SVC", name: "運費", isService: true })).json.id;
  // 備庫存：商品A 100 個 @10（移動平均成本 10.0000）
  await api("/purchases", { partnerId: supplierId, docDate: "2026-08-01", lines: [{ productId, qty: 100, unitPrice: 10 }] });
});

describe("盤虧／報廢（庫存調減）", () => {
  it("報廢：在庫量與存貨科目同步減、移動平均成本不變、損失進 7521 而非 5101", async () => {
    const inv1301Before = await accountNet("1301");
    const res = await api("/inventory/adjustments", {
      docDate: "2026-08-05",
      reason: "scrap",
      memo: "冷凍庫故障",
      lines: [{ productId, qtyDiff: -10 }],
    });
    expect(res.status).toBe(201);
    expect(res.json.totalOut).toBe(100); // 10 個 × 均價 10
    expect(res.json.totalIn).toBe(0);

    // 庫存子帳與總帳同步動、均價不變（B8 的核心缺陷就是兩邊分歧）
    const stock = await stockOf(productId);
    expect(stock.qty).toBe(90);
    expect(stock.amount).toBe(900);
    expect(stock.avgUnitCost).toBe(10);
    expect(await accountNet("1301")).toBe(inv1301Before - 100);
    expect(await accountNet("7521")).toBe(100); // 存貨盤損（不是 5101 銷貨成本）
    expect(await accountNet("5101")).toBe(0);

    // 傳票拋轉正確：借 7521 貸 1301，來源標庫存調整
    const entry = await api(`/journal-entries/${res.json.journalEntryId}`);
    expect(entry.json.memo).toContain("庫存調整單");
    expect(entry.json.memo).toContain("報廢");
    const loss = entry.json.lines.find((l: { code: string }) => l.code === "7521");
    expect(loss).toMatchObject({ debit: 100, credit: 0 });
  });

  it("報廢不收正數（盤盈請用盤點）、服務項目 422、在庫不足 409", async () => {
    const positive = await api("/inventory/adjustments", {
      docDate: "2026-08-05",
      reason: "scrap",
      lines: [{ productId, qtyDiff: 5 }],
    });
    expect(positive.status).toBe(422);
    expect(positive.json.error).toContain("盤點差異");

    const service = await api("/inventory/adjustments", {
      docDate: "2026-08-05",
      reason: "scrap",
      lines: [{ productId: serviceId, qtyDiff: -1 }],
    });
    expect(service.status).toBe(422);
    expect(service.json.error).toContain("服務項目");

    const tooMany = await api("/inventory/adjustments", {
      docDate: "2026-08-05",
      reason: "count",
      lines: [{ productId, qtyDiff: -1000 }],
    });
    expect(tooMany.status).toBe(409);
    expect(tooMany.json.error).toContain("在庫");
  });

  it("盤盈（count）：以當下均價入庫，借 1301 貸 7121", async () => {
    const res = await api("/inventory/adjustments", {
      docDate: "2026-08-06",
      reason: "count",
      lines: [{ productId, qtyDiff: 5 }],
    });
    expect(res.status).toBe(201);
    expect(res.json.totalIn).toBe(50); // 5 × 均價 10
    const stock = await stockOf(productId);
    expect(stock.qty).toBe(95);
    expect(stock.avgUnitCost).toBe(10);
    expect(await accountNet("7121")).toBe(-50); // 貸方餘額（revenue）
  });
});

describe("盤點輔助（差異由系統算）", () => {
  it("GET 底稿列現有品項＋帳面量；服務項目不列", async () => {
    const sheet = await api("/inventory/stocktake");
    expect(sheet.status).toBe(200);
    const rowA = sheet.json.find((r: { productId: number }) => r.productId === productId);
    expect(rowA.bookQty).toBe(95);
    expect(sheet.json.find((r: { productId: number }) => r.productId === serviceId)).toBeUndefined();
  });

  it("實盤量與帳面量一致：不建調整單（200，不是錯誤）", async () => {
    const res = await api("/inventory/stocktake", {
      docDate: "2026-08-07",
      lines: [{ productId, countedQty: 95 }],
    });
    expect(res.status).toBe(200);
    expect(res.json.adjustment).toBeNull();
    expect(res.json.message).toContain("一致");
  });

  it("實盤量少 5：系統算出差異建調整單，明細留下帳面量與實盤量", async () => {
    const res = await api("/inventory/stocktake", {
      docDate: "2026-08-07",
      memo: "月底例行盤點",
      lines: [{ productId, countedQty: 90 }],
    });
    expect(res.status).toBe(201);
    expect(res.json.adjustment.reason).toBe("count");
    expect(res.json.adjustment.totalOut).toBe(50); // 5 × 均價 10

    const stock = await stockOf(productId);
    expect(stock.qty).toBe(90);
    expect(stock.avgUnitCost).toBe(10);

    // 軌跡：差異怎麼算出來的，明細上查得到（帳面 95 → 實盤 90）
    const list = await api("/inventory/adjustments");
    const doc = list.json.find((a: { id: number }) => a.id === res.json.adjustment.id);
    const line = doc.lines.find((l: { productId: number }) => l.productId === productId);
    expect(Number(line.bookQty)).toBe(95);
    expect(Number(line.countedQty)).toBe(90);
    expect(line.direction).toBe("out");
  });
});

describe("作廢（B4 同一套機制）", () => {
  it("報廢單作廢：反向傳票沖平 7521、庫存以原成本回補、原單留痕；不可再作廢", async () => {
    const adj = await api("/inventory/adjustments", {
      docDate: "2026-08-10",
      reason: "scrap",
      lines: [{ productId, qtyDiff: -10 }],
    });
    expect(adj.status).toBe(201);
    const lossBefore = await accountNet("7521");
    const invBefore = await accountNet("1301");
    expect((await stockOf(productId)).qty).toBe(80);

    const voided = await api(`/inventory/adjustments/${adj.json.id}/void`, { reason: "掃錯商品" });
    expect(voided.status).toBe(200);
    expect(voided.json.reversalEntryId).toBeTruthy();

    // 總帳沖平、庫存回補、均價不變
    expect(await accountNet("7521")).toBe(lossBefore - 100);
    expect(await accountNet("1301")).toBe(invBefore + 100);
    const stock = await stockOf(productId);
    expect(stock.qty).toBe(90);
    expect(stock.avgUnitCost).toBe(10);

    // 原單留痕（永不刪除）
    const list = await api("/inventory/adjustments");
    const doc = list.json.find((a: { id: number }) => a.id === adj.json.id);
    expect(doc.voidedAt).toBeTruthy();
    expect(doc.voidReason).toBe("掃錯商品");

    const again = await api(`/inventory/adjustments/${adj.json.id}/void`, { reason: "再廢一次" });
    expect(again.status).toBe(409);
    expect(again.json.error).toContain("已於");
  });

  it("盤盈單作廢時那批貨已賣掉：在庫不足 409 並指路", async () => {
    // 商品B：進 10 @10 → 盤盈 +5 → 賣 12 → 在庫 3，不夠沖回盤盈的 5
    await api("/purchases", { partnerId: supplierId, docDate: "2026-08-11", lines: [{ productId: product2Id, qty: 10, unitPrice: 10 }] });
    const gain = await api("/inventory/adjustments", {
      docDate: "2026-08-11",
      reason: "count",
      lines: [{ productId: product2Id, qtyDiff: 5 }],
    });
    expect(gain.status).toBe(201);
    expect((await api("/sales", { partnerId: customerId, docDate: "2026-08-12", lines: [{ productId: product2Id, qty: 12, unitPrice: 50 }] })).status).toBe(201);

    const voided = await api(`/inventory/adjustments/${gain.json.id}/void`, { reason: "盤錯了" });
    expect(voided.status).toBe(409);
    expect(voided.json.error).toContain("在庫");
  });

  it("盤盈需要成本基礎：無庫存的商品 422 並指路進貨單／庫存開帳", async () => {
    const res = await api("/inventory/adjustments", {
      docDate: "2026-08-12",
      reason: "count",
      lines: [{ productId: product3Id, qtyDiff: 5 }],
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("成本");
  });
});

describe("權限與關帳", () => {
  it("庫存調整限財務／管理者：sales 角色 403", async () => {
    await api("/users", { username: "seller2", displayName: "業務", password: "secret-test", role: "sales" });
    const seller = await loginAs(app, "seller2", "secret-test");
    const create = await api(
      "/inventory/adjustments",
      { docDate: "2026-08-13", reason: "scrap", lines: [{ productId, qtyDiff: -1 }] },
      "POST",
      seller,
    );
    expect(create.status).toBe(403);
    const sheet = await api("/inventory/stocktake", undefined, "GET", seller);
    expect(sheet.status).toBe(403);
  });

  it("關帳期間：建調整單 409；作廢已關帳期間的調整單也 409（不收 voidDate）", async () => {
    // 先留一張活的調整單在 8 月，等關帳後試作廢
    const adj = await api("/inventory/adjustments", {
      docDate: "2026-08-20",
      reason: "scrap",
      lines: [{ productId, qtyDiff: -1 }],
    });
    expect(adj.status).toBe(201);
    expect((await api("/period-closes", { period: "2026-08" })).status).toBe(201);

    const blocked = await api("/inventory/adjustments", {
      docDate: "2026-08-25",
      reason: "scrap",
      lines: [{ productId, qtyDiff: -1 }],
    });
    expect(blocked.status).toBe(409);

    const voidBlocked = await api(`/inventory/adjustments/${adj.json.id}/void`, { reason: "打錯" });
    expect(voidBlocked.status).toBe(409);
    expect(voidBlocked.json.error).toContain("已關帳");
    expect(voidBlocked.json.error).toContain("重開");

    // 開放期間照常可建：關帳擋的是日期，不是功能
    const nextMonth = await api("/inventory/adjustments", {
      docDate: "2026-09-01",
      reason: "scrap",
      lines: [{ productId, qtyDiff: -1 }],
    });
    expect(nextMonth.status).toBe(201);
  });
});
