/**
 * Phase 3 驗收：一期完整資料 → 401 申報書檔（附件六）＋進銷項媒體檔（附件五）。
 * 場景含 B2B、B2C（內含稅拆算）、作廢發票（課稅別 F）、進項發票登錄。
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
  const supplier = await api("/partners", { name: "供應商", taxId: "96979933", isSupplier: true });
  const b2b = await api("/partners", { name: "企業客戶", taxId: "04541302", isCustomer: true });
  const b2c = await api("/partners", { name: "散客", isCustomer: true });
  const product = await api("/products", { sku: "SKU-200", name: "商品" });
  const pid = product.json.id;

  const purchase = await api("/purchases", {
    partnerId: supplier.json.id,
    docDate: "2026-07-01",
    lines: [{ productId: pid, qty: 100, unitPrice: 10 }],
  });
  await api(`/purchases/${purchase.json.id}/supplier-invoice`, { track: "AB", no: "12345678" }, "PATCH");

  await api("/invoice-tracks", { period: "202607", track: "KZ", rangeStart: 10000000, rangeEnd: 10000099 });

  const mkSale = (partnerId: number, qty: number, unitPrice: number) =>
    api("/sales", { partnerId, docDate: "2026-07-21", lines: [{ productId: pid, qty, unitPrice }] });

  const s1 = await mkSale(b2b.json.id, 10, 100); // 1000/50/1050
  await api(`/sales/${s1.json.id}/invoice`, { mode: "B2B", invoiceTime: "10:00:00", randomNumber: "1111" });
  const s2 = await mkSale(b2c.json.id, 3, 33); // 99/5/104（B2C 內含稅 104）
  await api(`/sales/${s2.json.id}/invoice`, { mode: "B2C", invoiceTime: "10:01:00", randomNumber: "2222" });
  const s3 = await mkSale(b2b.json.id, 5, 100); // 500/25/525 → 作廢
  const inv3 = await api(`/sales/${s3.json.id}/invoice`, { mode: "B2B", invoiceTime: "10:02:00", randomNumber: "3333" });
  await api(`/invoices/${inv3.json.id}/cancel`, { reason: "測試作廢", cancelDate: "2026-07-22", cancelTime: "09:00:00" });
});

describe("Phase 3：401 申報產出", () => {
  it("彙總正確：B2B 直取、B2C 依公式拆算、作廢不計入銷售額但計入發票份數", async () => {
    const res = await api("/vat-returns/401?period=202607");
    expect(res.status).toBe(200);
    expect(res.json.rocPeriod).toBe("11508");
    expect(res.json.summary).toMatchObject({
      invoiceCount: 3,
      outputSales: 1099, // 1000 + 99
      outputTax: 55, // 50 + 5
      inputExpense: 1000,
      inputExpenseTax: 50,
      payable: 5, // 55 - 50
      carryForward: 0,
    });
  });

  it("附件五媒體檔：4 筆記錄、每筆 81 bytes、作廢為課稅別 F、進項含銷售人統編", async () => {
    const res = await api("/vat-returns/401?period=202607");
    const lines: string[] = res.json.mediaFile.content.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(4); // 3 銷項 + 1 進項
    for (const line of lines) expect(line).toHaveLength(81);

    const [b2bLine, b2cLine, canceledLine, inputLine] = lines as [string, string, string, string];
    expect(b2bLine.slice(0, 2)).toBe("35");
    expect(b2bLine.slice(23, 31)).toBe("04541302"); // B2B 買受人統編
    expect(b2cLine.slice(23, 31)).toBe("        "); // B2C 無統編補空白
    expect(b2cLine.slice(49, 61)).toBe("000000000099"); // B2C 拆算後銷售額
    expect(canceledLine[61]).toBe("F"); // 作廢課稅別
    expect(canceledLine.slice(49, 61)).toBe("000000000000");
    expect(inputLine.slice(0, 2)).toBe("25"); // 進項電子發票格式
    expect(inputLine.slice(31, 39)).toBe("96979933"); // 銷售人統編
    expect(inputLine.slice(39, 41)).toBe("AB");
  });

  it("附件六申報書檔：112 欄、關鍵欄位一致", async () => {
    const res = await api("/vat-returns/401?period=202607");
    const fields: string[] = res.json.returnFile.content.trimEnd().split("|");
    expect(fields).toHaveLength(112);
    expect(fields[0]).toBe("1"); // 資料別 401
    expect(fields[2]).toBe("22099131");
    expect(fields[3]).toBe("11508");
    expect(fields[7]).toBe("0000000003"); // 使用發票份數
    expect(fields[9]).toBe("00000000109I"); // 電子發票應稅銷售額 1099
    expect(fields[15]).toBe("000000005E"); // 稅額 55
    expect(fields[90]).toBe("000000000E"); // 應實繳 5
  });

  it("迄月不足 31 天的期別也產得出申報檔（1-2、3-4、5-6 月）", async () => {
    // 2026-07-29 發現的 live bug：迄日寫死 `${迄月}-31`，迄月為 2/4/6 月時組出
    // 2026-02-31 這種不存在的日期，Postgres 拒絕整個查詢 → 500，六個申報期壞掉三個。
    // 既有測試全部用 202607（迄月 8 月剛好 31 天），所以一路綠燈沒被發現。
    for (const period of ["202601", "202603", "202605", "202609", "202611"]) {
      const res = await api(`/vat-returns/401?period=${period}`);
      expect(res.status, `期別 ${period} 應產得出申報檔`).toBe(200);
      expect(res.json.returnFile.content.trimEnd().split("|")).toHaveLength(112);
    }
  });

  it("公司稅籍資料未設定時回 422", async () => {
    // 另建一個乾淨環境驗證防呆
    const client = new PGlite();
    await applyMigrations((sql) => client.exec(sql));
    const db2 = drizzle(client);
    await seedAccounts(db2);
    const app2 = buildApp(db2);
    const auth2 = await setupAdmin(app2);
    await app2.request("/company-profile", {
      method: "PUT",
      headers: { ...auth2, "content-type": "application/json" },
      body: JSON.stringify({ name: "無稅籍公司", taxId: "22099131" }),
    });
    const res = await app2.request("/vat-returns/401?period=202607", { headers: auth2 });
    expect(res.status).toBe(422);
  });
});
