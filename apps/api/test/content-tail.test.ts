/**
 * 內容尾款四件驗收（第四批）：
 * ① 交期欄位（gap 3.5）：quotes/orders/purchase_orders 的 expectedDate——建立、轉單帶入、格式驗證
 * ② 訂單確認單列印（B5 尾款）：清單回應含列印視圖的全部取數（partnerName／明細品名／交期）
 * ③ 折舊明細表（gap 3.7）：期初累折＋本年度折舊＝期末累折、帳面淨值；CSV 同一份取數
 * ④ 庫存異動明細帳（R9）：逐筆結存連續性、期間篩選的期初接續、作廢回沖標籤、
 *    期初開帳的 doc_date 落地（0035 前這個日期永遠拼不回來）
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
let productId: number; // 明細帳主角
let openingProductId: number; // 期初開帳測試用

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

  const supplier = await api("/partners", admin, { name: "供應商甲", isSupplier: true });
  supplierId = supplier.json.id;
  const customer = await api("/partners", admin, { name: "客戶乙", taxId: "04541302", isCustomer: true, paymentTermDays: 30 });
  customerId = customer.json.id;
  const product = await api("/products", admin, { sku: "SKU-900", name: "冷凍水餃" });
  productId = product.json.id;
  const opening = await api("/products", admin, { sku: "SKU-901", name: "罐頭湯底" });
  openingProductId = opening.json.id;
});

describe("① 交期欄位（0035）", () => {
  it("報價單帶預計交期；成交轉訂單原樣帶入（談好的承諾不因轉單消失）", async () => {
    const quote = await api("/quotes", admin, {
      partnerId: customerId,
      quoteDate: "2026-08-01",
      expectedDate: "2026-08-20",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    expect(quote.status).toBe(201);
    expect(quote.json.expectedDate).toBe("2026-08-20");

    const converted = await api(`/quotes/${quote.json.id}/convert`, admin, { orderDate: "2026-08-02" });
    expect(converted.status).toBe(201);
    expect(converted.json.expectedDate).toBe("2026-08-20");
  });

  it("訂單與採購單都收 expectedDate；未帶＝null（未約定，不捏造日期）", async () => {
    const order = await api("/orders", admin, {
      partnerId: customerId,
      orderDate: "2026-08-03",
      expectedDate: "2026-08-15",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    expect(order.status).toBe(201);
    expect(order.json.expectedDate).toBe("2026-08-15");

    const po = await api("/purchase-orders", admin, {
      partnerId: supplierId,
      orderDate: "2026-08-03",
      expectedDate: "2026-08-25",
      lines: [{ productId, qty: 5, unitPrice: 50 }],
    });
    expect(po.status).toBe(201);
    expect(po.json.expectedDate).toBe("2026-08-25");
    const poList = await api("/purchase-orders", admin);
    expect(poList.json.find((p: { id: number }) => p.id === po.json.id).expectedDate).toBe("2026-08-25");

    const noDate = await api("/orders", admin, {
      partnerId: customerId,
      orderDate: "2026-08-03",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    expect(noDate.status).toBe(201);
    expect(noDate.json.expectedDate).toBeNull();
  });

  it("expectedDate 格式錯誤 400（YYYY-MM-DD 以外拒收）", async () => {
    const bad = await api("/quotes", admin, {
      partnerId: customerId,
      quoteDate: "2026-08-01",
      expectedDate: "2026/08/20",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    expect(bad.status).toBe(400);
  });
});

describe("② 訂單確認單列印取數（B5 尾款）", () => {
  it("訂單清單含列印視圖的全部取數：partnerName、明細品名與單價、expectedDate", async () => {
    const list = await api("/orders", admin);
    expect(list.status).toBe(200);
    const withDate = list.json.find((o: { expectedDate: string | null }) => o.expectedDate === "2026-08-15");
    expect(withDate).toBeDefined();
    expect(withDate.partnerName).toBe("客戶乙");
    expect(withDate.lines[0].productName).toBe("冷凍水餃");
    expect(Number(withDate.lines[0].unitPrice)).toBe(100);
    expect(withDate.subtotal + withDate.tax).toBe(withDate.total);
  });

  it("報價單清單也帶 expectedDate（報價單列印顯示交期）", async () => {
    const list = await api("/quotes", admin);
    expect(list.status).toBe(200);
    const q = list.json.find((r: { expectedDate: string | null }) => r.expectedDate === "2026-08-20");
    expect(q).toBeDefined();
    expect(q.status).toBe("won"); // 已於上一組轉訂單
  });
});

describe("③ 折舊明細表（gap 3.7）", () => {
  let assetId: number;

  beforeAll(async () => {
    // 月折舊 = (73000 − 1000) / 36 = 2000；2025-11 啟用 → 2025 提 2 期、2026 提 3 期
    const asset = await api("/fixed-assets", admin, {
      name: "辦公電腦",
      category: "computer",
      cost: 73000,
      salvage: 1000,
      startDate: "2025-11-15",
    });
    expect(asset.status).toBe(201);
    assetId = asset.json.id;
    for (const period of ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03"]) {
      const run = await api("/depreciations/run", admin, { period });
      expect(run.status).toBe(201);
    }
  });

  it("期初累折＋本年度折舊＝期末累折；帳面淨值＝成本−期末累折", async () => {
    const res = await api("/reports/depreciation-schedule?year=2026", admin);
    expect(res.status).toBe(200);
    const row = res.json.rows.find((r: { assetId: number }) => r.assetId === assetId);
    expect(row).toMatchObject({
      name: "辦公電腦",
      cost: 73000,
      openingAccum: 4000, // 2025-11 ＋ 2025-12
      yearDepreciation: 6000, // 2026-01..03
      accumulated: 10000,
      bookValue: 63000,
      status: "active",
    });
    expect(res.json.totals.accumulated).toBe(
      res.json.rows.reduce((s: number, r: { accumulated: number }) => s + r.accumulated, 0),
    );
  });

  it("該年度尚未啟用的資產不列（2024 年的表沒有 2025-11 啟用的電腦）", async () => {
    const res = await api("/reports/depreciation-schedule?year=2024", admin);
    expect(res.status).toBe(200);
    expect(res.json.rows.find((r: { assetId: number }) => r.assetId === assetId)).toBeUndefined();
  });

  it("CSV 與畫面同一份取數：BOM 開頭、表頭齊、含資產列", async () => {
    const res = await api("/reports/depreciation-schedule?year=2026&format=csv", admin);
    expect(res.status).toBe(200);
    expect(res.json.name).toBe("折舊明細表_2026.csv");
    expect(res.json.content.startsWith("﻿")).toBe(true);
    expect(res.json.content).toContain("期初累計折舊,本年度折舊,期末累計折舊,帳面淨值");
    expect(res.json.content).toContain("辦公電腦");
    expect(res.json.content).toContain("63000");
    expect(res.json.rows).toBeGreaterThan(0);
  });

  it("year 缺漏或格式錯誤 400（錯誤訊息講清楚要什麼）", async () => {
    const missing = await api("/reports/depreciation-schedule", admin);
    expect(missing.status).toBe(400);
    expect(missing.json.error).toContain("year");
    const bad = await api("/reports/depreciation-schedule?year=26", admin);
    expect(bad.status).toBe(400);
  });
});

describe("④ 庫存異動明細帳（R9）", () => {
  let saleId: number;

  beforeAll(async () => {
    // 時間軸：7/1 進 10@100 → 7/5 賣 4（成本 400）→ 7/10 進 10@130
    await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2026-07-01",
      lines: [{ productId, qty: 10, unitPrice: 100 }],
    });
    const sale = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2026-07-05",
      lines: [{ productId, qty: 4, unitPrice: 200 }],
    });
    expect(sale.status).toBe(201);
    saleId = sale.json.id;
    await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2026-07-10",
      lines: [{ productId, qty: 10, unitPrice: 130 }],
    });
  });

  it("逐筆結存連續性：每列結存＝前列結存±本列進出，期末與 /inventory 在庫一致", async () => {
    const res = await api(`/inventory/movements?productId=${productId}`, admin);
    expect(res.status).toBe(200);
    // ①＋②交期測試各出過 0 筆（報價/訂單不動庫存），這裡只有三筆實體異動
    const mine = res.json.rows;
    expect(mine.length).toBe(3);
    expect(mine.map((r: { sourceLabel: string }) => r.sourceLabel)).toEqual([
      expect.stringContaining("進貨單"),
      expect.stringContaining("銷貨單"),
      expect.stringContaining("進貨單"),
    ]);
    // 連續性：qty 10 → 6 → 16；金額 1000 → 600（銷貨以移動平均成本 100 出 4）→ 1900
    let qty = res.json.opening.qty;
    let amount = res.json.opening.amount;
    for (const r of mine) {
      const sign = r.direction === "in" ? 1 : -1;
      qty += sign * r.qty;
      amount += sign * r.amount;
      expect(r.balanceQty).toBe(qty);
      expect(r.balanceAmount).toBe(amount);
    }
    expect(res.json.closing).toEqual({ qty: 16, amount: 1900 });

    const inv = await api("/inventory", admin);
    const row = inv.json.find((r: { productId: number }) => r.productId === productId);
    expect(row.qty).toBe(res.json.closing.qty);
    expect(row.amount).toBe(res.json.closing.amount);
  });

  it("期間篩選：from 之前的異動收進期初，結存從期初接著走（不斷鏈）", async () => {
    const res = await api(`/inventory/movements?productId=${productId}&from=2026-07-06&to=2026-07-31`, admin);
    expect(res.status).toBe(200);
    expect(res.json.opening).toEqual({ qty: 6, amount: 600 }); // 7/1 進 10 − 7/5 出 4
    expect(res.json.rows.length).toBe(1); // 只剩 7/10 的進貨
    expect(res.json.rows[0].docDate).toBe("2026-07-10");
    expect(res.json.rows[0].balanceQty).toBe(16);
    expect(res.json.closing).toEqual({ qty: 16, amount: 1900 });
  });

  it("作廢回沖照列並標明：銷貨單作廢後多一筆「作廢回補」，結存回到未賣狀態", async () => {
    const voided = await api(`/sales/${saleId}/void`, admin, { reason: "打錯客戶" });
    expect(voided.status).toBe(200);
    const res = await api(`/inventory/movements?productId=${productId}`, admin);
    const rollback = res.json.rows.find(
      (r: { sourceLabel: string }) => r.sourceLabel === `銷貨單 #${saleId} 作廢回補`,
    );
    expect(rollback).toBeDefined();
    expect(rollback.direction).toBe("in");
    expect(rollback.docDate).toBe("2026-07-05"); // 與反向傳票同日＝原單日期
    expect(res.json.closing).toEqual({ qty: 20, amount: 2300 });
  });

  it("期初開帳的 doc_date 落地（0035）：明細帳的期初列按真正的開帳日歸期", async () => {
    const opening = await api("/inventory/opening", admin, {
      docDate: "2026-06-01",
      lines: [{ productId: openingProductId, qty: 50, unitCost: 20 }],
    });
    expect(opening.status).toBe(201);
    const res = await api(`/inventory/movements?productId=${openingProductId}`, admin);
    expect(res.json.rows.length).toBe(1);
    expect(res.json.rows[0]).toMatchObject({
      docDate: "2026-06-01", // 不是「今天」——0035 前這個日期永遠拼不回來
      sourceLabel: "期初開帳",
      balanceQty: 50,
      balanceAmount: 1000,
    });
  });

  it("productId 必填（400）；服務項目沒有明細帳（422 指路）", async () => {
    const missing = await api("/inventory/movements", admin);
    expect(missing.status).toBe(400);
    expect(missing.json.error).toContain("productId");
    const service = await api("/products", admin, { sku: "SVC-1", name: "運費", isService: true });
    const res = await api(`/inventory/movements?productId=${service.json.id}`, admin);
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("服務項目");
  });
});
