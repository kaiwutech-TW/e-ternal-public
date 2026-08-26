/**
 * 六站修補的覆核對抗測試（review 站）：專打各站測試「沒攻到」的角度。
 * - PII：個人客戶的身分證號不得從 /partners 清單或 /sales/:id（列印資料源）漏出
 * - id 空間：opening 與 sale 同號（新庫兩者 id 都從 1 起）沖銷不得互撞
 * - 扣抵代號 3 的進項退回：即使補了證明單也不得列入 401 減項（原進項稅本來就沒扣）
 * - 關帳期間被擋的開立不得消耗字軌號碼（409 之後 nextNo 不動）
 * - migration 0022 的統編重複守衛：舊庫有重複統編時升級要被擋下並講出撞到誰
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { encodeS9 } from "@tw-erp/vat";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let admin: Record<string, string>;
let customerId: number;
let supplierId: number;
let individualId: number;
let productId: number;
let cashAccountId: number;

const ID_NO = "A199887766"; // 假身分證號（僅測 PII 不外洩，不驗真）

async function api(path: string, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...admin, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, raw: text };
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
    { name: "覆核賣方", taxId: "22099131", address: "台北市覆核路1號", taxRegistrationNo: "123456789", cityCode: "A" },
    "PUT",
  );
  customerId = (await api("/partners", { name: "覆核客戶", taxId: "04541302", isCustomer: true })).json.id;
  supplierId = (await api("/partners", { name: "覆核供應商", taxId: "96979933", isSupplier: true })).json.id;
  individualId = (
    await api("/partners", { name: "王個人", isCustomer: true, isIndividual: true, idNo: ID_NO })
  ).json.id;
  productId = (await api("/products", { sku: "REV-1", name: "覆核商品" })).json.id;
  cashAccountId = (await api("/accounts")).json.find((a: { code: string }) => a.code === "1101").id;

  // 備妥庫存
  await api("/purchases", { partnerId: supplierId, docDate: "2026-06-01", lines: [{ productId, qty: 500, unitPrice: 10 }] });
});

describe("PII：身分證號的兩條可能外洩路徑", () => {
  it("GET /partners 清單不含身分證號明文，只回 hasIdNo", async () => {
    const res = await api("/partners");
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain(ID_NO);
    const row = res.json.find((p: { id: number }) => p.id === individualId);
    expect(row.hasIdNo).toBe(true);
    expect(row.idNo).toBeUndefined();
  });

  it("GET /sales/:id（列印資料源）整包 JSON 不含身分證號", async () => {
    const sale = await api("/sales", {
      partnerId: individualId,
      docDate: "2026-06-10",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    expect(sale.status).toBe(201);
    const detail = await api(`/sales/${sale.json.id}`);
    expect(detail.status).toBe(200);
    expect(detail.raw).not.toContain(ID_NO);
    expect(detail.json.partner.name).toBe("王個人");
  });
});

describe("id 空間：opening 與 sale 同號不互撞", () => {
  let saleId: number;
  let openingId: number;

  it("同一對象各有一張同號單據時，沖期初只動期初、銷貨單餘額不動", async () => {
    const sale = await api("/sales", {
      partnerId: customerId,
      docDate: "2026-06-15",
      lines: [{ productId, qty: 10, unitPrice: 100 }], // 含稅總額由系統算
    });
    saleId = sale.json.id;
    const opening = await api("/opening-balances", {
      kind: "receivable",
      partnerId: customerId,
      entryDate: "2026-06-01",
      docDate: "2026-05-15",
      amount: 30000,
      memo: "覆核期初",
    });
    expect(opening.status).toBe(201);
    openingId = opening.json.id;

    const before = (await api(`/open-documents?partnerId=${customerId}&kind=receipt`)).json;
    const saleRow = before.find((d: { docType: string; id: number }) => d.docType === "sale" && d.id === saleId);
    const openRow = before.find((d: { docType: string; id: number }) => d.docType === "opening" && d.id === openingId);
    expect(saleRow.remaining).toBeGreaterThan(0);
    expect(openRow.remaining).toBe(30000);

    const receipt = await api("/cash-docs", {
      kind: "receipt",
      partnerId: customerId,
      docDate: "2026-06-20",
      amount: 5000,
      accountId: cashAccountId,
      allocations: [{ targetType: "opening", targetId: openingId, amount: 5000 }],
    });
    expect(receipt.status).toBe(201);

    const after = (await api(`/open-documents?partnerId=${customerId}&kind=receipt`)).json;
    const saleAfter = after.find((d: { docType: string; id: number }) => d.docType === "sale" && d.id === saleId);
    const openAfter = after.find((d: { docType: string; id: number }) => d.docType === "opening" && d.id === openingId);
    expect(saleAfter.remaining).toBe(saleRow.remaining); // 銷貨單一毛都沒被沖到
    expect(openAfter.remaining).toBe(25000);
  });

  it("收款單不得沖應付側的期初單（kind 不符＝不在未沖清單）", async () => {
    const apOpening = await api("/opening-balances", {
      kind: "payable",
      partnerId: supplierId,
      entryDate: "2026-06-01",
      docDate: "2026-05-20",
      amount: 8000,
    });
    expect(apOpening.status).toBe(201);
    // 供應商不是客戶：收款先天被擋；改攻同一對象雙身分的情況
    await api(`/partners/${supplierId}`, { isCustomer: true }, "PATCH");
    const res = await api("/cash-docs", {
      kind: "receipt",
      partnerId: supplierId,
      docDate: "2026-06-21",
      amount: 1000,
      accountId: cashAccountId,
      allocations: [{ targetType: "opening", targetId: apOpening.json.id, amount: 1000 }],
    });
    expect(res.status).toBe(422); // 應付期初不在收款的未沖清單裡
  });
});

describe("扣抵代號 3 的進項退回：證明單補了也不得進 401 減項", () => {
  it("原進項稅本來就沒扣，退回再列減項會重複少繳", async () => {
    await api("/invoice-tracks", { period: "202609", track: "RV", rangeStart: 40000000, rangeEnd: 40000099 });
    const p = await api("/purchases", {
      partnerId: supplierId,
      docDate: "2026-09-05",
      lines: [{ productId, qty: 10, unitPrice: 100 }],
    });
    const reg = await api(
      `/purchases/${p.json.id}/supplier-invoice`,
      { track: "RV", no: "77770001", format: "25", deductionCode: "3" },
      "PATCH",
    );
    expect(reg.status).toBe(200);

    const info = await api(`/purchases/${p.json.id}/returnable`);
    const ret = await api(`/purchases/${p.json.id}/returns`, {
      kind: "return",
      docDate: "2026-09-10",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 5 }],
    });
    expect(ret.status).toBe(201);
    const patched = await api(
      `/purchase-returns/${ret.json.id}`,
      { certNo: "REV-ALW-1", certDate: "2026-09-15" },
      "PATCH",
    );
    expect(patched.status).toBe(200);

    const r = await api("/vat-returns/401?period=202609");
    expect(r.status).toBe(200);
    // 原進項在排除清單、退回不進任何減項欄
    expect(r.json.nonDeductible.count).toBe(1);
    expect(r.json.returnsInFiling.purchases.expense.count).toBe(0);
    expect(r.json.returnsInFiling.purchases.fixedAsset.count).toBe(0);
    const f: string[] = r.json.returnFile.content.trimEnd().split("|");
    expect(f[55]).toBe(encodeS9(0, 12)); // 序56 退出折讓-進貨費用
    expect(f[65]).toBe(encodeS9(0, 10)); // 序66 稅額
    expect(r.json.summary.deductibleInputTaxTotal ?? r.json.computed?.deductibleInputTaxTotal ?? 0).toBe(0);
  });
});

describe("關帳期間被擋的開立不消耗字軌號碼", () => {
  it("409 之後 nextNo 仍等於 rangeStart", async () => {
    await api("/invoice-tracks", { period: "202611", track: "RW", rangeStart: 50000000, rangeEnd: 50000099 });
    const sale = await api("/sales", {
      partnerId: customerId,
      docDate: "2026-11-05",
      lines: [{ productId, qty: 1, unitPrice: 100 }],
    });
    expect(sale.status).toBe(201);
    expect((await api("/period-closes", { period: "2026-06" })).status).toBe(201);
    expect((await api("/period-closes", { period: "2026-07" })).status).toBe(201);
    expect((await api("/period-closes", { period: "2026-08" })).status).toBe(201);
    expect((await api("/period-closes", { period: "2026-09" })).status).toBe(201);
    expect((await api("/period-closes", { period: "2026-10" })).status).toBe(201);
    expect((await api("/period-closes", { period: "2026-11" })).status).toBe(201);

    const blocked = await api(`/sales/${sale.json.id}/invoice`, { mode: "B2B", randomNumber: "0009" });
    expect(blocked.status).toBe(409);
    const tracks = (await api("/invoice-tracks")).json;
    const rw = tracks.find((t: { track: string }) => t.track === "RW");
    expect(rw.nextNo).toBe(50000000); // 一張都沒消耗
  });
});

describe("migration 0022 的統編重複升級守衛", () => {
  it("舊庫有兩筆同統編時，0022 要拒絕升級並講出撞到誰", async () => {
    const client = new PGlite();
    const dir = join(import.meta.dirname, "../../../packages/db/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (f >= "0022") break;
      await client.exec(readFileSync(join(dir, f), "utf8"));
    }
    await client.exec(
      `INSERT INTO partners (name, tax_id, is_customer) VALUES ('甲公司', '04541302', true), ('甲公司重複', '04541302', true);`,
    );
    const sql0022 = readFileSync(join(dir, files.find((f) => f.startsWith("0022"))!), "utf8");
    await expect(client.exec(sql0022)).rejects.toThrow(/04541302/);
  });
});
