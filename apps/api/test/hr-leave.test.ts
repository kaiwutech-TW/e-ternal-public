/**
 * 假別／額度帳／申請簽核／行事曆驗收（0040）。
 *
 * 要守住的五件事：
 *  1. 內建假別只能停用不能刪也不能改名；給薪比率一律 NULL 起步（系統不預填法定數字）
 *  2. 簽核鏈提交時快照：直屬主管 → 部門主管沿樹向上（去重、跳過本人）；空鏈＝自動核准
 *  3. 「已用」由核准單推導：核准扣額度、駁回不扣、額度不足在送單當下就擋
 *  4. 忘打卡核准才寫 punches（method='correction'），原紀錄一筆不動
 *  5. 三種申請 × 核准／駁回／取消整個參數空間都要跑（happy-path-only trap）
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { loginAs, setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let admin: Record<string, string>;
let worker: Record<string, string>; // 基層員工：直屬主管 mgr2、部門＝客服組（主管 mgr2）→ 上級部門主管 mgr1
let mgr2: Record<string, string>;
let mgr1: Record<string, string>;
let boss: Record<string, string>; // 沒主管沒部門：送單自動核准
let workerEmpId: number;
let mgr1EmpId: number;
let mgr2EmpId: number;
let annualTypeId: number;
let sickTypeId: number;

async function api(path: string, headers: Record<string, string>, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const YEAR = new Date().getFullYear();

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  app = buildApp(drizzle(client));
  admin = await setupAdmin(app);

  const mkEmp = async (name: string, extra: Record<string, unknown> = {}) =>
    (await api("/employees", admin, { name, ...extra })).json.id as number;
  const mkUser = async (username: string, employeeId: number) => {
    await api("/users", admin, { username, displayName: username, password: "secret-test", role: "employee", employeeId });
    return loginAs(app, username, "secret-test");
  };

  mgr1EmpId = await mkEmp("處長");
  mgr2EmpId = await mkEmp("組長", { managerEmployeeId: mgr1EmpId });
  const bossEmpId = await mkEmp("老闆");
  const rootDept = (await api("/departments", admin, { name: "客服處", managerEmployeeId: mgr1EmpId })).json.id;
  const subDept = (await api("/departments", admin, { name: "客服一組", parentId: rootDept, managerEmployeeId: mgr2EmpId })).json.id;
  workerEmpId = await mkEmp("小美", { departmentId: subDept, managerEmployeeId: mgr2EmpId });

  worker = await mkUser("meimei", workerEmpId);
  mgr2 = await mkUser("lead", mgr2EmpId);
  mgr1 = await mkUser("director", mgr1EmpId);
  boss = await mkUser("boss", bossEmpId);

  const types = (await api("/leave-types", admin)).json;
  annualTypeId = types.find((t: { code: string }) => t.code === "annual").id;
  sickTypeId = types.find((t: { code: string }) => t.code === "sick").id;
});

describe("假別", () => {
  it("內建法定假別已 seed（只有名稱），給薪比率全為 NULL——系統不預填任何比率", async () => {
    const types = (await api("/leave-types", admin)).json;
    expect(types.length).toBeGreaterThanOrEqual(13);
    for (const t of types) {
      expect(t.payRatioPercent).toBeNull();
      expect(t.isSystem).toBe(true);
    }
  });

  it("內建假別不能改名、可停用可再啟用；自訂假別可新增、代碼不可重複", async () => {
    expect((await api(`/leave-types/${sickTypeId}`, admin, { name: "改名" }, "PATCH")).status).toBe(422);
    expect((await api(`/leave-types/${sickTypeId}`, admin, { active: false }, "PATCH")).json.active).toBe(false);
    expect((await api(`/leave-types/${sickTypeId}`, admin, { active: true }, "PATCH")).json.active).toBe(true);
    const custom = await api("/leave-types", admin, { code: "birthday", name: "生日假" });
    expect(custom.status).toBe(201);
    expect(custom.json.isSystem).toBe(false);
    expect((await api("/leave-types", admin, { code: "birthday", name: "重複" })).status).toBe(409);
  });

  it("設定給薪比率要留得住依據來源；員工讀得到假別清單（申請下拉）但寫不了", async () => {
    const patched = await api(`/leave-types/${sickTypeId}`, admin, { payRatioPercent: 50, sourceNote: "使用者自查（測試）" }, "PATCH");
    expect(patched.json.payRatioPercent).toBe(50);
    expect((await api("/leave-types", worker)).status).toBe(200);
    expect((await api("/leave-types", worker, { code: "x", name: "x" })).status).toBe(403);
  });
});

describe("簽核鏈與請假", () => {
  let reqId: number;

  it("給假：同人同假別同年度 upsert；員工在打卡頁看得到自己的額度", async () => {
    // 特休 10 天 × 8 小時 = 4800 分
    expect((await api("/leave-balances", admin, { employeeId: workerEmpId, leaveTypeId: annualTypeId, year: YEAR, grantedMinutes: 4800, note: "年資測試" })).status).toBe(201);
    await api("/leave-balances", admin, { employeeId: workerEmpId, leaveTypeId: annualTypeId, year: YEAR, grantedMinutes: 4800 });
    const mine = (await api("/attendance/my-balances", worker)).json;
    expect(mine).toHaveLength(1);
    expect(mine[0].grantedMinutes).toBe(4800);
  });

  it("送出請假：簽核鏈快照＝直屬主管(組長) → 上級部門主管(處長)，去重後兩關", async () => {
    const res = await api("/hr-requests", worker, {
      kind: "leave",
      leaveTypeId: annualTypeId,
      startAt: `${YEAR}-06-01T09:00:00+08:00`,
      endAt: `${YEAR}-06-01T18:00:00+08:00`,
      minutes: 480,
      reason: "家裡有事",
    });
    expect(res.status).toBe(201);
    expect(res.json.status).toBe("pending");
    reqId = res.json.id;
    const my = (await api("/hr-requests/my", worker)).json;
    const req = my.find((r: { id: number }) => r.id === reqId);
    expect(req.steps.map((s: { approverName: string }) => s.approverName)).toEqual(["組長", "處長"]);
    expect(req.steps[0].status).toBe("pending");
    expect(req.steps[1].status).toBe("waiting");
  });

  it("額度把關：簽核中的也算佔用——剩 4320 分再請 4321 分被擋，訊息講出數字", async () => {
    const res = await api("/hr-requests", worker, {
      kind: "leave",
      leaveTypeId: annualTypeId,
      startAt: `${YEAR}-07-01T09:00:00+08:00`,
      endAt: `${YEAR}-07-10T18:00:00+08:00`,
      minutes: 4321,
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("額度不足");
  });

  it("沒設額度列的假別（事假形狀）不把關——可以直接請", async () => {
    const types = (await api("/leave-types", admin)).json;
    const personal = types.find((t: { code: string }) => t.code === "personal").id;
    const res = await api("/hr-requests", worker, {
      kind: "leave",
      leaveTypeId: personal,
      startAt: `${YEAR}-08-01T09:00:00+08:00`,
      endAt: `${YEAR}-08-01T13:00:00+08:00`,
      minutes: 240,
    });
    expect(res.status).toBe(201);
    // 收尾：取消掉，不影響後面的月彙總斷言
    await api(`/hr-requests/${res.json.id}/cancel`, worker, {});
  });

  it("第一關簽核人是組長：處長此刻不能簽、小美自己也不能簽", async () => {
    expect((await api(`/hr-requests/${reqId}/approve`, mgr1, {})).status).toBe(403);
    expect((await api(`/hr-requests/${reqId}/approve`, worker, {})).status).toBe(403);
    const pending = (await api("/hr-requests/pending-approvals", mgr2)).json;
    expect(pending.map((r: { id: number }) => r.id)).toContain(reqId);
  });

  it("組長核准 → 輪到處長；處長核准 → 全單核准、額度已用 480", async () => {
    expect((await api(`/hr-requests/${reqId}/approve`, mgr2, { comment: "准" })).status).toBe(200);
    const pending1 = (await api("/hr-requests/pending-approvals", mgr1)).json;
    expect(pending1.map((r: { id: number }) => r.id)).toContain(reqId);
    expect((await api(`/hr-requests/${reqId}/approve`, mgr1, {})).status).toBe(200);
    const my = (await api("/hr-requests/my", worker)).json;
    expect(my.find((r: { id: number }) => r.id === reqId).status).toBe("approved");
    const bal = (await api("/attendance/my-balances", worker)).json;
    expect(bal[0].usedMinutes).toBe(480);
    expect(bal[0].pendingMinutes).toBe(0);
  });

  it("已核准的單不能再簽；核准後同額度再請會以「已用」計算", async () => {
    expect((await api(`/hr-requests/${reqId}/approve`, mgr1, {})).status).toBe(422);
  });

  it("駁回：留意見、後續關卡 skipped、不扣額度", async () => {
    const res = await api("/hr-requests", worker, {
      kind: "leave",
      leaveTypeId: annualTypeId,
      startAt: `${YEAR}-09-01T09:00:00+08:00`,
      endAt: `${YEAR}-09-01T18:00:00+08:00`,
      minutes: 480,
    });
    const id = res.json.id;
    expect((await api(`/hr-requests/${id}/reject`, mgr2, { comment: "人力不足" })).status).toBe(200);
    const my = (await api("/hr-requests/my", worker)).json;
    const rejected = my.find((r: { id: number }) => r.id === id);
    expect(rejected.status).toBe("rejected");
    expect(rejected.steps[0].comment).toBe("人力不足");
    expect(rejected.steps[1].status).toBe("skipped");
    expect((await api("/attendance/my-balances", worker)).json[0].usedMinutes).toBe(480); // 沒變
  });

  it("取消：只有本人、只有簽核中可取消", async () => {
    const res = await api("/hr-requests", worker, {
      kind: "leave",
      leaveTypeId: annualTypeId,
      startAt: `${YEAR}-10-01T09:00:00+08:00`,
      endAt: `${YEAR}-10-01T18:00:00+08:00`,
      minutes: 480,
    });
    const id = res.json.id;
    expect((await api(`/hr-requests/${id}/cancel`, mgr2, {})).status).toBe(403);
    expect((await api(`/hr-requests/${id}/cancel`, worker, {})).status).toBe(200);
    expect((await api(`/hr-requests/${id}/cancel`, worker, {})).status).toBe(422);
    expect((await api(`/hr-requests/${reqId}/cancel`, worker, {})).status).toBe(422); // 已核准的不能取消
  });

  it("空鏈自動核准：老闆（沒主管沒部門）送單即核准，回應標明 autoApproved", async () => {
    const res = await api("/hr-requests", boss, {
      kind: "overtime",
      workDate: `${YEAR}-06-05`,
      dayType: "workday",
      minutes: 120,
    });
    expect(res.status).toBe(201);
    expect(res.json.status).toBe("approved");
    expect(res.json.autoApproved).toBe(true);
  });

  it("admin 可代簽（跳過「不是這一關的簽核人」的限制）；兩關都簽完才核准", async () => {
    const res = await api("/hr-requests", worker, {
      kind: "overtime",
      workDate: `${YEAR}-06-06`,
      dayType: "restday",
      minutes: 240,
    });
    expect((await api(`/hr-requests/${res.json.id}/approve`, admin, { comment: "代簽" })).status).toBe(200);
    let my = (await api("/hr-requests/my", worker)).json;
    expect(my.find((r: { id: number }) => r.id === res.json.id).status).toBe("pending"); // 還有第二關
    expect((await api(`/hr-requests/${res.json.id}/approve`, admin, {})).status).toBe(200);
    my = (await api("/hr-requests/my", worker)).json;
    expect(my.find((r: { id: number }) => r.id === res.json.id).status).toBe("approved");
  });
});

describe("忘打卡申請", () => {
  it("形狀驗證：三種 kind 缺專屬欄位都 422", async () => {
    expect((await api("/hr-requests", worker, { kind: "leave", minutes: 60 })).status).toBe(422);
    expect((await api("/hr-requests", worker, { kind: "overtime", minutes: 60 })).status).toBe(422);
    expect((await api("/hr-requests", worker, { kind: "punch_correction", workDate: `${YEAR}-06-10` })).status).toBe(422);
  });

  it("核准後才寫 punches（method='correction'、出勤日照申請人自填）；原紀錄不動", async () => {
    const before = (await api(`/attendance/punches?from=${YEAR}-06-10&to=${YEAR}-06-10`, admin)).json.length;
    const res = await api("/hr-requests", worker, {
      kind: "punch_correction",
      workDate: `${YEAR}-06-10`,
      direction: "in",
      claimedTime: "09:00",
      reason: "忘了打",
    });
    expect(res.status).toBe(201);
    // 還在簽核中：不寫卡
    expect((await api(`/attendance/punches?from=${YEAR}-06-10&to=${YEAR}-06-10`, admin)).json.length).toBe(before);
    await api(`/hr-requests/${res.json.id}/approve`, mgr2, {});
    await api(`/hr-requests/${res.json.id}/approve`, mgr1, {});
    const after = (await api(`/attendance/punches?from=${YEAR}-06-10&to=${YEAR}-06-10`, admin)).json;
    expect(after.length).toBe(before + 1);
    const corr = after.find((p: { method: string }) => p.method === "correction");
    expect(corr.workDate).toBe(`${YEAR}-06-10`);
    expect(corr.employeeId).toBe(workerEmpId);
    // 台北 09:00 = UTC 01:00
    expect(new Date(corr.punchedAt).toISOString()).toBe(`${YEAR}-06-10T01:00:00.000Z`);
    // 申請單回填了更正卡的 id
    const my = (await api("/hr-requests/my", worker)).json;
    expect(my.find((r: { id: number }) => r.id === res.json.id).correctionPunchId).toBe(corr.id);
  });
});

describe("行事曆", () => {
  it("批次 upsert、年度查詢、刪除；kind 只認 holiday/makeup_workday", async () => {
    const put = await api("/calendar-days", admin, {
      entries: [
        { day: `${YEAR}-01-01`, kind: "holiday", name: "元旦" },
        { day: `${YEAR}-02-07`, kind: "makeup_workday", name: "補班" },
      ],
    }, "PUT");
    expect(put.status).toBe(200);
    expect(put.json.saved).toBe(2);
    // 同日 upsert 改 kind
    await api("/calendar-days", admin, { entries: [{ day: `${YEAR}-02-07`, kind: "holiday", name: "改放假" }] }, "PUT");
    const list = (await api(`/calendar-days?year=${YEAR}`, admin)).json;
    expect(list.find((c: { day: string }) => c.day === `${YEAR}-02-07`).kind).toBe("holiday");
    expect((await api(`/calendar-days/${YEAR}-02-07`, admin, undefined, "DELETE")).status).toBe(200);
    expect((await api(`/calendar-days?year=${YEAR}`, admin)).json).toHaveLength(1);
    // 員工讀得到（申請頁提示用）、寫不了
    expect((await api(`/calendar-days?year=${YEAR}`, worker)).status).toBe(200);
    expect((await api("/calendar-days", worker, { entries: [{ day: `${YEAR}-03-01`, kind: "holiday" }] }, "PUT")).status).toBe(403);
  });
});

describe("月出勤彙總", () => {
  it("應出勤＝排班、請假按假別歸起始月、加班按日型；免打卡者不計缺勤", async () => {
    // 六月：給小美排 6/1（已核准請假那天）與 6/2 兩天早班
    const shiftId = (await api("/shifts", admin, { code: "S9", name: "早", startTime: "09:00", endTime: "18:00", breaks: [{ start: "12:00", end: "13:00" }] })).json.id;
    await api("/schedules", admin, { employeeIds: [workerEmpId], shiftId, from: `${YEAR}-06-01`, to: `${YEAR}-06-02` });
    const summary = (await api(`/attendance/summary?month=${YEAR}-06`, admin)).json;
    const me = summary.find((s: { employeeId: number }) => s.employeeId === workerEmpId);
    expect(me.scheduledDays).toBe(2);
    expect(me.scheduledMinutes).toBe(2 * 480); // 9 小時 − 1 小時休息
    expect(me.leaveByType.annual).toBe(480); // 6/1 的特休
    expect(me.absentDays).toBe(1); // 6/2 有排班、無卡、無假
    expect(me.overtimeByDayType.restday).toBe(240); // admin 代簽核准的那筆
    // 老闆的平日加班 120 分也在（自動核准）
    const bossRow = summary.find((s: { employeeName: string }) => s.employeeName === "老闆");
    expect(bossRow.overtimeByDayType.workday).toBe(120);
    expect((await api(`/attendance/summary?month=2026-13`, admin)).status).toBe(400);
  });

  it("員工看不到全公司彙總（hr 頁權限）", async () => {
    expect((await api(`/attendance/summary?month=${YEAR}-06`, worker)).status).toBe(403);
  });
});
