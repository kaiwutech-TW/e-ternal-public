/**
 * 會計科目維護：新增（含代號格式、代號首碼↔類別交叉驗證、重複）、停用/啟用、改類別、
 * 系統科目保護、改碼禁止、權限，以及 is_system 的升級校正。
 * 關鍵場景：停用一般科目後預設列表不再出現（下拉選不到），但 includeInactive=1 仍查得到——
 * 歷史傳票與明細分類帳靠這條相容性活著；系統科目停用一律 422，因為自動分錄直接指定其代號。
 * 停用之後不得再過帳（手工傳票與收付款單兩條路徑都測），否則「停用」只是把下拉選單藏起來。
 */
import { PGlite } from "@electric-sql/pglite";
import { SYSTEM_ACCOUNT_CODES } from "@tw-erp/core";
import { applyMigrations, schema } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { loginAs, setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let db: ReturnType<typeof drizzle>;
let admin: Record<string, string>;
const cookies: Record<string, Record<string, string>> = {};

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

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  db = drizzle(client);
  await seedAccounts(db);
  app = buildApp(db);
  admin = await setupAdmin(app);

  for (const [username, role] of [
    ["chen", "finance"],
    ["wang", "sales"],
    ["lin", "employee"],
    ["gao", "gm"],
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
});

describe("會計科目維護", () => {
  it("新增科目成功，預設啟用且非系統科目", async () => {
    const res = await api("/accounts", admin, { code: "6199", name: "測試費用", type: "expense" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ code: "6199", name: "測試費用", active: true, isSystem: false });
  });

  it("代號重複回 409", async () => {
    const res = await api("/accounts", admin, { code: "6199", name: "重複", type: "expense" });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("6199");
  });

  it("代號格式錯誤（非 4 碼數字、首碼超出 1-8）被擋", async () => {
    for (const code of ["abc", "619", "61999", "9101", "0101", ""]) {
      const res = await api("/accounts", admin, { code, name: "格式錯", type: "expense" });
      expect(res.status).toBe(400);
    }
  });

  it("代號首碼與類別不符被擋（400），訊息說得出應該選哪個類別", async () => {
    // 對抗驗證抓到的實例：6187 是營業費用，卻能建成 asset——之後這科目的費用在損益表消失
    const res = await api("/accounts", admin, { code: "6187", name: "誤建的費用", type: "asset" });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("6xxx");
    expect(res.json.error).toContain("營業費用");
    expect(res.json.error).toContain("expense");

    for (const [code, type] of [
      ["1901", "expense"],
      ["2901", "asset"],
      ["3901", "liability"],
      ["4901", "expense"],
      ["5901", "revenue"],
      ["8901", "asset"],
    ] as const) {
      expect((await api("/accounts", admin, { code, name: "類別不符", type })).status).toBe(400);
    }
    // 沒有一個被建起來
    const all: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    for (const code of ["6187", "1901", "2901", "3901", "4901", "5901", "8901"]) {
      expect(all.find((a) => a.code === code)).toBeUndefined();
    }
  });

  it("7xxx 營業外收支收入與費用都可建立", async () => {
    expect((await api("/accounts", admin, { code: "7112", name: "兌換利益", type: "revenue" })).status).toBe(201);
    expect((await api("/accounts", admin, { code: "7512", name: "兌換損失", type: "expense" })).status).toBe(201);
    expect((await api("/accounts", admin, { code: "7513", name: "首碼不符", type: "asset" })).status).toBe(400);
  });

  it("停用一般科目成功；停用後預設列表看不到、includeInactive=1 仍看得到", async () => {
    const rows: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    const target = rows.find((a) => a.code === "6199")!;

    const patched = await api(`/accounts/${target.id}`, admin, { active: false }, "PATCH");
    expect(patched.status).toBe(200);
    expect(patched.json.active).toBe(false);

    const active: AccountRow[] = (await api("/accounts", admin)).json;
    expect(active.find((a) => a.code === "6199")).toBeUndefined();
    const all: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    expect(all.find((a) => a.code === "6199")).toBeDefined();

    // 再啟用回來，確認是可逆的
    const reactivated = await api(`/accounts/${target.id}`, admin, { active: true }, "PATCH");
    expect(reactivated.json.active).toBe(true);
    expect(((await api("/accounts", admin)).json as AccountRow[]).find((a) => a.code === "6199")).toBeDefined();
  });

  it("已有分錄的科目「可以」停用——停用只影響下拉選單，歷史帳不動", async () => {
    // 6198 先入一張手工傳票再停用（借 6198 / 貸 1101）
    const created = await api("/accounts", admin, { code: "6198", name: "已入帳費用", type: "expense" });
    expect(created.status).toBe(201);
    const entry = await api("/journal-entries", admin, {
      entryDate: "2026-03-05",
      memo: "測試分錄",
      lines: [
        { accountCode: "6198", debit: 100, credit: 0 },
        { accountCode: "1101", debit: 0, credit: 100 },
      ],
    });
    expect(entry.status).toBe(201);

    const res = await api(`/accounts/${created.json.id}`, admin, { active: false }, "PATCH");
    expect(res.status).toBe(200);
    // 有餘額仍准停用（整理科目表是正當需求），但回傳要帶警告讓前端提示
    expect(res.json.warning).toContain("100");
    expect(res.json.warning).toContain("6198");
    // 明細分類帳仍查得到這筆（停用不影響歷史）
    const ledger = await api("/reports/ledger?accountCode=6198&from=2026-01-01&to=2026-12-31", admin);
    expect(ledger.status).toBe(200);
    expect(ledger.json.lines.length).toBe(1);
    expect(ledger.json.account).toMatchObject({ code: "6198", name: "已入帳費用" });
  });

  it("停用系統科目回 422 並說明原因", async () => {
    const rows: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    const cash = rows.find((a) => a.code === "1101")!;
    expect(cash.isSystem).toBe(true);
    const res = await api(`/accounts/${cash.id}`, admin, { active: false }, "PATCH");
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("系統科目");
  });

  it("系統科目仍可改名（只是不能停用）", async () => {
    const rows: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    const cash = rows.find((a) => a.code === "1101")!;
    const res = await api(`/accounts/${cash.id}`, admin, { name: "庫存現金（總部）" }, "PATCH");
    expect(res.status).toBe(200);
    expect(res.json.name).toBe("庫存現金（總部）");
    await api(`/accounts/${cash.id}`, admin, { name: "庫存現金" }, "PATCH");
  });

  it("改代號一律被擋（400）", async () => {
    const rows: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    const target = rows.find((a) => a.code === "6199")!;
    const res = await api(`/accounts/${target.id}`, admin, { code: "6197" }, "PATCH");
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("不可修改");
    expect(((await api("/accounts", admin)).json as AccountRow[]).find((a) => a.code === "6197")).toBeUndefined();
  });

  it("無餘額的科目停用不帶警告", async () => {
    const created = await api("/accounts", admin, { code: "6194", name: "沒動過的科目", type: "expense" });
    const res = await api(`/accounts/${created.json.id}`, admin, { active: false }, "PATCH");
    expect(res.status).toBe(200);
    expect(res.json.warning).toBeUndefined();
  });

  it("已停用的科目不可再過帳（停用不只是藏下拉選單）", async () => {
    // 6198 在前一個案例已被停用，且它有歷史分錄——歷史留著，但不准再新增
    const res = await api("/journal-entries", admin, {
      entryDate: "2026-03-06",
      memo: "停用後補記",
      lines: [
        { accountCode: "6198", debit: 50, credit: 0 },
        { accountCode: "1101", debit: 0, credit: 50 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("已停用");
    expect(res.json.error).toContain("6198");
    // 沒有半筆漏進去
    const ledger = await api("/reports/ledger?accountCode=6198&from=2026-01-01&to=2026-12-31", admin);
    expect(ledger.json.lines.length).toBe(1);
  });

  it("已停用的自建銀行科目不可用於收付款單（不是只有手工傳票要擋）", async () => {
    // 1101/1103 是系統科目停不掉，但使用者自建的銀行科目停用後仍可用 id 指定，這條路徑一樣要擋
    const bank = await api("/accounts", admin, {
      code: "1104", name: "銀行存款－已結清帳戶", type: "asset", isCash: true,
    });
    expect(bank.status).toBe(201);
    const partner = await api("/partners", admin, { name: "測試客戶", isCustomer: true });
    expect(partner.status).toBe(201);

    const ok = await api("/cash-docs", admin, {
      kind: "receipt", partnerId: partner.json.id, docDate: "2026-03-10", amount: 100, accountId: bank.json.id,
    });
    expect(ok.status).toBe(201);

    await api(`/accounts/${bank.json.id}`, admin, { active: false }, "PATCH");
    const blocked = await api("/cash-docs", admin, {
      kind: "receipt", partnerId: partner.json.id, docDate: "2026-03-11", amount: 100, accountId: bank.json.id,
    });
    expect(blocked.status).toBe(400);
    expect(blocked.json.error).toContain("已停用");
  });

  it("尚無分錄的科目可以改類別（代號首碼相符時）", async () => {
    const created = await api("/accounts", admin, { code: "7191", name: "類別打錯", type: "expense" });
    expect(created.status).toBe(201);
    const res = await api(`/accounts/${created.json.id}`, admin, { type: "revenue" }, "PATCH");
    expect(res.status).toBe(200);
    expect(res.json.type).toBe("revenue");
  });

  it("改類別仍須符合代號首碼（400）", async () => {
    const created = await api("/accounts", admin, { code: "6193", name: "費用科目", type: "expense" });
    const res = await api(`/accounts/${created.json.id}`, admin, { type: "asset" }, "PATCH");
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("營業費用");
    const after: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    expect(after.find((a) => a.code === "6193")).toMatchObject({ type: "expense" });
  });

  it("已有分錄的科目不可改類別（422，訊息含分錄筆數與可行的替代做法）", async () => {
    const created = await api("/accounts", admin, { code: "7192", name: "已入帳業外", type: "expense" });
    const entry = await api("/journal-entries", admin, {
      entryDate: "2026-03-07",
      memo: "業外支出",
      lines: [
        { accountCode: "7192", debit: 300, credit: 0 },
        { accountCode: "1101", debit: 0, credit: 300 },
      ],
    });
    expect(entry.status).toBe(201);

    const res = await api(`/accounts/${created.json.id}`, admin, { type: "revenue" }, "PATCH");
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("1 筆分錄");
    expect(res.json.error).toContain("停用");
    const after: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    expect(after.find((a) => a.code === "7192")).toMatchObject({ type: "expense" });
  });

  it("PATCH 空 body 回 400 而不是 500", async () => {
    const rows: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    const target = rows.find((a) => a.code === "6199")!;
    const res = await api(`/accounts/${target.id}`, admin, {}, "PATCH");
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("未提供");
  });

  it("科目不存在回 404", async () => {
    const res = await api("/accounts/99999", admin, { name: "不存在" }, "PATCH");
    expect(res.status).toBe(404);
  });

  it("沒有 DELETE 路由（科目只能停用不能刪）", async () => {
    const rows: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    const target = rows.find((a) => a.code === "6199")!;
    const res = await app.request(`/accounts/${target.id}`, { method: "DELETE", headers: admin });
    expect(res.status).toBe(404); // hono 沒有這條路由
  });

  it("權限：財務可寫入；業務、員工、總經理不可；讀取則所有人皆可", async () => {
    const ok = await api("/accounts", cookies["chen"]!, { code: "6196", name: "財務新增", type: "expense" });
    expect(ok.status).toBe(201);

    for (const who of ["wang", "lin", "gao"]) {
      const res = await api("/accounts", cookies[who]!, { code: "6195", name: "越權", type: "expense" });
      expect(res.status).toBe(403);
      const patch = await api(`/accounts/${ok.json.id}`, cookies[who]!, { name: "越權改名" }, "PATCH");
      expect(patch.status).toBe(403);
    }
    // 下拉選單要用，讀取不能鎖
    for (const who of ["chen", "wang", "lin", "gao"]) {
      expect((await api("/accounts", cookies[who]!)).status).toBe(200);
    }
  });

  it("重跑 seed 後全表 is_system 與 core 一致（使用者自建的科目不會被誤標）", async () => {
    await seedAccounts(db); // 模擬重新部署：校正必須不動使用者自建的 6199/6198/7192...
    const rows: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    const flagged = rows.filter((a) => a.isSystem).map((a) => a.code).sort();
    expect(flagged).toEqual([...SYSTEM_ACCOUNT_CODES].sort());
  });

  it("自建銀行科目可勾現金科目，並立刻進得了現金流量表與現金水位", async () => {
    const created = await api("/accounts", admin, {
      code: "1105",
      name: "銀行存款－玉山",
      type: "asset",
      isCash: true,
    });
    expect(created.status).toBe(201);
    expect(created.json.isCash).toBe(true);

    // 收一筆錢進這個自建帳戶：試算表看得到，現金流量表也必須看得到（這正是寫死 1101/1103 時消失的那筆）
    const partner = await api("/partners", admin, { name: "玉山客戶", isCustomer: true });
    const doc = await api("/cash-docs", admin, {
      kind: "receipt", partnerId: partner.json.id, docDate: "2026-05-06", amount: 5000, accountId: created.json.id,
    });
    expect(doc.status).toBe(201);

    const cf = (await api("/reports/cash-flow?from=2026-05-01&to=2026-05-31", admin)).json;
    expect(cf.detail.some((d: { amount: number }) => d.amount === 5000)).toBe(true);
    expect(cf.operating).toBe(5000);
  });

  it("現金科目限資產類：負債/費用科目勾現金一律 400（新增與修改都擋）", async () => {
    const bad = await api("/accounts", admin, { code: "2105", name: "短期借款－玉山", type: "liability", isCash: true });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("現金科目");
    expect(((await api("/accounts?includeInactive=1", admin)).json as AccountRow[]).find((a) => a.code === "2105"))
      .toBeUndefined();

    const liability = await api("/accounts", admin, { code: "2106", name: "應付租金", type: "liability" });
    expect(liability.status).toBe(201);
    const patched = await api(`/accounts/${liability.json.id}`, admin, { isCash: true }, "PATCH");
    expect(patched.status).toBe(400);
    expect(patched.json.error).toContain("現金科目");
  });

  it("種子科目改 is_cash 會回警告：下次啟動會被校正回預設值", async () => {
    const rows: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    const petty = rows.find((a) => a.code === "1102")!;
    expect(petty.isCash).toBe(true); // 1102 零用金本來就是現金科目（不在 CASH_CODES 裡正是這輪修的漏）
    const res = await api(`/accounts/${petty.id}`, admin, { isCash: false }, "PATCH");
    expect(res.status).toBe(200);
    expect(res.json.warning).toContain("下次系統啟動");
    await seedAccounts(db); // 校正回來，不影響後續案例
    const after: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    expect(after.find((a) => a.code === "1102")!.isCash).toBe(true);
  });

  it("現值與代號首碼不符：回 warning 而不是擋下操作（擋下會讓已入帳的錯配科目連改名都做不到）", async () => {
    // 舊資料才會有的狀態（交叉驗證上線前建的科目），這裡直接寫進資料庫模擬
    await db.insert(schema.accounts).values({ code: "6186", name: "舊資料錯配科目", type: "asset" });
    const rows: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    const broken = rows.find((a) => a.code === "6186")!;

    // 純改名要成功，但必須把錯配講出來——曾經改成回 400，結果是使用者被鎖死：
    // 送原類別撞 400、送正確類別撞 422（已有分錄），連停用都做不到
    const renamed = await api(`/accounts/${broken.id}`, admin, { name: "改個名字" }, "PATCH");
    expect(renamed.status).toBe(200);
    expect(renamed.json.name).toBe("改個名字");
    expect(renamed.json.warning).toContain("不符");
    expect(renamed.json.warning).toContain("費用 expense");

    // 改成正確類別就過（此科目尚無分錄），改完 warning 消失
    const fixed = await api(`/accounts/${broken.id}`, admin, { type: "expense" }, "PATCH");
    expect(fixed.status).toBe(200);
    expect(fixed.json.type).toBe("expense");
    expect(fixed.json.warning).toBeUndefined();
  });

  it("已入帳的錯配科目仍改得了名字（第二輪修正引入的回歸：改名曾被類別檢查連坐擋下）", async () => {
    await db.insert(schema.accounts).values({ code: "6189", name: "錯配且已入帳", type: "asset" });
    const rows: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    const broken = rows.find((a) => a.code === "6189")!;
    const cash = ((await api("/accounts?includeInactive=1", admin)).json as AccountRow[]).find((a) => a.code === "1101")!;
    const entry = await api("/journal-entries", admin, {
      entryDate: "2026-03-01",
      memo: "讓它有分錄",
      lines: [
        { accountCode: "6189", debit: 100, credit: 0 },
        { accountCode: cash.code, debit: 0, credit: 100 },
      ],
    });
    expect(entry.status).toBe(201);

    // 改名不帶 type：不該被「有分錄不可改類別」連坐擋下
    const renamed = await api(`/accounts/${broken.id}`, admin, { name: "改名成功" }, "PATCH");
    expect(renamed.status).toBe(200);
    expect(renamed.json.name).toBe("改名成功");

    // 停用也不該被擋（整理科目表是正當需求）
    const disabled = await api(`/accounts/${broken.id}`, admin, { active: false }, "PATCH");
    expect(disabled.status).toBe(200);

    // 但真的要改類別時，仍因為已有分錄而被擋
    const typeChange = await api(`/accounts/${broken.id}`, admin, { type: "expense" }, "PATCH");
    expect(typeChange.status).toBe(422);
    expect(typeChange.json.error).toContain("已有 1 筆分錄");
  });

  it("非現金科目不可當收付科目（錢會從現金流量表憑空消失）", async () => {
    const notCash = await api("/accounts", admin, { code: "1106", name: "銀行存款－忘了勾現金", type: "asset" });
    expect(notCash.status).toBe(201);
    expect(notCash.json.isCash).toBe(false);
    const partner = await api("/partners", admin, { name: "非現金測試客戶", isCustomer: true });

    const blocked = await api("/cash-docs", admin, {
      kind: "receipt", partnerId: partner.json.id, docDate: "2026-03-20", amount: 5000, accountId: notCash.json.id,
    });
    expect(blocked.status).toBe(422);
    expect(blocked.json.error).toContain("不是現金科目");

    // 勾成現金科目後就能用
    const marked = await api(`/accounts/${notCash.json.id}`, admin, { isCash: true }, "PATCH");
    expect(marked.status).toBe(200);
    const ok = await api("/cash-docs", admin, {
      kind: "receipt", partnerId: partner.json.id, docDate: "2026-03-20", amount: 5000, accountId: notCash.json.id,
    });
    expect(ok.status).toBe(201);
  });

  it("系統科目不可改類別（自動分錄依它的類別決定借貸方向）", async () => {
    const rows: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    const disposalGain = rows.find((a) => a.code === "7101")!;
    expect(disposalGain.isSystem).toBe(true);
    // 7xxx 首碼允許 revenue/expense 兩種，所以擋下它的唯一理由就是「它是系統科目」
    const res = await api(`/accounts/${disposalGain.id}`, admin, { type: "expense" }, "PATCH");
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("系統科目");
  });

  it("seedAccounts 冪等：重複套用科目數不變", async () => {
    const before = ((await api("/accounts?includeInactive=1", admin)).json as AccountRow[]).length;
    await seedAccounts(db);
    await seedAccounts(db);
    const after: AccountRow[] = (await api("/accounts?includeInactive=1", admin)).json;
    expect(after.length).toBe(before);
    // 重跑 seed 不會把使用者停用的科目救活（onConflictDoNothing 只新增不更新）
    expect(after.find((a) => a.code === "6198")!.active).toBe(false);
  });
});

/**
 * is_system / is_cash / active 的升級路徑（不是新裝路徑）。
 * 為什麼要另開一個資料庫：applyMigrations() 建的是空表，seedAccounts() 灌進去的列旗標天生就對，
 * 在那條路徑上怎麼測都是恆真。真正會壞的是「舊庫升級」——0013 加欄位時 DEFAULT false，
 * 而 seed 是 onConflictDoNothing 不更新既有列，於是舊部署的系統科目保護與現金科目判定會永遠失效。
 * 這裡先手動灌入幾筆旗標不對的舊列，再跑 seed 校正。
 */
describe("科目旗標的升級校正（舊資料庫）", () => {
  it("種子科目的 is_system 兩個方向都校正；使用者自建科目一律不碰", async () => {
    const client = new PGlite();
    await applyMigrations((sql) => client.exec(sql));
    const legacyDb = drizzle(client);

    // 模擬 0013 之前就存在的科目列：欄位剛加上、值全是 DEFAULT false
    await client.exec(`
      INSERT INTO accounts (code, name, type, active, is_system) VALUES
        ('1101', '庫存現金', 'asset', true, false),
        ('6131', '旅費', 'expense', true, false),
        ('6140', '折舊費用', 'expense', true, false),
        ('6121', '租金支出', 'expense', true, true),
        ('6901', '老闆自建費用', 'expense', true, false),
        ('6902', '被誤標的自建費用', 'expense', true, true);
    `);

    await seedAccounts(legacyDb);

    const rows = await legacyDb.select().from(schema.accounts);
    const byCode = new Map(rows.map((r) => [r.code, r]));
    // 舊列是系統科目 → 補標 true（否則停用保護對升級上來的庫完全失效）
    for (const code of ["1101", "6131", "6140"]) expect(byCode.get(code)!.isSystem).toBe(true);
    // 種子科目但非系統科目、卻被誤標 true → 校正回 false（不留幽靈系統科目）
    expect(byCode.get("6121")!.isSystem).toBe(false);
    // 使用者自建 → 維持原值，兩個方向都不動：
    // is_system/is_cash 對自建科目而言是「使用者自己的設定」（現金科目就是使用者勾的），
    // 校正若一路蓋過去，等於每次重啟就把使用者的設定清掉。6902 這種被誤標的自建科目
    // 只能靠人工處理，這是刻意接受的代價。
    expect(byCode.get("6901")!.isSystem).toBe(false);
    expect(byCode.get("6902")!.isSystem).toBe(true);
    const flagged = rows.filter((r) => r.isSystem).map((r) => r.code).sort();
    expect(flagged).toEqual([...SYSTEM_ACCOUNT_CODES, "6902"].sort());
    // 沒有把舊列的名稱蓋掉
    expect(byCode.get("6901")!.name).toBe("老闆自建費用");
  });

  it("舊列的 is_cash 被補上；使用者自建的現金科目不會被校正回 false", async () => {
    const client = new PGlite();
    await applyMigrations((sql) => client.exec(sql));
    const legacyDb = drizzle(client);

    // 舊庫：現金科目 is_cash 全是 DEFAULT false（現金流量表會整個抓不到錢），
    // 另有使用者自建的銀行帳戶科目已勾現金，以及一個被誤勾的種子科目
    await client.exec(`
      INSERT INTO accounts (code, name, type, active, is_system, is_cash) VALUES
        ('1101', '庫存現金', 'asset', true, false, false),
        ('1102', '零用金', 'asset', true, false, false),
        ('1103', '銀行存款', 'asset', true, false, false),
        ('1104', '銀行存款－玉山', 'asset', true, false, true),
        ('1301', '商品存貨', 'asset', true, false, true);
    `);

    await seedAccounts(legacyDb);

    const byCode = new Map((await legacyDb.select().from(schema.accounts)).map((r) => [r.code, r]));
    for (const code of ["1101", "1102", "1103"]) expect(byCode.get(code)!.isCash).toBe(true);
    // 使用者自建的銀行帳戶：他自己勾的，校正不得動它（否則重啟後現金流量表又少一個帳戶）
    expect(byCode.get("1104")!.isCash).toBe(true);
    // 種子科目被誤勾 → 校正回 false（存貨不是現金）
    expect(byCode.get("1301")!.isCash).toBe(false);
  });

  it("被停用的系統科目在 seed 時強制扳回啟用（否則自動分錄永遠過不了帳）", async () => {
    const client = new PGlite();
    await applyMigrations((sql) => client.exec(sql));
    const legacyDb = drizzle(client);

    // 舊庫的誤操作／舊資料：系統科目處於停用狀態。
    // PATCH 擋停用、前端對系統科目不給啟用按鈕，這個狀態沒有任何 UI 途徑救得回來，
    // 而收付款、進銷貨、報銷會在服務層直接 400「科目已停用」——所以 seed 必須自我修復。
    await client.exec(`
      INSERT INTO accounts (code, name, type, active, is_system) VALUES
        ('1103', '銀行存款', 'asset', false, true),
        ('6188', '雜項費用', 'expense', false, true),
        ('6121', '租金支出', 'expense', false, false);
    `);

    await seedAccounts(legacyDb);

    const byCode = new Map((await legacyDb.select().from(schema.accounts)).map((r) => [r.code, r]));
    expect(byCode.get("1103")!.active).toBe(true);
    expect(byCode.get("6188")!.active).toBe(true);
    // 非系統的種子科目使用者有權停用，不可被 seed 一併救活
    expect(byCode.get("6121")!.active).toBe(false);
  });
});
