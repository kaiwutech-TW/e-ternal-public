/**
 * HR 出勤地基（0039）：部門、班別、排班、打卡（設計紀律見 migration 檔頭）。
 *
 * 一句話版本：**打卡是事實、排班是計畫、規則是政策**——
 * 事實 append-only（打錯走補卡申請，下一批）、計畫可改、政策只存不算（算錢是薪資批）。
 */
import { schema } from "@tw-erp/db";
import { and, asc, desc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";

/**
 * 台灣時區寫死：這是台灣中小企業 ERP，出勤日的「當天」就是台北的當天。
 * 容器跑 UTC 也不會歪——所有換算經過這裡，不吃 process 的本地時區。
 */
const TZ = "Asia/Taipei";
const DEFAULT_CUTOFF = "04:00";

export function taipeiParts(at: Date): { date: string; time: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  // Intl 的 24 小時制在整點零分會給 "24"（規格如此）——正規化回 00
  const hour = parts["hour"] === "24" ? "00" : parts["hour"];
  return { date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`, time: `${hour}:${parts["minute"]}` };
}

function addDaysStr(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * 打卡歸屬日（跨日班的核心解法，邏輯抄自實機考察）：
 * 「切點（含）之前的打卡歸前一天」。切點優先取**前一天排班班別**的 day_cutoff
 * （凌晨的卡多半是前一天晚班的收尾），沒排班就用預設 04:00。
 *
 * 落地而不即時推導：班別事後改了切點，歷史打卡的出勤日不能跟著漂——
 * 與費率快照（0016 的三個 blocker）同一個教訓。
 */
export async function resolveWorkDate(db: Db, employeeId: number, at: Date): Promise<string> {
  const { date, time } = taipeiParts(at);
  const yesterday = addDaysStr(date, -1);
  const [ySchedule] = await db
    .select({ cutoff: schema.shifts.dayCutoff })
    .from(schema.schedules)
    .innerJoin(schema.shifts, eq(schema.schedules.shiftId, schema.shifts.id))
    .where(and(eq(schema.schedules.employeeId, employeeId), eq(schema.schedules.workDate, yesterday)));
  const cutoff = (ySchedule?.cutoff ?? DEFAULT_CUTOFF).slice(0, 5);
  return time <= cutoff ? yesterday : date;
}

/** IP 白名單：完整 IP 或 CIDR（IPv4），逗號分隔；空字串＝不限制 */
export function ipAllowed(allowlist: string, ip: string): boolean {
  const rules = allowlist.split(",").map((s) => s.trim()).filter(Boolean);
  if (!rules.length) return true;
  if (!ip) return false; // 有白名單卻拿不到來源＝擋下（政策開了就要能執行）
  const ipNum = ipv4ToNum(ip);
  if (ipNum === null) return rules.includes(ip); // 非 IPv4（IPv6 等）退回精確比對
  for (const rule of rules) {
    if (rule === ip) return true;
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(rule);
    if (!m) continue;
    const base = ipv4ToNum(m[1]!);
    const bits = Number(m[2]);
    if (base === null || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if (((ipNum & mask) >>> 0) === ((base & mask) >>> 0)) return true;
  }
  return false;
}

function ipv4ToNum(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

export async function getAttendanceSettings(db: Db) {
  const [row] = await db.select().from(schema.attendanceSettings).where(eq(schema.attendanceSettings.id, 1));
  if (!row) throw new AppError(500, "attendance_settings 沒有預設列（migration 0039 應已建立）");
  return row;
}

/**
 * 打卡。direction 由使用者按的鈕決定（上班／下班兩顆鈕，同實機考察的形狀）——
 * 系統不猜方向，但會回報「今天最後一筆是什麼」讓前端把該按的鈕放大。
 */
export async function punch(
  db: Db,
  input: { employeeId: number; direction: "in" | "out"; sourceIp: string; memo?: string | undefined },
) {
  const settings = await getAttendanceSettings(db);
  if (!ipAllowed(settings.ipAllowlist, input.sourceIp)) {
    throw new AppError(
      403,
      "這個網路位置不在允許打卡的範圍內（限公司網路）。在外面工作請改送補卡申請，或請管理者調整出勤設定的 IP 白名單",
    );
  }
  const at = new Date();
  const workDate = await resolveWorkDate(db, input.employeeId, at);
  const [row] = await db
    .insert(schema.punches)
    .values({
      employeeId: input.employeeId,
      punchedAt: at,
      direction: input.direction,
      workDate,
      sourceIp: input.sourceIp,
      method: "web",
      memo: input.memo ?? "",
    })
    .returning();
  return row!;
}

/** 我的出勤（打卡頁）：今天的打卡＋本週排班＋建議的下一個方向 */
export async function myAttendance(db: Db, employeeId: number) {
  const { date: today } = taipeiParts(new Date());
  const weekStart = addDaysStr(today, -6);
  const weekEnd = addDaysStr(today, 7);
  const todayPunches = await db
    .select()
    .from(schema.punches)
    .where(and(eq(schema.punches.employeeId, employeeId), eq(schema.punches.workDate, today)))
    .orderBy(asc(schema.punches.punchedAt));
  const scheduleRows = await db
    .select({ workDate: schema.schedules.workDate, shift: schema.shifts, note: schema.schedules.note })
    .from(schema.schedules)
    .innerJoin(schema.shifts, eq(schema.schedules.shiftId, schema.shifts.id))
    .where(
      and(
        eq(schema.schedules.employeeId, employeeId),
        gte(schema.schedules.workDate, weekStart),
        lte(schema.schedules.workDate, weekEnd),
      ),
    )
    .orderBy(asc(schema.schedules.workDate));
  const last = todayPunches.at(-1);
  return {
    today,
    punches: todayPunches,
    suggestedDirection: last?.direction === "in" ? "out" : "in",
    schedule: scheduleRows.map((r) => ({
      workDate: r.workDate,
      shiftCode: r.shift.code,
      shiftName: r.shift.name,
      startTime: r.shift.startTime.slice(0, 5),
      endTime: r.shift.endTime.slice(0, 5),
      color: r.shift.color,
      note: r.note,
    })),
  };
}

/**
 * 排班批次設定：對一群員工×一段日期套同一班別（「一鍵展開」的通例）。
 * 既有排班同日覆蓋（排班是計畫可改）；weekdays 過濾（1=一 … 7=日）讓「平日班」一次排整月。
 */
export async function setSchedules(
  db: Db,
  input: {
    employeeIds: number[];
    shiftId: number;
    from: string;
    to: string;
    weekdays?: number[] | undefined;
    note?: string | undefined;
  },
) {
  const [shift] = await db.select().from(schema.shifts).where(eq(schema.shifts.id, input.shiftId));
  if (!shift) throw new AppError(404, "班別不存在: {id}", { id: input.shiftId });
  if (!shift.active) throw new AppError(422, "班別已停用: {code} {name}", { code: shift.code, name: shift.name });
  const days = spanDays(input.from, input.to);
  if (days.length > 92) {
    throw new AppError(422, "一次最多排 92 天（本次 {n} 天）——請確認起迄日期沒打錯，要更長請分次", { n: days.length });
  }
  const weekdaySet = input.weekdays?.length ? new Set(input.weekdays) : null;
  const targets = days.filter((d) => !weekdaySet || weekdaySet.has(isoWeekday(d)));
  let count = 0;
  for (const empId of input.employeeIds) {
    for (const d of targets) {
      await db
        .insert(schema.schedules)
        .values({ employeeId: empId, workDate: d, shiftId: input.shiftId, note: input.note ?? "" })
        .onConflictDoUpdate({
          target: [schema.schedules.employeeId, schema.schedules.workDate],
          set: { shiftId: input.shiftId, note: input.note ?? "" },
        });
      count++;
    }
  }
  return { scheduled: count, days: targets.length, employees: input.employeeIds.length };
}

function spanDays(from: string, to: string): string[] {
  if (to < from) throw new AppError(422, "迄日（{to}）不可早於起日（{from}）", { to, from });
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysStr(d, 1)) out.push(d);
  return out;
}

function isoWeekday(date: string): number {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** 排班表（管理視角）：一段期間全員的班，給排班頁畫格子 */
export async function scheduleBoard(db: Db, from: string, to: string) {
  const rows = await db
    .select({
      id: schema.schedules.id,
      employeeId: schema.schedules.employeeId,
      workDate: schema.schedules.workDate,
      shiftId: schema.schedules.shiftId,
      shiftCode: schema.shifts.code,
      color: schema.shifts.color,
    })
    .from(schema.schedules)
    .innerJoin(schema.shifts, eq(schema.schedules.shiftId, schema.shifts.id))
    .where(and(gte(schema.schedules.workDate, from), lte(schema.schedules.workDate, to)))
    .orderBy(asc(schema.schedules.workDate));
  return rows;
}

/** 打卡紀錄查詢（管理視角）：某期間、可篩員工 */
export async function listPunches(
  db: Db,
  q: { from: string; to: string; employeeId?: number | undefined },
) {
  const conds = [gte(schema.punches.workDate, q.from), lte(schema.punches.workDate, q.to)];
  if (q.employeeId !== undefined) conds.push(eq(schema.punches.employeeId, q.employeeId));
  return db
    .select()
    .from(schema.punches)
    .where(and(...conds))
    .orderBy(desc(schema.punches.punchedAt))
    .limit(1000);
}

// ── 月出勤彙總（0040）：算薪的取數來源 ──

function shiftRequiredMinutes(shift: { startTime: string; endTime: string; breaks: unknown }): number {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const start = toMin(shift.startTime);
  let end = toMin(shift.endTime);
  if (end <= start) end += 24 * 60; // 跨日班
  let breakTotal = 0;
  for (const b of (shift.breaks as { start: string; end: string }[]) ?? []) {
    let bs = toMin(b.start);
    let be = toMin(b.end);
    // 休息段也可能落在跨日側（凌晨）：換算到與班別同一條時間軸
    if (bs < start) bs += 24 * 60;
    if (be < start) be += 24 * 60;
    if (be > bs) breakTotal += be - bs;
  }
  return end - start - breakTotal;
}

/**
 * 補時制的當日淨工時：配對 in→out 的分鐘數，扣掉與班別休息時段的重疊
 * （單一 09:00→18:00 的配對要扣午休；分段班各段自己打卡則本來就不含段間空檔）。
 * 回傳 null＝當天沒有任何完整配對（漏刷卡），呼叫端不應據此扣款。
 */
function dayNetWorkedMinutes(
  punches: { direction: string; punchedAt: Date }[],
  workDate: string,
  shift: { startTime: string; endTime: string; breaks: unknown },
): number | null {
  const shiftStartMs = new Date(`${workDate}T${shift.startTime.slice(0, 5)}:00+08:00`).getTime();
  const toMs = (t: string) => {
    let ms = new Date(`${workDate}T${t.slice(0, 5)}:00+08:00`).getTime();
    if (ms < shiftStartMs) ms += 24 * 3600_000; // 跨日側的休息段換算到班別同一條時間軸
    return ms;
  };
  const breaks = ((shift.breaks as { start: string; end: string }[]) ?? [])
    .map((b) => [toMs(b.start), toMs(b.end)] as const)
    .filter(([a, b]) => b > a);
  let total = 0;
  let pairs = 0;
  let inAt: Date | null = null;
  for (const p of punches) {
    if (p.direction === "in") {
      if (inAt === null) inAt = p.punchedAt;
    } else if (inAt !== null) {
      const a = inAt.getTime();
      const b = p.punchedAt.getTime();
      let mins = Math.round((b - a) / 60_000);
      for (const [bs, be] of breaks) {
        const ov = Math.min(b, be) - Math.max(a, bs);
        if (ov > 0) mins -= Math.round(ov / 60_000);
      }
      total += Math.max(0, mins);
      pairs++;
      inAt = null;
    }
  }
  return pairs === 0 ? null : total;
}

export interface EmployeeMonthSummary {
  employeeId: number;
  employeeName: string;
  punchExempt: boolean;
  scheduledDays: number;
  scheduledMinutes: number;
  workedMinutes: number;
  lateCount: number;
  lateMinutes: number;
  earlyLeaveCount: number;
  earlyLeaveMinutes: number;
  absentDays: number;
  absentMinutes: number;
  /** 假別 code → 分鐘（已核准；歸屬在請假起始日所在的月份） */
  leaveByType: Record<string, number>;
  /** 日型 → 分鐘（已核准加班單） */
  overtimeByDayType: Record<string, number>;
}

/**
 * 月出勤彙總：**應出勤＝排班**（排班的人自己會避開國定假日；行事曆在畫面上提示，
 * 不反過來否定排班）、實際＝打卡配對、遲到早退吃彈性分鐘、缺勤＝有排班無卡也無假。
 * 免打卡者（punch_exempt）不算遲到早退缺勤。即時計算不落地——落地的快照在薪資批
 * （payroll_items.detail），彙總本身要永遠反映最新的核准單與補卡。
 */
export async function monthlySummary(db: Db, month: string): Promise<EmployeeMonthSummary[]> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AppError(400, "月份格式須為 YYYY-MM（收到「{month}」）", { month });
  const from = `${month}-01`;
  const days: string[] = [];
  for (let d = from; d.slice(0, 7) === month; d = addDaysStr(d, 1)) days.push(d);
  const to = days[days.length - 1]!;

  const employees = await db.select().from(schema.employees).where(eq(schema.employees.active, true));
  const settings = await getAttendanceSettings(db);
  const flex = settings.flexMinutes;

  const scheduleRows = await db
    .select({ employeeId: schema.schedules.employeeId, workDate: schema.schedules.workDate, shift: schema.shifts })
    .from(schema.schedules)
    .innerJoin(schema.shifts, eq(schema.schedules.shiftId, schema.shifts.id))
    .where(and(gte(schema.schedules.workDate, from), lte(schema.schedules.workDate, to)));
  const punchRows = await db
    .select()
    .from(schema.punches)
    .where(and(gte(schema.punches.workDate, from), lte(schema.punches.workDate, to)))
    .orderBy(asc(schema.punches.punchedAt));
  // 請假：起始日（台北）落在本月的已核准單（跨月的假整筆歸起始月——分攤的複雜度留給真的需要的那天）
  const monthStart = new Date(`${from}T00:00:00+08:00`);
  const monthEnd = new Date(`${addDaysStr(to, 1)}T00:00:00+08:00`);
  const leaveRows = await db
    .select({ req: schema.hrRequests, typeCode: schema.leaveTypes.code })
    .from(schema.hrRequests)
    .innerJoin(schema.leaveTypes, eq(schema.hrRequests.leaveTypeId, schema.leaveTypes.id))
    .where(
      and(
        eq(schema.hrRequests.kind, "leave"),
        eq(schema.hrRequests.status, "approved"),
        gte(schema.hrRequests.startAt, monthStart),
        lt(schema.hrRequests.startAt, monthEnd),
      ),
    );
  const overtimeRows = await db
    .select()
    .from(schema.hrRequests)
    .where(
      and(
        eq(schema.hrRequests.kind, "overtime"),
        eq(schema.hrRequests.status, "approved"),
        gte(schema.hrRequests.workDate, from),
        lte(schema.hrRequests.workDate, to),
      ),
    );

  const out: EmployeeMonthSummary[] = [];
  for (const emp of employees) {
    const mySchedules = scheduleRows.filter((s) => s.employeeId === emp.id);
    const myPunchesByDate = new Map<string, typeof punchRows>();
    for (const p of punchRows) {
      if (p.employeeId !== emp.id) continue;
      const list = myPunchesByDate.get(p.workDate) ?? [];
      list.push(p);
      myPunchesByDate.set(p.workDate, list);
    }
    const myLeaves = leaveRows.filter((r) => r.req.employeeId === emp.id);
    const sum: EmployeeMonthSummary = {
      employeeId: emp.id,
      employeeName: emp.name,
      punchExempt: emp.punchExempt,
      scheduledDays: mySchedules.length,
      scheduledMinutes: 0,
      workedMinutes: 0,
      lateCount: 0,
      lateMinutes: 0,
      earlyLeaveCount: 0,
      earlyLeaveMinutes: 0,
      absentDays: 0,
      absentMinutes: 0,
      leaveByType: {},
      overtimeByDayType: {},
    };
    // 實際工時：配對 in→out 加總（不限有排班的日子——加班日的卡也算工時）
    for (const [, list] of myPunchesByDate) {
      let inAt: Date | null = null;
      for (const p of list) {
        if (p.direction === "in") {
          if (inAt === null) inAt = p.punchedAt; // 連打兩次上班取第一次
        } else if (inAt !== null) {
          sum.workedMinutes += Math.round((p.punchedAt.getTime() - inAt.getTime()) / 60_000);
          inAt = null;
        }
      }
    }
    for (const s of mySchedules) {
      const required = shiftRequiredMinutes(s.shift);
      sum.scheduledMinutes += required;
      const dayPunches = myPunchesByDate.get(s.workDate) ?? [];
      // 這一天有核准的假（起訖的台北日期範圍涵蓋當天）→ 不算缺勤也不算遲到早退
      const onLeave = myLeaves.some((l) => {
        const from = taipeiParts(l.req.startAt!).date;
        const to = taipeiParts(l.req.endAt!).date;
        return s.workDate >= from && s.workDate <= to;
      });
      if (emp.punchExempt || onLeave) continue;
      if (dayPunches.length === 0) {
        sum.absentDays++;
        sum.absentMinutes += required;
        continue;
      }
      if (settings.lateEarlyMode === "shortfall") {
        // 補時制（0045）：不看幾點來，當日配對工時（扣休息重疊）補不滿表定的分鐘數記為早退。
        // 沒有任何完整 in→out 配對（漏刷下班卡等）＝出勤異常交人工，不自動扣——
        // 用「假設他早退」去罰漏刷卡的人是猜測，不是算術（golden 實測：晚班整月無下班卡照常計薪）
        const net = dayNetWorkedMinutes(dayPunches, s.workDate, s.shift);
        if (net !== null) {
          const shortfall = required - net;
          if (shortfall > flex) {
            sum.earlyLeaveCount++;
            sum.earlyLeaveMinutes += shortfall;
          }
        }
        continue;
      }
      // schedule（預設）：遲到／早退與班別表定時間比（絕對時刻——跨日班的下班表定在隔天）
      const shiftStart = new Date(`${s.workDate}T${s.shift.startTime.slice(0, 5)}:00+08:00`);
      let shiftEnd = new Date(`${s.workDate}T${s.shift.endTime.slice(0, 5)}:00+08:00`);
      if (shiftEnd <= shiftStart) shiftEnd = new Date(shiftEnd.getTime() + 24 * 3600_000);
      const firstIn = dayPunches.find((p) => p.direction === "in");
      const lastOut = [...dayPunches].reverse().find((p) => p.direction === "out");
      if (firstIn) {
        const lateMin = Math.floor((firstIn.punchedAt.getTime() - shiftStart.getTime()) / 60_000);
        if (lateMin > flex) {
          sum.lateCount++;
          sum.lateMinutes += lateMin;
        }
      }
      if (lastOut) {
        const earlyMin = Math.floor((shiftEnd.getTime() - lastOut.punchedAt.getTime()) / 60_000);
        if (earlyMin > flex) {
          sum.earlyLeaveCount++;
          sum.earlyLeaveMinutes += earlyMin;
        }
      }
    }
    for (const l of myLeaves) {
      sum.leaveByType[l.typeCode] = (sum.leaveByType[l.typeCode] ?? 0) + (l.req.minutes ?? 0);
    }
    for (const o of overtimeRows) {
      if (o.employeeId !== emp.id) continue;
      const dt = o.dayType ?? "workday";
      sum.overtimeByDayType[dt] = (sum.overtimeByDayType[dt] ?? 0) + (o.minutes ?? 0);
    }
    out.push(sum);
  }
  return out;
}

/** 部門樹（列表附主管名；樹狀組裝留給前端——20 個部門以內攤平比遞迴好讀） */
export async function listDepartments(db: Db) {
  const rows = await db.select().from(schema.departments).orderBy(asc(schema.departments.id));
  const managerIds = rows.map((r) => r.managerEmployeeId).filter((x): x is number => x !== null);
  const managers = managerIds.length
    ? await db.select({ id: schema.employees.id, name: schema.employees.name }).from(schema.employees).where(inArray(schema.employees.id, managerIds))
    : [];
  const nameOf = new Map(managers.map((m) => [m.id, m.name]));
  return rows.map((r) => ({ ...r, managerName: r.managerEmployeeId ? (nameOf.get(r.managerEmployeeId) ?? null) : null }));
}
