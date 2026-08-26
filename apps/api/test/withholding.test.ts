/**
 * 扣繳追蹤：個人／法人識別、使用者自訂費率（含「尚未設定」與覆寫）、分錄結構、
 * 年度彙總（受領人 × 類別、跨年不混）、2211／2212 的系統科目保護、六角色權限。
 *
 * 這支測試守的核心命題是本批的設計紀律：
 * **系統只提供結構與算術，費率是使用者填的資料。**
 * 因此有兩格看起來「什麼都沒做」的測試特別重要——
 * 費率為 NULL 時試算必須是 0＋提示（不可自己猜一個數字），
 * 以及使用者覆寫時必須完全照他填的（不可被系統的試算值蓋掉）。
 * 這兩格若被改成「系統應該算出 X」，就是紀律被推翻的訊號。
 *
 * ⚠️ 本檔的身分證號一律用明顯假造的值（A123456789 這種教科書範例），
 *    絕不放真實號碼——partners.id_no 是 PII，而本 repo 可能公開。
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, schema } from "@tw-erp/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { loginAs, setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let db: ReturnType<typeof drizzle>;
let admin: Record<string, string>;
const cookies: Record<string, Record<string, string>> = {};

let landlordId: number; // 個人房東
let designerId: number; // 個人接案設計師
let companyId: number; // 法人供應商
let rentCategoryId: number; // 種子類別：付給個人房東的租金（6121）
let serviceCategoryId: number; // 種子類別：付給個人的專業服務費（6124）
let bankId: number; // 1103 銀行存款
let arId: number; // 1144 應收帳款（非現金科目，用來測擋下）

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

interface AccountRow {
  id: number;
  code: string;
  name: string;
  active: boolean;
  isSystem: boolean;
  isCash: boolean;
}

async function accountByCode(code: string): Promise<AccountRow> {
  const rows: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
  const row = rows.find((a) => a.code === code);
  if (!row) throw new Error(`科目不存在: ${code}`);
  return row;
}

/** 某張傳票的明細（代號 → 借/貸），用來斷言分錄結構 */
async function entryLines(entryId: number) {
  const res = await api(`/journal-entries/${entryId}`, admin);
  expect(res.status).toBe(200);
  return (res.json.lines as { code: string; debit: number; credit: number }[]).map((l) => ({
    code: l.code,
    debit: l.debit,
    credit: l.credit,
  }));
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);

  for (const [username, role] of [
    ["fin", "finance"],
    ["sal", "sales"],
    ["pur", "purchasing"],
    ["boss", "gm"],
    ["emp", "employee"],
  ] as const) {
    const res = await api("/users", admin, {
      username,
      displayName: username,
      password: "secret-test",
      role,
    });
    if (res.status !== 201) throw new Error(`建立 ${username} 失敗: ${JSON.stringify(res.json)}`);
    cookies[username] = await loginAs(app, username, "secret-test");
  }

  bankId = (await accountByCode("1103")).id;
  arId = (await accountByCode("1144")).id;

  const cats = (await api("/withholding-categories", admin)).json as { id: number; label: string }[];
  rentCategoryId = cats.find((c) => c.label.includes("租金"))!.id;
  serviceCategoryId = cats.find((c) => c.label.includes("專業服務費"))!.id;
});

describe("交易對象的個人／法人區分", () => {
  it("種子扣繳類別只給標籤與科目對應，費率一律 NULL（系統不預設任何費率）", async () => {
    const cats = (await api("/withholding-categories", admin)).json as {
      label: string;
      expenseAccountCode: string;
      taxRateBp: number | null;
      supplementRateBp: number | null;
      sourceNote: string | null;
      active: boolean;
    }[];
    expect(cats).toHaveLength(2);
    for (const c of cats) {
      // 這一格就是紀律本身：種子若有任何費率值，代表系統在替使用者斷言稅率
      expect(c.taxRateBp).toBeNull();
      expect(c.supplementRateBp).toBeNull();
      expect(c.sourceNote).toBeNull();
      expect(c.active).toBe(true);
    }
    expect(cats.map((c) => c.expenseAccountCode).sort()).toEqual(["6121", "6124"]);
  });

  it("個人：填身分證號可建檔，但清單不回傳明文（只回 hasIdNo）", async () => {
    const res = await api("/partners", admin, {
      name: "房東王先生",
      isIndividual: true,
      idNo: "A123456789",
    });
    expect(res.status).toBe(201);
    expect(res.json.isIndividual).toBe(true);
    expect(res.json.hasIdNo).toBe(true);
    expect(res.json.idNo).toBeUndefined(); // PII 不進回傳
    landlordId = res.json.id;

    const list = (await api("/partners", admin)).json as Record<string, unknown>[];
    const row = list.find((p) => p["id"] === landlordId)!;
    expect(row["hasIdNo"]).toBe(true);
    expect("idNo" in row).toBe(false);
    // 明文確實存進去了（直接查 DB，不經 API）——不然「有存」只是幻覺
    const [dbRow] = await db.select().from(schema.partners).where(eq(schema.partners.id, landlordId));
    expect(dbRow!.idNo).toBe("A123456789");
  });

  it("個人不得有統一編號，訊息要講出怎麼脫困", async () => {
    const res = await api("/partners", admin, {
      name: "誤填統編的個人",
      isIndividual: true,
      taxId: "12345675",
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("統一編號");
    expect(res.json.error).toContain("清空"); // 出路：清空統編，或取消個人勾選
  });

  it("法人：統編仍驗檢查碼；法人不得填身分證號", async () => {
    const bad = await api("/partners", admin, { name: "檢查碼錯的公司", taxId: "12345678", isSupplier: true });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json)).toContain("統一編號檢查碼錯誤");

    const ok = await api("/partners", admin, { name: "正常供應商股份有限公司", taxId: "12345675", isSupplier: true });
    expect(ok.status).toBe(201);
    expect(ok.json.isIndividual).toBe(false);
    expect(ok.json.hasIdNo).toBe(false);
    companyId = ok.json.id;

    const wrong = await api("/partners", admin, { name: "法人填身分證", taxId: "04595252", idNo: "A123456789" });
    expect(wrong.status).toBe(422);
    expect(wrong.json.error).toContain("身分證");
  });

  it("既有法人改成個人：統編沒清會被擋，同一次請求清掉統編就過（脫困路徑要真的走得通）", async () => {
    const blocked = await api(`/partners/${companyId}`, admin, { isIndividual: true }, "PATCH");
    expect(blocked.status).toBe(422);

    const created = await api("/partners", admin, { name: "其實是個人的設計師", taxId: "04595252" });
    expect(created.status).toBe(201);
    designerId = created.json.id;
    const fixed = await api(
      `/partners/${designerId}`,
      admin,
      { isIndividual: true, taxId: null, idNo: "F234567890" },
      "PATCH",
    );
    expect(fixed.status).toBe(200);
    expect(fixed.json).toMatchObject({ isIndividual: true, taxId: null, hasIdNo: true });
  });

  it("身分證號明文只走單筆端點，且限財務／管理者", async () => {
    const asAdmin = await api(`/partners/${landlordId}/id-no`, admin);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.json.idNo).toBe("A123456789");
    expect((await api(`/partners/${landlordId}/id-no`, cookies["fin"]!)).status).toBe(200);
    for (const who of ["sal", "pur", "boss", "emp"]) {
      expect((await api(`/partners/${landlordId}/id-no`, cookies[who]!)).status).toBe(403);
    }
  });

  it("清除身分證號有明確的出口（PII 刪除路徑不靠猜）", async () => {
    const tmp = await api("/partners", admin, { name: "臨時個人", isIndividual: true, idNo: "A100000001" });
    const id = tmp.json.id;
    const cleared = await api(`/partners/${id}/id-no`, admin, undefined, "DELETE");
    expect(cleared.status).toBe(200);
    expect(cleared.json.hasIdNo).toBe(false);
    expect((await api(`/partners/${id}/id-no`, admin)).json.idNo).toBeNull();
  });
});

describe("扣繳試算：費率是使用者填的，系統只做乘法", () => {
  it("費率未設定時試算為 0，並在回應提示「尚未設定費率」（不自己猜數字）", async () => {
    const est = await api("/withholding-payments/estimate", admin, {
      partnerId: landlordId,
      categoryId: rentCategoryId,
      payDate: "2026-03-05",
      grossAmount: 30_000,
      cashAccountId: bankId,
    });
    expect(est.status).toBe(200);
    expect(est.json.taxWithheld).toBe(0);
    expect(est.json.supplementWithheld).toBe(0);
    expect(est.json.netAmount).toBe(30_000);
    expect(est.json.notes.join("")).toContain("尚未設定");
    expect(est.json.notes.join("")).toContain("來源"); // 提示要說「請註明依據來源」
  });

  it("使用者填入費率＋依據來源後，試算為給付額 × 費率（basis point）", async () => {
    const patched = await api(
      `/withholding-categories/${rentCategoryId}`,
      admin,
      {
        taxRateBp: 1000, // 10%＝使用者自己查到並填入的值，本測試不主張這個數字正確
        supplementRateBp: 191, // 1.91%，用來釘住「bp 容得下小數費率」
        sourceNote: "依據：使用者自行查得之來源，查詢日 2026-07-30（測試用）",
      },
      "PATCH",
    );
    expect(patched.status).toBe(200);
    expect(patched.json.taxRateBp).toBe(1000);

    const est = await api("/withholding-payments/estimate", admin, {
      partnerId: landlordId,
      categoryId: rentCategoryId,
      payDate: "2026-03-05",
      grossAmount: 30_000,
      cashAccountId: bankId,
    });
    expect(est.json.taxWithheld).toBe(3_000);
    expect(est.json.supplementWithheld).toBe(573); // 30000 × 1.91% = 573
    expect(est.json.netAmount).toBe(30_000 - 3_000 - 573);
    expect(est.json.notes).toEqual([]); // 費率齊全時不該有雜訊
  });

  it("費率上限 10000 bp（打錯一個零在設定當下就擋掉）", async () => {
    const res = await api(`/withholding-categories/${rentCategoryId}`, admin, { taxRateBp: 10_001 }, "PATCH");
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain("10000");
  });

  it("費率可清回 NULL（＝尚未設定），與 0（查過、不用扣）語意不同", async () => {
    const cleared = await api(`/withholding-categories/${serviceCategoryId}`, admin, { taxRateBp: null }, "PATCH");
    expect(cleared.json.taxRateBp).toBeNull();
    const zero = await api(
      `/withholding-categories/${serviceCategoryId}`,
      admin,
      { taxRateBp: 0, supplementRateBp: 0 },
      "PATCH",
    );
    expect(zero.json.taxRateBp).toBe(0);
    // 0 是「已設定為不扣」→ 不該再出現「尚未設定」的提示（否則使用者永遠被同一句話煩）
    const est = await api("/withholding-payments/estimate", admin, {
      partnerId: designerId,
      categoryId: serviceCategoryId,
      payDate: "2026-04-10",
      grossAmount: 50_000,
      cashAccountId: bankId,
    });
    expect(est.json.taxWithheld).toBe(0);
    expect(est.json.notes).toEqual([]);
    // 收尾：把兩個費率都清回 NULL，後面的「未設定＋自填」才測得到
    await api(
      `/withholding-categories/${serviceCategoryId}`,
      admin,
      { taxRateBp: null, supplementRateBp: null },
      "PATCH",
    );
  });
});

describe("扣繳支出單：分錄與恆等式", () => {
  let firstPaymentId: number;
  let firstEntryId: number;

  it("建立成功：四行分錄（借費用／貸 2211、2212、現金），為 0 的行仍寫出", async () => {
    const res = await api("/withholding-payments", admin, {
      partnerId: landlordId,
      categoryId: rentCategoryId,
      payDate: "2026-03-05",
      grossAmount: 30_000,
      supplementWithheld: 0, // 這個月不扣補充保費（使用者覆寫試算的 573）
      cashAccountId: bankId,
      memo: "3 月辦公室租金",
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      grossAmount: 30_000,
      taxWithheld: 3_000, // 依使用者設定的 10% 試算
      supplementWithheld: 0,
      netAmount: 27_000,
    });
    firstPaymentId = res.json.id;
    firstEntryId = res.json.journalEntryId;
    expect(firstEntryId).toBeTruthy();

    const lines = await entryLines(firstEntryId);
    expect(lines).toEqual([
      { code: "6121", debit: 30_000, credit: 0 },
      { code: "2211", debit: 0, credit: 3_000 },
      { code: "2212", debit: 0, credit: 0 }, // 為 0 也寫出：對帳的人要看得出「這張沒扣補充保費」
      { code: "1103", debit: 0, credit: 27_000 },
    ]);
    const debit = lines.reduce((s, l) => s + l.debit, 0);
    const credit = lines.reduce((s, l) => s + l.credit, 0);
    expect(debit).toBe(credit);
  });

  it("覆寫試算值時照使用者填的入帳，並在回應說明差異", async () => {
    const res = await api("/withholding-payments", admin, {
      partnerId: landlordId,
      categoryId: rentCategoryId,
      payDate: "2026-04-05",
      grossAmount: 30_000,
      taxWithheld: 2_500, // 使用者手上的繳款單就是 2500（門檻／例外系統沒有模型）
      supplementWithheld: 0,
      cashAccountId: bankId,
    });
    expect(res.status).toBe(201);
    expect(res.json.taxWithheld).toBe(2_500); // 不可被系統試算的 3000 蓋掉
    expect(res.json.netAmount).toBe(27_500);
    expect(res.json.notes.join("")).toContain("覆寫");
    const lines = await entryLines(res.json.journalEntryId);
    expect(lines.find((l) => l.code === "2211")!.credit).toBe(2_500);
  });

  it("費率未設定時預設 0 並提示，使用者自填金額也記得住", async () => {
    const res = await api("/withholding-payments", admin, {
      partnerId: designerId,
      categoryId: serviceCategoryId, // 費率已清回 NULL
      payDate: "2026-04-10",
      grossAmount: 50_000,
      cashAccountId: bankId,
    });
    expect(res.status).toBe(201);
    expect(res.json.taxWithheld).toBe(0);
    expect(res.json.netAmount).toBe(50_000);
    expect(res.json.notes.join("")).toContain("尚未設定");

    const withOwn = await api("/withholding-payments", admin, {
      partnerId: designerId,
      categoryId: serviceCategoryId,
      payDate: "2026-05-10",
      grossAmount: 50_000,
      taxWithheld: 5_000,
      cashAccountId: bankId,
    });
    expect(withOwn.status).toBe(201);
    expect(withOwn.json.taxWithheld).toBe(5_000);
    expect(withOwn.json.netAmount).toBe(45_000);
    expect(withOwn.json.notes.join("")).toContain("自行填入");
  });

  it("net_amount 恆等式：資料庫存的淨額永遠等於 gross − tax − supplement", async () => {
    const rows = await db.select().from(schema.withholdingPayments);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.netAmount).toBe(r.grossAmount - r.taxWithheld - r.supplementWithheld);
    }
    // 清單有回連傳票，帳與單對得起來
    const list = (await api("/withholding-payments", admin)).json as { id: number; journalEntryId: number }[];
    expect(list.every((r) => !!r.journalEntryId)).toBe(true);
    expect(list.find((r) => r.id === firstPaymentId)!.journalEntryId).toBe(firstEntryId);
  });

  it("代扣合計超過給付總額被擋（否則實付會變負數）", async () => {
    const res = await api("/withholding-payments", admin, {
      partnerId: landlordId,
      categoryId: rentCategoryId,
      payDate: "2026-06-05",
      grossAmount: 10_000,
      taxWithheld: 9_000,
      supplementWithheld: 2_000,
      cashAccountId: bankId,
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("超過給付總額");
  });

  it("付款科目必須是現金科目（否則錢會從現金流量表消失）", async () => {
    const res = await api("/withholding-payments", admin, {
      partnerId: landlordId,
      categoryId: rentCategoryId,
      payDate: "2026-06-05",
      grossAmount: 30_000,
      cashAccountId: arId, // 1144 應收帳款
      supplementWithheld: 0,
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("不是現金科目");
  });

  it("非個人的交易對象不得開扣繳支出單，訊息要指出兩條出路", async () => {
    const res = await api("/withholding-payments", admin, {
      partnerId: companyId,
      categoryId: rentCategoryId,
      payDate: "2026-06-05",
      grossAmount: 30_000,
      supplementWithheld: 0,
      cashAccountId: bankId,
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("不是個人");
    expect(res.json.error).toContain("客戶與商品"); // 出路一：改勾個人
    expect(res.json.error).toContain("手工傳票"); // 出路二：仍要記代扣就自己開三腳分錄
    // 訊息不得斷言「對法人沒有扣繳問題」——那是未查證的稅法判斷，
    // 而且把它當成出路等於告訴使用者「你不需要做這件事」，那不是脫困路徑。
    // 限制的理由只能是本頁的適用範圍（年度憑單彙總依受領人分組）
    expect(res.json.error).not.toContain("沒有扣繳問題");
    expect(res.json.error).toContain("年度憑單");
  });

  it("類別的費用科目被停用後不得過帳，並指出去扣繳設定改科目", async () => {
    // 使用者自建的費用科目（可停用），先掛到類別上
    const created = await api("/accounts", admin, { code: "6197", name: "測試用委外費", type: "expense" });
    expect(created.status).toBe(201);
    const tmpCat = await api("/withholding-categories", admin, {
      label: "測試類別",
      expenseAccountCode: "6197",
    });
    expect(tmpCat.status).toBe(201);
    await api(`/accounts/${created.json.id}`, admin, { active: false }, "PATCH");

    const res = await api("/withholding-payments", admin, {
      partnerId: landlordId,
      categoryId: tmpCat.json.id,
      payDate: "2026-06-05",
      grossAmount: 1_000,
      cashAccountId: bankId,
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("科目已停用");
    expect(res.json.error).toContain("扣繳設定");

    // 停用的類別也不得再開單（出路是啟用它或改選其他類別）
    await api(`/withholding-categories/${tmpCat.json.id}`, admin, { active: false }, "PATCH");
    const off = await api("/withholding-payments", admin, {
      partnerId: landlordId,
      categoryId: tmpCat.json.id,
      payDate: "2026-06-05",
      grossAmount: 1_000,
      cashAccountId: bankId,
    });
    expect(off.status).toBe(422);
    expect(off.json.error).toContain("已停用");
  });

  it("類別的費用科目必須是費用類（指到資產科目會讓費用在損益表消失）", async () => {
    const res = await api("/withholding-categories", admin, {
      label: "科目類別錯誤的類別",
      expenseAccountCode: "1103",
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("費用");
  });
});

describe("年度彙總（1 月申報憑單的取數來源）", () => {
  beforeAll(async () => {
    // 前一年度的給付：用來釘住「跨年不混」
    const res = await api("/withholding-payments", admin, {
      partnerId: landlordId,
      categoryId: rentCategoryId,
      payDate: "2025-12-05",
      grossAmount: 20_000,
      taxWithheld: 2_000,
      supplementWithheld: 0,
      cashAccountId: bankId,
    });
    expect(res.status).toBe(201);
  });

  it("依受領人 × 類別分組，且只含該年度（依給付日）", async () => {
    const res = await api("/withholding-payments/summary?year=2026", admin);
    expect(res.status).toBe(200);
    const rows = res.json.rows as {
      partnerName: string;
      categoryId: number;
      count: number;
      grossAmount: number;
      taxWithheld: number;
      supplementWithheld: number;
      hasIdNo: boolean;
    }[];
    // 房東 × 租金（2026 年兩筆：3 月與 4 月）＋設計師 × 專業服務費（4 月與 5 月）
    const rent = rows.find((r) => r.partnerName === "房東王先生" && r.categoryId === rentCategoryId)!;
    expect(rent.count).toBe(2);
    expect(rent.grossAmount).toBe(60_000);
    expect(rent.taxWithheld).toBe(5_500); // 3000 + 2500
    expect(rent.supplementWithheld).toBe(0);
    expect(rent.hasIdNo).toBe(true); // 憑單要填身分證號，沒填要看得出來

    const service = rows.find((r) => r.categoryId === serviceCategoryId)!;
    expect(service.count).toBe(2);
    expect(service.grossAmount).toBe(100_000);
    expect(service.taxWithheld).toBe(5_000);

    // 前一年度的 20,000 不得混進 2026
    expect(rows.every((r) => r.grossAmount !== 20_000 || r.count !== 1)).toBe(true);
    expect(res.json.total.grossAmount).toBe(160_000);

    const prev = await api("/withholding-payments/summary?year=2025", admin);
    expect(prev.json.rows).toHaveLength(1);
    expect(prev.json.total).toMatchObject({ count: 1, grossAmount: 20_000, taxWithheld: 2_000 });
  });

  it("彙總不回傳身分證號明文（PII），只回有沒有填", async () => {
    const res = await api("/withholding-payments/summary?year=2026", admin);
    expect(JSON.stringify(res.json)).not.toContain("A123456789");
    expect(JSON.stringify(res.json)).not.toContain("F234567890");
  });

  it("同時回 2211／2212 餘額＝已扣未繳，且不提任何繳納期限（未查證）", async () => {
    const res = await api("/withholding-payments/summary?year=2026", admin);
    const liabilities = res.json.liabilities as { code: string; balance: number }[];
    // 2026：3000 + 2500 + 0 + 5000；2025：2000 → 合計 12500（餘額不分年度，是「現在還欠多少」）
    expect(liabilities.find((l) => l.code === "2211")!.balance).toBe(12_500);
    expect(liabilities.find((l) => l.code === "2212")!.balance).toBe(0);
    // 期限一律不由系統斷言：出現「日前」「期限」就是紀律被推翻
    expect(JSON.stringify(res.json)).not.toContain("期限");
    expect(JSON.stringify(res.json)).not.toContain("日前");
  });

  it("year 參數缺漏或無效回 400（不預設成今年，免得看到空表以為沒扣過）", async () => {
    expect((await api("/withholding-payments/summary", admin)).status).toBe(400);
    expect((await api("/withholding-payments/summary?year=abc", admin)).status).toBe(400);
  });
});

describe("2211／2212 是系統科目", () => {
  it("被標為系統科目且不可停用（扣繳支出單直接指定這兩碼）", async () => {
    for (const code of ["2211", "2212"]) {
      const account = await accountByCode(code);
      expect(account.isSystem).toBe(true);
      const res = await api(`/accounts/${account.id}`, admin, { active: false }, "PATCH");
      expect(res.status).toBe(422);
      expect(res.json.error).toContain("系統科目");
    }
  });
});

describe("權限（六角色）", () => {
  it("只有管理者與財務進得去扣繳頁的 API", async () => {
    const allowed = ["fin"];
    const denied = ["sal", "pur", "boss", "emp"];
    expect((await api("/withholding-categories", admin)).status).toBe(200);
    for (const who of allowed) {
      expect((await api("/withholding-categories", cookies[who]!)).status).toBe(200);
      expect((await api("/withholding-payments", cookies[who]!)).status).toBe(200);
      expect((await api("/withholding-payments/summary?year=2026", cookies[who]!)).status).toBe(200);
    }
    for (const who of denied) {
      expect((await api("/withholding-categories", cookies[who]!)).status).toBe(403);
      expect((await api("/withholding-payments", cookies[who]!)).status).toBe(403);
      expect((await api("/withholding-payments/summary?year=2026", cookies[who]!)).status).toBe(403);
    }
  });

  it("寫入同樣限管理者／財務（總經理唯讀也不例外——這頁看得到自然人的給付明細）", async () => {
    const body = {
      partnerId: landlordId,
      categoryId: rentCategoryId,
      payDate: "2026-07-05",
      grossAmount: 30_000,
      supplementWithheld: 0,
      cashAccountId: bankId,
    };
    for (const who of ["sal", "pur", "boss", "emp"]) {
      expect((await api("/withholding-payments", cookies[who]!, body)).status).toBe(403);
      expect(
        (await api("/withholding-categories", cookies[who]!, { label: "x", expenseAccountCode: "6188" })).status,
      ).toBe(403);
    }
    const fin = await api("/withholding-payments", cookies["fin"]!, body);
    expect(fin.status).toBe(201);
  });
});

describe("關帳期間", () => {
  it("已關帳的期間不得再開扣繳支出單（帳務鎖與其他單據同一條規則）", async () => {
    const closed = await api("/period-closes", admin, { period: "2025-12" });
    expect(closed.status).toBe(201);
    const res = await api("/withholding-payments", admin, {
      partnerId: landlordId,
      categoryId: rentCategoryId,
      payDate: "2025-12-20",
      grossAmount: 30_000,
      supplementWithheld: 0,
      cashAccountId: bankId,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("已關帳");
  });
});

describe("費率快照：分得出「漏設費率的 0」與「查過不用扣的 0」", () => {
  it("未設費率時建單 → 彙總標出筆數；補設費率後不回頭重算，舊單仍被標出", async () => {
    // 兩個類別：一個從頭到尾沒設費率、一個明確設成 0%（＝查過確實不用扣）
    const unset = await api("/withholding-categories", admin, {
      label: "尚未查證的支出", expenseAccountCode: "6124",
    });
    expect(unset.status).toBe(201);
    expect(unset.json.taxRateBp).toBeNull();
    const zero = await api("/withholding-categories", admin, {
      label: "查過確實不用扣的支出", expenseAccountCode: "6124",
      taxRateBp: 0, supplementRateBp: 0, sourceNote: "依據：使用者查證紀錄",
    });
    expect(zero.status).toBe(201);

    const mk = (categoryId: number, day: string) =>
      api("/withholding-payments", admin, {
        partnerId: landlordId, categoryId, payDate: `2026-03-${day}`,
        grossAmount: 10_000, cashAccountId: bankId,
      });
    expect((await mk(unset.json.id, "01")).status).toBe(201);
    expect((await mk(zero.json.id, "02")).status).toBe(201);

    const s1 = await api("/withholding-payments/summary?year=2026", admin);
    const unsetRow = s1.json.rows.find((r: { categoryId: number }) => r.categoryId === unset.json.id);
    const zeroRow = s1.json.rows.find((r: { categoryId: number }) => r.categoryId === zero.json.id);
    // 兩者的代扣金額都是 0，但只有「沒設費率」那筆被標出來
    expect(unsetRow.taxWithheld).toBe(0);
    expect(zeroRow.taxWithheld).toBe(0);
    expect(unsetRow.unsetTaxRateCount).toBe(1);
    expect(zeroRow.unsetTaxRateCount).toBe(0);

    // 事後補設費率：已建立的單據不回頭重算，快照也不變（否則歷史就被改寫了）
    const patched = await api(`/withholding-categories/${unset.json.id}`, admin, { taxRateBp: 1000 }, "PATCH");
    expect(patched.status).toBe(200);
    const s2 = await api("/withholding-payments/summary?year=2026", admin);
    const after = s2.json.rows.find((r: { categoryId: number }) => r.categoryId === unset.json.id);
    expect(after.taxWithheld).toBe(0);
    expect(after.unsetTaxRateCount).toBe(1);

    // 補設之後新建的單才會依費率試算，且不再被標記
    expect((await mk(unset.json.id, "10")).status).toBe(201);
    const s3 = await api("/withholding-payments/summary?year=2026", admin);
    const latest = s3.json.rows.find((r: { categoryId: number }) => r.categoryId === unset.json.id);
    expect(latest.count).toBe(2);
    expect(latest.taxWithheld).toBe(1_000); // 10,000 × 10%
    expect(latest.unsetTaxRateCount).toBe(1); // 仍是那一筆舊的
  });
});
