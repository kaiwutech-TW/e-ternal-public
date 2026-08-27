/**
 * W7：依賣方統編給「歷史分類候選」（GET /expense-categories/suggestions）。
 *
 * 這支端點是純確定性查詢，沒有任何推測——所以測的是四件事：
 * 1. 母體對不對（哪些單算「公司做過的選擇」）；
 * 2. 量尺對不對（**幾張單這樣歸過**，不是幾筆明細——一張批次上傳的單不該壓過好幾張單）；
 * 3. 排序、決勝鍵與上限對不對（claimCount desc、同分時科目代號 asc、最多 3 筆）；
 * 4. 權限對不對（每個角色都要替自己報銷，所以每個角色都要打得了它；未登入 401）。
 *
 * 排除類的測試一律**正反各一**：同一個分類代號在「被接受的單」裡出現時必須看得到，
 * 在「退回／作廢／待審的單」裡出現時必須看不到。只測負面的話，把整個查詢寫成回空陣列也會綠。
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, schema } from "@tw-erp/db";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { loginAs, setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let db: ReturnType<typeof drizzle>;
let admin: Record<string, string>;
let fin: Record<string, string>; // 財務（核准／退回／作廢的人；與申請人不同人才過得了自我核准把關）
let emp: Record<string, string>; // 一般員工，連結「王小明」
let sal: Record<string, string>; // 業務——不是報銷的管理者，用來驗「非財務角色也打得了這支」
let empWang: number;
let cashAccountId: number;

/** 賣方 A：主要母體。B：只出現在被排除的單裡的分類，要在這裡看得到（正面對照） */
const SELLER_A = "04541302";
const SELLER_B = "22099131";
/** 只用來當「6131 沒有被分類過濾掉」的正面對照 */
const SELLER_C = "53212539";
/** 歷史列裡有已下架科目的賣方（測資直接塞列，見 beforeAll） */
const SELLER_D = "24566673";
/** 決勝鍵專用：兩組同分（見「同分」那一段） */
const SELLER_E = "28080623";
/** 從來沒有人在這家消費過——冷啟動 */
const SELLER_COLD = "12345675";

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

/** 發票號碼要全域唯一（R5 查重橫跨所有單），用一個計數器發號免得測資互撞 */
let invoiceSeq = 0;
function nextInvoiceNumber(): string {
  invoiceSeq += 1;
  return `AA${String(invoiceSeq).padStart(8, "0")}`;
}

/** 依「分類 → 幾筆」建一張報銷單，回傳單號。金額固定，這支端點根本不看金額 */
async function createClaim(sellerTaxId: string, counts: Record<string, number>): Promise<number> {
  const items = Object.entries(counts).flatMap(([accountCode, n]) =>
    Array.from({ length: n }, () => ({
      accountCode,
      description: "測試",
      docType: "einvoice" as const,
      amount: 1050,
      invoiceNumber: nextInvoiceNumber(),
      invoiceDate: "2026-07-05",
      sellerTaxId,
    })),
  );
  const res = await api("/expense-claims", emp, { claimDate: "2026-07-10", items });
  expect(res.status).toBe(201);
  return res.json.id;
}

/** 同一個分類開 n 張**各自被核准**的單（每張只有一筆明細），回傳單號陣列 */
async function approveNClaims(sellerTaxId: string, accountCode: string, n: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = await createClaim(sellerTaxId, { [accountCode]: 1 });
    expect((await api(`/expense-claims/${id}/approve`, fin, {})).status).toBe(200);
    ids.push(id);
  }
  return ids;
}

async function suggestions(sellerTaxId: string, headers = emp) {
  return api(`/expense-categories/suggestions?sellerTaxId=${sellerTaxId}`, headers);
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);
  await app.request("/company-profile", {
    method: "PUT",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ name: "測試公司", taxId: "22099131", taxRegistrationNo: "123456789", cityCode: "A" }),
  });
  empWang = (await api("/employees", admin, { name: "王小明" })).json.id;
  const empChang = (await api("/employees", admin, { name: "張會計" })).json.id;
  for (const u of [
    { username: "fin", role: "finance", employeeId: empChang },
    { username: "wang", role: "employee", employeeId: empWang },
    { username: "sal", role: "sales" },
  ]) {
    expect((await api("/users", admin, { ...u, displayName: u.username, password: "secret-test" })).status).toBe(201);
  }
  fin = await loginAs(app, "fin", "secret-test");
  emp = await loginAs(app, "wang", "secret-test");
  sal = await loginAs(app, "sal", "secret-test");
  cashAccountId = (await api("/accounts", admin)).json.find((a: { code: string }) => a.code === "1101").id;

  // ── 賣方 A 的母體 ────────────────────────────────────────────────
  // 單據數刻意做成 4/3/2/1（沒有同分）：同分本身另外由賣方 E 專門測，
  // 混在一起的話「最多 3 筆」這條的驗收會多一個變因。
  //
  // ★ 6131 是**一張 7 筆明細的批次單**，而 6112/6137/6115 是好幾張各自被核准的單。
  //   這組測資的形狀就是為了讓兩把量尺給出不同答案：
  //     以明細筆數排 → 6131(7) > 6112(4) > 6137(3) > 6115(2)
  //     以單據數排   → 6112(4) > 6137(3) > 6115(2) > 6131(1)
  //   若哪天有人把權重改回明細筆數，下面的順序斷言會紅，而不是剛好也過。
  const claims6112 = await approveNClaims(SELLER_A, "6112", 4);
  // 4 張裡挑一張再付款：驗 approved 與 paid 同權重（付款不是第二次被接受）
  expect((await api(`/expense-claims/${claims6112[0]}/pay`, fin, { accountId: cashAccountId })).status).toBe(200);
  await approveNClaims(SELLER_A, "6137", 3);
  await approveNClaims(SELLER_A, "6115", 2);
  const batchClaim = await createClaim(SELLER_A, { "6131": 7 });
  expect((await api(`/expense-claims/${batchClaim}/approve`, fin, {})).status).toBe(200);

  // 被排除的三種單，每種都開 **5 張**（大於第一名的 4 張）：
  // 只開一張的話，就算判準寫錯把它算進來，它也會被「最多 3 筆」擋在候選之外——
  // 那種測試是在會過的組態上取樣，改壞了也不會紅
  // 被退回的單：6188 在 A 這裡只出現在這幾張單上
  for (let i = 0; i < 5; i += 1) {
    const rejectedClaim = await createClaim(SELLER_A, { "6188": 1 });
    expect((await api(`/expense-claims/${rejectedClaim}/reject`, fin, { reason: "分類錯誤" })).status).toBe(200);
  }
  // 核准後又作廢的單：6139 在 A 這裡只出現在這幾張單上
  for (const voidedClaim of await approveNClaims(SELLER_A, "6139", 5)) {
    expect((await api(`/expense-claims/${voidedClaim}/void`, fin, { reason: "重開" })).status).toBe(200);
  }
  // 還沒有人看過的單：6133 在 A 這裡只出現在這幾張單上
  for (let i = 0; i < 5; i += 1) await createClaim(SELLER_A, { "6133": 1 });

  // ── 賣方 E：全部同分，專門驗決勝鍵 ──────────────────────────────
  // 10 個分類**各 1 張被核准的單**，claimCount 全部是 1：誰進得了前三名完全由決勝鍵決定。
  //
  // 為什麼要那麼多個而不是兩兩同分：實測過——只有兩組同分時，資料庫這邊的自然順序
  // 剛好也是代號由小到大（GroupAggregate 走的是 0049 那個以 account_code 為第二鍵的索引），
  // 於是拿掉 asc(account_code) 測試照樣綠，那條斷言等於沒有在守決勝鍵。
  // 同分的組別多到排序要真的做決定時，自然順序才會跟代號序分家。
  // 建立順序刻意是代號反序，讓「照插入順序出來」也不會剛好對。
  for (const code of ["6188", "6139", "6138", "6137", "6136", "6135", "6133", "6131", "6115", "6112"]) {
    await approveNClaims(SELLER_E, code, 1);
  }

  // ── 賣方 B：上面三個被排除的分類，在「被接受的單」裡的正面對照 ──
  const acceptedAtB = await createClaim(SELLER_B, { "6188": 3, "6139": 2, "6133": 1 });
  expect((await api(`/expense-claims/${acceptedAtB}/approve`, fin, {})).status).toBe(200);

  // ── 賣方 C：6131 在被接受的單裡的正面對照（A 那邊它被上限截掉，不是被分類過濾掉）──
  const acceptedAtC = await createClaim(SELLER_C, { "6131": 1 });
  expect((await api(`/expense-claims/${acceptedAtC}/approve`, fin, {})).status).toBe(200);

  // ── 賣方 D：已經不在現行分類清單裡的舊科目。走 API 建不出來（建單會擋 422），
  //    所以直接塞列——要驗的正是「歷史資料裡有這種列」時候選長什麼樣 ──
  const legacyClaim = await createClaim(SELLER_D, { "6112": 1 });
  expect((await api(`/expense-claims/${legacyClaim}/approve`, fin, {})).status).toBe(200);
  await db.insert(schema.expenseItems).values(
    Array.from({ length: 4 }, () => ({
      claimId: legacyClaim,
      accountCode: "6199",
      docType: "receipt" as const,
      amount: 500,
      sellerTaxId: SELLER_D,
    })),
  );
});

describe("W7 歷史分類候選：母體與排序", () => {
  it("依單據數排序、最多 3 筆，且跨分類都在候選裡", async () => {
    const res = await suggestions(SELLER_A);
    expect(res.status).toBe(200);
    expect(res.json).toEqual([
      { accountCode: "6112", label: "員工伙食", claimCount: 4 },
      { accountCode: "6137", label: "餐飲與交際", claimCount: 3 },
      { accountCode: "6115", label: "員工福利", claimCount: 2 },
    ]);
  });

  it("同一賣方橫跨多個分類時不會只回最大那一個", async () => {
    const codes = (await suggestions(SELLER_A)).json.map((r: { accountCode: string }) => r.accountCode);
    expect(new Set(codes).size).toBe(3);
  });

  it("第四名（6131，實際存在且被核准過）被上限截掉", async () => {
    const codes = (await suggestions(SELLER_A)).json.map((r: { accountCode: string }) => r.accountCode);
    expect(codes).toHaveLength(3);
    expect(codes).not.toContain("6131");
    // 正面對照：6131 這個分類本身回得出來（在 A 那邊只是排第四被截掉，不是被過濾掉）
    expect((await suggestions(SELLER_C)).json).toEqual([
      { accountCode: "6131", label: "交通與差旅", claimCount: 1 },
    ]);
  });

  it("approved 與 paid 同權重（6112 的 4 張單裡有一張已付款）", async () => {
    const top = (await suggestions(SELLER_A)).json[0];
    expect(top).toEqual({ accountCode: "6112", label: "員工伙食", claimCount: 4 });
  });
});

describe("W7 歷史分類候選：量尺是單據數，不是明細筆數", () => {
  /**
   * 一張批次上傳的單 = 一次核准動作 = 一個歸類決定被接受了一次。
   * 照明細筆數算的話，賣方 A 的 6131（一張 7 筆的批次單）會排第一，
   * 把 4 張／3 張／2 張各自被核准的分類全部壓下去。
   */
  it("一張 7 筆明細的批次單排不進候選，4 張各 1 筆的單排第一", async () => {
    const rows = (await suggestions(SELLER_A)).json as { accountCode: string; claimCount: number }[];
    expect(rows.map((r) => r.accountCode)).not.toContain("6131");
    expect(rows[0]).toMatchObject({ accountCode: "6112", claimCount: 4 });
  });

  it("同一張單裡同分類的多筆明細只算一次（6131 在別處是 1 張單就是 1）", async () => {
    // 賣方 C 的 6131 是一張單一筆明細；A 的 6131 是一張單七筆明細。
    // 兩邊的單據數都必須是 1——「7」這個數字不該從任何一個出口漏出去
    expect((await suggestions(SELLER_C)).json).toEqual([
      { accountCode: "6131", label: "交通與差旅", claimCount: 1 },
    ]);
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.expenseItems)
      .where(and(eq(schema.expenseItems.sellerTaxId, SELLER_A), eq(schema.expenseItems.accountCode, "6131")));
    expect(row!.n).toBe(7); // 測資真的是 7 筆明細（否則上面那條是在無害的組態上取樣）
  });
});

describe("W7 歷史分類候選：同分時的決勝鍵", () => {
  /**
   * 決勝鍵（asc(account_code)）沒有它就會 flaky：同分的兩個分類誰在前、誰進得了前三名，
   * 由資料庫當下的掃描順序決定。有了它，同一份資料按幾次都是同一個答案——
   * 所以這裡斷言的是**完整順序**，不是集合。
   */
  it("10 個分類全部同分時，前三名是代號最小的三個（完整順序）", async () => {
    expect((await suggestions(SELLER_E)).json).toEqual([
      { accountCode: "6112", label: "員工伙食", claimCount: 1 },
      { accountCode: "6115", label: "員工福利", claimCount: 1 },
      { accountCode: "6131", label: "交通與差旅", claimCount: 1 },
    ]);
  });

  it("同一份資料連問三次給同一個答案", async () => {
    const runs = await Promise.all([suggestions(SELLER_E), suggestions(SELLER_E), suggestions(SELLER_E)]);
    expect(runs[1]!.json).toEqual(runs[0]!.json);
    expect(runs[2]!.json).toEqual(runs[0]!.json);
  });
});

describe("W7 歷史分類候選：哪些單不算數（正反各一）", () => {
  it("退回（rejected）的單不計入，同一個分類在被核准的單裡看得到", async () => {
    expect((await suggestions(SELLER_A)).json.map((r: { accountCode: string }) => r.accountCode)).not.toContain("6188");
    expect((await suggestions(SELLER_B)).json).toContainEqual({ accountCode: "6188", label: "其他", claimCount: 1 });
  });

  it("作廢（voided_at）的單不計入，同一個分類在未作廢的單裡看得到", async () => {
    expect((await suggestions(SELLER_A)).json.map((r: { accountCode: string }) => r.accountCode)).not.toContain("6139");
    expect((await suggestions(SELLER_B)).json).toContainEqual({ accountCode: "6139", label: "廣告行銷", claimCount: 1 });
  });

  it("還沒審過（submitted）的單不計入，同一個分類在被核准的單裡看得到", async () => {
    expect((await suggestions(SELLER_A)).json.map((r: { accountCode: string }) => r.accountCode)).not.toContain("6133");
    expect((await suggestions(SELLER_B)).json).toContainEqual({
      accountCode: "6133",
      label: "文具與辦公用品",
      claimCount: 1,
    });
  });
});

describe("W7 歷史分類候選：冷啟動與輸入", () => {
  it("歷史列裡已不在現行分類清單的科目不會回出來（回了使用者也選不了）", async () => {
    expect((await suggestions(SELLER_D)).json).toEqual([
      { accountCode: "6112", label: "員工伙食", claimCount: 1 },
    ]);
  });

  it("沒有歷史的賣方回空陣列，不猜一個預設分類", async () => {
    const res = await suggestions(SELLER_COLD);
    expect(res.status).toBe(200);
    expect(res.json).toEqual([]);
  });

  it("統編格式不對回 400（回空陣列會被讀成『這家店沒有歷史』）", async () => {
    expect((await suggestions("abc")).status).toBe(400);
    expect((await suggestions("1234567")).status).toBe(400);
    expect((await api("/expense-categories/suggestions", emp)).status).toBe(400);
  });

  it("只回分類、標籤與單據數——不夾帶金額、報銷人或單號", async () => {
    const rows = (await suggestions(SELLER_A)).json as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["accountCode", "claimCount", "label"]);
  });
});

describe("W7 歷史分類候選：權限", () => {
  it("一般員工可以呼叫（他才是填單的人）", async () => {
    expect((await suggestions(SELLER_A, emp)).status).toBe(200);
  });

  it("業務角色也可以呼叫（每個角色都要替自己報銷）", async () => {
    expect((await suggestions(SELLER_A, sal)).status).toBe(200);
  });

  it("財務與管理者可以呼叫", async () => {
    expect((await suggestions(SELLER_A, fin)).status).toBe(200);
    expect((await suggestions(SELLER_A, admin)).status).toBe(200);
  });

  it("未登入 401", async () => {
    expect((await suggestions(SELLER_A, {})).status).toBe(401);
  });

  it("這個路徑上的寫入動作不搭 GET 那條規則的便車", async () => {
    // RULES 那條限定 methods:["GET"]，POST 落到 default-deny（admin 之外皆 403）。
    // 端點本身沒有 POST handler，所以 admin 會拿到 404 而不是 403——差別正是權限層攔沒攔
    expect((await api(`/expense-categories/suggestions?sellerTaxId=${SELLER_A}`, emp, {})).status).toBe(403);
  });
});

describe("W7 歷史分類候選：熱路徑的索引（0049）", () => {
  /**
   * 這支端點是第一個以 seller_tax_id 當條件的查詢，而且掃完一張收據就問一次。
   * migration 冪等由 test/migrations.test.ts 守；這裡守的是**索引真的建出來了**，
   * 而且覆蓋這個查詢會讀的三欄——否則哪天有人把 0049 改成只建單欄，
   * 查詢還是會過，只是每次都要回表。
   */
  it("expense_items 上有涵蓋 (seller_tax_id, account_code, claim_id) 的索引", async () => {
    const res = await db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'expense_items' AND indexname = 'idx_expense_items_seller_category'`,
    );
    const rows = (Array.isArray(res) ? res : (res as unknown as { rows: unknown[] }).rows) as {
      indexdef: string;
    }[];
    expect(rows).toHaveLength(1);
    const def = rows[0]!.indexdef;
    for (const col of ["seller_tax_id", "account_code", "claim_id"]) expect(def).toContain(col);
    // partial：沒有統編的明細（收據／其他憑證）一列都用不到這個索引
    expect(def).toMatch(/WHERE .*seller_tax_id IS NOT NULL/);
  });
});
