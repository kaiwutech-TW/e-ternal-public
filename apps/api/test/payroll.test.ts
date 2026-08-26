/**
 * 薪資驗收（0041）。
 *
 * 要守住的五件事：
 *  1. 系統不內建法定數字：沒設除數／費率／給薪比率＝該項算 0 ＋ warnings 明講（不靜默）
 *  2. 薪資檔是歷次紀錄：同人同生效日擋重複；算薪取「月底仍生效的最新一列」
 *  3. 加班費按日型分段套倍率（月薪÷除數、時薪直接用）；金額整數元
 *  4. 定案過帳：借 6111/6113/6114＝貸 2202/2212/2203、借貸平衡；期間鎖擋定案；定案後不可重算不可調整
 *  5. 草稿重算保留手動調整項；未建薪資檔的員工出現在明細（算 0）而不是消失
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
let monthlyEmpId: number; // 月薪 60000、除數 240 → 時薪 250
let hourlyEmpId: number; // 時薪 200
let bareEmpId: number; // 沒薪資檔
let runId: number;

const MONTH = "2026-06";

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
  await seedAccounts(db); // 定案過帳要用 6111 等系統科目
  app = buildApp(db);
  admin = await setupAdmin(app);
  monthlyEmpId = (await api("/employees", admin, { name: "月薪員" })).json.id;
  hourlyEmpId = (await api("/employees", admin, { name: "時薪員" })).json.id;
  bareEmpId = (await api("/employees", admin, { name: "沒建檔" })).json.id;

  // 月薪員：60000／除數 240（時薪 250）；勞健保員工負擔 1000+500、雇主 2000+1500、勞退 1200
  await api("/employee-salaries", admin, {
    employeeId: monthlyEmpId,
    validFrom: "2026-01-01",
    payType: "monthly",
    baseAmount: 55000, // 先填錯的一列（測歷次：算薪要取最新生效列）
  });
  await api("/employee-salaries", admin, {
    employeeId: monthlyEmpId,
    validFrom: "2026-05-01",
    payType: "monthly",
    baseAmount: 60000,
    hourlyDivisor: 240,
    laborInsEmployee: 1000,
    healthInsEmployee: 500,
    laborInsEmployer: 2000,
    healthInsEmployer: 1500,
    pensionEmployer: 1200,
    sourceNote: "測試自填",
  });
  await api("/employee-salaries", admin, {
    employeeId: hourlyEmpId,
    validFrom: "2026-01-01",
    payType: "hourly",
    baseAmount: 200,
  });

  // 加班費率（使用者自填的倍率）：平日前 2 小時 1.5 倍、之後 2 倍；休息日未設定（要看到警告）
  await api("/overtime-rates", admin, { dayType: "workday", fromMinutes: 0, multiplierBp: 15000, sourceNote: "測試" });
  await api("/overtime-rates", admin, { dayType: "workday", fromMinutes: 120, multiplierBp: 20000 });

  // 出勤材料：六月排班 + 打卡 + 核准的加班單
  const shiftId = (await api("/shifts", admin, { code: "P1", name: "班", startTime: "09:00", endTime: "18:00", breaks: [{ start: "12:00", end: "13:00" }] })).json.id;
  await api("/schedules", admin, { employeeIds: [hourlyEmpId], shiftId, from: "2026-06-03", to: "2026-06-03" });
  // 時薪員 6/3 打滿 8 小時（直接寫 punches 太繞——用補卡申請＋自動核准最短路徑：
  // 時薪員沒有主管與部門 → 送單即核准並寫卡）
  const hourlyUser = await (async () => {
    await api("/users", admin, { username: "pt", displayName: "PT", password: "secret-test", role: "employee", employeeId: hourlyEmpId });
    return loginAs(app, "pt", "secret-test");
  })();
  await api("/hr-requests", hourlyUser, { kind: "punch_correction", workDate: "2026-06-03", direction: "in", claimedTime: "09:00" });
  await api("/hr-requests", hourlyUser, { kind: "punch_correction", workDate: "2026-06-03", direction: "out", claimedTime: "17:00" });
  // 月薪員：平日加班 3 小時（180 分）＋ 休息日 2 小時（費率沒設 → 警告）
  const monthlyUser = await (async () => {
    await api("/users", admin, { username: "ft", displayName: "FT", password: "secret-test", role: "employee", employeeId: monthlyEmpId });
    return loginAs(app, "ft", "secret-test");
  })();
  await api("/hr-requests", monthlyUser, { kind: "overtime", workDate: "2026-06-10", dayType: "workday", minutes: 180 });
  await api("/hr-requests", monthlyUser, { kind: "overtime", workDate: "2026-06-14", dayType: "restday", minutes: 120 });
});

describe("薪資檔", () => {
  it("同人同生效日擋重複，訊息指路「新增更正列」", async () => {
    const res = await api("/employee-salaries", admin, {
      employeeId: monthlyEmpId,
      validFrom: "2026-05-01",
      payType: "monthly",
      baseAmount: 61000,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("歷次紀錄");
  });
});

describe("發薪作業（草稿）", () => {
  it("建立草稿：三個員工都在（含沒建檔的），數字對得上手算", async () => {
    const res = await api("/payroll-runs", admin, { month: MONTH });
    expect(res.status).toBe(201);
    runId = res.json.id;
    expect(res.json.status).toBe("draft");
    expect(res.json.items).toHaveLength(3);

    const monthly = res.json.items.find((i: { employeeId: number }) => i.employeeId === monthlyEmpId);
    // 本薪＝月薪整額（取 5/1 生效的 60000，不是 1/1 的 55000）
    expect(monthly.basePay).toBe(60000);
    // 加班費：時薪 250；平日 180 分＝前 120 分×1.5 ＋ 後 60 分×2.0 ＝ 250×(2×1.5＋1×2) ＝ 1250
    expect(monthly.overtimePay).toBe(1250);
    // 休息日費率未設 → 警告明講、該日型算 0
    expect(monthly.detail.warnings.join()).toContain("休息日");
    expect(monthly.laborInsEmployee).toBe(1000);
    expect(monthly.netPay).toBe(60000 + 1250 - 1000 - 500);

    const hourly = res.json.items.find((i: { employeeId: number }) => i.employeeId === hourlyEmpId);
    // 時薪 200 × 8 小時（09-17 兩張更正卡）＝ 1600
    expect(hourly.basePay).toBe(1600);
    expect(hourly.netPay).toBe(1600);

    const bare = res.json.items.find((i: { employeeId: number }) => i.employeeId === bareEmpId);
    expect(bare.basePay).toBe(0);
    expect(bare.detail.warnings.join()).toContain("未設薪資檔");
  });

  it("同月不能開第二份；亂格式月份 400", async () => {
    expect((await api("/payroll-runs", admin, { month: MONTH })).status).toBe(409);
    expect((await api("/payroll-runs", admin, { month: "2026-6" })).status).toBe(400);
  });

  it("手動調整（加項/減項/備註）改實發；重算保留手動調整", async () => {
    const run = (await api(`/payroll-runs/${runId}`, admin)).json;
    const monthly = run.items.find((i: { employeeId: number }) => i.employeeId === monthlyEmpId);
    const patched = await api(`/payroll-items/${monthly.id}`, admin, { otherEarning: 3000, otherDeduction: 200, memo: "測試獎金；代扣稅 200" }, "PATCH");
    expect(patched.status).toBe(200);
    expect(patched.json.netPay).toBe(60000 + 1250 + 3000 - 200 - 1000 - 500);
    const recalced = (await api(`/payroll-runs/${runId}/recalc`, admin, {})).json;
    const again = recalced.items.find((i: { employeeId: number }) => i.employeeId === monthlyEmpId);
    expect(again.otherEarning).toBe(3000);
    expect(again.memo).toContain("獎金");
    expect(again.netPay).toBe(60000 + 1250 + 3000 - 200 - 1000 - 500);
  });
});

describe("定案與過帳", () => {
  it("定案：過帳月底計提傳票，借 6111/6113/6114＝貸 2202/2212/2203，借貸平衡", async () => {
    const res = await api(`/payroll-runs/${runId}/finalize`, admin, {});
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("finalized");
    const entryId = res.json.journalEntryId;
    expect(entryId).toBeTruthy();
    const entry = (await api(`/journal-entries/${entryId}`, admin)).json;
    expect(entry.entryDate).toBe("2026-06-30");
    const byCode = new Map(entry.lines.map((l: { code: string; debit: number; credit: number }) => [l.code, l]));
    const gross = 60000 + 1250 + 3000 - 200 + 1600; // 月薪員毛額 + 時薪員
    expect((byCode.get("6111") as { debit: number }).debit).toBe(gross);
    expect((byCode.get("6113") as { debit: number }).debit).toBe(3500); // 雇主 2000+1500
    expect((byCode.get("6114") as { debit: number }).debit).toBe(1200);
    expect((byCode.get("2202") as { credit: number }).credit).toBe(gross - 1500); // 實發＝毛額−員工保費
    expect((byCode.get("2212") as { credit: number }).credit).toBe(1500);
    expect((byCode.get("2203") as { credit: number }).credit).toBe(4700);
    const totalDebit = entry.lines.reduce((s: number, l: { debit: number }) => s + l.debit, 0);
    const totalCredit = entry.lines.reduce((s: number, l: { credit: number }) => s + l.credit, 0);
    expect(totalDebit).toBe(totalCredit);
  });

  it("定案後：不可再定案、不可重算、不可調整明細", async () => {
    expect((await api(`/payroll-runs/${runId}/finalize`, admin, {})).status).toBe(422);
    expect((await api(`/payroll-runs/${runId}/recalc`, admin, {})).status).toBe(422);
    const run = (await api(`/payroll-runs/${runId}`, admin)).json;
    expect((await api(`/payroll-items/${run.items[0].id}`, admin, { otherEarning: 1 }, "PATCH")).status).toBe(422);
  });

  it("期間鎖：關帳月份的發薪作業不能定案", async () => {
    // 2026-01 沒有任何單據，直接關到 1 月
    const close = await api("/period-closes", admin, { period: "2026-01" });
    expect(close.status).toBe(201);
    const run = await api("/payroll-runs", admin, { month: "2026-01" });
    expect(run.status).toBe(201);
    const fin = await api(`/payroll-runs/${run.json.id}/finalize`, admin, {});
    expect(fin.status).not.toBe(200);
    expect((await api("/period-closes/latest", admin, undefined, "DELETE")).status).toBe(200); // 還原
  });

  it("毛額為 0（該月沒有任何生效的薪資檔）不能定案，訊息講清楚原因", async () => {
    // 2025-12：所有薪資列都是 2026-01-01 之後才生效 → 全員算 0 → 定案沒有意義
    const run = await api("/payroll-runs", admin, { month: "2025-12" });
    expect(run.status).toBe(201);
    const fin = await api(`/payroll-runs/${run.json.id}/finalize`, admin, {});
    expect(fin.status).toBe(422);
    expect(fin.json.error).toContain("毛額");
  });
});

describe("級距按單套用＋固定時數計（0042，golden sample 對數字的產物）", () => {
  it("兩天各 2 小時＝兩次第一級（不是月合計 4 小時拆兩級）；例假日做 6 給 8；時薪取兩位小數", async () => {
    // 專用員工（無主管→申請單自動核准）：月薪 65000／除數 240 → 時薪 270.8333… → 取 270.83
    const empId = (await api("/employees", admin, { name: "級距員" })).json.id;
    await api("/employee-salaries", admin, {
      employeeId: empId,
      validFrom: "2026-01-01",
      payType: "monthly",
      baseAmount: 65000,
      hourlyDivisor: 240,
    });
    await api("/users", admin, { username: "tier", displayName: "T", password: "secret-test", role: "employee", employeeId: empId });
    const u = await loginAs(app, "tier", "secret-test");
    // 平日費率沿用 beforeAll 的 0-2h 1.5 倍、2h+ 2.0 倍；例假日：0-8h 以固定 8 小時計 ×1.0、8h+ 1.34 倍
    await api("/overtime-rates", admin, { dayType: "regular_off", fromMinutes: 0, multiplierBp: 10000, fixedMinutes: 480, sourceNote: "測試" });
    await api("/overtime-rates", admin, { dayType: "regular_off", fromMinutes: 480, multiplierBp: 13400 });
    await api("/hr-requests", u, { kind: "overtime", workDate: "2026-07-06", dayType: "workday", minutes: 120 });
    await api("/hr-requests", u, { kind: "overtime", workDate: "2026-07-07", dayType: "workday", minutes: 120 });
    await api("/hr-requests", u, { kind: "overtime", workDate: "2026-07-12", dayType: "regular_off", minutes: 360 });

    const run = await api("/payroll-runs", admin, { month: "2026-07" });
    expect(run.status).toBe(201);
    const item = run.json.items.find((i: { employeeId: number }) => i.employeeId === empId);
    // 平日：每張單獨立套級距＝各 120 分全在第一級 ×1.5 → 2 × (2h × 270.83 × 1.5) ＝ 1625.0
    //（按月合計的錯誤算法會是 120@1.5＋120@2.0 ＝ 1896——這正是修掉的 bug）
    // 例假日：做 6 給 8 → 8h × 270.83 × 1.0 ＝ 2166.6
    expect(item.overtimePay).toBe(Math.round(2 * 2 * 270.83 * 1.5 + 8 * 270.83));
    expect(item.overtimePay).toBe(3792); // 1625.0 + 2166.6 = 3791.6 → 3792（時薪先取兩位小數才會是這個數）
  });
});

describe("伙食津貼＋遲到早退扣款＋應免稅拆分（0044，golden sample 第二輪的產物）", () => {
  it("入基底：時薪含伙食津貼；請假與早退扣款按本薪:津貼拆分、各自四捨五入後相加", async () => {
    // 月薪 57000＋伙食 3000 入基底／除數 240 → 時薪 (57000+3000)/240 ＝ 250
    const empId = (await api("/employees", admin, { name: "伙食員" })).json.id;
    await api("/employee-salaries", admin, {
      employeeId: empId,
      validFrom: "2026-01-01",
      payType: "monthly",
      baseAmount: 57000,
      hourlyDivisor: 240,
      mealAllowance: 3000,
      mealAllowanceInBase: true,
    });
    await api("/users", admin, { username: "meal", displayName: "M", password: "secret-test", role: "employee", employeeId: empId });
    const u = await loginAs(app, "meal", "secret-test");
    // 病假給薪比率 50%（使用者自填）：8 小時 → 扣 8×250×0.5 ＝ 1000 → 拆 950／50
    const types = (await api("/leave-types", admin)).json;
    const sick = types.find((t: { code: string }) => t.code === "sick");
    await api(`/leave-types/${sick.id}`, admin, { payRatioPercent: 50, sourceNote: "測試自填" }, "PATCH");
    await api("/hr-requests", u, {
      kind: "leave",
      leaveTypeId: sick.id,
      startAt: "2026-09-08T09:00:00+08:00",
      endAt: "2026-09-08T18:00:00+08:00",
      minutes: 480,
    });
    // 早退 56 分：排班 09-18、打卡 09:00 進 17:04 出 → 56×250÷60 ＝ 233.33 → 拆 222＋12 ＝ 234
    //（未拆分取整會是 233——「各自四捨五入後相加」正是 golden sample 對出來的行為）
    const shiftId = (await api("/shifts", admin, { code: "P2", name: "班2", startTime: "09:00", endTime: "18:00", breaks: [{ start: "12:00", end: "13:00" }] })).json.id;
    await api("/schedules", admin, { employeeIds: [empId], shiftId, from: "2026-09-09", to: "2026-09-09" });
    await api("/hr-requests", u, { kind: "punch_correction", workDate: "2026-09-09", direction: "in", claimedTime: "09:00" });
    await api("/hr-requests", u, { kind: "punch_correction", workDate: "2026-09-09", direction: "out", claimedTime: "17:04" });

    const run = await api("/payroll-runs", admin, { month: "2026-09" });
    expect(run.status).toBe(201);
    const item = run.json.items.find((i: { employeeId: number }) => i.employeeId === empId);
    expect(item.basePay).toBe(57000);
    expect(item.mealAllowance).toBe(3000);
    expect(item.leaveDeduction).toBe(1000);
    expect(item.detail.leaveSplit).toEqual({ taxable: 950, exempt: 50 });
    expect(item.lateEarlyDeduction).toBe(234);
    expect(item.detail.lateEarlySplit).toEqual({ taxable: 222, exempt: 12 });
    expect(item.netPay).toBe(57000 + 3000 - 1000 - 234);
  });

  it("不入基底：時薪只除本薪、扣款不拆分；伙食津貼仍整額入應發", async () => {
    // 月薪 48000＋伙食 2000 不入基底 → 時薪 48000/240 ＝ 200；病假 2 小時 → 扣 2×200×0.5 ＝ 200 全歸本薪側
    const empId = (await api("/employees", admin, { name: "不入基底員" })).json.id;
    await api("/employee-salaries", admin, {
      employeeId: empId,
      validFrom: "2026-01-01",
      payType: "monthly",
      baseAmount: 48000,
      hourlyDivisor: 240,
      mealAllowance: 2000,
      mealAllowanceInBase: false,
    });
    await api("/users", admin, { username: "nobase", displayName: "N", password: "secret-test", role: "employee", employeeId: empId });
    const u = await loginAs(app, "nobase", "secret-test");
    const types = (await api("/leave-types", admin)).json;
    const sick = types.find((t: { code: string }) => t.code === "sick");
    await api("/hr-requests", u, {
      kind: "leave",
      leaveTypeId: sick.id,
      startAt: "2026-10-06T09:00:00+08:00",
      endAt: "2026-10-06T11:00:00+08:00",
      minutes: 120,
    });
    const run = await api("/payroll-runs", admin, { month: "2026-10" });
    expect(run.status).toBe(201);
    const item = run.json.items.find((i: { employeeId: number }) => i.employeeId === empId);
    expect(item.mealAllowance).toBe(2000);
    expect(item.leaveDeduction).toBe(200);
    expect(item.detail.leaveSplit).toEqual({ taxable: 200, exempt: 0 });
    expect(item.netPay).toBe(48000 + 2000 - 200);
  });

  it("拆分是兩側基底各自全精度算再各取整——不是總額按比例拆（golden A0017 差 2 元的迴歸）", async () => {
    // 月薪 47000＋伙食 3000 入基底：本薪側時薪 47000/240 ＝ 195.8333…（全精度）
    // 事假（0% 給薪）3 小時 → 本薪側 587.5→588、津貼側 37.5→38 ＝ 626
    // 先把時薪取兩位（195.83）再拆會變 587.49→587＋37.49→37 ＝ 624——錯 2 元
    const empId = (await api("/employees", admin, { name: "拆分精度員" })).json.id;
    await api("/employee-salaries", admin, {
      employeeId: empId,
      validFrom: "2026-01-01",
      payType: "monthly",
      baseAmount: 47000,
      hourlyDivisor: 240,
      mealAllowance: 3000,
      mealAllowanceInBase: true,
    });
    await api("/users", admin, { username: "prec", displayName: "P", password: "secret-test", role: "employee", employeeId: empId });
    const u = await loginAs(app, "prec", "secret-test");
    const types = (await api("/leave-types", admin)).json;
    const personal = types.find((t: { code: string }) => t.code === "personal");
    await api(`/leave-types/${personal.id}`, admin, { payRatioPercent: 0, sourceNote: "測試自填" }, "PATCH");
    await api("/hr-requests", u, {
      kind: "leave",
      leaveTypeId: personal.id,
      startAt: "2026-12-08T13:00:00+08:00",
      endAt: "2026-12-08T17:00:00+08:00",
      minutes: 180,
    });
    const run = await api("/payroll-runs", admin, { month: "2026-12" });
    const item = run.json.items.find((i: { employeeId: number }) => i.employeeId === empId);
    expect(item.detail.leaveSplit).toEqual({ taxable: 588, exempt: 38 });
    expect(item.leaveDeduction).toBe(626);
  });

  it("時薪制設了伙食津貼：明講不折算（warnings），該項算 0", async () => {
    const empId = (await api("/employees", admin, { name: "時薪伙食員" })).json.id;
    await api("/employee-salaries", admin, {
      employeeId: empId,
      validFrom: "2026-01-01",
      payType: "hourly",
      baseAmount: 200,
      mealAllowance: 1000,
    });
    const run = await api("/payroll-runs", admin, { month: "2026-11" });
    expect(run.status).toBe(201);
    const item = run.json.items.find((i: { employeeId: number }) => i.employeeId === empId);
    expect(item.mealAllowance).toBe(0);
    expect(item.detail.warnings.join()).toContain("伙食津貼");
  });
});

describe("補時制（0045，golden 第二輪：遲到不罰、當日工時補不滿表定才扣）", () => {
  it("配對工時扣休息後不足＝早退分鐘；晚到晚走補滿＝不扣；漏刷下班卡＝不猜不扣", async () => {
    await api("/attendance/settings", admin, { lateEarlyMode: "shortfall" }, "PUT");
    const empId = (await api("/employees", admin, { name: "補時員" })).json.id;
    await api("/employee-salaries", admin, {
      employeeId: empId,
      validFrom: "2026-01-01",
      payType: "monthly",
      baseAmount: 60000,
      hourlyDivisor: 240,
    });
    const shiftId = (await api("/shifts", admin, { code: "P3", name: "班3", startTime: "09:00", endTime: "18:00", breaks: [{ start: "12:00", end: "13:00" }] })).json.id;
    await api("/schedules", admin, { employeeIds: [empId], shiftId, from: "2027-01-04", to: "2027-01-06" });
    await api("/users", admin, { username: "mkup", displayName: "K", password: "secret-test", role: "employee", employeeId: empId });
    const u = await loginAs(app, "mkup", "secret-test");
    // 1/4 晚到晚走（09:46→19:26，淨 520 分 ≥ 480）＝不扣；schedule 模式下這天會是 46 分遲到
    await api("/hr-requests", u, { kind: "punch_correction", workDate: "2027-01-04", direction: "in", claimedTime: "09:46" });
    await api("/hr-requests", u, { kind: "punch_correction", workDate: "2027-01-04", direction: "out", claimedTime: "19:26" });
    // 1/5 09:00→15:00：跨午休配對＝360−60＝300，短缺 180 分
    await api("/hr-requests", u, { kind: "punch_correction", workDate: "2027-01-05", direction: "in", claimedTime: "09:00" });
    await api("/hr-requests", u, { kind: "punch_correction", workDate: "2027-01-05", direction: "out", claimedTime: "15:00" });
    // 1/6 只有上班卡（漏刷下班）：無完整配對＝出勤異常交人工，不自動扣
    await api("/hr-requests", u, { kind: "punch_correction", workDate: "2027-01-06", direction: "in", claimedTime: "09:00" });
    const run = await api("/payroll-runs", admin, { month: "2027-01" });
    expect(run.status).toBe(201);
    const item = run.json.items.find((i: { employeeId: number }) => i.employeeId === empId);
    // 180 分 × 時薪 250 ÷ 60 ＝ 750（無伙食津貼＝整額本薪側）
    expect(item.lateEarlyDeduction).toBe(750);
    expect(item.detail.summary.earlyLeaveMinutes).toBe(180);
    expect(item.detail.summary.lateMinutes).toBe(0);
    await api("/attendance/settings", admin, { lateEarlyMode: "schedule" }, "PUT"); // 還原，不污染其他測試
  });
});

describe("權限", () => {
  it("employee 角色進不了薪資 API（payroll 頁只有 admin/finance）", async () => {
    const empId = (await api("/employees", admin, { name: "權限測試" })).json.id;
    await api("/users", admin, { username: "peek", displayName: "偷看", password: "secret-test", role: "employee", employeeId: empId });
    const peek = await loginAs(app, "peek", "secret-test");
    expect((await api("/employee-salaries", peek)).status).toBe(403);
    expect((await api("/overtime-rates", peek)).status).toBe(403);
    expect((await api("/payroll-runs", peek)).status).toBe(403);
    expect((await api(`/payroll-runs/${runId}`, peek)).status).toBe(403);
  });
});
