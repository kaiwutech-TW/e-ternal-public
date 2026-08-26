/**
 * B10＋B11 驗收：401 的「算錯稅三件套」。
 * - B10 進項憑證分類：扣抵代號 3/4 不進可扣抵合計（只寫媒體檔明細）、
 *   格式 21/22 落申報書「統一發票扣抵聯」欄（28-31）而非電子發票欄（32-35）。
 * - B11a 上期累積留抵：申報紀錄（vat_returns）承轉、人工覆寫、第一次申報預設 0 且出聲。
 * - B11b 退回折讓減項：有證明單的才列入（歸期依證明單日期）、缺證明單的留在警示；
 *   PATCH 補登證明單後重新產出即列入。
 * - B11c 申報人／委託記帳士：company_profile → 申報書第 98-104 欄；
 *   申報人身分證號是 PII——不進 GET /company-profile，一般明文限財務／管理者。
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { encodeS9 } from "@tw-erp/vat";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { loginAs, setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let admin: Record<string, string>;
let salesUser: Record<string, string>;
let supplierId: number;
let b2bId: number;
let productId: number;

async function api(path: string, body?: unknown, method = body ? "POST" : "GET", headers = admin) {
  const res = await app.request(path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json() };
}

/** 建進貨單並登錄供應商發票（格式×代號由參數指定） */
async function purchaseWithInvoice(
  docDate: string,
  qty: number,
  unitPrice: number,
  no: string,
  format: string,
  deductionCode: string,
) {
  const p = await api("/purchases", {
    partnerId: supplierId,
    docDate,
    lines: [{ productId, qty, unitPrice }],
  });
  expect(p.status).toBe(201);
  const reg = await api(
    `/purchases/${p.json.id}/supplier-invoice`,
    { track: "AB", no, format, deductionCode },
    "PATCH",
  );
  expect(reg.status).toBe(200);
  return p.json as { id: number; subtotal: number; tax: number };
}

async function saleWithInvoice(docDate: string, qty: number, unitPrice: number, randomNumber: string) {
  const s = await api("/sales", { partnerId: b2bId, docDate, lines: [{ productId, qty, unitPrice }] });
  expect(s.status).toBe(201);
  const inv = await api(`/sales/${s.json.id}/invoice`, { mode: "B2B", randomNumber });
  expect(inv.status).toBe(201);
  return s.json as { id: number; subtotal: number; tax: number };
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);
  await api("/users", { username: "sal", displayName: "業務", password: "secret-test", role: "sales" });
  salesUser = await loginAs(app, "sal", "secret-test");

  await api(
    "/company-profile",
    {
      name: "測試賣方公司",
      taxId: "22099131",
      taxRegistrationNo: "123456789",
      cityCode: "A",
      filerName: "王申報",
      filerIdNo: "A123456789",
      filerAreaCode: "02",
      filerPhone: "12345678",
      filerExt: "9",
    },
    "PUT",
  );

  supplierId = (await api("/partners", { name: "供應商", taxId: "96979933", isSupplier: true })).json.id;
  b2bId = (await api("/partners", { name: "企業客戶", taxId: "04541302", isCustomer: true })).json.id;
  productId = (await api("/products", { sku: "SKU-401", name: "商品" })).json.id;

  await api("/invoice-tracks", { period: "202607", track: "KA", rangeStart: 10000000, rangeEnd: 10000099 });
  await api("/invoice-tracks", { period: "202609", track: "KB", rangeStart: 20000000, rangeEnd: 20000099 });

  // ── 202607 期（B10 的進項分桶＋留抵鏈的第一期）──
  // 進項六張先建（銷貨要有庫存）：格式（25 電子／21 紙本）× 代號（1 費用／2 固資／3、4 不可扣抵）
  await purchaseWithInvoice("2026-07-01", 100, 10, "11110001", "25", "1"); // 1000/50
  await purchaseWithInvoice("2026-07-02", 70, 100, "11110002", "21", "1"); // 7000/350 → 紙本欄
  await purchaseWithInvoice("2026-07-03", 2, 10000, "11110003", "25", "2"); // 20000/1000 → 固資
  await purchaseWithInvoice("2026-07-04", 3, 1000, "11110004", "21", "2"); // 3000/150 → 紙本固資
  await purchaseWithInvoice("2026-07-05", 4, 1000, "11110005", "25", "3"); // 4000/200 → 不可扣抵
  await purchaseWithInvoice("2026-07-06", 2, 1000, "11110006", "25", "4"); // 2000/100 → 不可扣抵固資
  // 銷項：10000/500
  await saleWithInvoice("2026-07-10", 10, 1000, "0001");
});

describe("B10：進項憑證分類", () => {
  it("扣抵代號 3/4 不進任何可扣抵合計，排除清單看得到", async () => {
    const res = await api("/vat-returns/401?period=202607");
    expect(res.status).toBe(200);
    // 可扣抵：費用 1000+7000、固資 20000+3000；不可扣抵的 6000/300 完全不在其中
    expect(res.json.summary).toMatchObject({
      inputExpense: 8000,
      inputExpenseTax: 400,
      inputFixedAsset: 23000,
      inputFixedAssetTax: 1150,
      deductibleInputTaxTotal: 1550,
    });
    expect(res.json.nonDeductible).toMatchObject({ count: 2, amount: 6000, tax: 300 });
    const codes = res.json.nonDeductible.items.map((i: { deductionCode: string }) => i.deductionCode).sort();
    expect(codes).toEqual(["3", "4"]);
  });

  it("媒體檔：六張進項逐筆都在（含不可扣抵），格式與扣抵代號照登錄值", async () => {
    const res = await api("/vat-returns/401?period=202607");
    const lines: string[] = res.json.mediaFile.content.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(7); // 1 銷項 + 6 進項
    const inputLines = lines.filter((l) => l.slice(0, 2) !== "35");
    expect(inputLines).toHaveLength(6);
    // 格式代號在第 1-2 碼、扣抵代號在第 73 碼
    const pairs = inputLines.map((l) => `${l.slice(0, 2)}/${l[72]}`).sort();
    expect(pairs).toEqual(["21/1", "21/2", "25/1", "25/2", "25/3", "25/4"]);
  });

  it("申報書：紙本（21）落統一發票扣抵聯欄（序 50/51/60/61），電子（25）落 32-35 欄", async () => {
    const res = await api("/vat-returns/401?period=202607");
    const f: string[] = res.json.returnFile.content.trimEnd().split("|");
    expect(f[49]).toBe(encodeS9(7000, 12)); // 序50 統一發票扣抵聯-進貨費用(28)
    expect(f[50]).toBe(encodeS9(3000, 12)); // 序51 統一發票扣抵聯-固資(30)
    expect(f[51]).toBe(encodeS9(1000, 12)); // 序52 電子發票-進貨費用(32)
    expect(f[52]).toBe(encodeS9(20000, 12)); // 序53 電子發票-固資(34)
    expect(f[59]).toBe(encodeS9(350, 10)); // 序60 稅額(29)
    expect(f[60]).toBe(encodeS9(150, 10)); // 序61 稅額(31)
    expect(f[61]).toBe(encodeS9(50, 10)); // 序62 稅額(33)
    expect(f[62]).toBe(encodeS9(1000, 10)); // 序63 稅額(35)
    expect(f[86]).toBe(encodeS9(1550, 10)); // 序87 得扣抵進項稅額合計(107)——不含 3/4 的 300
  });
});

describe("B11c：申報人與委託記帳士", () => {
  it("申報人五欄進申報書；未填代理字號＝自行申報（序 98=1）", async () => {
    const res = await api("/vat-returns/401?period=202607");
    const f: string[] = res.json.returnFile.content.trimEnd().split("|");
    expect(f[97]).toBe("1");
    expect(f[98]).toBe("A123456789");
    expect(f[99]).toBe("王申報");
    expect(f[100]).toBe("02");
    expect(f[101]).toBe("12345678");
    expect(f[102]).toBe("9");
    expect(f[103]).toBe("");
    expect(res.json.filer).toMatchObject({ name: "王申報", hasIdNo: true, selfFiled: true });
  });

  it("填了委託記帳士登錄字號 → 序 98=2、序 104=字號", async () => {
    const put = await api(
      "/company-profile",
      {
        name: "測試賣方公司",
        taxId: "22099131",
        taxRegistrationNo: "123456789",
        cityCode: "A",
        filerName: "王申報",
        declarationAgentNo: "REG-12345",
      },
      "PUT",
    );
    expect(put.status).toBe(200);
    const res = await api("/vat-returns/401?period=202607");
    const f: string[] = res.json.returnFile.content.trimEnd().split("|");
    expect(f[97]).toBe("2");
    expect(f[103]).toBe("REG-12345");
    expect(res.json.filer.selfFiled).toBe(false);
    // 清空（空字串）→ 回到自行申報
    await api(
      "/company-profile",
      { name: "測試賣方公司", taxId: "22099131", taxRegistrationNo: "123456789", cityCode: "A", declarationAgentNo: "" },
      "PUT",
    );
    const back = await api("/vat-returns/401?period=202607");
    expect(back.json.returnFile.content.trimEnd().split("|")[97]).toBe("1");
  });

  it("PII：GET /company-profile 不含身分證明文、明文端點限財務／管理者", async () => {
    const profile = await api("/company-profile");
    expect(profile.status).toBe(200);
    expect(JSON.stringify(profile.json)).not.toContain("A123456789");
    expect(profile.json.hasFilerIdNo).toBe(true);
    expect(profile.json.filerIdNo).toBeUndefined();

    const mine = await api("/company-profile/filer-id-no");
    expect(mine.status).toBe(200);
    expect(mine.json.filerIdNo).toBe("A123456789");

    const forbidden = await api("/company-profile/filer-id-no", undefined, "GET", salesUser);
    expect(forbidden.status).toBe(403);
  });

  it("PUT 未帶 filerIdNo＝保留既有值；DELETE 專用端點才清空", async () => {
    // 上一個測試的 PUT 都沒帶 filerIdNo，明文應該還在
    const still = await api("/company-profile/filer-id-no");
    expect(still.json.filerIdNo).toBe("A123456789");
    const del = await api("/company-profile/filer-id-no", undefined, "DELETE");
    expect(del.status).toBe(200);
    expect(del.json.hasFilerIdNo).toBe(false);
    // 補回去給後面的期別用
    await api(
      "/company-profile",
      {
        name: "測試賣方公司",
        taxId: "22099131",
        taxRegistrationNo: "123456789",
        cityCode: "A",
        filerName: "王申報",
        filerIdNo: "A123456789",
      },
      "PUT",
    );
  });
});

describe("B11a：上期累積留抵的承轉", () => {
  it("第一次申報沒有上期紀錄：預設 0 且回應出聲", async () => {
    const res = await api("/vat-returns/401?period=202607");
    expect(res.json.carryover).toMatchObject({ prevPeriod: "202605", prevCarryForward: 0, source: "none" });
    expect(res.json.carryover.notes.join()).toContain("以 0 帶入");
    const f: string[] = res.json.returnFile.content.trimEnd().split("|");
    expect(f[87]).toBe(encodeS9(0, 10)); // 序88 上期累積留抵(108)
  });

  it("存檔後下一期自動承轉：202607 留抵 1050 → 202609 的代號 108", async () => {
    // 202607：銷項稅 500、可扣抵 1550 → 應實繳 0、期末留抵 1050
    const gen = await api("/vat-returns/401?period=202607");
    expect(gen.json.summary).toMatchObject({ payable: 0, carryForward: 1050 });

    const filed = await api("/vat-returns/401/file", { period: "202607" });
    expect(filed.status).toBe(201);
    expect(filed.json).toMatchObject({ period: "202607", carryForward: 1050, prevCarryForward: 0 });

    // 202609：銷項 20000/1000、無進項 → 應實繳 = 1000 − 1050 上期留抵 → 0，續留抵 50
    await saleWithInvoice("2026-09-10", 20, 1000, "0002");
    const next = await api("/vat-returns/401?period=202609");
    expect(next.json.carryover).toMatchObject({ prevPeriod: "202607", prevCarryForward: 1050, source: "filed" });
    const f: string[] = next.json.returnFile.content.trimEnd().split("|");
    expect(f[87]).toBe(encodeS9(1050, 10)); // 序88 上期累積留抵(108)
    expect(next.json.summary).toMatchObject({ payable: 0, carryForward: 50 });
  });

  it("人工覆寫：與上期紀錄不一致時出聲提醒", async () => {
    const res = await api("/vat-returns/401?period=202609&prevCarryForward=99");
    expect(res.json.carryover).toMatchObject({ prevCarryForward: 99, source: "manual" });
    expect(res.json.carryover.notes.join()).toContain("不一致");
    const bad = await api("/vat-returns/401?period=202609&prevCarryForward=-5");
    expect(bad.status).toBe(422);
  });

  it("申報紀錄的鏈不可亂序：重複存 409、回頭補存 409、只能刪最新一期", async () => {
    const dup = await api("/vat-returns/401/file", { period: "202607" });
    expect(dup.status).toBe(409);
    const backfill = await api("/vat-returns/401/file", { period: "202605" });
    expect(backfill.status).toBe(409);
    expect(backfill.json.error).toContain("較晚期別");

    const filed9 = await api("/vat-returns/401/file", { period: "202609" });
    expect(filed9.status).toBe(201);
    const delMiddle = await api("/vat-returns/401/filings/202607", undefined, "DELETE");
    expect(delMiddle.status).toBe(409);
    const delLatest = await api("/vat-returns/401/filings/202609", undefined, "DELETE");
    expect(delLatest.status).toBe(200);
    const list = await api("/vat-returns/401/filings");
    expect(list.json.map((r: { period: string }) => r.period)).toEqual(["202607"]);
  });
});

describe("B11b：退回折讓的 401 減項", () => {
  let saleId: number;
  let purchaseId: number;

  beforeAll(async () => {
    await api("/invoice-tracks", { period: "202701", track: "KC", rangeStart: 30000000, rangeEnd: 30000099 });
    // 202701 期：銷項 10000/500；進項 5000/250（電子、可扣抵費用）
    const s = await api("/sales", { partnerId: b2bId, docDate: "2027-01-10", lines: [{ productId, qty: 10, unitPrice: 1000 }] });
    saleId = s.json.id;
    await api(`/sales/${saleId}/invoice`, { mode: "B2B", randomNumber: "0003" });
    const p = await purchaseWithInvoice("2027-01-05", 5, 1000, "22220001", "25", "1");
    purchaseId = p.id;
  });

  it("缺證明單的退回不列入減項，留在紅色警示；有證明單的列入序 13/19", async () => {
    // 銷貨退回 4000（未登錄證明單）
    const info = await api(`/sales/${saleId}/returnable`);
    const ret = await api(`/sales/${saleId}/returns`, {
      kind: "return",
      docDate: "2027-01-20",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 4 }],
    });
    expect(ret.status).toBe(201);

    const before = await api("/vat-returns/401?period=202701");
    expect(before.json.returnsNotReflected.sales).toMatchObject({ count: 1, subtotal: 4000, tax: 200 });
    expect(before.json.returnsInFiling.sales.count).toBe(0);
    let f: string[] = before.json.returnFile.content.trimEnd().split("|");
    expect(f[12]).toBe(encodeS9(0, 12)); // 減項不動
    expect(f[13]).toBe(encodeS9(10000, 12)); // 序14 合計仍為毛額

    // 補登證明單（PATCH——B11b 抓到的 404 缺口）
    const patched = await api(
      `/sales-returns/${ret.json.id}`,
      { certNo: "ALW-0001", certDate: "2027-01-25" },
      "PATCH",
    );
    expect(patched.status).toBe(200);

    const after = await api("/vat-returns/401?period=202701");
    expect(after.json.returnsNotReflected.sales.count).toBe(0);
    expect(after.json.returnsInFiling.sales).toMatchObject({ count: 1, amount: 4000, tax: 200 });
    f = after.json.returnFile.content.trimEnd().split("|");
    expect(f[12]).toBe(encodeS9(4000, 12)); // 序13 退回及折讓(17)
    expect(f[18]).toBe(encodeS9(200, 10)); // 序19 退回及折讓(18)
    expect(f[13]).toBe(encodeS9(6000, 12)); // 序14 合計(21) = 10000-4000
    expect(f[46]).toBe(encodeS9(6000, 12)); // 序47 銷售額總計(25)
    expect(after.json.summary.outputTaxTotal).toBe(300);
  });

  it("進項退出折讓：證明單日期決定歸期（1 月退、證明單 3 月 → 列入 202703）", async () => {
    const info = await api(`/purchases/${purchaseId}/returnable`);
    const ret = await api(`/purchases/${purchaseId}/returns`, {
      kind: "return",
      docDate: "2027-01-25",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 2 }],
    });
    expect(ret.status).toBe(201);
    const patched = await api(
      `/purchase-returns/${ret.json.id}`,
      { certNo: "ALW-0002", certDate: "2027-03-02" },
      "PATCH",
    );
    expect(patched.status).toBe(200);

    // 202701：退回日在期內但證明單日在 3 月 → 不列入本期減項、也不再警示（已有證明單）
    const jan = await api("/vat-returns/401?period=202701");
    expect(jan.json.returnsInFiling.purchases.expense.count).toBe(0);
    expect(jan.json.returnsNotReflected.purchases.count).toBe(0);

    // 202703：依證明單日期列入
    const mar = await api("/vat-returns/401?period=202703");
    expect(mar.json.returnsInFiling.purchases.expense).toMatchObject({ count: 1, amount: 2000, tax: 100 });
    const f: string[] = mar.json.returnFile.content.trimEnd().split("|");
    expect(f[55]).toBe(encodeS9(2000, 12)); // 序56 退出折讓-進貨費用(40)
    expect(f[65]).toBe(encodeS9(100, 10)); // 序66 稅額(41)
    expect(f[57]).toBe(encodeS9(-2000, 12)); // 序58 合計(44)：本期無進項，減項後為負
  });

  it("補登也不擋「證明單日期早於退回日」（與建單路徑同一條規則：不拿未查證的假設擋人）", async () => {
    const info = await api(`/purchases/${purchaseId}/returnable`);
    const ret = await api(`/purchases/${purchaseId}/returns`, {
      kind: "allowance",
      docDate: "2027-01-26",
      lines: [{ sourceLineId: info.json.lines[0].id, amount: 100 }],
    });
    expect(ret.status).toBe(201);
    const early = await api(
      `/purchase-returns/${ret.json.id}`,
      { certNo: "ALW-0003", certDate: "2027-01-20" },
      "PATCH",
    );
    expect(early.status).toBe(200);
    expect(early.json).toMatchObject({ certNo: "ALW-0003", certDate: "2027-01-20" });
  });
});
