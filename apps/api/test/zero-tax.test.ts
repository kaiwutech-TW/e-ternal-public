/**
 * B12 零稅率整條鏈（migration 0028）：
 * 建單（稅額 0、收入記 4102、快照 0）→ 發票 XML（TaxType 2、金額走 ZeroTaxSalesAmount）
 * → 401（零稅率銷售額落欄 22-25、媒體檔課稅別 2）→ 兼營標記時 401 拒產。
 * 應稅路徑的迴歸（稅額照算、欄位不受影響）也釘在這裡。
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { encodeS9 } from "@tw-erp/vat";
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

let foreignId: number; // 外國客戶：無統編 → B2C
let b2bId: number; // 國內企業客戶：有統編
let productId: number;
let zeroCustomsSaleId: number; // 經海關出口（免開統一發票）、建單時沒填報單號碼
let zeroNonCustomsSaleId: number; // 非經海關、有外匯證明號碼、開 B2C 發票
let taxableSaleId: number;

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  auth = await setupAdmin(app);

  await api(
    "/company-profile",
    { name: "外銷測試公司", taxId: "22099131", taxRegistrationNo: "123456789", cityCode: "A" },
    "PUT",
  );
  const supplier = await api("/partners", { name: "供應商", taxId: "96979933", isSupplier: true });
  foreignId = (await api("/partners", { name: "Pacific Trading Pte. Ltd.", isCustomer: true })).json.id;
  b2bId = (await api("/partners", { name: "國內企業", taxId: "04541302", isCustomer: true })).json.id;
  productId = (await api("/products", { sku: "EXP-001", name: "外銷商品" })).json.id;
  await api("/purchases", {
    partnerId: supplier.json.id,
    docDate: "2026-07-01",
    lines: [{ productId, qty: 100, unitPrice: 500 }],
  });
  await api("/invoice-tracks", { period: "202607", track: "KZ", rangeStart: 10000000, rangeEnd: 10000099 });
});

describe("createSale：課稅別入口", () => {
  it("零稅率（經海關）：稅額 0、費率快照 0、缺證明文件號碼時 taxNotes 出聲", async () => {
    const res = await api("/sales", {
      partnerId: foreignId,
      docDate: "2026-07-05",
      taxType: "2",
      zeroTaxViaCustoms: true,
      lines: [{ productId, qty: 10, unitPrice: 1000 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      subtotal: 10000,
      tax: 0,
      total: 10000,
      taxType: "2",
      zeroTaxViaCustoms: true,
      zeroTaxCertNo: null,
      vatRateBp: 0,
    });
    expect((res.json.taxNotes as string[]).some((n) => n.includes("證明文件號碼"))).toBe(true);
    zeroCustomsSaleId = res.json.id;
  });

  it("零稅率（非經海關）帶證明文件號碼：不再出聲", async () => {
    const res = await api("/sales", {
      partnerId: foreignId,
      docDate: "2026-07-06",
      taxType: "2",
      zeroTaxViaCustoms: false,
      zeroTaxCertNo: "FX-2026-0001",
      lines: [{ productId, qty: 5, unitPrice: 1000 }],
    });
    expect(res.status).toBe(201);
    expect(res.json.tax).toBe(0);
    expect(res.json.zeroTaxCertNo).toBe("FX-2026-0001");
    expect((res.json.taxNotes as string[]).some((n) => n.includes("證明文件"))).toBe(false);
    zeroNonCustomsSaleId = res.json.id;
  });

  it("應稅單完全不受影響（迴歸）：稅照算、課稅別 '1'、零稅率欄為 NULL", async () => {
    const res = await api("/sales", {
      partnerId: b2bId,
      docDate: "2026-07-07",
      lines: [{ productId, qty: 10, unitPrice: 100 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      subtotal: 1000,
      tax: 50,
      total: 1050,
      taxType: "1",
      zeroTaxViaCustoms: null,
      zeroTaxCertNo: null,
    });
    taxableSaleId = res.json.id;
  });

  it("零稅率收入記 4102、應稅記 4101；銷項稅額只有應稅的 50", async () => {
    const tb = await api("/trial-balance");
    const row = (code: string) => tb.json.rows.find((r: { code: string }) => r.code === code);
    expect(row("4102")).toMatchObject({ credit: 15000, debit: 0 }); // 10000 + 5000
    expect(row("4101")).toMatchObject({ credit: 1000 });
    expect(row("2288")).toMatchObject({ credit: 50 });
  });

  it("免稅（taxType '3'）拒收並指路 403", async () => {
    const res = await api("/sales", {
      partnerId: b2bId,
      docDate: "2026-07-07",
      taxType: "3",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("403");
  });

  it("零稅率沒指明經海關與否 → 422；應稅帶零稅率欄位 → 422", async () => {
    const noCustoms = await api("/sales", {
      partnerId: foreignId,
      docDate: "2026-07-07",
      taxType: "2",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    expect(noCustoms.status).toBe(422);
    expect(noCustoms.json.error).toContain("經海關");
    const wrongShape = await api("/sales", {
      partnerId: b2bId,
      docDate: "2026-07-07",
      zeroTaxCertNo: "X-1",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    expect(wrongShape.status).toBe(422);
  });
});

describe("零稅率發票 XML（MIG F0401）", () => {
  it("B2C 零稅率：TaxType 2、TaxRate 0、金額走 ZeroTaxSalesAmount、SalesAmount 0", async () => {
    const res = await api(`/sales/${zeroNonCustomsSaleId}/invoice`, {
      mode: "B2C",
      invoiceTime: "10:00:00",
      randomNumber: "1111",
    });
    expect(res.status).toBe(201);
    expect(res.json.taxType).toBe("2");
    expect(res.json.salesAmount).toBe(0);
    expect(res.json.taxAmount).toBe(0);
    expect(res.json.totalAmount).toBe(5000);
    const xml: string = res.json.xml;
    expect(xml).toContain("<SalesAmount>0</SalesAmount>");
    expect(xml).toContain("<ZeroTaxSalesAmount>5000</ZeroTaxSalesAmount>");
    expect(xml).toContain("<TaxType>2</TaxType>");
    expect(xml).toContain("<TaxRate>0</TaxRate>");
    expect(xml).toContain("<TaxAmount>0</TaxAmount>");
    expect(xml).toContain("<TotalAmount>5000</TotalAmount>");
    expect(xml).not.toContain("<TaxType>1</TaxType>"); // 明細的課稅別也要是 2
  });

  it("應稅 B2B 發票不受影響（迴歸）：TaxType 1、稅額分離", async () => {
    const res = await api(`/sales/${taxableSaleId}/invoice`, {
      mode: "B2B",
      invoiceTime: "10:01:00",
      randomNumber: "2222",
    });
    expect(res.status).toBe(201);
    expect(res.json.taxType).toBe("1");
    const xml: string = res.json.xml;
    expect(xml).toContain("<SalesAmount>1000</SalesAmount>");
    expect(xml).toContain("<TaxAmount>50</TaxAmount>");
    expect(xml).toContain("<ZeroTaxSalesAmount>0</ZeroTaxSalesAmount>");
  });
});

describe("401 接線與證明文件補登", () => {
  it("零稅率銷售額落欄 22-25、計入銷售額總計；應稅欄位不受影響；缺證明文件出聲", async () => {
    const res = await api("/vat-returns/401?period=202607");
    expect(res.status).toBe(200);
    // 應稅（迴歸）：outputSales 只有 1000（零稅率不混入）
    expect(res.json.summary.outputSales).toBe(1000);
    expect(res.json.summary.outputTax).toBe(50);
    // 銷售額總計＝應稅 1000 ＋ 零稅率 15000
    expect(res.json.summary.salesTotal).toBe(16000);
    expect(res.json.zeroRate).toMatchObject({
      nonCustoms: 5000,
      customs: 10000,
      returns: 0,
      total: 15000,
    });
    expect(res.json.zeroRate.missingCert.count).toBe(1); // 經海關那張還沒補報單號碼
    expect(res.json.zeroRate.missingCert.items[0].saleId).toBe(zeroCustomsSaleId);
    expect(res.json.zeroRate.notes.join("")).toContain("證明文件");
    expect(res.json.zeroRate.notes.join("")).toContain("113"); // 退稅欄不計算的提醒

    const fields: string[] = res.json.returnFile.content.trimEnd().split("|");
    expect(fields).toHaveLength(112);
    expect(fields[21]).toBe(encodeS9(5000, 12)); // 欄22 非經海關(7)
    expect(fields[22]).toBe(encodeS9(10000, 12)); // 欄23 經海關(15)
    expect(fields[23]).toBe(encodeS9(0, 12)); // 欄24 退回折讓(19)
    expect(fields[24]).toBe(encodeS9(15000, 12)); // 欄25 合計(23)
    expect(fields[46]).toBe(encodeS9(16000, 12)); // 欄47 銷售額總計(25)
    expect(fields[9]).toBe(encodeS9(1000, 12)); // 欄10 應稅銷售額只有 1000
    expect(fields[92]).toBe(encodeS9(0, 10)); // 欄93 得退稅限額維持 0
  });

  it("媒體檔：零稅率發票課稅別 2、金額為發票總額、稅額 0；81 bytes 不變", async () => {
    const res = await api("/vat-returns/401?period=202607");
    const lines: string[] = res.json.mediaFile.content.split("\r\n").filter(Boolean);
    for (const line of lines) expect(line).toHaveLength(81);
    const zeroLine = lines.find((l) => l[61] === "2");
    expect(zeroLine).toBeDefined();
    expect(zeroLine!.slice(0, 2)).toBe("35"); // 銷項電子發票
    expect(zeroLine!.slice(49, 61)).toBe("000000005000"); // 銷售額 5000
    expect(zeroLine!.slice(62, 72)).toBe("0000000000"); // 稅額 0
    // 應稅 B2B 那張仍是課稅別 1（迴歸）
    expect(lines.some((l) => l[61] === "1" && l.slice(23, 31) === "04541302")).toBe(true);
  });

  it("補登出口報單號碼（PATCH /sales/:id/zero-tax-cert）後，缺證明文件歸零", async () => {
    const patch = await api(`/sales/${zeroCustomsSaleId}/zero-tax-cert`, { certNo: "AA00-1234-5678" }, "PATCH");
    expect(patch.status).toBe(200);
    expect(patch.json.zeroTaxCertNo).toBe("AA00-1234-5678");

    const res = await api("/vat-returns/401?period=202607");
    expect(res.json.zeroRate.missingCert.count).toBe(0);
    expect(res.json.zeroRate.total).toBe(15000); // 金額不因補登而變

    // 應稅單沒有證明文件欄可補
    const wrong = await api(`/sales/${taxableSaleId}/zero-tax-cert`, { certNo: "X-1" }, "PATCH");
    expect(wrong.status).toBe(422);
  });

  it("兼營標記時 401 拒產（422 指路 403），取消標記後恢復", async () => {
    await api(
      "/company-profile",
      {
        name: "外銷測試公司",
        taxId: "22099131",
        taxRegistrationNo: "123456789",
        cityCode: "A",
        vatMixedBusiness: true,
      },
      "PUT",
    );
    const blocked = await api("/vat-returns/401?period=202607");
    expect(blocked.status).toBe(422);
    expect(blocked.json.error).toContain("403");
    expect(blocked.json.error).toContain("兼營");
    // 存申報紀錄同樣被擋（fileReturn401 內部走 generate401）
    const fileBlocked = await api("/vat-returns/401/file", { period: "202607" });
    expect(fileBlocked.status).toBe(422);

    await api(
      "/company-profile",
      {
        name: "外銷測試公司",
        taxId: "22099131",
        taxRegistrationNo: "123456789",
        cityCode: "A",
        vatMixedBusiness: false,
      },
      "PUT",
    );
    const ok = await api("/vat-returns/401?period=202607");
    expect(ok.status).toBe(200);
  });

  it("零稅率銷貨退回（有證明單）落欄 24 並自零稅率合計扣除，不混入應稅減項", async () => {
    // 退掉非經海關那張的 2 件（1000×2＝2000）；證明單號碼建單即帶
    const ret = await api(`/sales/${zeroNonCustomsSaleId}/returns`, {
      kind: "return",
      docDate: "2026-07-20",
      certNo: "RET-Z-001",
      certDate: "2026-07-21",
      lines: [{ sourceLineId: (await api(`/sales/${zeroNonCustomsSaleId}/returnable`)).json.lines[0].id, qty: 2 }],
    });
    expect(ret.status).toBe(201);
    expect(ret.json.tax).toBe(0); // 零稅率退回的稅額也是 0（費率快照 0）

    const res = await api("/vat-returns/401?period=202607");
    expect(res.json.zeroRate.returns).toBe(2000);
    expect(res.json.zeroRate.total).toBe(13000); // 15000 - 2000
    const fields: string[] = res.json.returnFile.content.trimEnd().split("|");
    expect(fields[23]).toBe(encodeS9(2000, 12)); // 欄24 零稅率退回折讓(19)
    expect(fields[24]).toBe(encodeS9(13000, 12)); // 欄25 零稅率合計
    expect(fields[12]).toBe(encodeS9(0, 12)); // 欄13 應稅退回及折讓不受影響
    expect(fields[46]).toBe(encodeS9(14000, 12)); // 欄47 總計 = 1000 + 13000
  });
});
