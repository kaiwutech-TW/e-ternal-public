/**
 * 0022 主檔欄位補齊驗收（gap-analysis-2608 B1／B2／B3／3.1-3.3）：
 * - 交易對象：新欄位存得進、查得回；統編重複 409；業務負責人必須在職
 * - 商品：新欄位、PATCH（sku 不可改）、SKU 撞號 409
 * - 員工：PATCH 改名／停用；停用後報銷 422（原本是永遠跑不到的死碼）
 * - 收款到期日：由付款條件預設、可覆寫、不可早於單據日
 * - 帳齡方向（盤點抓到的方向相反 bug，這裡釘死）：
 *   月結 60 天的客戶第 45 天**不再**被標逾期；貨到付款的客戶第 20 天**要**被標逾期
 * - 服務項目：開單不檢查庫存、不動庫存、成本 0；進貨端拒收
 * - 電子發票買方：主檔有地址／Email 之後，XML 帶得出來
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
let supplierId: number;
let productId: number; // 一般（庫存）商品
let serviceId: number; // 服務項目
let net60Id: number; // 月結 60 天的客戶
let codId: number; // 貨到付款（0 天）的客戶
let employeeId: number;

async function api(path: string, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
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
  auth = await setupAdmin(app);

  const emp = await api("/employees", { name: "趙業務", title: "業務" });
  employeeId = emp.json.id;

  const supplier = await api("/partners", { name: "供應商", isSupplier: true });
  supplierId = supplier.json.id;
  const net60 = await api("/partners", {
    name: "月結六十",
    taxId: "04541302",
    isCustomer: true,
    paymentTermDays: 60,
    creditLimit: 100_000,
  });
  net60Id = net60.json.id;
  const cod = await api("/partners", { name: "貨到付款", isCustomer: true, paymentTermDays: 0 });
  codId = cod.json.id;

  const product = await api("/products", { sku: "G-001", name: "一般商品", listPrice: 1000, minStock: 5 });
  productId = product.json.id;
  const service = await api("/products", { sku: "SVC-001", name: "運費", unit: "式", isService: true, listPrice: 350 });
  serviceId = service.json.id;

  // 備庫存：100 個 @600
  await api("/purchases", {
    partnerId: supplierId,
    docDate: "2026-07-01",
    lines: [{ productId, qty: 100, unitPrice: 600 }],
  });
});

describe("交易對象主檔（B1／3.1）", () => {
  it("POST 的新欄位存得進、GET 查得回（不再被 zod 靜默丟棄）", async () => {
    const res = await api("/partners", {
      name: "全欄位客戶",
      isCustomer: true,
      contactPerson: "王聯絡",
      phone: "02-1234-5678",
      email: "a@example.tw",
      address: "登記地址一號",
      shipToAddress: "送貨地址二號",
      paymentTermDays: 45,
      creditLimit: 50_000,
      salesOwnerEmployeeId: employeeId,
      note: "備註內容",
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      contactPerson: "王聯絡",
      phone: "02-1234-5678",
      email: "a@example.tw",
      address: "登記地址一號",
      shipToAddress: "送貨地址二號",
      paymentTermDays: 45,
      creditLimit: 50_000,
      salesOwnerEmployeeId: employeeId,
      note: "備註內容",
    });
    const list = (await api("/partners")).json;
    expect(list.find((p: { id: number }) => p.id === res.json.id).phone).toBe("02-1234-5678");
  });

  it("PATCH 可改新欄位；送 null 是清空", async () => {
    const res = await api(`/partners/${net60Id}`, { phone: "0900-000-000", creditLimit: null }, "PATCH");
    expect(res.status).toBe(200);
    expect(res.json.phone).toBe("0900-000-000");
    expect(res.json.creditLimit).toBeNull();
    expect(res.json.paymentTermDays).toBe(60); // 沒帶的欄位不動
  });

  it("統編重複：POST 與 PATCH 都回 409，訊息講出撞到誰", async () => {
    const dup = await api("/partners", { name: "撞統編", taxId: "04541302", isCustomer: true });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toContain("月結六十");
    const patch = await api(`/partners/${codId}`, { taxId: "04541302" }, "PATCH");
    expect(patch.status).toBe(409);
  });

  it("業務負責人必須在職：指派停用員工回 422", async () => {
    const resigned = await api("/employees", { name: "已離職" });
    await api(`/employees/${resigned.json.id}`, { active: false }, "PATCH");
    const res = await api(`/partners/${net60Id}`, { salesOwnerEmployeeId: resigned.json.id }, "PATCH");
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("已停用");
  });
});

describe("商品主檔（B2／3.2）", () => {
  it("SKU 撞號回 409（不再是 500 internal error）", async () => {
    const res = await api("/products", { sku: "G-001", name: "重複" });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("G-001");
  });

  it("PATCH 可改品名／售價／安全庫存；sku 不可改（400 且講明出路）", async () => {
    const res = await api(`/products/${productId}`, { name: "改名商品", listPrice: 1200, minStock: 10 }, "PATCH");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ name: "改名商品", listPrice: 1200, minStock: 10, sku: "G-001" });
    const bad = await api(`/products/${productId}`, { sku: "G-002" }, "PATCH");
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("SKU 不可修改");
  });

  it("已有庫存的商品不可改成服務項目（422）；空 body 400", async () => {
    const res = await api(`/products/${productId}`, { isService: true }, "PATCH");
    expect(res.status).toBe(422);
    expect((await api(`/products/${productId}`, {}, "PATCH")).status).toBe(400);
  });
});

describe("員工主檔（B3／3.3）", () => {
  it("PATCH 改名與補職稱", async () => {
    const res = await api(`/employees/${employeeId}`, { name: "趙大業務", phone: "0911-111-111" }, "PATCH");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ name: "趙大業務", phone: "0911-111-111", title: "業務", active: true });
  });

  it("停用員工進不了新報銷單（expenses.ts 的把關從死碼變成真的會擋）", async () => {
    const emp = await api("/employees", { name: "即將停用" });
    const off = await api(`/employees/${emp.json.id}`, { active: false }, "PATCH");
    expect(off.status).toBe(200);
    expect(off.json.active).toBe(false);
    const claim = await api("/expense-claims", {
      employeeId: emp.json.id,
      claimDate: "2026-08-01",
      items: [{ accountCode: "6132", docType: "receipt", amount: 500 }],
    });
    expect(claim.status).toBe(422);
    expect(claim.json.error).toContain("已停用");
  });
});

describe("收款到期日（sales.due_date）", () => {
  it("由客戶付款條件預設：docDate＋60 天", async () => {
    const res = await api("/sales", {
      partnerId: net60Id,
      docDate: "2026-07-18",
      lines: [{ productId, qty: 10, unitPrice: 1000 }],
    });
    expect(res.status).toBe(201);
    expect(res.json.dueDate).toBe("2026-09-16");
  });

  it("可逐單覆寫；早於單據日回 422", async () => {
    const res = await api("/sales", {
      partnerId: net60Id,
      docDate: "2026-08-01",
      dueDate: "2026-08-10",
      lines: [{ productId, qty: 1, unitPrice: 1000 }],
    });
    expect(res.status).toBe(201);
    expect(res.json.dueDate).toBe("2026-08-10");
    const bad = await api("/sales", {
      partnerId: net60Id,
      docDate: "2026-08-01",
      dueDate: "2026-07-31",
      lines: [{ productId, qty: 1, unitPrice: 1000 }],
    });
    expect(bad.status).toBe(422);
  });

  it("客戶未約定付款條件 → dueDate 為 NULL", async () => {
    const noTerms = await api("/partners", { name: "未約定客戶", isCustomer: true });
    const res = await api("/sales", {
      partnerId: noTerms.json.id,
      docDate: "2026-08-01",
      lines: [{ productId, qty: 1, unitPrice: 1000 }],
    });
    expect(res.status).toBe(201);
    expect(res.json.dueDate).toBeNull();
  });
});

describe("帳齡與逾期方向（盤點抓到的方向相反 bug）", () => {
  it("月結 60 天第 45 天＝未到期；貨到付款第 20 天＝逾期", async () => {
    // 貨到付款客戶：8/12 出貨（terms 0 → 到期日 8/12），基準日 9/1 已逾期 20 天
    const codSale = await api("/sales", {
      partnerId: codId,
      docDate: "2026-08-12",
      lines: [{ productId, qty: 2, unitPrice: 1000 }],
    });
    expect(codSale.json.dueDate).toBe("2026-08-12");

    const aging = (await api("/reports/ar-aging?asOf=2026-09-01")).json;
    // 月結六十：7/18 賣 10500（到期 9/16）＋8/1 賣 1050（覆寫到期 8/10）
    const net60Row = aging.rows.find((r: { partnerId: number }) => r.partnerId === net60Id);
    // 7/18 那張（到期 9/16）：第 45 天，未到期——舊算法會把它標成逾期（>30 天），方向相反
    expect(net60Row.notDue).toBe(10500);
    expect(net60Row.d0_30).toBe(1050); // 覆寫到期 8/10 的那張：逾期 22 天
    expect(net60Row.overdue).toBe(1050);
    // 貨到付款：第 20 天就是逾期——舊算法（30 天內＝安全）會說它沒事，方向相反
    const codRow = aging.rows.find((r: { partnerId: number }) => r.partnerId === codId);
    expect(codRow).toMatchObject({ notDue: 0, d0_30: 2100, overdue: 2100, total: 2100 });
  });

  it("無到期日的舊單退回以單據日估算，且回應有標註", async () => {
    const aging = (await api("/reports/ar-aging?asOf=2026-09-01")).json;
    // 「未約定客戶」8/1 的 1050：31 天 → 依單據日進 31-60 桶並列入逾期（沿用舊行為）
    const row = aging.rows.find((r: { name: string }) => r.name === "未約定客戶");
    expect(row).toMatchObject({ d31_60: 1050, overdue: 1050 });
    expect(aging.notes.join("")).toContain("沒有收款到期日");
  });

  it("儀表板 overdueAr＝已到期未收（不再是 total − 30 天內）", async () => {
    const d = (await api("/reports/dashboard?asOf=2026-09-01")).json;
    const aging = (await api("/reports/ar-aging?asOf=2026-09-01")).json;
    expect(d.overdueAr).toBe(aging.totals.overdue);
    // 月結 60 的 7/18 大單（10500）未到期，一定不在逾期數字裡
    expect(d.overdueAr).toBeLessThan(10500);
  });
});

describe("服務項目（B2：不入庫存）", () => {
  it("庫存 0 也開得了單；成本 0、不寫庫存異動", async () => {
    const res = await api("/sales", {
      partnerId: codId,
      docDate: "2026-08-20",
      lines: [{ productId: serviceId, qty: 1, unitPrice: 50_000 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ subtotal: 50_000, tax: 2500, cogs: 0 });
    // 服務項目不出現在庫存頁（列著「運費 在庫 0 式」只是噪音）
    const inv = (await api("/inventory")).json;
    expect(inv.find((r: { productId: number }) => r.productId === serviceId)).toBeUndefined();
  });

  it("混合單：庫存只扣一般商品，服務行成本 0", async () => {
    const before = (await api("/inventory")).json.find((r: { productId: number }) => r.productId === productId);
    const res = await api("/sales", {
      partnerId: codId,
      docDate: "2026-08-21",
      lines: [
        { productId, qty: 3, unitPrice: 1000 },
        { productId: serviceId, qty: 1, unitPrice: 350 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.json.cogs).toBe(3 * 600); // 只有商品行有成本
    const after = (await api("/inventory")).json.find((r: { productId: number }) => r.productId === productId);
    expect(before.qty - after.qty).toBe(3);
  });

  it("進貨端拒收服務項目（422，指出費用該走哪裡）", async () => {
    const res = await api("/purchases", {
      partnerId: supplierId,
      docDate: "2026-08-20",
      lines: [{ productId: serviceId, qty: 1, unitPrice: 800 }],
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("服務項目");
  });
});

describe("電子發票買方（B1 下游：主檔有資料之後 XML 帶得出來）", () => {
  it("B2B 發票 XML 含買方 Address 與 EmailAddress", async () => {
    await app.request("/company-profile", {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "測試賣方", taxId: "22099131", address: "賣方地址" }),
    });
    await api("/invoice-tracks", { period: "202607", track: "MA", rangeStart: 20000000, rangeEnd: 20000099 });
    await api(`/partners/${net60Id}`, { address: "買方地址一號", email: "buyer@example.tw" }, "PATCH");
    const sale = await api("/sales", {
      partnerId: net60Id,
      docDate: "2026-07-25",
      lines: [{ productId, qty: 1, unitPrice: 1000 }],
    });
    const inv = await api(`/sales/${sale.json.id}/invoice`, { mode: "B2B" });
    expect(inv.status).toBe(201);
    expect(inv.json.xml).toContain("<Address>買方地址一號</Address>");
    expect(inv.json.xml).toContain("<EmailAddress>buyer@example.tw</EmailAddress>");
  });
});
