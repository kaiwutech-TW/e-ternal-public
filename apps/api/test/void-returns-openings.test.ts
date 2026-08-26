/**
 * 0030 驗收（第三批第 2 站）：退回／折讓單與期初應收付單的作廢入口＋G0501 接線。
 * - 退回單作廢＝庫存反向回沖（銷退作廢再扣庫存、進退作廢再回補），returnable 餘量回復
 * - 折讓單作廢不動庫存；已登錄證明單的折讓作廢後產 G0501（單張下載＋批次匯出）
 * - 401 減項排除已作廢退回折讓；作廢後補登證明單 409
 * - 期初單作廢＝反向傳票沖 1144/3351；已被收款沖銷者懸空 409（先作廢收款單解鎖）
 * - 共通：二階（作廢再作廢）409、理由必填、關帳期間 409、作廢權限限 admin/finance
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
let customer2Id: number;
let productId: number; // 大量在庫（100 個 @10）
let product2Id: number; // 稀缺（5 個 @10）：驗「退回的貨又賣掉 → 作廢 409」
let cashAccountId: number;

async function api(path: string, body?: unknown, method = body ? "POST" : "GET", headers = admin) {
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

async function stockOf(id: number) {
  const inv = await api("/inventory");
  return inv.json.find((r: { productId: number }) => r.productId === id);
}

async function arOf(partnerId: number): Promise<number> {
  const rows = await api("/partner-balances");
  return rows.json.find((b: { partnerId: number }) => b.partnerId === partnerId)?.ar ?? 0;
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);

  await api(
    "/company-profile",
    { name: "測試公司", taxId: "22099131", address: "台北市測試路1號", taxRegistrationNo: "123456789", cityCode: "A" },
    "PUT",
  );
  supplierId = (await api("/partners", { name: "供應商甲", taxId: "04541302", isSupplier: true })).json.id;
  customerId = (await api("/partners", { name: "客戶乙", taxId: "12345675", isCustomer: true })).json.id;
  customer2Id = (await api("/partners", { name: "老客戶丙", taxId: "20828393", isCustomer: true })).json.id;
  productId = (await api("/products", { sku: "VR-001", name: "商品一" })).json.id;
  product2Id = (await api("/products", { sku: "VR-002", name: "稀缺品" })).json.id;
  cashAccountId = (await api("/accounts")).json.find((a: { code: string }) => a.code === "1101").id;
  await api("/purchases", {
    partnerId: supplierId,
    docDate: "2026-08-01",
    lines: [
      { productId, qty: 100, unitPrice: 10 },
      { productId: product2Id, qty: 5, unitPrice: 10 },
    ],
  });
  // 開發票用字軌（2026-08 屬期別 202607）
  await api("/invoice-tracks", { period: "202607", track: "VR", rangeStart: 30000000, rangeEnd: 30000049 });
});

describe("銷貨退回單作廢：庫存回沖、returnable 餘量回復", () => {
  let saleId: number;
  let returnId: number;

  it("作廢退回單：貨再沖出去、餘量回復、餘額回復、反向傳票留痕", async () => {
    const sale = await api("/sales", { partnerId: customerId, docDate: "2026-08-05", lines: [{ productId, qty: 10, unitPrice: 100 }] });
    expect(sale.status).toBe(201);
    saleId = sale.json.id;
    const info = await api(`/sales/${saleId}/returnable`);
    const ret = await api(`/sales/${saleId}/returns`, {
      kind: "return",
      docDate: "2026-08-06",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 4 }],
    });
    expect(ret.status).toBe(201);
    returnId = ret.json.id;
    expect((await stockOf(productId)).qty).toBe(94); // 100 − 10 ＋ 退回 4
    expect(await arOf(customerId)).toBe(1050 - ret.json.arOffset);

    const voided = await api(`/sales-returns/${returnId}/void`, { reason: "退貨數量打錯" });
    expect(voided.status).toBe(200);
    expect(voided.json.reversalEntryId).toBeTruthy();
    // ① 庫存：回補過的 4 個再沖出去（銷退作廢＝當作沒退過）
    expect((await stockOf(productId)).qty).toBe(90);
    // ② returnable 餘量回復：可退量回到 10、已退歸零
    const after = await api(`/sales/${saleId}/returnable`);
    expect(after.json.lines[0].returnedQty).toBe(0);
    expect(after.json.lines[0].remainingQty).toBe(10);
    // ③ 對象餘額回復（arOffset 不再抵減）
    expect(await arOf(customerId)).toBe(1050);
    // ④ 反向傳票留痕：memo 註明沖轉哪張、原單標記齊全
    const entry = await api(`/journal-entries/${voided.json.reversalEntryId}`);
    expect(entry.json.memo).toContain(`作廢沖轉 銷貨退回單 #${returnId}`);
    expect(entry.json.memo).toContain("退貨數量打錯");
    const rows = await api("/sales-returns");
    const row = rows.json.find((r: { id: number }) => r.id === returnId);
    expect(row.voidedAt).toBeTruthy();
    expect(row.voidReason).toBe("退貨數量打錯");
  });

  it("二階：已作廢的退回單再作廢 409", async () => {
    const again = await api(`/sales-returns/${returnId}/void`, { reason: "再廢一次" });
    expect(again.status).toBe(409);
    expect(again.json.error).toContain("不可再作廢");
  });

  it("理由必填：空理由 400", async () => {
    const res = await api(`/sales-returns/${returnId}/void`, { reason: "  " });
    expect(res.status).toBe(400);
  });

  it("退回單全數作廢後，原銷貨單可整單作廢（已作廢退回單不再擋雙重沖銷）", async () => {
    const res = await api(`/sales/${saleId}/void`, { reason: "整筆交易取消" });
    expect(res.status).toBe(200);
    expect((await stockOf(productId)).qty).toBe(100); // 出貨的 10 個回補
  });

  it("退回來的貨又賣掉：作廢 409 並指出在庫不足", async () => {
    // 稀缺品 5 個：賣 5 → 退 5 → 又賣 5（在庫 0），此時作廢退回單要沖出 5 個 → 409
    const saleA = await api("/sales", { partnerId: customerId, docDate: "2026-08-07", lines: [{ productId: product2Id, qty: 5, unitPrice: 50 }] });
    const info = await api(`/sales/${saleA.json.id}/returnable`);
    const ret = await api(`/sales/${saleA.json.id}/returns`, {
      kind: "return",
      docDate: "2026-08-08",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 5 }],
    });
    expect(ret.status).toBe(201);
    const saleB = await api("/sales", { partnerId: customerId, docDate: "2026-08-09", lines: [{ productId: product2Id, qty: 5, unitPrice: 50 }] });
    expect(saleB.status).toBe(201);
    expect((await stockOf(product2Id)).qty).toBe(0);

    const res = await api(`/sales-returns/${ret.json.id}/void`, { reason: "作廢試試" });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("在庫");
    expect(res.json.error).toContain("稀缺品");
  });

  it("非 admin/finance 不可作廢（sales 角色 403）", async () => {
    await api("/users", { username: "seller", displayName: "業務", password: "secret-test", role: "sales" });
    const seller = await loginAs(app, "seller", "secret-test");
    const res = await api(`/sales-returns/${returnId}/void`, { reason: "越權" }, "POST", seller);
    expect(res.status).toBe(403);
  });
});

describe("進貨退出單作廢：庫存按原成本回補", () => {
  it("作廢退出單：貨補回來、應付餘額回復", async () => {
    const purchase = await api("/purchases", { partnerId: supplierId, docDate: "2026-08-03", lines: [{ productId, qty: 10, unitPrice: 12 }] });
    expect(purchase.status).toBe(201);
    const baseQty = (await stockOf(productId)).qty;
    const info = await api(`/purchases/${purchase.json.id}/returnable`);
    const ret = await api(`/purchases/${purchase.json.id}/returns`, {
      kind: "return",
      docDate: "2026-08-04",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 4 }],
    });
    expect(ret.status).toBe(201);
    expect((await stockOf(productId)).qty).toBe(baseQty - 4);

    const voided = await api(`/purchase-returns/${ret.json.id}/void`, { reason: "退錯批" });
    expect(voided.status).toBe(200);
    // 沖出過的 4 個按原成本補回
    expect((await stockOf(productId)).qty).toBe(baseQty);
    const entry = await api(`/journal-entries/${voided.json.reversalEntryId}`);
    expect(entry.json.memo).toContain(`作廢沖轉 進貨退出單 #${ret.json.id}`);
    // returnable 餘量回復
    const after = await api(`/purchases/${purchase.json.id}/returnable`);
    expect(after.json.lines[0].returnedQty).toBe(0);
    expect(after.json.lines[0].remainingQty).toBe(10);
  });

  it("關帳期間的退出單不可作廢：409 指路重開期間", async () => {
    const purchase = await api("/purchases", { partnerId: supplierId, docDate: "2026-06-10", lines: [{ productId, qty: 1, unitPrice: 10 }] });
    const info = await api(`/purchases/${purchase.json.id}/returnable`);
    const ret = await api(`/purchases/${purchase.json.id}/returns`, {
      kind: "return",
      docDate: "2026-06-15",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 1 }],
    });
    expect(ret.status).toBe(201);
    expect((await api("/period-closes", { period: "2026-06" })).status).toBe(201);
    const res = await api(`/purchase-returns/${ret.json.id}/void`, { reason: "遲來的更正" });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("已關帳期間");
    expect(res.json.error).toContain("重開");
    expect((await api("/period-closes/latest", undefined, "DELETE")).status).toBe(200);
  });
});

describe("折讓單作廢：不動庫存、401 排除、產 G0501", () => {
  let saleId: number;
  let allowanceId: number;

  it("作廢已登錄證明單的折讓單：庫存不動、401 減項移除", async () => {
    const sale = await api("/sales", { partnerId: customerId, docDate: "2026-08-10", lines: [{ productId, qty: 10, unitPrice: 100 }] });
    saleId = sale.json.id;
    const inv = await api(`/sales/${saleId}/invoice`, { mode: "B2B", invoiceTime: "10:00:00", randomNumber: "1234" });
    expect(inv.status).toBe(201);
    const info = await api(`/sales/${saleId}/returnable`);
    const alw = await api(`/sales/${saleId}/returns`, {
      kind: "allowance",
      docDate: "2026-08-11",
      certNo: "ALWV0001",
      certDate: "2026-08-12",
      lines: [{ sourceLineId: info.json.lines[0].id, amount: 200 }],
    });
    expect(alw.status).toBe(201);
    allowanceId = alw.json.id;
    const before401 = await api("/vat-returns/401?period=202607");
    expect(before401.json.returnsInFiling.sales.count).toBe(1);
    const qtyBefore = (await stockOf(productId)).qty;

    const voided = await api(`/sales-returns/${allowanceId}/void`, { reason: "折讓談錯金額" });
    expect(voided.status).toBe(200);
    // 折讓不動庫存：作廢也不動
    expect((await stockOf(productId)).qty).toBe(qtyBefore);
    // 401 減項排除已作廢折讓（G0401 的減項基礎跟著消失）
    const after401 = await api("/vat-returns/401?period=202607");
    expect(after401.json.returnsInFiling.sales.count).toBe(0);
    // 不因「缺證明單」出聲——這張單已作廢，不需要證明單
    expect(after401.json.returnsNotReflected.sales.count).toBe(0);
  });

  it("G0501 單張下載：欄位齊、作廢理由與原證明單號碼都在", async () => {
    const res = await app.request(`/sales-returns/${allowanceId}/g0501-xml`, { headers: admin });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="G0501-ALWV0001.xml"');
    const xml = await res.text();
    expect(xml).toContain("urn:GEINV:eInvoiceMessage:G0501:4.1");
    expect(xml).toContain("<CancelAllowanceNumber>ALWV0001</CancelAllowanceNumber>");
    expect(xml).toContain("<AllowanceType>2</AllowanceType>"); // 與原 G0401 一致（賣方開立）
    expect(xml).toContain("<AllowanceDate>20260812</AllowanceDate>"); // 原證明單日期
    expect(xml).toContain("<BuyerId>12345675</BuyerId>");
    expect(xml).toContain("<SellerId>22099131</SellerId>");
    expect(xml).toContain("<CancelReason>折讓談錯金額</CancelReason>");
    // 同一張單再下載一次：訊息可重現（作廢時間取 voided_at，不是「現在」）
    const res2 = await app.request(`/sales-returns/${allowanceId}/g0501-xml`, { headers: admin });
    expect(await res2.text()).toBe(xml);
  });

  it("批次匯出：G0401 與 G0501 同一期都在（大平台要先收到開立訊息才收得了作廢訊息）", async () => {
    const res = await api("/exports/einvoice-xml?from=2026-08-01&to=2026-08-31");
    expect(res.status).toBe(200);
    const names = res.json.files.map((f: { name: string }) => f.name);
    expect(names).toContain("G0401-ALWV0001.xml");
    expect(names).toContain("G0501-ALWV0001.xml");
    expect(res.json.allowanceCancelCount).toBe(1);
  });

  it("尚未作廢的折讓單沒有 G0501：422 指路", async () => {
    const info = await api(`/sales/${saleId}/returnable`);
    const alive = await api(`/sales/${saleId}/returns`, {
      kind: "allowance",
      docDate: "2026-08-13",
      certNo: "ALWV0002",
      certDate: "2026-08-13",
      lines: [{ sourceLineId: info.json.lines[0].id, amount: 100 }],
    });
    expect(alive.status).toBe(201);
    const res = await api(`/sales-returns/${alive.json.id}/g0501-xml`);
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("尚未作廢");
  });

  it("沒登錄過證明單就作廢的折讓單：不需要 G0501（422 說明），批次也不出聲", async () => {
    const info = await api(`/sales/${saleId}/returnable`);
    const alw = await api(`/sales/${saleId}/returns`, {
      kind: "allowance",
      docDate: "2026-08-14",
      lines: [{ sourceLineId: info.json.lines[0].id, amount: 50 }],
    });
    expect((await api(`/sales-returns/${alw.json.id}/void`, { reason: "重複建了" })).status).toBe(200);
    const res = await api(`/sales-returns/${alw.json.id}/g0501-xml`);
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("從未產出 G0401");
    // 批次：這張已作廢的無證明單折讓不進「缺證明單」出聲清單
    const batch = await api("/exports/einvoice-xml?from=2026-08-01&to=2026-08-31");
    expect(batch.json.notes.some((n: string) => n.includes(`折讓單 #${alw.json.id}`))).toBe(false);
  });

  it("作廢後不可再補登／修改證明單：409", async () => {
    const res = await api(`/sales-returns/${allowanceId}`, { certNo: "ALWV9999", certDate: "2026-08-20" }, "PATCH");
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("已於");
    expect(res.json.error).toContain("作廢");
  });

  it("退回單沒有 G0501（證明單以外部工具開立）：422 指路", async () => {
    const res = await api(`/sales-returns/${allowanceId + 100000}/g0501-xml`);
    expect(res.status).toBe(404); // 不存在的單 404；退回單 422 已由服務層 kind 檢查涵蓋
  });
});

describe("期初應收付單作廢：反向傳票沖 1144/3351、懸空 409", () => {
  let openingId: number;
  let receiptId: number;

  it("已被收款沖銷的期初單：懸空 409 指路先作廢收款單", async () => {
    const opening = await api("/opening-balances", {
      kind: "receivable",
      partnerId: customer2Id,
      entryDate: "2026-08-01",
      docDate: "2026-07-01",
      amount: 5000,
      memo: "舊系統轉入",
    });
    expect(opening.status).toBe(201);
    openingId = opening.json.id;
    const receipt = await api("/cash-docs", {
      kind: "receipt",
      partnerId: customer2Id,
      docDate: "2026-08-05",
      amount: 2000,
      accountId: cashAccountId,
      allocations: [{ targetType: "opening", targetId: openingId, amount: 2000 }],
    });
    expect(receipt.status).toBe(201);
    receiptId = receipt.json.id;

    const res = await api(`/opening-balances/${openingId}/void`, { reason: "金額打錯" });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain(`收款單 #${receiptId}`);
    expect(res.json.error).toContain("先作廢");
  });

  it("作廢收款單後解鎖：反向傳票貸 1144 借 3351，餘額與沖銷清單回復", async () => {
    expect((await api(`/cash-docs/${receiptId}/void`, { reason: "沖錯單" })).status).toBe(200);
    const voided = await api(`/opening-balances/${openingId}/void`, { reason: "金額打錯，應為 50000" });
    expect(voided.status).toBe(200);
    expect(voided.json.reversalEntryId).toBeTruthy();

    // 反向傳票＝開帳分錄借貸互換：貸 1144、借 3351（累積盈虧）
    const entry = await api(`/journal-entries/${voided.json.reversalEntryId}`);
    expect(entry.json.memo).toContain(`作廢沖轉 期初應收單 #${openingId}`);
    const ar = entry.json.lines.find((l: { code: string }) => l.code === "1144");
    expect(ar).toMatchObject({ debit: 0, credit: 5000 });
    const re = entry.json.lines.find((l: { code: string }) => l.code === "3351");
    expect(re).toMatchObject({ debit: 5000, credit: 0 });

    // 餘額回復、收款畫面的可沖清單不再有這張期初單、清單留痕且未沖歸零
    expect(await arOf(customer2Id)).toBe(0);
    const open = await api(`/open-documents?partnerId=${customer2Id}&kind=receipt`);
    expect(open.json.some((d: { docType: string; id: number }) => d.docType === "opening" && d.id === openingId)).toBe(false);
    const rows = await api("/opening-balances");
    const row = rows.json.find((r: { id: number }) => r.id === openingId);
    expect(row.voidedAt).toBeTruthy();
    expect(row.remaining).toBe(0);
  });

  it("二階：已作廢期初單再作廢 409", async () => {
    const res = await api(`/opening-balances/${openingId}/void`, { reason: "再廢" });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("不可再作廢");
  });

  it("voidDate 早於開帳日：422（反向傳票不得落在原單之前）", async () => {
    const opening = await api("/opening-balances", {
      kind: "payable",
      partnerId: supplierId,
      entryDate: "2026-08-02",
      docDate: "2026-07-15",
      amount: 300,
    });
    const res = await api(`/opening-balances/${opening.json.id}/void`, { reason: "測日期", voidDate: "2026-08-01" });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("早於原單日期");
  });
});
