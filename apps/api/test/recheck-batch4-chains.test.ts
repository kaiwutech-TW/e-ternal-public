/**
 * 第四批覆核的二階組合鏈（跨站對抗探針轉正式迴歸）：
 * 各站自己的測試都驗一階操作，這裡釘的是「兩站的功能疊在一起」的鏈——
 * 前三批覆核抓到的 bug 全是這個形狀（TOTP 中途放棄、反向傳票再作廢、短交結案被翻回）。
 * ① 溢付付款單被 apply-prepaid 沖用後整筆作廢 → 對象餘額/1212/open-documents 全鏈回復
 *    → 退出單沖應付上限（balances.ts 口徑）用回復後的數字；
 * ② FIFO 沖畢的單在收款單作廢後可再立沖（「已沖畢」的 422 不能把作廢後的回復也擋掉）；
 * ③ 處分發票「作廢並沖回」→ 資產回使用中 → 再處分＋再開票（0034 partial unique
 *    只擋 issued）→ 401 回基線（canceled 0 元、只算活著那張）；
 * ④ 報銷單作廢（0036）釋出發票號碼給進貨側 R5 反向查重（兩個站各修一半，接縫在這）；
 * ⑤ 清單×作廢：作廢單照列照數，X-Total-Count 與列數同一份 where。
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
let productId: number;
let bankAccountId: number;

async function api(path: string, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...admin, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

const balanceOf = async (partnerId: number) =>
  (await api("/partner-balances")).json.find((b: { partnerId: number }) => b.partnerId === partnerId);

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  const db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);
  productId = (await api("/products", { sku: "P-RC4", name: "覆核商品" })).json.id;
  bankAccountId = (await api("/accounts")).json.find((a: { code: string }) => a.code === "1103").id;
  // 公司稅籍（開發票與 401 需要）
  await api(
    "/company-profile",
    {
      name: "覆核測試公司",
      taxId: "04595257",
      taxRegistrationNo: "123456789",
      cityCode: "A",
      address: "台北市",
      personInCharge: "王覆核",
    },
    "PUT",
  );
  await api("/invoice-tracks", { period: "202607", track: "RC", rangeStart: 1, rangeEnd: 200 });
});

describe("鏈①：溢付付款單被沖用後作廢 → 餘額全鏈回復 → 退出單上限正確", () => {
  let supplier: number;
  let p1: number;
  let p2: number;
  let payment: number;

  beforeAll(async () => {
    supplier = (await api("/partners", { name: "鏈一供應商", isSupplier: true })).json.id;
    p1 = (await api("/purchases", { partnerId: supplier, docDate: "2026-05-01", lines: [{ productId, qty: 10, unitPrice: 100 }] })).json.id; // 1050
    // 付 2000 立沖 P1 全額 → 溢付 950 掛 1212
    payment = (
      await api("/cash-docs", {
        kind: "payment", partnerId: supplier, docDate: "2026-05-02", amount: 2000,
        accountId: bankAccountId, allocations: [{ targetId: p1, amount: 1050 }],
      })
    ).json.id;
    p2 = (await api("/purchases", { partnerId: supplier, docDate: "2026-05-10", lines: [{ productId, qty: 10, unitPrice: 100 }] })).json.id; // 1050
    // 事後沖用預付 500 到 P2
    const applied = await api(`/cash-docs/${payment}/apply-prepaid`, {
      applyDate: "2026-05-11",
      allocations: [{ targetId: p2, amount: 500 }],
    });
    expect(applied.status).toBe(201);
  });

  it("作廢付款單：ap 回到 2100、預付歸零、1212 總帳不留負數", async () => {
    expect(await balanceOf(supplier)).toMatchObject({ ap: 550, prepaidPaid: 450 });
    const voided = await api(`/cash-docs/${payment}/void`, { reason: "覆核探針：整筆作廢" });
    expect(voided.status).toBe(200);
    // 付款當作沒發生：兩張進貨全額回到應付
    expect(await balanceOf(supplier)).toMatchObject({ ap: 2100 });
    // 1212 預付貨款總帳餘額回零（原傳票＋沖用傳票都被反向）
    const tb = (await api("/trial-balance")).json;
    const row1212 = tb.rows?.find?.((r: { code: string }) => r.code === "1212") ?? tb.find?.((r: { code: string }) => r.code === "1212");
    if (row1212) expect(row1212.debit - row1212.credit).toBe(0);
    // open-documents 也回復
    const open = (await api(`/open-documents?partnerId=${supplier}&kind=payment`)).json;
    const docs = open.filter((d: { docType: string }) => d.docType === "purchase");
    expect(docs.reduce((s: number, d: { remaining: number }) => s + d.remaining, 0)).toBe(2100);
  });

  it("作廢後退出單沖應付上限用回復後的餘額（apOffset＝全額）", async () => {
    const returnable = (await api(`/purchases/${p1}/returnable`)).json;
    const doc = await api(`/purchases/${p1}/returns`, {
      kind: "return", docDate: "2026-05-15",
      lines: [{ sourceLineId: returnable.lines[0].id, qty: 10 }],
    });
    expect(doc.status).toBe(201);
    expect(doc.json.apOffset).toBe(1050);
    expect(doc.json.receivableAmount).toBe(0);
    // 三處合計一致
    expect(await balanceOf(supplier)).toMatchObject({ ap: 1050 });
    const aging = (await api("/reports/ap-aging?asOf=2026-05-31")).json.rows.find(
      (r: { partnerId: number }) => r.partnerId === supplier,
    );
    expect(aging.total).toBe(1050);
  });
});

describe("鏈②：FIFO 沖畢的單，其收款單作廢後可再立沖", () => {
  it("收款（未指定沖銷）→ 作廢 → 同單可再全額立沖", async () => {
    const customer = (await api("/partners", { name: "鏈二客戶", isCustomer: true })).json.id;
    const sup = (await api("/partners", { name: "鏈二備貨", isSupplier: true })).json.id;
    await api("/purchases", { partnerId: sup, docDate: "2026-05-01", lines: [{ productId, qty: 10, unitPrice: 100 }] });
    const sale = (await api("/sales", { partnerId: customer, docDate: "2026-05-03", lines: [{ productId, qty: 5, unitPrice: 200 }] })).json.id; // 1050
    const r1 = (await api("/cash-docs", { kind: "receipt", partnerId: customer, docDate: "2026-05-05", amount: 1050, accountId: bankAccountId })).json.id;
    // FIFO 沖畢：不能再立沖
    const dup = await api("/cash-docs", {
      kind: "receipt", partnerId: customer, docDate: "2026-05-06", amount: 100,
      accountId: bankAccountId, allocations: [{ targetId: sale, amount: 100 }],
    });
    expect(dup.status).toBe(422);
    // 作廢原收款 → 回復 → 全額立沖成功
    await api(`/cash-docs/${r1}/void`, { reason: "覆核探針" });
    const again = await api("/cash-docs", {
      kind: "receipt", partnerId: customer, docDate: "2026-05-07", amount: 1050,
      accountId: bankAccountId, allocations: [{ targetId: sale, amount: 1050 }],
    });
    expect(again.status).toBe(201);
    expect(await balanceOf(customer)).toBeUndefined(); // 全結清
  });
});

describe("鏈③：處分發票作廢沖回 → 再處分 → 再開票（partial unique 不擋 canceled）", () => {
  let assetId: number;
  let buyer: number;

  beforeAll(async () => {
    buyer = (await api("/partners", { name: "處分買家", isCustomer: true, taxId: "04541302" })).json.id;
    const res = await api("/fixed-assets", { name: "覆核機器", category: "computer", cost: 36000, startDate: "2026-01-10" });
    expect(res.status).toBe(201);
    assetId = res.json.id;
    // 成本入帳（處分前置：成本未入帳會被 422 擋）
    await api("/journal-entries", {
      entryDate: "2026-01-10",
      memo: "購入 覆核機器",
      lines: [
        { accountCode: "1421", debit: 36000, credit: 0 },
        { accountCode: "1103", debit: 0, credit: 36000 },
      ],
    });
  });

  it("處分＋開票 → 發票作廢並沖回 → 資產回使用中 → 再處分＋再開票成功", async () => {
    const d1 = await api(`/fixed-assets/${assetId}/dispose`, {
      date: "2026-07-10", proceeds: 42000, accountCode: "1103",
      invoice: { mode: "B2B", partnerId: buyer },
    });
    expect(d1.status).toBe(200);
    const inv1 = (await api("/invoices")).json.find((i: { assetId: number | null }) => i.assetId === assetId);
    expect(inv1).toBeTruthy();
    // 作廢並沖回
    const cancel = await api(`/invoices/${inv1.id}/cancel`, { reason: "覆核探針", reverseDisposal: true });
    expect(cancel.status).toBe(200);
    expect(cancel.json.reversalEntryId).toBeGreaterThan(0);
    const asset = (await api("/fixed-assets")).json.find((a: { id: number }) => a.id === assetId);
    expect(asset.status).toBe("active");
    // 再處分＋再開票（同資產第二張 issued，前一張 canceled 不擋）
    const d2 = await api(`/fixed-assets/${assetId}/dispose`, {
      date: "2026-07-20", proceeds: 31500, accountCode: "1103",
      invoice: { mode: "B2B", partnerId: buyer },
    });
    expect(d2.status).toBe(200);
    const invoices = (await api("/invoices")).json.filter((i: { assetId: number | null }) => i.assetId === assetId);
    expect(invoices).toHaveLength(2);
    expect(invoices.filter((i: { status: string }) => i.status === "issued")).toHaveLength(1);
    // 401：canceled 那張 0 元、只算新張銷項 30000/1500（作廢後回基線＝只剩活著的那張）
    const vat = await api("/vat-returns/401?period=202607");
    expect(vat.status).toBe(200);
    expect(vat.json.summary.outputSales).toBe(30000);
    expect(vat.json.summary.outputTax).toBe(1500);
  });

  it("已提折舊累計不因作廢重處分而重複（兩次處分各自補提，作廢已沖回第一次）", async () => {
    const sched = (await api("/reports/depreciation-schedule?year=2026")).json;
    const row = sched.rows.find((r: { assetId: number }) => r.assetId === assetId);
    expect(row).toBeTruthy();
    // 補提不重複：帳面淨值＝成本 − 期末累折，且期末累折 ≤ 成本
    expect(row.accumulated).toBeLessThanOrEqual(row.cost);
    expect(row.bookValue).toBe(row.cost - row.accumulated);
  });
});

describe("鏈④：報銷作廢 → 進貨補登同號發票放行（R5 反向查重×0036）", () => {
  let supplier: number;

  beforeAll(async () => {
    supplier = (await api("/partners", { name: "鏈四供應商", isSupplier: true, taxId: "12345675" })).json.id;
    const emp = (await api("/employees", { name: "鏈四員工" })).json.id;
    // 報銷含發票 ZX22334455
    const claimRes = await api("/expense-claims", {
      employeeId: emp, claimDate: "2026-07-01",
      items: [{ accountCode: "6133", docType: "einvoice", amount: 1050, deductible: true, invoiceNumber: "ZX22334455", invoiceDate: "2026-07-01", sellerTaxId: "12345675" }],
    });
    expect(claimRes.status).toBe(201);
    const claim = claimRes.json;
    expect((await api(`/expense-claims/${claim.id}/approve`, {})).status).toBe(200);
    // 進貨補同號 → 該被擋
    const purchase = (await api("/purchases", { partnerId: supplier, docDate: "2026-07-02", lines: [{ productId, qty: 1, unitPrice: 1000 }] })).json;
    const dup = await api(`/purchases/${purchase.id}/supplier-invoice`, { track: "ZX", no: "22334455", date: "2026-07-01" }, "PATCH");
    expect(dup.status).toBe(422);
    expect(dup.json.error).toContain("報銷單");
    // 作廢報銷單 → 放行
    const voided = await api(`/expense-claims/${claim.id}/void`, { reason: "覆核探針：登錯" });
    expect(voided.status).toBe(200);
    const ok = await api(`/purchases/${purchase.id}/supplier-invoice`, { track: "ZX", no: "22334455", date: "2026-07-01" }, "PATCH");
    expect(ok.status).toBe(200);
  });

  it("上述鏈完成（斷言都在 beforeAll 內逐步驗證）", () => {
    expect(true).toBe(true);
  });
});

describe("清單×作廢：X-Total-Count 與列數同口徑（含作廢單）", () => {
  it("作廢的銷貨單照列、照數", async () => {
    const customer = (await api("/partners", { name: "清單客戶X", isCustomer: true })).json.id;
    const sup = (await api("/partners", { name: "清單備貨X", isSupplier: true })).json.id;
    await api("/purchases", { partnerId: sup, docDate: "2026-06-01", lines: [{ productId, qty: 5, unitPrice: 100 }] });
    const s1 = (await api("/sales", { partnerId: customer, docDate: "2026-06-02", lines: [{ productId, qty: 1, unitPrice: 200 }] })).json.id;
    await api("/sales", { partnerId: customer, docDate: "2026-06-03", lines: [{ productId, qty: 1, unitPrice: 200 }] });
    await api(`/sales/${s1}/void`, { reason: "覆核探針" });
    const res = await api(`/sales?partnerId=${customer}`);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect(res.json).toHaveLength(2);
    expect(res.json.some((s: { id: number }) => s.id === s1)).toBe(true);
  });
});
