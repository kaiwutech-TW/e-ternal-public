/**
 * 週期性支出驗收（0047）：每月/每季/每年固定要付出去的錢。
 *
 * 要守住的五件事：
 *  1. 這是計畫不是負債——不產任何傳票、不進應付帳款
 *  2. 依據欄必填（零斷言紀律的落點：系統不預設金額與頻率，出處由使用者自己寫）
 *  3. 週期只有「每 N 個月」的純算術；大小月取月底；重複展開不生重複期；60 期上限
 *  4. 「這期付了沒」一律推導：指向的報銷單／傳票存活即結清，報銷單作廢自動回到未結清
 *  5. 一張單只能對一期；已結清的期鎖住（不能改、不能刪、不能重對）
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { seedAccounts } from "../src/services/seed.ts";
import { loginAs, setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let admin: Record<string, string>;
let employeeId: number;
let rentId: number; // 房租（每月）
let insId: number; // 保費（每月，無交易對象）

async function api(path: string, headers: Record<string, string>, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
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
  admin = await setupAdmin(app);
  employeeId = (await api("/employees", admin, { name: "負責人" })).json.id;
});

describe("建立與零斷言紀律", () => {
  it("依據欄空白擋下，訊息說清楚為什麼要填", async () => {
    const res = await api("/recurring-payables", admin, {
      name: "辦公室租金",
      basis: "   ",
      intervalMonths: 1,
      dayOfMonth: 5,
      defaultAmount: 38_000,
      startDate: "2026-01-05",
    });
    expect(res.status).toBe(422); // 服務層擋純空白（zod min(1) 對 "   " 是放行的）
    expect(res.json.error).toContain("依據");
  });

  it("建立每月房租與每月保費（保費無交易對象）", async () => {
    const rent = await api("/recurring-payables", admin, {
      name: "辦公室租金",
      basis: "租賃契約第 3 條（我自己查的：合約正本在合約頁附件）",
      intervalMonths: 1,
      dayOfMonth: 5,
      defaultAmount: 38_000,
      startDate: "2026-01-05",
      defaultAccountCode: "6121",
    });
    expect(rent.status).toBe(201);
    rentId = rent.json.id;
    const ins = await api("/recurring-payables", admin, {
      name: "勞健保費",
      basis: "投保單位繳款單（金額依每月繳款單為準，系統不代算）",
      intervalMonths: 1,
      dayOfMonth: 25,
      defaultAmount: 9_000,
      startDate: "2026-01-25",
    });
    expect(ins.status).toBe(201);
    expect(ins.json.partnerId).toBeNull();
    insId = ins.json.id;
  });

  it("不存在或已停用的預設科目擋下", async () => {
    const res = await api("/recurring-payables", admin, {
      name: "亂填科目",
      basis: "測試",
      intervalMonths: 1,
      dayOfMonth: 1,
      startDate: "2026-01-01",
      defaultAccountCode: "9999",
    });
    expect(res.status).toBe(404);
  });
});

describe("展開排程（純算術）", () => {
  it("每月：展開到年底＝12 期；重複展開不生重複期", async () => {
    const res = await api(`/recurring-payables/${rentId}/items/generate`, admin, { to: "2026-12-31" });
    expect(res.status).toBe(201);
    expect(res.json).toHaveLength(12);
    expect(res.json[0]).toMatchObject({ seq: 1, dueDate: "2026-01-05", amount: 38_000, settled: false });
    expect(res.json[11].dueDate).toBe("2026-12-05");
    const again = await api(`/recurring-payables/${rentId}/items/generate`, admin, { to: "2026-12-31" });
    expect(again.json).toHaveLength(12); // 同樣 12 期，沒有長出第 13 期
  });

  it("每季/每半年/每年都只是算術；大小月取月底（31 號起排的 2 月是 28）", async () => {
    const cases = [
      { months: 3, expect: ["2026-01-31", "2026-04-30", "2026-07-31", "2026-10-31"] },
      { months: 6, expect: ["2026-01-31", "2026-07-31"] },
      { months: 12, expect: ["2026-01-31"] },
    ];
    for (const c of cases) {
      const p = await api("/recurring-payables", admin, {
        name: `每 ${c.months} 個月的支出`,
        basis: "測試自填",
        intervalMonths: c.months,
        dayOfMonth: 31,
        defaultAmount: 1000,
        startDate: "2026-01-31",
      });
      const items = await api(`/recurring-payables/${p.json.id}/items/generate`, admin, { to: "2026-12-31" });
      expect(items.json.map((i: { dueDate: string }) => i.dueDate)).toEqual(c.expect);
    }
    // 每月 31 號的一整年：2 月取 28（2026 非閏年）、4/6/9/11 取 30
    const monthly = await api("/recurring-payables", admin, {
      name: "每月 31 號",
      basis: "測試自填",
      intervalMonths: 1,
      dayOfMonth: 31,
      defaultAmount: 1000,
      startDate: "2026-01-31",
    });
    const all = await api(`/recurring-payables/${monthly.json.id}/items/generate`, admin, { to: "2026-12-31" });
    expect(all.json.map((i: { dueDate: string }) => i.dueDate.slice(5))).toEqual([
      "01-31", "02-28", "03-31", "04-30", "05-31", "06-30",
      "07-31", "08-31", "09-30", "10-31", "11-30", "12-31",
    ]);
  });

  it("一次超過 60 期擋下，訊息提醒年份可能打錯", async () => {
    const p = await api("/recurring-payables", admin, {
      name: "打錯年份",
      basis: "測試自填",
      intervalMonths: 1,
      dayOfMonth: 1,
      defaultAmount: 100,
      startDate: "2026-01-01",
    });
    const res = await api(`/recurring-payables/${p.json.id}/items/generate`, admin, { to: "2036-01-01" });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("60");
  });
});

describe("結清＝指向既有單據（不生成任何單據）", () => {
  let firstItemId: number;
  let claimId: number;

  it("用公司支付的報銷單結清房租第一期；報銷單本身照既有流程建立", async () => {
    const items = (await api(`/recurring-payables/${rentId}/items`, admin)).json;
    firstItemId = items[0].id;
    const claim = await api("/expense-claims", admin, {
      employeeId,
      claimDate: "2026-01-05",
      paidBy: "company",
      // 6121 租金支出**不在** EXPENSE_CATEGORIES（報銷分類只有 6112/6115/613x/6188），
      // 所以房租今天只能報成「其他」或改走傳票——這正是兩條結清路徑都要有的原因
      items: [{ accountCode: "6188", description: "1 月租金", docType: "other", amount: 38_000 }],
    });
    expect(claim.status).toBe(201);
    claimId = claim.json.id;
    const accounts = (await api("/accounts", admin)).json;
    const cash = accounts.find((a: { code: string }) => a.code === "1101");
    expect((await api(`/expense-claims/${claimId}/approve`, admin, { accountId: cash.id })).status).toBe(200);

    const settled = await api(`/recurring-payables/${rentId}/items/${firstItemId}/settle`, admin, {
      expenseClaimId: claimId,
    });
    expect(settled.status).toBe(200);
    expect(settled.json.find((i: { id: number }) => i.id === firstItemId)).toMatchObject({
      expenseClaimId: claimId,
      journalEntryId: null,
      settled: true,
    });
  });

  it("已結清的期鎖住：不能改、不能刪、不能重對；一張單只能對一期", async () => {
    expect((await api(`/recurring-payables/${rentId}/items/${firstItemId}`, admin, { amount: 1 }, "PATCH")).status).toBe(409);
    expect((await api(`/recurring-payables/${rentId}/items/${firstItemId}`, admin, undefined, "DELETE")).status).toBe(409);
    const items = (await api(`/recurring-payables/${rentId}/items`, admin)).json;
    const second = items[1].id;
    const dup = await api(`/recurring-payables/${rentId}/items/${second}/settle`, admin, { expenseClaimId: claimId });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toContain("只能對一期");
  });

  it("兩個結清指標必須擇一：都給或都不給都擋", async () => {
    const items = (await api(`/recurring-payables/${rentId}/items`, admin)).json;
    const third = items[2].id;
    expect((await api(`/recurring-payables/${rentId}/items/${third}/settle`, admin, {})).status).toBe(422);
    expect(
      (await api(`/recurring-payables/${rentId}/items/${third}/settle`, admin, { expenseClaimId: 1, journalEntryId: 1 }))
        .status,
    ).toBe(422);
  });

  it("保費用自己開的手工傳票結清（沒有憑證可報銷的走這條）", async () => {
    await api(`/recurring-payables/${insId}/items/generate`, admin, { to: "2026-03-31" });
    const items = (await api(`/recurring-payables/${insId}/items`, admin)).json;
    const entry = await api("/journal-entries", admin, {
      entryDate: "2026-01-25",
      memo: "1 月保費繳納",
      lines: [
        { accountCode: "2203", debit: 9_000, credit: 0 },
        { accountCode: "1101", debit: 0, credit: 9_000 },
      ],
    });
    expect(entry.status).toBe(201);
    const settled = await api(`/recurring-payables/${insId}/items/${items[0].id}/settle`, admin, {
      journalEntryId: entry.json.id,
    });
    expect(settled.status).toBe(200);
    expect(settled.json[0]).toMatchObject({ journalEntryId: entry.json.id, settled: true });
  });

  it("報銷單作廢 → 該期自動回到未結清（狀態一律推導，不存欄位）", async () => {
    const voided = await api(`/expense-claims/${claimId}/void`, admin, { reason: "重開一張" });
    expect(voided.status).toBe(200);
    const items = (await api(`/recurring-payables/${rentId}/items`, admin)).json;
    expect(items.find((i: { id: number }) => i.id === firstItemId)).toMatchObject({
      expenseClaimId: claimId, // 指標還在
      settled: false, // 但已經不算結清
    });
  });

  it("解除結清：指標清掉，那張傳票原封不動", async () => {
    const items = (await api(`/recurring-payables/${insId}/items`, admin)).json;
    const entryId = items[0].journalEntryId;
    const res = await api(`/recurring-payables/${insId}/items/${items[0].id}/unsettle`, admin, {});
    expect(res.status).toBe(200);
    expect(res.json[0]).toMatchObject({ journalEntryId: null, settled: false });
    expect((await api(`/journal-entries/${entryId}`, admin)).status).toBe(200);
  });
});

describe("待付清單與「計畫不是負債」", () => {
  it("待付只列未結清的期，逾期在前；作廢報銷單的那期會回列", async () => {
    const due = (await api("/recurring-payables/due?within=366", admin)).json;
    const rentRows = due.filter((d: { payableId: number }) => d.payableId === rentId);
    // 12 期全部未結清（第一期的報銷單已作廢而回列）
    expect(rentRows).toHaveLength(12);
    expect(rentRows[0].dueDate <= rentRows[1].dueDate).toBe(true);
    expect(rentRows[0]).toMatchObject({ payableName: "辦公室租金", defaultAccountCode: "6121" });
    // 停用後整筆退出清單
    await api(`/recurring-payables/${rentId}`, admin, { status: "ended" }, "PATCH");
    const after = (await api("/recurring-payables/due?within=366", admin)).json;
    expect(after.filter((d: { payableId: number }) => d.payableId === rentId)).toHaveLength(0);
  });

  it("計畫不進帳：建立與展開沒有產生任何傳票，應付帳款一毛都沒動", async () => {
    const before = (await api("/journal-entries?limit=500", admin)).json;
    const p = await api("/recurring-payables", admin, {
      name: "不該產傳票的支出",
      basis: "測試自填",
      intervalMonths: 1,
      dayOfMonth: 10,
      defaultAmount: 5_000,
      startDate: "2027-01-10",
    });
    await api(`/recurring-payables/${p.json.id}/items/generate`, admin, { to: "2027-06-30" });
    const after = (await api("/journal-entries?limit=500", admin)).json;
    expect(after.length).toBe(before.length);
  });
});

describe("權限", () => {
  it("業務與採購都進不去（這頁看得到勞健保與稅款金額）", async () => {
    await api("/users", admin, { username: "sal2", displayName: "業務", password: "secret-test", role: "sales" });
    const sal = await loginAs(app, "sal2", "secret-test");
    expect((await api("/recurring-payables", sal)).status).toBe(403);
    expect((await api("/recurring-payables/due", sal)).status).toBe(403);
    expect((await api(`/recurring-payables/${insId}/items`, sal)).status).toBe(403);
  });
});
