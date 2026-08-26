/**
 * HR 出勤地基驗收（0039）：打卡歸屬日、IP 白名單、排班展開、權限。
 *
 * 要守住的四件事：
 *  1. 打卡永遠打自己的（身分取自 session，不收 employeeId）
 *  2. 跨日班的歸屬日切點：前一天有排跨日班時，凌晨的卡歸前一天
 *  3. IP 白名單開了就要能執行（拿不到來源＝擋下）；沒開＝不限制
 *  4. 排班是計畫（可覆蓋可刪、週幾過濾、92 天上限擋年份打錯）
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { ipAllowed, taipeiParts } from "../src/services/attendance.ts";
import { loginAs, setupAdmin } from "./auth-helper.ts";

let app: ReturnType<typeof buildApp>;
let admin: Record<string, string>;
let emp: Record<string, string>; // 員工角色（已連結員工主檔）
let empId: number;

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
  app = buildApp(drizzle(client));
  admin = await setupAdmin(app);
  empId = (await api("/employees", admin, { name: "出勤測試員" })).json.id;
  await api("/users", admin, { username: "worker", displayName: "員工", password: "secret-test", role: "employee", employeeId: empId });
  emp = await loginAs(app, "worker", "secret-test");
});

describe("打卡", () => {
  it("員工按上班鈕即打卡；身分取自 session，回應含歸屬日與來源", async () => {
    const res = await api("/attendance/punch", emp, { direction: "in" });
    expect(res.status).toBe(201);
    expect(res.json.employeeId).toBe(empId);
    expect(res.json.direction).toBe("in");
    expect(res.json.workDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("我的出勤：今天的卡＋建議方向（上了班建議下班）", async () => {
    const my = await api("/attendance/my", emp);
    expect(my.status).toBe(200);
    expect(my.json.punches.length).toBeGreaterThanOrEqual(1);
    expect(my.json.suggestedDirection).toBe("out");
  });

  it("帳號未連結員工主檔：打卡 422 指路、我的出勤回 notLinked", async () => {
    await api("/users", admin, { username: "nolink", displayName: "未連結", password: "secret-test", role: "employee" });
    const nolink = await loginAs(app, "nolink", "secret-test");
    const res = await api("/attendance/punch", nolink, { direction: "in" });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("員工主檔");
    expect((await api("/attendance/my", nolink)).json.notLinked).toBe(true);
  });
});

describe("IP 白名單（純函式——政策的所有分支）", () => {
  it("空白名單＝不限制；精確 IP 與 CIDR 都認；拿不到來源時開了白名單就擋", () => {
    expect(ipAllowed("", "1.2.3.4")).toBe(true);
    expect(ipAllowed("", "")).toBe(true);
    expect(ipAllowed("203.0.113.7", "203.0.113.7")).toBe(true);
    expect(ipAllowed("203.0.113.7", "203.0.113.8")).toBe(false);
    expect(ipAllowed("192.168.1.0/24", "192.168.1.99")).toBe(true);
    expect(ipAllowed("192.168.1.0/24", "192.168.2.99")).toBe(false);
    expect(ipAllowed("192.168.1.0/24, 10.0.0.1", "10.0.0.1")).toBe(true);
    expect(ipAllowed("192.168.1.0/24", "")).toBe(false); // 政策開了就要能執行
  });

  it("設了白名單後，來源不符的打卡收 403 帶指路訊息", async () => {
    await api("/attendance/settings", admin, { ipAllowlist: "203.0.113.0/24" }, "PUT");
    // 測試環境拿不到 socket 來源（空字串）→ 白名單生效時一律擋
    const res = await api("/attendance/punch", emp, { direction: "out" });
    expect(res.status).toBe(403);
    expect(res.json.error).toContain("補卡申請");
    await api("/attendance/settings", admin, { ipAllowlist: "" }, "PUT"); // 還原
  });
});

describe("班別與歸屬日", () => {
  let nightShiftId: number;

  it("跨日晚班建得起來（end < start 刻意允許）；班別代碼不可改", async () => {
    const res = await api("/shifts", admin, {
      code: "N001",
      name: "晚班",
      startTime: "15:00",
      endTime: "00:00",
      dayCutoff: "04:00",
      breaks: [{ start: "18:00", end: "19:00" }],
    });
    expect(res.status).toBe(201);
    nightShiftId = res.json.id;
    expect((await api("/shifts", admin, { code: "N001", name: "重複", startTime: "1:00", endTime: "2:00" })).status).not.toBe(201);
    const patch = await api(`/shifts/${nightShiftId}`, admin, { name: "夜班" }, "PATCH");
    expect(patch.status).toBe(200);
    expect(patch.json.code).toBe("N001");
  });

  it("歸屬日切點：前一天排了跨日班，凌晨（切點前）的卡歸前一天；沒排班用預設 04:00", async () => {
    // 直接驗 resolveWorkDate 的行為面：現在打的卡，若「昨天」排了 N001（cutoff 04:00），
    // 只有當下台北時間 <= 04:00 才會歸昨天。兩種情況都斷言其一致性（不對時鐘做假設）
    const { time, date } = taipeiParts(new Date());
    const yesterday = new Date(Date.now() - 86400_000);
    const yDate = taipeiParts(yesterday).date;
    await api("/schedules", admin, { employeeIds: [empId], shiftId: nightShiftId, from: yDate, to: yDate });
    const p = await api("/attendance/punch", emp, { direction: "in" });
    expect(p.status).toBe(201);
    if (time <= "04:00") expect(p.json.workDate).toBe(yDate);
    else expect(p.json.workDate).toBe(date);
  });
});

describe("排班", () => {
  let dayShiftId: number;

  beforeAll(async () => {
    dayShiftId = (await api("/shifts", admin, { code: "D001", name: "早班", startTime: "09:00", endTime: "18:00" })).json.id;
  });

  it("批次展開：兩週只排週一到週五＝10 天；同日重排＝覆蓋不報錯（計畫可改）", async () => {
    const res = await api("/schedules", admin, {
      employeeIds: [empId],
      shiftId: dayShiftId,
      from: "2026-09-07", // 週一
      to: "2026-09-20",
      weekdays: [1, 2, 3, 4, 5],
    });
    expect(res.status).toBe(201);
    expect(res.json.days).toBe(10);
    const again = await api("/schedules", admin, {
      employeeIds: [empId],
      shiftId: dayShiftId,
      from: "2026-09-07",
      to: "2026-09-20",
      weekdays: [1, 2, 3, 4, 5],
    });
    expect(again.status).toBe(201);
    const board = (await api("/schedules?from=2026-09-07&to=2026-09-20", admin)).json;
    expect(board.filter((b: { employeeId: number }) => b.employeeId === empId)).toHaveLength(10);
  });

  it("一次排超過 92 天要擋（年份打錯的護欄），訊息講出天數", async () => {
    const res = await api("/schedules", admin, {
      employeeIds: [empId],
      shiftId: dayShiftId,
      from: "2026-09-01",
      to: "2027-09-01",
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("366 天");
  });
});

describe("權限", () => {
  it("員工可打卡看排班（讀 shifts/departments），但動不了排班、進不了出勤設定", async () => {
    expect((await api("/shifts", emp)).status).toBe(200);
    expect((await api("/departments", emp)).status).toBe(200);
    expect((await api("/attendance/settings", emp)).status).toBe(403);
    expect((await api("/schedules", emp, { employeeIds: [empId], shiftId: 1, from: "2026-09-01", to: "2026-09-01" })).status).toBe(403);
    expect((await api("/shifts", emp, { code: "X", name: "x", startTime: "01:00", endTime: "02:00" })).status).toBe(403);
  });

  it("部門樹：主管掛部門、parent 不能是自己", async () => {
    const dep = await api("/departments", admin, { name: "客服部", managerEmployeeId: empId });
    expect(dep.status).toBe(201);
    const list = (await api("/departments", admin)).json;
    expect(list.find((d: { id: number }) => d.id === dep.json.id).managerName).toBe("出勤測試員");
    expect((await api(`/departments/${dep.json.id}`, admin, { parentId: dep.json.id }, "PATCH")).status).toBe(422);
  });
});
