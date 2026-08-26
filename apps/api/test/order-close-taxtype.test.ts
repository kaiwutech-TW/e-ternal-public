/**
 * 0032 驗收：訂單/採購單短交結案 ＋ 課稅別走訂單流程 ＋ 收貨單價覆寫。
 * - 短交結案：partial → closed（理由必填）、open → closed 也允許；結案後不可 ship/receive/cancel；
 *   儀表板在手訂單（openBacklog）排除已結案的剩餘量。cancel 與 close 的語意差要在錯誤訊息裡讀得到。
 * - 課稅別：零稅率報價（稅 0）→ 轉訂單（三欄原樣搬）→ 出貨（銷貨單 taxType 2、稅 0）→ 401 進零稅率欄。
 * - 收貨價覆寫：receive 帶 unitPrice 時進貨單以收貨價入帳，採購單保留原下單價，回應逐筆列差異。
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

async function api(path: string, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json() };
}

let supplierId: number;
let customerId: number;
let foreignId: number;
let productId: number;

async function backlog() {
  const res = await api("/reports/dashboard?asOf=2026-07-31");
  return { sales: res.json.backlog, purchase: res.json.inbound };
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  auth = await setupAdmin(app);

  await api(
    "/company-profile",
    { name: "短交測試公司", taxId: "22099131", taxRegistrationNo: "123456789", cityCode: "A" },
    "PUT",
  );
  supplierId = (await api("/partners", { name: "供應商", taxId: "96979933", isSupplier: true })).json.id;
  customerId = (await api("/partners", { name: "本地客戶", taxId: "04541302", isCustomer: true })).json.id;
  foreignId = (await api("/partners", { name: "Overseas Ltd.", isCustomer: true })).json.id;
  productId = (await api("/products", { sku: "CLS-001", name: "外銷零件" })).json.id;
  // 備庫存：100 個 @500
  await api("/purchases", {
    partnerId: supplierId,
    docDate: "2026-07-01",
    lines: [{ productId, qty: 100, unitPrice: 500 }],
  });
});

describe("訂單短交結案", () => {
  let orderId: number;

  it("partial 短交結案：理由必填、closedAt/closeReason 落地、backlog 排除剩餘量", async () => {
    const order = await api("/orders", {
      partnerId: customerId,
      orderDate: "2026-07-10",
      lines: [{ productId, qty: 10, unitPrice: 1000 }],
    });
    expect(order.status).toBe(201);
    orderId = order.json.id;
    const lineId = (await api("/orders")).json.find((o: { id: number }) => o.id === orderId).lines[0].id;
    const ship = await api(`/orders/${orderId}/ship`, {
      docDate: "2026-07-11",
      lines: [{ orderLineId: lineId, qty: 4 }],
    });
    expect(ship.status).toBe(201);
    expect(ship.json.order.status).toBe("partial");

    const before = await backlog();
    // 剩餘 6 個 @1000 未稅在手
    const noReason = await api(`/orders/${orderId}/close`, {});
    expect(noReason.status).toBe(400);

    const closed = await api(`/orders/${orderId}/close`, { reason: "客戶砍單" });
    expect(closed.status).toBe(200);
    expect(closed.json.status).toBe("closed");
    expect(closed.json.closeReason).toBe("客戶砍單");
    expect(closed.json.closedAt).not.toBeNull();

    const after = await backlog();
    expect(before.sales.amount - after.sales.amount).toBe(6000);
    expect(before.sales.count - after.sales.count).toBe(1);
  });

  it("結案後不可出貨、不可取消、不可再結案；錯誤訊息講清楚 cancel 與 close 的語意差", async () => {
    const lineId = (await api("/orders")).json.find((o: { id: number }) => o.id === orderId).lines[0].id;
    const ship = await api(`/orders/${orderId}/ship`, { docDate: "2026-07-12", lines: [{ orderLineId: lineId, qty: 1 }] });
    expect(ship.status).toBe(409);
    expect(ship.json.error).toContain("結案");
    expect(ship.json.error).toContain("到此為止");

    const cancel = await api(`/orders/${orderId}/cancel`, {});
    expect(cancel.status).toBe(409);
    expect(cancel.json.error).toContain("從沒發生");
    expect(cancel.json.error).toContain("結案");

    const again = await api(`/orders/${orderId}/close`, { reason: "再關一次" });
    expect(again.status).toBe(409);
    expect(again.json.error).toContain("客戶砍單"); // 原結案理由要在訊息裡
  });

  it("已出貨的銷貨單不因結案消失（結案＝到此為止，不動已開出的單據）", async () => {
    const order = (await api("/orders")).json.find((o: { id: number }) => o.id === orderId);
    expect(order.saleIds).toHaveLength(1);
    const sale = await api(`/sales/${order.saleIds[0]}`);
    expect(sale.status).toBe(200);
    expect(sale.json.subtotal).toBe(4000); // 出掉的 4 個 @1000
  });

  it("open → close 也允許（整單放棄留紀錄）；canceled 不可結案", async () => {
    const o1 = await api("/orders", {
      partnerId: customerId,
      orderDate: "2026-07-13",
      lines: [{ productId, qty: 2, unitPrice: 1000 }],
    });
    const closed = await api(`/orders/${o1.json.id}/close`, { reason: "客戶整單放棄" });
    expect(closed.status).toBe(200);
    expect(closed.json.status).toBe("closed");

    const o2 = await api("/orders", {
      partnerId: customerId,
      orderDate: "2026-07-13",
      lines: [{ productId, qty: 2, unitPrice: 1000 }],
    });
    await api(`/orders/${o2.json.id}/cancel`, {});
    const closeCanceled = await api(`/orders/${o2.json.id}/close`, { reason: "x" });
    expect(closeCanceled.status).toBe(409);
    expect(closeCanceled.json.error).toContain("已取消");
  });

  it("全數出清的自動結案不標「短交」：closedAt 維持 NULL，再 close 是 409", async () => {
    const o = await api("/orders", {
      partnerId: customerId,
      orderDate: "2026-07-14",
      lines: [{ productId, qty: 3, unitPrice: 1000 }],
    });
    await api(`/orders/${o.json.id}/ship`, { docDate: "2026-07-14" });
    const row = (await api("/orders")).json.find((r: { id: number }) => r.id === o.json.id);
    expect(row.status).toBe("closed");
    expect(row.closedAt).toBeNull();
    const res = await api(`/orders/${o.json.id}/close`, { reason: "x" });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("全數出清");
  });

  it("短交結案的訂單：作廢其出貨銷貨單後，出貨量退回但**不**翻回 open（結案是明示決定）", async () => {
    // 二階組合（第三批覆核抓到）：結案訊息承諾「到此為止，剩餘量不再出貨」，
    // 但作廢出貨的 rollback 原本無條件以出貨量重推狀態——短交結案的單被悄悄復活回 backlog，
    // 且留下 status=open 掛著 closed_at 的自相矛盾。修正後：量退回、結案立場不變。
    const o = await api("/orders", {
      partnerId: customerId,
      orderDate: "2026-07-15",
      lines: [{ productId, qty: 10, unitPrice: 1000 }],
    });
    const lineId = (await api("/orders")).json.find((r: { id: number }) => r.id === o.json.id).lines[0].id;
    const ship = await api(`/orders/${o.json.id}/ship`, { docDate: "2026-07-15", lines: [{ orderLineId: lineId, qty: 4 }] });
    expect(ship.status).toBe(201);
    expect((await api(`/orders/${o.json.id}/close`, { reason: "客戶砍單" })).status).toBe(200);
    const backlogBefore = await backlog();

    const voided = await api(`/sales/${ship.json.saleId}/void`, { reason: "出貨單打錯" });
    expect(voided.status).toBe(200);

    const row = (await api("/orders")).json.find((r: { id: number }) => r.id === o.json.id);
    expect(row.status).toBe("closed"); // 不翻回 open
    expect(row.closedAt).toBeTruthy(); // 結案軌跡留著
    expect(row.closeReason).toBe("客戶砍單");
    expect(Number(row.lines[0].shippedQty)).toBe(0); // 量照退（數量軌跡要對）
    expect(row.saleIds).toHaveLength(0); // 作廢單不列關聯連結
    // 仍不可出貨、不進在手訂單
    const shipAgain = await api(`/orders/${o.json.id}/ship`, { docDate: "2026-07-16", lines: [{ orderLineId: lineId, qty: 1 }] });
    expect(shipAgain.status).toBe(409);
    expect((await backlog()).sales).toEqual(backlogBefore.sales);
  });
});

describe("採購單短交結案與收貨價覆寫", () => {
  let poId: number;
  let poLineId: number;

  it("收貨價覆寫：進貨單以收貨價入帳、採購單保留原價、回應列出差異", async () => {
    const po = await api("/purchase-orders", {
      partnerId: supplierId,
      orderDate: "2026-07-15",
      lines: [{ productId, qty: 10, unitPrice: 100 }],
    });
    expect(po.status).toBe(201);
    poId = po.json.id;
    poLineId = (await api("/purchase-orders")).json.find((p: { id: number }) => p.id === poId).lines[0].id;

    const recv = await api(`/purchase-orders/${poId}/receive`, {
      docDate: "2026-07-16",
      lines: [{ poLineId, qty: 5, unitPrice: 120 }],
    });
    expect(recv.status).toBe(201);
    expect(recv.json.priceOverrides).toEqual([
      { poLineId, productId, orderPrice: 100, receivedPrice: 120 },
    ]);
    expect(recv.json.taxNotes.join("")).toContain("收貨價 120");

    // 進貨單以收貨價入帳：未稅 5×120＝600、稅 30（傳票金額同一組數字）
    const purchase = (await api("/purchases")).json.find((d: { id: number }) => d.id === recv.json.purchaseId);
    expect(purchase).toMatchObject({ subtotal: 600, tax: 30, total: 630 });

    // 採購單明細保留原下單價（差異可比對）
    const poRow = (await api("/purchase-orders")).json.find((p: { id: number }) => p.id === poId);
    expect(Number(poRow.lines[0].unitPrice)).toBe(100);
  });

  it("未帶 unitPrice ＝照採購單價入帳（不產生覆寫紀錄）", async () => {
    const recv = await api(`/purchase-orders/${poId}/receive`, {
      docDate: "2026-07-17",
      lines: [{ poLineId, qty: 2 }],
    });
    expect(recv.status).toBe(201);
    expect(recv.json.priceOverrides).toEqual([]);
    const purchase = (await api("/purchases")).json.find((d: { id: number }) => d.id === recv.json.purchaseId);
    expect(purchase).toMatchObject({ subtotal: 200, tax: 10 });
  });

  it("partial 短交結案：inbound backlog 排除、結案後不可收貨；cancel 指路結案", async () => {
    const before = await backlog();
    const cancel = await api(`/purchase-orders/${poId}/cancel`, {});
    expect(cancel.status).toBe(409);
    expect(cancel.json.error).toContain("結案");

    const closed = await api(`/purchase-orders/${poId}/close`, { reason: "廠商斷貨" });
    expect(closed.status).toBe(200);
    expect(closed.json.status).toBe("closed");
    expect(closed.json.closeReason).toBe("廠商斷貨");

    const after = await backlog();
    expect(before.purchase.amount - after.purchase.amount).toBe(300); // 剩餘 3 個 @100
    expect(before.purchase.count - after.purchase.count).toBe(1);

    const recv = await api(`/purchase-orders/${poId}/receive`, { docDate: "2026-07-18" });
    expect(recv.status).toBe(409);
    expect(recv.json.error).toContain("結案");
    expect(recv.json.error).toContain("到此為止");
  });

  it("短交結案的採購單：作廢其收貨進貨單後，收貨量退回但**不**翻回 open（與訂單側對稱）", async () => {
    const po = await api("/purchase-orders", {
      partnerId: supplierId,
      orderDate: "2026-07-19",
      lines: [{ productId, qty: 10, unitPrice: 100 }],
    });
    const line = (await api("/purchase-orders")).json.find((p: { id: number }) => p.id === po.json.id).lines[0];
    const recv = await api(`/purchase-orders/${po.json.id}/receive`, {
      docDate: "2026-07-19",
      lines: [{ poLineId: line.id, qty: 4 }],
    });
    expect(recv.status).toBe(201);
    expect((await api(`/purchase-orders/${po.json.id}/close`, { reason: "廠商斷貨" })).status).toBe(200);

    const voided = await api(`/purchases/${recv.json.purchaseId}/void`, { reason: "收貨單打錯" });
    expect(voided.status).toBe(200);

    const row = (await api("/purchase-orders")).json.find((p: { id: number }) => p.id === po.json.id);
    expect(row.status).toBe("closed");
    expect(row.closedAt).toBeTruthy();
    expect(row.closeReason).toBe("廠商斷貨");
    expect(Number(row.lines[0].receivedQty)).toBe(0);
    expect(row.purchaseIds).toHaveLength(0);
    const recvAgain = await api(`/purchase-orders/${po.json.id}/receive`, { docDate: "2026-07-20" });
    expect(recvAgain.status).toBe(409);
  });
});

describe("課稅別走訂單流程（零稅率整條鏈）", () => {
  let quoteId: number;
  let orderId: number;
  let saleId: number;

  it("零稅率報價：稅 0、快照 0；缺「經海關與否」422；非零稅率帶零稅率欄 422；免稅 422", async () => {
    const quote = await api("/quotes", {
      partnerId: foreignId,
      quoteDate: "2026-07-20",
      taxType: "2",
      zeroTaxViaCustoms: true,
      lines: [{ productId, qty: 5, unitPrice: 2000 }],
    });
    expect(quote.status).toBe(201);
    expect(quote.json).toMatchObject({ subtotal: 10000, tax: 0, total: 10000, taxType: "2", zeroTaxViaCustoms: true, vatRateBp: 0 });
    quoteId = quote.json.id;

    const missing = await api("/quotes", {
      partnerId: foreignId,
      quoteDate: "2026-07-20",
      taxType: "2",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    expect(missing.status).toBe(422);
    expect(missing.json.error).toContain("經海關");

    const mixed = await api("/quotes", {
      partnerId: foreignId,
      quoteDate: "2026-07-20",
      zeroTaxCertNo: "X-1",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    expect(mixed.status).toBe(422);

    const exempt = await api("/quotes", {
      partnerId: foreignId,
      quoteDate: "2026-07-20",
      taxType: "3",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    expect(exempt.status).toBe(422);
    expect(exempt.json.error).toContain("403");
  });

  it("轉訂單：課稅別三欄原樣搬、稅額整組沿用（仍為 0）", async () => {
    const order = await api(`/quotes/${quoteId}/convert`, { orderDate: "2026-07-21" });
    expect(order.status).toBe(201);
    expect(order.json).toMatchObject({ taxType: "2", zeroTaxViaCustoms: true, tax: 0, total: 10000 });
    orderId = order.json.id;
  });

  it("出貨：銷貨單帶課稅別、稅 0、缺證明文件出聲；401 零稅率經海關欄拿到金額", async () => {
    const ship = await api(`/orders/${orderId}/ship`, { docDate: "2026-07-22" });
    expect(ship.status).toBe(201);
    saleId = ship.json.saleId;
    // 證明文件（出口報單）還沒補，提醒要一路浮到出貨回應
    expect(ship.json.taxNotes.join("")).toContain("證明文件");

    const sale = await api(`/sales/${saleId}`);
    expect(sale.json).toMatchObject({ taxType: "2", zeroTaxViaCustoms: true, tax: 0, total: 10000, vatRateBp: 0 });

    const vat = await api("/vat-returns/401?period=202607");
    expect(vat.status).toBe(200);
    expect(vat.json.zeroRate.customs).toBe(10000);
    expect(vat.json.zeroRate.missingCert.count).toBe(1);
  });

  it("直接下單（不經報價）零稅率＋出貨：非經海關欄也接得到", async () => {
    const order = await api("/orders", {
      partnerId: foreignId,
      orderDate: "2026-07-23",
      taxType: "2",
      zeroTaxViaCustoms: false,
      zeroTaxCertNo: "FX-2026-0777",
      lines: [{ productId, qty: 2, unitPrice: 1500 }],
    });
    expect(order.status).toBe(201);
    expect(order.json).toMatchObject({ tax: 0, total: 3000, taxType: "2", zeroTaxViaCustoms: false });

    const ship = await api(`/orders/${order.json.id}/ship`, { docDate: "2026-07-23" });
    expect(ship.status).toBe(201);
    const sale = await api(`/sales/${ship.json.saleId}`);
    expect(sale.json).toMatchObject({ taxType: "2", zeroTaxViaCustoms: false, zeroTaxCertNo: "FX-2026-0777", tax: 0 });

    const vat = await api("/vat-returns/401?period=202607");
    expect(vat.json.zeroRate.nonCustoms).toBe(3000);
    expect(vat.json.zeroRate.total).toBe(13000);
  });

  it("應稅訂單出貨照常課稅（迴歸）：稅額由出貨日費率重算", async () => {
    const order = await api("/orders", {
      partnerId: customerId,
      orderDate: "2026-07-24",
      lines: [{ productId, qty: 1, unitPrice: 1000 }],
    });
    expect(order.json).toMatchObject({ taxType: "1", tax: 50 });
    const ship = await api(`/orders/${order.json.id}/ship`, { docDate: "2026-07-24" });
    const sale = await api(`/sales/${ship.json.saleId}`);
    expect(sale.json).toMatchObject({ taxType: "1", tax: 50, zeroTaxViaCustoms: null });
  });
});
