/**
 * 稅法參數：append-only、生效期間不重疊、接續只動 valid_to、依日期解析、回退帶警告、六角色權限，
 * 以及兩條實際取用參數的路徑（營業稅率接進單據；可扣抵旗標接進報銷）。
 *
 * 這支測試守的核心命題是本批的設計紀律：
 * **系統絕不斷言任何稅率；程式提供結構與算術，不提供答案。**
 * 因此有幾格看起來「什麼都沒做」的測試特別重要——
 * 找不到參數時必須**回退並出聲**（不可靜默、也不可自己猜一個數字），
 * 以及舊列被接續後**值與依據原封不動**（append-only 的本體）。
 * 這些若被改成「系統應該知道 X」，就是紀律被推翻的訊號。
 *
 * ⚠️ 本檔的費率一律用中性數字（3.5%、20%、50%）。唯一出現 500 bp 的地方是
 *    「migration 種子的遷移值」那一格——那一格測的正是「它被標成遷移而不是查證結果」。
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, schema } from "@tw-erp/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { loginAs, setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let db: ReturnType<typeof drizzle>;
let admin: Record<string, string>;
const cookies: Record<string, Record<string, string>> = {};

let customerId: number;
let supplierId: number;
let productId: number;
let employeeId: number;

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

/** 只留 migration 種子那一列，讓每個 describe 從同一個起點出發（append-only 的表在測試裡要自己清） */
async function resetToSeed() {
  await db.delete(schema.taxParameters).where(eq(schema.taxParameters.kind, "input_tax_deductible"));
  await db.delete(schema.taxParameters).where(eq(schema.taxParameters.kind, "income_tax"));
  await db.delete(schema.taxParameters).where(eq(schema.taxParameters.kind, "undistributed_earnings"));
}

const flat = (rateBp: number) => [{ from: 0, to: null, mode: "rate_on_total" as const, rateBp }];

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);

  for (const role of ["gm", "finance", "sales", "purchasing", "employee"] as const) {
    await api("/users", admin, { username: role, displayName: role, password: "secret-test", role });
    cookies[role] = await loginAs(app, role, "secret-test");
  }
  cookies["admin"] = admin;

  customerId = (await api("/partners", admin, { name: "客戶甲", isCustomer: true })).json.id;
  supplierId = (await api("/partners", admin, { name: "供應商乙", isSupplier: true })).json.id;
  productId = (await api("/products", admin, { sku: "P1", name: "商品一", unit: "個" })).json.id;
  employeeId = (await api("/employees", admin, { name: "王小明" })).json.id;
  // 先進一批貨，之後的銷貨才有庫存
  await api("/purchases", admin, {
    partnerId: supplierId,
    docDate: "2026-01-05",
    lines: [{ productId, qty: 1000, unitPrice: 100 }],
  });
});

describe("migration 種子：一列 vat 參數，標明是遷移不是查證結果", () => {
  it("種子列存在、涵蓋全部既有單據，且來源欄明說「不是本專案的查證結果」", async () => {
    const res = await api("/tax-parameters", admin);
    expect(res.status).toBe(200);
    const vat = (res.json.rows as { kind: string; sourceNote: string; brackets: unknown; validFrom: string }[]).filter(
      (r) => r.kind === "vat",
    );
    expect(vat).toHaveLength(1);
    expect(vat[0]!.brackets).toEqual([{ from: 0, to: null, mode: "rate_on_total", rateBp: 500 }]);
    expect(vat[0]!.sourceNote).toContain("不是本專案的查證結果");
    // 生效起日必須早到足以涵蓋任何既有單據，否則升級後舊單的退貨會突然走回退路徑
    expect(vat[0]!.validFrom < "2000-01-01").toBe(true);
  });

  it("維護頁把「系統只保管、不計算」的 kind 標出來", async () => {
    const res = await api("/tax-parameters", admin);
    expect(res.json.recordOnlyKinds).toEqual(["income_tax", "undistributed_earnings"]);
  });
});

describe("append-only：新增、重疊、接續", () => {
  beforeEach(resetToSeed);

  it("生效期間重疊被擋，訊息指出跟哪一列衝突", async () => {
    const first = await api("/tax-parameters", admin, {
      kind: "test_rate",
      label: "測試費率 A",
      validFrom: "2026-01-01",
      brackets: flat(350),
      sourceNote: "例如：依據 XXX 頁面，查詢日 2026-08-01",
    });
    expect(first.status).toBe(201);

    const clash = await api("/tax-parameters", admin, {
      kind: "test_rate",
      label: "測試費率 B",
      validFrom: "2026-07-01",
      brackets: flat(2000),
    });
    expect(clash.status).toBe(422);
    expect(clash.json.error).toContain(`第 #${first.json.id} 列`);
    expect(clash.json.error).toContain("測試費率 A");
    expect(clash.json.error).toContain("接續前一列"); // 訊息要給得出脫困路徑
  });

  it("接續只動前一列的 valid_to：值、依據、輸入者一律不變", async () => {
    const first = await api("/tax-parameters", admin, {
      kind: "test_rate2",
      label: "測試費率 A",
      validFrom: "2026-01-01",
      brackets: flat(350),
      sourceNote: "原始依據",
    });
    const second = await api("/tax-parameters", admin, {
      kind: "test_rate2",
      label: "測試費率 B",
      validFrom: "2026-07-01",
      brackets: flat(2000),
      supersedePrevious: true,
    });
    expect(second.status).toBe(201);
    expect(second.json.superseded).toMatchObject({ id: first.json.id, newValidTo: "2026-06-30" });

    const rows = (await api("/tax-parameters", admin)).json.rows as {
      id: number;
      validFrom: string;
      validTo: string | null;
      brackets: { rateBp: number }[];
      sourceNote: string | null;
      status: string;
    }[];
    const old = rows.find((r) => r.id === first.json.id)!;
    expect(old.validTo).toBe("2026-06-30");
    expect(old.validFrom).toBe("2026-01-01"); // 起日不動
    expect(old.brackets[0]!.rateBp).toBe(350); // 值不動
    expect(old.sourceNote).toBe("原始依據"); // 依據不動
  });

  it("歷史列不隱藏，只標狀態（append-only 的價值就在這）", async () => {
    await api("/tax-parameters", admin, {
      kind: "test_rate3",
      label: "A",
      validFrom: "2020-01-01",
      validTo: "2020-12-31",
      brackets: flat(350),
    });
    await api("/tax-parameters", admin, {
      kind: "test_rate3",
      label: "C",
      validFrom: "2099-01-01",
      brackets: flat(2000),
    });
    const rows = (await api("/tax-parameters?asOf=2026-08-01", admin)).json.rows as {
      label: string;
      kind: string;
      status: string;
    }[];
    const mine = rows.filter((r) => r.kind === "test_rate3");
    expect(mine.map((r) => `${r.label}:${r.status}`)).toEqual(["A:expired", "C:future"]);
  });

  it("沒有可接續的前一列時明說，並給出脫困路徑（同日填錯不能就地改）", async () => {
    const first = await api("/tax-parameters", admin, {
      kind: "test_rate4",
      label: "打錯的那一列",
      validFrom: "2026-01-01",
      brackets: flat(3500),
    });
    const sameDay = await api("/tax-parameters", admin, {
      kind: "test_rate4",
      label: "更正",
      validFrom: "2026-01-01",
      brackets: flat(350),
      supersedePrevious: true,
    });
    expect(sameDay.status).toBe(422);
    expect(sameDay.json.error).toContain(`更正第 #${first.json.id} 列`);
    expect(sameDay.json.error).toContain("舊年度必須算得回來");

    // 脫困路徑本身要真的走得通：改用晚一天的生效日 + 接續
    const fixed = await api("/tax-parameters", admin, {
      kind: "test_rate4",
      label: "更正",
      validFrom: "2026-01-02",
      brackets: flat(350),
      supersedePrevious: true,
      sourceNote: `更正第 #${first.json.id} 列`,
    });
    expect(fixed.status).toBe(201);
  });

  it("沒有 PATCH／DELETE：append-only 不是靠慣例，是沒有那條路", async () => {
    const row = await api("/tax-parameters", admin, {
      kind: "test_rate5",
      label: "A",
      validFrom: "2026-01-01",
      brackets: flat(350),
    });
    // Hono 的 404 不是 JSON，所以這裡直接看 status（api() 會嘗試 JSON.parse）
    const patch = await app.request(`/tax-parameters/${row.json.id}`, {
      method: "PATCH",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ label: "B" }),
    });
    expect(patch.status).toBe(404);
    const del = await app.request(`/tax-parameters/${row.json.id}`, { method: "DELETE", headers: admin });
    expect(del.status).toBe(404);
  });

  it("形狀驗證：級距與布林值必須恰好一種；期間顛倒擋下", async () => {
    const both = await api("/tax-parameters", admin, {
      kind: "test_shape",
      label: "兩種都填",
      validFrom: "2026-01-01",
      brackets: flat(350),
      boolValue: true,
    });
    expect(both.status).toBe(422);
    expect(both.json.error).toContain("二選一");

    const neither = await api("/tax-parameters", admin, {
      kind: "test_shape",
      label: "都沒填",
      validFrom: "2026-01-01",
    });
    expect(neither.status).toBe(422);

    const reversed = await api("/tax-parameters", admin, {
      kind: "test_shape",
      label: "期間顛倒",
      validFrom: "2026-07-01",
      validTo: "2026-01-01",
      brackets: flat(350),
    });
    expect(reversed.status).toBe(422);
    expect(reversed.json.error).toContain("仍有效");

    const overlapBrackets = await api("/tax-parameters", admin, {
      kind: "test_shape",
      label: "級距重疊",
      validFrom: "2026-01-01",
      brackets: [
        { from: 0, to: 200_000, mode: "rate_on_total", rateBp: 350 },
        { from: 100_000, to: null, mode: "rate_on_total", rateBp: 2000 },
      ],
    });
    expect(overlapBrackets.status).toBe(422);
    expect(overlapBrackets.json.error).toContain("重疊");
  });

  it("記錄用的 kind（營所稅／未分配盈餘）存得進去——系統保管規則，但不計算", async () => {
    const res = await api("/tax-parameters", admin, {
      kind: "income_tax",
      label: "營所稅級距（我查到的）",
      validFrom: "2026-01-01",
      brackets: [
        { from: 0, to: 100_000, mode: "exempt" },
        { from: 100_000, to: 300_000, mode: "rate_of_excess", rateBp: 2000 },
        { from: 300_000, to: null, mode: "rate_of_excess", rateBp: 5000 },
      ],
      sourceNote: "例如：依據 XXX 頁面，查詢日 2026-08-01",
    });
    expect(res.status).toBe(201);
    // 系統不因為這一列存在就去算什麼：沒有任何端點會用到它（只在維護頁列出）
  });
});

describe("營業稅率解析：依單據日期，且回退不靜默", () => {
  beforeEach(resetToSeed);

  it("同一 kind 兩列不同期間，兩張不同日期的單各拿到對的那列", async () => {
    // 種子那一列涵蓋到永遠，先接續掉再排兩段中性費率
    await api("/tax-parameters", admin, {
      kind: "vat",
      label: "營業稅率（測試段一）",
      validFrom: "2025-01-01",
      validTo: "2025-06-30",
      brackets: flat(350), // 3.5%
      supersedePrevious: true,
    });
    await api("/tax-parameters", admin, {
      kind: "vat",
      label: "營業稅率（測試段二）",
      validFrom: "2025-07-01",
      brackets: flat(2000), // 20%
    });

    const a = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2025-03-15",
      lines: [{ productId, qty: 1, unitPrice: 10_000 }],
    });
    expect(a.status).toBe(201);
    expect(a.json.tax).toBe(350); // 10000 × 3.5%
    expect(a.json.taxNotes).toEqual([]);

    const b = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2025-08-15",
      lines: [{ productId, qty: 1, unitPrice: 10_000 }],
    });
    expect(b.json.tax).toBe(2_000); // 10000 × 20%

    // 進貨、報價、訂單、採購單全都接上同一條解析
    const p = await api("/purchases", admin, {
      partnerId: supplierId,
      docDate: "2025-03-15",
      lines: [{ productId, qty: 1, unitPrice: 10_000 }],
    });
    expect(p.json.tax).toBe(350);
    const q = await api("/quotes", admin, {
      partnerId: customerId,
      quoteDate: "2025-08-01",
      lines: [{ productId, qty: 1, unitPrice: 10_000 }],
    });
    expect(q.json.tax).toBe(2_000);
    const o = await api("/orders", admin, {
      partnerId: customerId,
      orderDate: "2025-03-01",
      lines: [{ productId, qty: 1, unitPrice: 10_000 }],
    });
    expect(o.json.tax).toBe(350);
    const po = await api("/purchase-orders", admin, {
      partnerId: supplierId,
      orderDate: "2025-08-01",
      lines: [{ productId, qty: 1, unitPrice: 10_000 }],
    });
    expect(po.json.tax).toBe(2_000);

    // 退回單的費率跟著**原單日期**，不是退回日：軋平的對象是原單的稅額
    const ret = await api(`/sales/${a.json.id}/returns`, admin, {
      kind: "return",
      docDate: "2025-08-20", // 退回日落在 20% 那一段
      lines: [{ sourceLineId: (await api(`/sales/${a.json.id}/returnable`, admin)).json.lines[0].id, qty: 1 }],
    });
    expect(ret.status).toBe(201);
    expect(ret.json.tax).toBe(350); // 用 3.5% 軋平原單，不是 20%
  });

  it("空窗期（日期早於最早生效日）回退到既有預設值，並在回應帶警告", async () => {
    // 把種子列的起日往後推：新增一列 1900 起、2026 止是做不到的（會重疊），
    // 所以改測「另一個 kind 完全沒設定」以外的路徑——直接刪掉種子列再建一段有限期間的
    await db.delete(schema.taxParameters).where(eq(schema.taxParameters.kind, "vat"));
    await api("/tax-parameters", admin, {
      kind: "vat",
      label: "營業稅率（測試）",
      validFrom: "2026-01-01",
      brackets: flat(350),
    });

    const early = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2025-12-31", // 早於最早生效日
      lines: [{ productId, qty: 1, unitPrice: 10_000 }],
    });
    expect(early.status).toBe(201);
    expect(early.json.tax).toBe(500); // 回退值＝系統既有預設
    expect(early.json.taxNotes).toHaveLength(1);
    expect(early.json.taxNotes[0]).toContain("2025-12-31");
    expect(early.json.taxNotes[0]).toContain("不是本專案查證的結果");

    // 參數表完全空的時候也不能壞掉（全新資料庫、使用者還沒設定過任何東西）
    await db.delete(schema.taxParameters).where(eq(schema.taxParameters.kind, "vat"));
    const empty = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2026-03-01",
      lines: [{ productId, qty: 1, unitPrice: 10_000 }],
    });
    expect(empty.status).toBe(201);
    expect(empty.json.tax).toBe(500);
    expect(empty.json.taxNotes[0]).toContain("稅法參數");
  });

  it("多段級距的 vat 列接不上單一費率流程：回退並說明理由，不默默取第一段", async () => {
    await db.delete(schema.taxParameters).where(eq(schema.taxParameters.kind, "vat"));
    const tiered = await api("/tax-parameters", admin, {
      kind: "vat",
      label: "查定課徵（多段）",
      validFrom: "2025-01-01",
      brackets: [
        { from: 0, to: 100_000, mode: "exempt" },
        { from: 100_000, to: null, mode: "rate_of_excess", rateBp: 350 },
      ],
    });
    const s = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2025-03-01",
      lines: [{ productId, qty: 1, unitPrice: 10_000 }],
    });
    expect(s.json.tax).toBe(500); // 回退
    expect(s.json.taxNotes[0]).toContain(`第 #${tiered.json.id} 列`);
    expect(s.json.taxNotes[0]).toContain("不是單一費率");
  });

  it("小規模營業人的查定課徵稅率是「同一張表換一列」就表達得出來的東西", async () => {
    await db.delete(schema.taxParameters).where(eq(schema.taxParameters.kind, "vat"));
    const res = await api("/tax-parameters", admin, {
      kind: "vat",
      label: "查定課徵稅率（我查到的）",
      validFrom: "2026-01-01",
      // 封一個迄日：R2 之後測試時間線移到過去，開放期間會蓋到後面 describe 的 2026-07 報銷單
      validTo: "2026-03-31",
      brackets: flat(100), // 中性數字，系統不預設任何這類數值
      sourceNote: "例如：依據 XXX 頁面，查詢日 2026-08-01",
    });
    expect(res.status).toBe(201);
    const s = await api("/sales", admin, {
      partnerId: customerId,
      docDate: "2026-03-01",
      lines: [{ productId, qty: 1, unitPrice: 10_000 }],
    });
    expect(s.json.tax).toBe(100);
    expect(s.json.taxNotes).toEqual([]);
  });
});

describe("報銷可扣抵旗標：有覆寫用覆寫值，無覆寫用 core 預設", () => {
  beforeEach(resetToSeed);

  // 發票號碼逐次遞增：R5（第三批）起同號發票只能列報一次，fixture 重用同一號會被正確地 422
  let invoiceSeq = 0;
  const claim = (accountCode: string, claimDate: string) => ({
    employeeId,
    claimDate,
    items: [
      {
        accountCode,
        description: "測試",
        docType: "einvoice" as const,
        amount: 1050,
        deductible: true,
        invoiceNumber: `AB${String(12345678 + ++invoiceSeq).padStart(8, "0")}`,
        invoiceDate: claimDate,
        sellerTaxId: "12345675",
      },
    ],
  });

  it("沒有覆寫時用 core 的預設值（6131 預設可扣抵、6137 預設不可）", async () => {
    const ok = await api("/expense-claims", admin, claim("6131", "2026-07-10"));
    expect(ok.json.total).toBe(1050);
    const items = await db
      .select()
      .from(schema.expenseItems)
      .where(eq(schema.expenseItems.claimId, ok.json.id));
    expect(items[0]!.deductible).toBe(true);

    const no = await api("/expense-claims", admin, claim("6137", "2026-07-10"));
    const noItems = await db
      .select()
      .from(schema.expenseItems)
      .where(eq(schema.expenseItems.claimId, no.json.id));
    expect(noItems[0]!.deductible).toBe(false);
    expect(noItems[0]!.tax).toBe(0);
  });

  it("有覆寫時用覆寫值，兩個方向都要（可 → 不可、不可 → 可）", async () => {
    await api("/tax-parameters", admin, {
      kind: "input_tax_deductible",
      scopeKey: "6131",
      label: "6131 交通與差旅：進項稅可否扣抵",
      validFrom: "2026-07-01",
      boolValue: false,
      sourceNote: "例如：依據 XXX 頁面，查詢日 2026-08-01",
    });
    await api("/tax-parameters", admin, {
      kind: "input_tax_deductible",
      scopeKey: "6137",
      label: "6137 餐飲與交際：進項稅可否扣抵",
      validFrom: "2026-07-01",
      boolValue: true,
    });

    const flipped = await api("/expense-claims", admin, claim("6131", "2026-07-10"));
    const a = await db.select().from(schema.expenseItems).where(eq(schema.expenseItems.claimId, flipped.json.id));
    expect(a[0]!.deductible).toBe(false);
    expect(a[0]!.tax).toBe(0);

    const opened = await api("/expense-claims", admin, claim("6137", "2026-07-10"));
    const b = await db.select().from(schema.expenseItems).where(eq(schema.expenseItems.claimId, opened.json.id));
    expect(b[0]!.deductible).toBe(true);
    expect(b[0]!.tax).toBe(50); // 1050 − round(1050 / 1.05)
  });

  it("以**報銷單日期**解析生效期間：生效前的單仍用預設值", async () => {
    await api("/tax-parameters", admin, {
      kind: "input_tax_deductible",
      scopeKey: "6133",
      label: "6133 文具：進項稅可否扣抵",
      validFrom: "2026-07-01",
      boolValue: false,
    });
    const before = await api("/expense-claims", admin, claim("6133", "2026-06-30"));
    const x = await db.select().from(schema.expenseItems).where(eq(schema.expenseItems.claimId, before.json.id));
    expect(x[0]!.deductible).toBe(true); // 生效前 → core 預設（可扣抵）

    const after = await api("/expense-claims", admin, claim("6133", "2026-07-01"));
    const y = await db.select().from(schema.expenseItems).where(eq(schema.expenseItems.claimId, after.json.id));
    expect(y[0]!.deductible).toBe(false); // 生效當日就算涵蓋（期間兩端都含）
  });

  it("/expense-categories 說得出「這一類目前是系統預設還是你設定的值」", async () => {
    const before = await api("/expense-categories?onDate=2026-07-10", admin);
    const c6137before = (before.json as { accountCode: string; deductibleSource: string }[]).find(
      (c) => c.accountCode === "6137",
    )!;
    expect(c6137before.deductibleSource).toBe("default");

    await api("/tax-parameters", admin, {
      kind: "input_tax_deductible",
      scopeKey: "6137",
      label: "6137 餐飲與交際：進項稅可否扣抵",
      validFrom: "2026-07-01",
      boolValue: true,
      sourceNote: "例如：依據 XXX 頁面，查詢日 2026-08-01",
    });
    const after = await api("/expense-categories?onDate=2026-07-10", admin);
    const c6137 = (after.json as {
      accountCode: string;
      inputTaxDeductible: boolean;
      defaultDeductible: boolean;
      deductibleSource: string;
      deductibleSourceNote: string | null;
    }[]).find((c) => c.accountCode === "6137")!;
    expect(c6137.inputTaxDeductible).toBe(true); // 生效值
    expect(c6137.defaultDeductible).toBe(false); // 系統預設值仍看得到
    expect(c6137.deductibleSource).toBe("parameter");
    expect(c6137.deductibleSourceNote).toContain("查詢日");
  });
});

describe("權限：六角色", () => {
  it("僅 admin／finance 讀寫得了稅法參數；其餘四個角色一律 403", async () => {
    const body = {
      kind: "test_perm",
      label: "測試",
      validFrom: "2040-01-01",
      brackets: flat(350),
    };
    for (const role of ["admin", "finance"] as const) {
      expect((await api("/tax-parameters", cookies[role]!)).status).toBe(200);
    }
    for (const role of ["gm", "sales", "purchasing", "employee"] as const) {
      expect((await api("/tax-parameters", cookies[role]!)).status).toBe(403);
      expect((await api("/tax-parameters", cookies[role]!, body)).status).toBe(403);
    }
    // finance 寫得進去（讀寫同一頁權限）
    expect((await api("/tax-parameters", cookies["finance"]!, body)).status).toBe(201);
  });

  it("未登入一律 401（全路由 default-deny）", async () => {
    const res = await app.request("/tax-parameters");
    expect(res.status).toBe(401);
  });
});

describe("費率快照：參數怎麼改都動不到已落地的單據（對抗驗證抓到的兩個 blocker）", () => {
  /**
   * 自建隔離資料庫：本檔其他測試已經在共用庫裡種了一列 2099 生效的參數，
   * 而這幾格要驗的正是「新增參數之後歷史不變」，需要自己控制整條時間線。
   */
  async function freshApp() {
    const client = new PGlite();
    await applyMigrations((sql) => client.exec(sql));
    const d = drizzle(client);
    await seedAccounts(d);
    const a = buildApp(d);
    const auth = await setupAdmin(a);
    const call = async (path: string, body?: unknown, method = body ? "POST" : "GET") => {
      const res = await a.request(path, {
        method,
        headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    };
    await call("/company-profile", {
      name: "快照測試公司", taxId: "22099131", taxRegistrationNo: "123456789", cityCode: "A",
    }, "PUT");
    const sup = (await call("/partners", { name: "供應商", isSupplier: true })).json;
    const cus = (await call("/partners", { name: "客戶", isCustomer: true })).json;
    const prod = (await call("/products", { sku: "SNAP-1", name: "快照品" })).json;
    await call("/purchases", {
      partnerId: sup.id, docDate: "2026-01-05", lines: [{ productId: prod.id, qty: 100, unitPrice: 5 }],
    });
    return { call, cus, prod };
  }

  it("新增參數不會追溯改掉 401 的申報數字（實測過：稅額曾從 50 變成 175）", async () => {
    const { call, cus, prod } = await freshApp();
    const sale = await call("/sales", {
      partnerId: cus.id, docDate: "2026-01-10", lines: [{ productId: prod.id, qty: 10, unitPrice: 100 }],
    });
    expect(sale.json.tax).toBe(50);
    expect(sale.json.vatRateBp).toBe(500); // 建單當下的費率快照

    await call("/invoice-tracks", { period: "202601", track: "KX", rangeStart: 60000000, rangeEnd: 60000099 });
    expect((await call(`/sales/${sale.json.id}/invoice`, { mode: "B2C", randomNumber: "0007" })).status).toBe(201);

    const before = await call("/vat-returns/401?period=202601");
    const created = await call("/tax-parameters", {
      kind: "vat", label: "費率調整", validFrom: "2026-06-01",
      brackets: [{ from: 0, to: null, mode: "rate_on_total", rateBp: 2000 }],
      supersedePrevious: true, sourceNote: "測試用",
    });
    expect(created.status).toBe(201);
    const after = await call("/vat-returns/401?period=202601");

    // B2C 的拆算用的是開立當時的費率快照，參數改了也動不到它
    expect(after.json.summary.outputTax).toBe(before.json.summary.outputTax);
    expect(after.json.summary.outputSales).toBe(before.json.summary.outputSales);
    expect(after.json.mediaFile.content).toBe(before.json.mediaFile.content);
  });

  it("部分退回用原單的費率快照，2288 不會留下沖不掉的殘額", async () => {
    const { call, cus, prod } = await freshApp();
    const sale = await call("/sales", {
      partnerId: cus.id, docDate: "2026-01-11", lines: [{ productId: prod.id, qty: 10, unitPrice: 100 }],
    });
    expect(sale.json.tax).toBe(50);
    expect((await call("/tax-parameters", {
      kind: "vat", label: "費率調整", validFrom: "2026-06-01",
      brackets: [{ from: 0, to: null, mode: "rate_on_total", rateBp: 2000 }],
      supersedePrevious: true, sourceNote: "測試用",
    })).status).toBe(201);

    const info = await call(`/sales/${sale.json.id}/returnable`);
    const ret = await call(`/sales/${sale.json.id}/returns`, {
      kind: "return", docDate: "2026-07-20", // 退回日落在新費率期間
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 5 }],
    });
    expect(ret.status).toBe(201);
    expect(ret.json.subtotal).toBe(500);
    expect(ret.json.tax).toBe(25); // 原單費率的一半；用新費率會是 100，留下 2288 殘額
  });

  it("參數只能往未來延伸：不得插進已封閉的歷史區間中段", async () => {
    const { call } = await freshApp();
    // 先合法地往前延伸兩次：[種子 1900~2026-05-31][2026-06-01~2026-12-31][2027-01-01~null]
    for (const [validFrom, rateBp] of [["2026-06-01", 2000], ["2027-01-01", 350]] as const) {
      const r = await call("/tax-parameters", {
        kind: "vat", label: `第 ${validFrom} 段`, validFrom,
        brackets: [{ from: 0, to: null, mode: "rate_on_total", rateBp }],
        supersedePrevious: true, sourceNote: "測試用",
      });
      expect(r.status).toBe(201);
    }
    const before = (await call("/tax-parameters")).json.rows.filter((r: { kind: string }) => r.kind === "vat");
    expect(before.length).toBe(3);

    // 往中段插：2026-09-01 落在已經被 2027-01-01 那列封閉的區間裡，
    // 會把「2028 下半年那些天該用哪個費率」整段改判
    const res = await call("/tax-parameters", {
      kind: "vat", label: "中途插入", validFrom: "2026-09-01",
      brackets: [{ from: 0, to: null, mode: "rate_on_total", rateBp: 1 }],
      supersedePrevious: true, sourceNote: "測試用",
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("早於既有的第");
    expect(res.json.error).toContain("由舊到新依序新增"); // 補建歷史的正當做法

    // 沒有任何一列被動到
    const after = (await call("/tax-parameters")).json.rows.filter((r: { kind: string }) => r.kind === "vat");
    expect(after.length).toBe(before.length);
    expect(after.map((r: { validFrom: string; validTo: string | null }) => [r.validFrom, r.validTo]))
      .toEqual(before.map((r: { validFrom: string; validTo: string | null }) => [r.validFrom, r.validTo]));
  });
});

describe("taxNotes：回退不可靜默，但「用快照」不是回退", () => {
  it("發票的費率跟著原銷貨單的快照，不會因為期間參數變動而與 sale.tax 打架", async () => {
    const client = new PGlite();
    await applyMigrations((sql) => client.exec(sql));
    const d = drizzle(client);
    await seedAccounts(d);
    const a = buildApp(d);
    const au = await setupAdmin(a);
    const call = async (path: string, body?: unknown, method = body ? "POST" : "GET") => {
      const res = await a.request(path, {
        method,
        headers: { ...au, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    };
    await call("/company-profile", {
      name: "快照發票公司", taxId: "22099131", taxRegistrationNo: "123456789", cityCode: "A",
    }, "PUT");
    const sup = (await call("/partners", { name: "供應商", isSupplier: true })).json;
    const cus = (await call("/partners", { name: "客戶", taxId: "04541302", isCustomer: true })).json;
    const prod = (await call("/products", { sku: "INV-SNAP", name: "品" })).json;
    await call("/purchases", {
      partnerId: sup.id, docDate: "2026-01-05", lines: [{ productId: prod.id, qty: 100, unitPrice: 5 }],
    });
    const sale = await call("/sales", {
      partnerId: cus.id, docDate: "2026-01-10", lines: [{ productId: prod.id, qty: 10, unitPrice: 100 }],
    });
    expect(sale.json.tax).toBe(50);

    // 開單之後、開票之前改費率：發票若重新解析就會拿到新費率，
    // 而 sale.tax 早已落地不動 → XML 的 taxRate 與 taxAmount 自相矛盾
    expect((await call("/tax-parameters", {
      kind: "vat", label: "期間內調整", validFrom: "2026-01-11",
      brackets: [{ from: 0, to: null, mode: "rate_on_total", rateBp: 2000 }],
      supersedePrevious: true, sourceNote: "測試用",
    })).status).toBe(201);

    await call("/invoice-tracks", { period: "202601", track: "KV", rangeStart: 80000000, rangeEnd: 80000099 });
    const inv = await call(`/sales/${sale.json.id}/invoice`, { mode: "B2B", randomNumber: "0011" });
    expect(inv.status).toBe(201);
    // 發票的稅額必須等於銷貨單的稅額，XML 的稅率也必須是開單當時那一個
    expect(inv.json.taxAmount).toBe(sale.json.tax);
    expect(inv.json.vatRateBp).toBe(sale.json.vatRateBp);
    expect(inv.json.xml).toContain("<TaxRate>0.05</TaxRate>");
    expect(inv.json.taxNotes).toEqual([]); // 用快照不是回退，不該出聲
  });

  it("沒有快照的舊單（本欄位出現前建立）走回退並出聲", async () => {
    const client = new PGlite();
    await applyMigrations((sql) => client.exec(sql));
    const d = drizzle(client);
    await seedAccounts(d);
    const a = buildApp(d);
    const au = await setupAdmin(a);
    const call = async (path: string, body?: unknown, method = body ? "POST" : "GET") => {
      const res = await a.request(path, {
        method,
        headers: { ...au, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    };
    const sup = (await call("/partners", { name: "供應商", isSupplier: true })).json;
    const cus = (await call("/partners", { name: "客戶", isCustomer: true })).json;
    const prod = (await call("/products", { sku: "OLD-SNAP", name: "品" })).json;
    await call("/purchases", {
      partnerId: sup.id, docDate: "2026-02-01", lines: [{ productId: prod.id, qty: 100, unitPrice: 5 }],
    });
    const sale = await call("/sales", {
      partnerId: cus.id, docDate: "2026-02-05", lines: [{ productId: prod.id, qty: 10, unitPrice: 100 }],
    });
    // 模擬本欄位出現前建立的舊單：把快照清成 NULL
    await d.update(schema.sales).set({ vatRateBp: null }).where(eq(schema.sales.id, sale.json.id));

    const info = await call(`/sales/${sale.json.id}/returnable`);
    const ret = await call(`/sales/${sale.json.id}/returns`, {
      kind: "return", docDate: "2026-02-10",
      lines: [{ sourceLineId: info.json.lines[0].id, qty: 2 }],
    });
    expect(ret.status).toBe(201);
    // 沒有快照就只能依日期重新解析，而那個結果可能與當初入帳的金額不一致——必須說出來
    expect(ret.json.taxNotes.length).toBeGreaterThan(0);
    expect(ret.json.taxNotes.join("")).toContain("沒有費率快照");
  });
});
