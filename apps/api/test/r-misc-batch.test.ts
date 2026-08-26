/**
 * R 系列雜項五件（0029 批）驗收：
 * 1. R5 供應商發票重複登錄要擋（同供應商＋同號 422；空白不擋、作廢排除、自己排除）
 * 2. R20 進項歸期吃供應商發票日期（無值退回進貨單日期並出聲）
 * 3. GET /invoices 清單瘦身（白名單、不含 xml/cancelXml；單張端點照舊）
 * 4. 字軌號碼區間重疊 422（同期別同字軌；接續與不同字軌照常 201）
 * 5. 載具／捐贈碼落地 invoices 欄位＋XML 對應（缺捐贈碼 422 且不消耗字軌號碼）
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
let supplier1Id: number;
let supplier2Id: number;
let b2cCustomerId: number;
let productId: number;

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

const mkPurchase = (partnerId: number, docDate: string, qty = 100, unitPrice = 10) =>
  api("/purchases", { partnerId, docDate, lines: [{ productId, qty, unitPrice }] });

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  auth = await setupAdmin(app);

  await app.request("/company-profile", {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      name: "測試賣方公司",
      taxId: "22099131",
      taxRegistrationNo: "123456789",
      cityCode: "A",
    }),
  });
  const s1 = await api("/partners", { name: "供應商甲", taxId: "96979933", isSupplier: true });
  supplier1Id = s1.json.id;
  const s2 = await api("/partners", { name: "供應商乙", taxId: "05004058", isSupplier: true });
  supplier2Id = s2.json.id;
  const b2c = await api("/partners", { name: "散客", isCustomer: true });
  b2cCustomerId = b2c.json.id;
  const product = await api("/products", { sku: "R-SKU-1", name: "雜項商品" });
  productId = product.json.id;
});

// ---------------------------------------------------------------- R5：供應商發票重複登錄
describe("R5：同一供應商的同一張發票號碼只能登錄一次", () => {
  let pA: number; // 供應商甲，已登錄 AB11112222
  let pB: number; // 供應商甲，第二張單
  let pC: number; // 供應商乙

  beforeAll(async () => {
    // 放在 2026-03（同期別內互不干擾 R20 的 202605/202607 斷言）
    pA = (await mkPurchase(supplier1Id, "2026-03-05")).json.id;
    pB = (await mkPurchase(supplier1Id, "2026-03-10")).json.id;
    pC = (await mkPurchase(supplier2Id, "2026-03-12")).json.id;
  });

  it("正向：登錄成功；重複登錄同號回 422 並指出已登錄在哪張單", async () => {
    const first = await api(`/purchases/${pA}/supplier-invoice`, { track: "AB", no: "11112222" }, "PATCH");
    expect(first.status).toBe(200);
    const dup = await api(`/purchases/${pB}/supplier-invoice`, { track: "AB", no: "11112222" }, "PATCH");
    expect(dup.status).toBe(422);
    expect(dup.json.error).toContain(`#${pA}`);
    expect(dup.json.error).toContain("AB11112222");
    // 撞號的那張單維持未登錄（不能半套寫入）
    const rows = await api("/purchases");
    expect(rows.json.find((p: { id: number }) => p.id === pB).invNo).toBeNull();
  });

  it("邊界：不同供應商同號不擋（號碼跨期重用是現實）；改自己的格式不換號也不擋", async () => {
    const other = await api(`/purchases/${pC}/supplier-invoice`, { track: "AB", no: "11112222" }, "PATCH");
    expect(other.status).toBe(200);
    const self = await api(
      `/purchases/${pA}/supplier-invoice`,
      { track: "AB", no: "11112222", format: "21" },
      "PATCH",
    );
    expect(self.status).toBe(200);
    expect(self.json.invFormat).toBe("21");
  });

  it("邊界：原單作廢後，同號可登錄在重開的新單上（作廢單的進項不申報）", async () => {
    const voided = await api(`/purchases/${pA}/void`, { reason: "登錯供應商，作廢重開" });
    expect(voided.status).toBe(200);
    const reuse = await api(`/purchases/${pB}/supplier-invoice`, { track: "AB", no: "11112222" }, "PATCH");
    expect(reuse.status).toBe(200);
  });
});

// ---------------------------------------------------------------- R20：進項歸期吃發票日期
describe("R20：401 進項歸期優先用供應商發票日期，無值退回進貨單日期並出聲", () => {
  it("正向：發票 6/30、進貨 7/2 → 落 202605 期，202607 期不見它", async () => {
    const p = await mkPurchase(supplier1Id, "2026-07-02", 10, 100);
    const reg = await api(
      `/purchases/${p.json.id}/supplier-invoice`,
      { track: "CD", no: "22223333", invDate: "2026-06-30" },
      "PATCH",
    );
    expect(reg.status).toBe(200);
    expect(reg.json.invDate).toBe("2026-06-30");

    const may = await api("/vat-returns/401?period=202605");
    expect(may.status).toBe(200);
    expect(may.json.summary.inputExpense).toBe(1000);
    expect(may.json.summary.inputExpenseTax).toBe(50);
    // 有登發票日期＝沒有退回，不出聲
    expect(may.json.inputDateFallback.count).toBe(0);
    expect(may.json.inputDateFallback.notes).toEqual([]);
    // 媒體檔年月＝憑證日（民國 115 年 6 月），與篩選說同一件事
    expect(may.json.mediaFile.content).toContain("11506");

    const jul = await api("/vat-returns/401?period=202607");
    expect(jul.status).toBe(200);
    expect(jul.json.summary.inputExpenseTax).toBe(0);
  });

  it("邊界（舊資料相容）：沒登發票日期 → 以進貨單日期歸期，且出聲點名那張單", async () => {
    const p = await mkPurchase(supplier2Id, "2026-07-05", 20, 100);
    await api(`/purchases/${p.json.id}/supplier-invoice`, { track: "CD", no: "33334444" }, "PATCH");

    const jul = await api("/vat-returns/401?period=202607");
    expect(jul.status).toBe(200);
    expect(jul.json.summary.inputExpense).toBe(2000);
    expect(jul.json.summary.inputExpenseTax).toBe(100);
    expect(jul.json.inputDateFallback.count).toBe(1);
    expect(jul.json.inputDateFallback.items[0].purchaseId).toBe(p.json.id);
    expect(jul.json.inputDateFallback.notes[0]).toContain(`#${p.json.id}`);
    expect(jul.json.inputDateFallback.notes[0]).toContain("進貨單日期");
  });

  it("邊界：補登發票日期時鎖的是歸期那一期——原歸期已關帳就 409", async () => {
    const p = await mkPurchase(supplier1Id, "2026-09-03", 5, 100);
    const reg = await api(
      `/purchases/${p.json.id}/supplier-invoice`,
      { track: "CD", no: "44445555", invDate: "2026-09-03" },
      "PATCH",
    );
    expect(reg.status).toBe(200);
    // 起始關帳月可任選（period.ts：尚未關過帳時本期即起始月）——直接關 2026-09
    const closed = await api("/period-closes", { period: "2026-09" });
    expect(closed.status).toBe(201);
    // 已（可能）申報過的 9 月數字不得被無聲改寫：把發票日期改到 10 月也不行（原歸期 9 月被鎖）
    const res = await api(
      `/purchases/${p.json.id}/supplier-invoice`,
      { track: "CD", no: "44445555", invDate: "2026-10-01" },
      "PATCH",
    );
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("已關帳");
    // 收尾：重開期間，別讓後面的測試被鎖擋住
    const reopened = await api("/period-closes/latest", undefined, "DELETE");
    expect(reopened.status).toBe(200);
  });
});

// ---------------------------------------------------------------- 字軌區間重疊
describe("字軌：同期別同字軌的號碼區間重疊回 422", () => {
  it("正向：建立 202609 KZ 1-50；重疊區間 30-80 被擋，訊息給接續起號", async () => {
    const first = await api("/invoice-tracks", { period: "202609", track: "KZ", rangeStart: 1, rangeEnd: 50 });
    expect(first.status).toBe(201);
    const overlap = await api("/invoice-tracks", { period: "202609", track: "KZ", rangeStart: 30, rangeEnd: 80 });
    expect(overlap.status).toBe(422);
    expect(overlap.json.error).toContain("重疊");
    expect(overlap.json.error).toContain("51"); // 指路：接續請從 rangeEnd+1 起
  });

  it("邊界：完全包住既有區間也算重疊；緊鄰接續（51 起）與不同字軌照常 201", async () => {
    const contains = await api("/invoice-tracks", { period: "202609", track: "KZ", rangeStart: 0, rangeEnd: 99 });
    expect(contains.status).toBe(422);
    const adjacent = await api("/invoice-tracks", { period: "202609", track: "KZ", rangeStart: 51, rangeEnd: 100 });
    expect(adjacent.status).toBe(201);
    const otherTrack = await api("/invoice-tracks", { period: "202609", track: "KY", rangeStart: 30, rangeEnd: 80 });
    expect(otherTrack.status).toBe(201);
    // 完全相同的區間維持 409（重按的救濟訊息），不落到 422
    const exact = await api("/invoice-tracks", { period: "202609", track: "KZ", rangeStart: 51, rangeEnd: 100 });
    expect(exact.status).toBe(409);
  });
});

// ---------------------------------------------------------------- 清單瘦身＋載具/捐贈碼
describe("GET /invoices 清單瘦身＋載具／捐贈碼落地", () => {
  let saleWithCarrier: number;
  let saleForDonate: number;
  let salePlain: number;

  beforeAll(async () => {
    await api("/invoice-tracks", { period: "202607", track: "RZ", rangeStart: 20000000, rangeEnd: 20000019 });
    const mkSale = () =>
      api("/sales", { partnerId: b2cCustomerId, docDate: "2026-07-21", lines: [{ productId, qty: 1, unitPrice: 100 }] });
    saleWithCarrier = (await mkSale()).json.id;
    saleForDonate = (await mkSale()).json.id;
    salePlain = (await mkSale()).json.id;
  });

  it("正向：帶手機條碼載具開立 → 欄位落地、XML 對應（CarrierType/CarrierId1/Id2）", async () => {
    const res = await api(`/sales/${saleWithCarrier}/invoice`, {
      mode: "B2C",
      carrier: { type: "3J0002", id1: "/ABC1234", id2: "/ABC1234" },
    });
    expect(res.status).toBe(201);
    expect(res.json.carrierType).toBe("3J0002");
    expect(res.json.carrierId).toBe("/ABC1234");
    expect(res.json.donateMark).toBe("0");
    expect(res.json.npoban).toBeNull();
    expect(res.json.xml).toContain("<CarrierType>3J0002</CarrierType>");
    expect(res.json.xml).toContain("<CarrierId1>/ABC1234</CarrierId1>");
    expect(res.json.xml).toContain("<CarrierId2>/ABC1234</CarrierId2>");
  });

  it("邊界：捐贈缺捐贈碼 422 且不消耗字軌號碼；補上捐贈碼後開立成功、XML 有 NPOBAN", async () => {
    const missing = await api(`/sales/${saleForDonate}/invoice`, { mode: "B2C", donateMark: "1" });
    expect(missing.status).toBe(422);
    expect(missing.json.error).toContain("捐贈碼");
    // 帶了捐贈碼卻沒標捐贈：兩個欄位各說各話，一樣 422
    const orphan = await api(`/sales/${saleForDonate}/invoice`, { mode: "B2C", npoban: "919" });
    expect(orphan.status).toBe(422);

    const ok = await api(`/sales/${saleForDonate}/invoice`, { mode: "B2C", donateMark: "1", npoban: "919" });
    expect(ok.status).toBe(201);
    // 上面兩次 422 都發生在配號之前：號碼必須緊接著上一張（20000001），一個都沒被燒掉
    expect(ok.json.invoiceNumber).toBe("RZ20000001");
    expect(ok.json.donateMark).toBe("1");
    expect(ok.json.npoban).toBe("919");
    expect(ok.json.xml).toContain("<DonateMark>1</DonateMark>");
    expect(ok.json.xml).toContain("<NPOBAN>919</NPOBAN>");
  });

  it("清單白名單：查得到載具／捐贈欄，但不含 xml/cancelXml；未帶載具維持現行預設", async () => {
    const plain = await api(`/sales/${salePlain}/invoice`, { mode: "B2C" });
    expect(plain.status).toBe(201);

    const list = await api("/invoices");
    expect(list.status).toBe(200);
    const rows = list.json as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row).not.toHaveProperty("xml");
      expect(row).not.toHaveProperty("cancelXml");
    }
    const byNumber = new Map(rows.map((r) => [r["invoiceNumber"], r]));
    const carrierRow = byNumber.get("RZ20000000")!;
    expect(carrierRow["carrierType"]).toBe("3J0002");
    expect(carrierRow["carrierId"]).toBe("/ABC1234");
    const donateRow = byNumber.get("RZ20000001")!;
    expect(donateRow["donateMark"]).toBe("1");
    expect(donateRow["npoban"]).toBe("919");
    // 未帶載具＝現行行為（紙本證明聯）：donate_mark '0'、載具欄空、printMark 維持 N（B2C 預設）
    const plainRow = byNumber.get("RZ20000002")!;
    expect(plainRow["carrierType"]).toBeNull();
    expect(plainRow["donateMark"]).toBe("0");
    expect(plainRow["npoban"]).toBeNull();
    expect(plainRow["printMark"]).toBe("N");

    // XML 本體走單張端點（清單瘦身不是拿掉能力）：內容就是開立當下落地的那份
    const single = await app.request(`/invoices/${carrierRow["id"]}/xml`, { headers: auth });
    expect(single.status).toBe(200);
    expect(await single.text()).toContain("<CarrierType>3J0002</CarrierType>");
  });
});

// ---------------------------------------------------------------- R5 報銷側（第三批雜項 ④）
// 進項稅重複列報的另一半：expense_items 登錄發票號碼時查 purchases 與 expense_items 兩邊。
// 放行的例外照進貨側（0029）的模式：作廢進貨單／退回報銷單不算數；
// 兩邊賣方統編都有值且不同＝跨期重用的同號發票，不擋
describe("R5 報銷側：發票號碼查重（purchases 與 expense_items 兩邊）", () => {
  let employeeId: number;

  const mkClaim = (items: Record<string, unknown>[], claimDate = "2026-03-20") =>
    api("/expense-claims", { employeeId, claimDate, items });
  const item = (invoiceNumber: string, sellerTaxId?: string) => ({
    accountCode: "6137",
    docType: "einvoice" as const,
    amount: 1050,
    ...(sellerTaxId ? { deductible: true, sellerTaxId } : {}),
    invoiceNumber,
  });

  beforeAll(async () => {
    employeeId = (await api("/employees", { name: "報銷員" })).json.id;
  });

  it("同一張報銷單裡同號出現兩次 422（四筆同號＝進項稅被算四遍的實測缺口）", async () => {
    const res = await mkClaim([item("EF11110000"), item("EF11110000")]);
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("EF11110000");
    expect(res.json.error).toContain("出現兩次");
  });

  it("撞進貨單：已登錄在進貨單的號碼 422 並指出撞到哪張；不同賣方統編放行", async () => {
    // CD22223333 已登錄在供應商甲（96979933）的進貨單上（R20 測試建的）
    const purchases = (await api("/purchases")).json;
    const holder = purchases.find((p: { invTrack: string | null; invNo: string | null }) => p.invTrack === "CD" && p.invNo === "22223333");
    const blind = await mkClaim([item("CD22223333")]); // 沒填賣方統編＝無從分辨 → 擋
    expect(blind.status).toBe(422);
    expect(blind.json.error).toContain(`進貨單 #${holder.id}`);
    const same = await mkClaim([item("CD22223333", "96979933")]); // 同賣方＝同一張紙 → 擋
    expect(same.status).toBe(422);
    const other = await mkClaim([item("CD22223333", "04541302")]); // 不同賣方＝跨期重用 → 放行
    expect(other.status).toBe(201);
  });

  it("撞既有報銷：422 並指出撞到哪張報銷單；退回（rejected）的報銷單放行", async () => {
    const first = await mkClaim([item("EF55667788", "96979933")]);
    expect(first.status).toBe(201);
    const dup = await mkClaim([item("EF55667788", "96979933")]);
    expect(dup.status).toBe(422);
    expect(dup.json.error).toContain(`報銷單 #${first.json.id}`);
    // 退回第一張（登錯了）之後，同號可以重新報——與進貨側「作廢重開沿用同號」同一條出路
    const rejected = await api(`/expense-claims/${first.json.id}/reject`, { reason: "發票登錯，退回重報" });
    expect(rejected.status).toBe(200);
    const again = await mkClaim([item("EF55667788", "96979933")]);
    expect(again.status).toBe(201);
  });

  it("作廢進貨單的號碼放行（作廢單的進項不申報，同號重開是正常出路）", async () => {
    const p = await mkPurchase(supplier1Id, "2026-03-25");
    await api(`/purchases/${p.json.id}/supplier-invoice`, { track: "GH", no: "99990000" }, "PATCH");
    // 未作廢時擋（同賣方）
    expect((await mkClaim([item("GH99990000", "96979933")])).status).toBe(422);
    await api(`/purchases/${p.json.id}/void`, { reason: "登錯，作廢重開" });
    // 作廢後放行
    expect((await mkClaim([item("GH99990000", "96979933")])).status).toBe(201);
  });

  // ---- R5 反向（第四批）：先走報銷、再登進貨——PATCH /purchases/:id/supplier-invoice
  // 反向查 expense_items 的既有號碼。放行條件與報銷側鏡像：退回的報銷單不算；
  // 兩邊賣方統編都有值且不同＝跨期重用的同號，不擋
  it("反向：進貨登錄撞既有報銷 422 並指出報銷單；退回該報銷後放行", async () => {
    const claim = await mkClaim([item("JK12341234", "96979933")]);
    expect(claim.status).toBe(201);
    const p = await mkPurchase(supplier1Id, "2026-03-26"); // 供應商甲統編 96979933＝同賣方 → 擋
    const dup = await api(`/purchases/${p.json.id}/supplier-invoice`, { track: "JK", no: "12341234" }, "PATCH");
    expect(dup.status).toBe(422);
    expect(dup.json.error).toContain(`報銷單 #${claim.json.id}`);
    expect(dup.json.error).toContain("JK12341234");
    // 撞號的進貨單維持未登錄（不能半套寫入）
    const rows = await api("/purchases");
    expect(rows.json.find((row: { id: number }) => row.id === p.json.id).invNo).toBeNull();
    // 退回報銷單（登錯了）後同號可登進貨——與報銷側同一條出路
    expect((await api(`/expense-claims/${claim.json.id}/reject`, { reason: "其實是進貨，退回" })).status).toBe(200);
    expect((await api(`/purchases/${p.json.id}/supplier-invoice`, { track: "JK", no: "12341234" }, "PATCH")).status).toBe(200);
  });

  it("反向：兩邊賣方統編都有值且不同＝跨期重用，放行；報銷未填統編＝無從分辨，擋", async () => {
    // 報銷登了別家賣方（04541302）的 JK55556666 → 供應商甲（96979933）登同號可放行
    expect((await mkClaim([item("JK55556666", "04541302")])).status).toBe(201);
    const p1 = await mkPurchase(supplier1Id, "2026-03-27");
    expect((await api(`/purchases/${p1.json.id}/supplier-invoice`, { track: "JK", no: "55556666" }, "PATCH")).status).toBe(200);
    // 報銷沒填賣方統編 → 無從分辨 → 擋（訊息指路補統編）
    const blind = await mkClaim([item("JK77778888")]);
    expect(blind.status).toBe(201);
    const p2 = await mkPurchase(supplier1Id, "2026-03-28");
    const blocked = await api(`/purchases/${p2.json.id}/supplier-invoice`, { track: "JK", no: "77778888" }, "PATCH");
    expect(blocked.status).toBe(422);
    expect(blocked.json.error).toContain("賣方統編");
  });
});
