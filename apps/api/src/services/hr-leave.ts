/**
 * 假別／額度帳／三種申請（請假・加班・忘打卡）＋簽核鏈／行事曆（0040）。
 *
 * 資料紀律（延續 0039「打卡是事實、排班是計畫、規則是政策」）：
 * - **額度帳只存「給了多少」**：已用一律由核准的請假單即時推導。兩處記數字遲早對不上，
 *   單一事實來源選在事實（核准單）那一邊。
 * - **簽核鏈提交時快照**：直屬主管 → 所屬部門主管 → 沿部門樹向上，去重、跳過本人。
 *   之後改組織圖不影響在途單。鏈是空的（老闆、沒排主管的人）＝提交即核准，畫面上明講。
 * - **忘打卡核准才寫 punches**（method='correction'）：原打卡紀錄永不修改，
 *   出勤日以申請人自填的那天為準（不重推歸屬日——申請單自己就是「這卡屬於哪天」的宣告）。
 * - 假別的給薪比率／年資對照天數一律使用者自填：系統不預填任何勞基法數字。
 */
import { schema } from "@tw-erp/db";
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";

export const REQUEST_KINDS = ["leave", "overtime", "punch_correction"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** 加班日型：值域是結構（業界通用的四型），哪天算哪型由申請人選——系統不判斷 */
export const DAY_TYPES = ["workday", "restday", "regular_off", "holiday"] as const;
export const DAY_TYPE_LABELS: Record<string, string> = {
  workday: "平日",
  restday: "休息日",
  regular_off: "例假日",
  holiday: "國定假日",
};

// ── 假別 ──

export async function listLeaveTypes(db: Db) {
  return db.select().from(schema.leaveTypes).orderBy(asc(schema.leaveTypes.id));
}

export async function createLeaveType(
  db: Db,
  input: {
    code: string;
    name: string;
    payRatioPercent?: number | null | undefined;
    sourceNote?: string | undefined;
    minUnitMinutes?: number | undefined;
    note?: string | undefined;
  },
) {
  const [dup] = await db.select({ id: schema.leaveTypes.id }).from(schema.leaveTypes).where(eq(schema.leaveTypes.code, input.code));
  if (dup) throw new AppError(409, `假別代碼已存在: ${input.code}`);
  const [row] = await db
    .insert(schema.leaveTypes)
    .values({
      code: input.code,
      name: input.name,
      isSystem: false,
      payRatioPercent: input.payRatioPercent ?? null,
      sourceNote: input.sourceNote ?? "",
      minUnitMinutes: input.minUnitMinutes ?? 30,
      note: input.note ?? "",
    })
    .returning();
  return row!;
}

export async function patchLeaveType(
  db: Db,
  id: number,
  input: {
    name?: string | undefined;
    active?: boolean | undefined;
    payRatioPercent?: number | null | undefined;
    sourceNote?: string | undefined;
    minUnitMinutes?: number | undefined;
    note?: string | undefined;
  },
) {
  const [row] = await db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.id, id));
  if (!row) throw new AppError(404, `假別不存在: ${id}`);
  if (row.isSystem && input.name !== undefined && input.name !== row.name) {
    throw new AppError(422, `內建假別「${row.name}」的名稱不可改（可停用、可設定給薪比率）`);
  }
  const [updated] = await db.update(schema.leaveTypes).set(input).where(eq(schema.leaveTypes.id, id)).returning();
  return updated!;
}

// ── 額度帳 ──

/** 已用額度＝該年度（台北時間）已核准請假單的分鐘合計。pending 另計，畫面顯示「簽核中」 */
async function usedByYear(db: Db, year: number, statuses: string[]) {
  // 台北時區固定 UTC+8（無日光節約）：年度界線直接用 +08:00 表示
  const from = new Date(`${year}-01-01T00:00:00+08:00`);
  const to = new Date(`${year + 1}-01-01T00:00:00+08:00`);
  return db
    .select({
      employeeId: schema.hrRequests.employeeId,
      leaveTypeId: schema.hrRequests.leaveTypeId,
      minutes: sql<number>`coalesce(sum(${schema.hrRequests.minutes}), 0)::int`,
    })
    .from(schema.hrRequests)
    .where(
      and(
        eq(schema.hrRequests.kind, "leave"),
        inArray(schema.hrRequests.status, statuses),
        gte(schema.hrRequests.startAt, from),
        lt(schema.hrRequests.startAt, to),
      ),
    )
    .groupBy(schema.hrRequests.employeeId, schema.hrRequests.leaveTypeId);
}

export async function grantBalance(
  db: Db,
  input: { employeeId: number; leaveTypeId: number; year: number; grantedMinutes: number; note?: string | undefined },
  userId: number,
) {
  const [emp] = await db.select().from(schema.employees).where(eq(schema.employees.id, input.employeeId));
  if (!emp) throw new AppError(404, `員工不存在: ${input.employeeId}`);
  const [lt] = await db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.id, input.leaveTypeId));
  if (!lt) throw new AppError(404, `假別不存在: ${input.leaveTypeId}`);
  const [row] = await db
    .insert(schema.leaveBalances)
    .values({ ...input, note: input.note ?? "", updatedBy: userId })
    .onConflictDoUpdate({
      target: [schema.leaveBalances.employeeId, schema.leaveBalances.leaveTypeId, schema.leaveBalances.year],
      set: { grantedMinutes: input.grantedMinutes, note: input.note ?? "", updatedBy: userId },
    })
    .returning();
  return row!;
}

export async function listBalances(db: Db, year: number, employeeId?: number) {
  const conds = [eq(schema.leaveBalances.year, year)];
  if (employeeId !== undefined) conds.push(eq(schema.leaveBalances.employeeId, employeeId));
  const rows = await db
    .select({
      balance: schema.leaveBalances,
      employeeName: schema.employees.name,
      leaveTypeCode: schema.leaveTypes.code,
      leaveTypeName: schema.leaveTypes.name,
    })
    .from(schema.leaveBalances)
    .innerJoin(schema.employees, eq(schema.leaveBalances.employeeId, schema.employees.id))
    .innerJoin(schema.leaveTypes, eq(schema.leaveBalances.leaveTypeId, schema.leaveTypes.id))
    .where(and(...conds))
    .orderBy(asc(schema.leaveBalances.employeeId), asc(schema.leaveBalances.leaveTypeId));
  const approved = await usedByYear(db, year, ["approved"]);
  const pending = await usedByYear(db, year, ["pending"]);
  const key = (e: number, l: number) => `${e}:${l}`;
  const approvedMap = new Map(approved.map((r) => [key(r.employeeId, r.leaveTypeId ?? 0), r.minutes]));
  const pendingMap = new Map(pending.map((r) => [key(r.employeeId, r.leaveTypeId ?? 0), r.minutes]));
  return rows.map((r) => ({
    ...r.balance,
    employeeName: r.employeeName,
    leaveTypeCode: r.leaveTypeCode,
    leaveTypeName: r.leaveTypeName,
    usedMinutes: approvedMap.get(key(r.balance.employeeId, r.balance.leaveTypeId)) ?? 0,
    pendingMinutes: pendingMap.get(key(r.balance.employeeId, r.balance.leaveTypeId)) ?? 0,
  }));
}

// ── 簽核鏈 ──

/**
 * 提交時建鏈：直屬主管 → 所屬部門主管 → 上級部門主管…（去重、跳過本人與停用者，
 * 部門樹循環防護深度 10）。空鏈＝提交即核准——沒有人可以簽的單卡在系統裡才是事故。
 */
export async function buildApprovalChain(db: Db, employeeId: number): Promise<number[]> {
  const [emp] = await db.select().from(schema.employees).where(eq(schema.employees.id, employeeId));
  if (!emp) throw new AppError(404, `員工不存在: ${employeeId}`);
  const chain: number[] = [];
  const push = async (candidateId: number | null) => {
    if (candidateId === null || candidateId === employeeId || chain.includes(candidateId)) return;
    const [cand] = await db.select({ active: schema.employees.active }).from(schema.employees).where(eq(schema.employees.id, candidateId));
    if (cand?.active) chain.push(candidateId);
  };
  await push(emp.managerEmployeeId);
  let deptId = emp.departmentId;
  const visited = new Set<number>();
  for (let depth = 0; deptId !== null && depth < 10; depth++) {
    if (visited.has(deptId)) break;
    visited.add(deptId);
    const [dept] = await db.select().from(schema.departments).where(eq(schema.departments.id, deptId));
    if (!dept) break;
    await push(dept.managerEmployeeId);
    deptId = dept.parentId;
  }
  return chain;
}

// ── 申請單 ──

export interface CreateRequestInput {
  kind: RequestKind;
  employeeId: number;
  reason?: string | undefined;
  // leave
  leaveTypeId?: number | undefined;
  startAt?: string | undefined; // ISO datetime
  endAt?: string | undefined;
  minutes?: number | undefined;
  // overtime
  dayType?: string | undefined;
  // punch_correction（work_date 也給 overtime 用：加班是哪天的加班）
  workDate?: string | undefined;
  direction?: string | undefined;
  claimedTime?: string | undefined; // 'HH:MM' 台北時間
}

const HHMM = /^\d{2}:\d{2}$/;

function assertRequestShape(input: CreateRequestInput): void {
  if (input.kind === "leave") {
    if (!input.leaveTypeId) throw new AppError(422, "請假申請必須選假別");
    if (!input.startAt || !input.endAt) throw new AppError(422, "請假申請必須填起訖時間");
    if (new Date(input.endAt) <= new Date(input.startAt)) throw new AppError(422, "請假的結束時間必須晚於開始時間");
    if (!input.minutes || input.minutes <= 0) throw new AppError(422, "請假時數（分鐘）必須大於 0");
  } else if (input.kind === "overtime") {
    if (!input.workDate) throw new AppError(422, "加班申請必須填加班日期");
    if (!input.dayType || !DAY_TYPES.includes(input.dayType as (typeof DAY_TYPES)[number])) {
      throw new AppError(422, `加班申請必須選日型（${DAY_TYPES.map((d) => DAY_TYPE_LABELS[d]).join("／")}）`);
    }
    if (!input.minutes || input.minutes <= 0) throw new AppError(422, "加班時數（分鐘）必須大於 0");
  } else if (input.kind === "punch_correction") {
    if (!input.workDate) throw new AppError(422, "補卡申請必須填出勤日");
    if (input.direction !== "in" && input.direction !== "out") throw new AppError(422, "補卡申請必須選方向（上班／下班）");
    if (!input.claimedTime || !HHMM.test(input.claimedTime)) throw new AppError(422, "補卡申請必須填時刻（HH:MM）");
  } else {
    throw new AppError(422, `未知的申請類型: ${input.kind}`);
  }
}

/** 請假額度把關：該假別×該年度**有設額度列才把關**（事假這類不給額度的假別不擋） */
async function assertQuota(db: Db, employeeId: number, leaveTypeId: number, startAt: string, minutes: number): Promise<void> {
  const year = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric" }).format(new Date(startAt)),
  );
  const [balance] = await db
    .select()
    .from(schema.leaveBalances)
    .where(
      and(
        eq(schema.leaveBalances.employeeId, employeeId),
        eq(schema.leaveBalances.leaveTypeId, leaveTypeId),
        eq(schema.leaveBalances.year, year),
      ),
    );
  if (!balance) return;
  const sums = await usedByYear(db, year, ["approved", "pending"]);
  const used = sums.find((r) => r.employeeId === employeeId && r.leaveTypeId === leaveTypeId)?.minutes ?? 0;
  const remaining = balance.grantedMinutes - used;
  if (minutes > remaining) {
    const h = (m: number) => `${Math.floor(m / 60)} 時 ${m % 60} 分`;
    throw new AppError(
      422,
      `額度不足：本年度給假 ${h(balance.grantedMinutes)}，已用＋簽核中 ${h(used)}，` +
        `剩 ${h(Math.max(0, remaining))}，本次申請 ${h(minutes)}。要調整額度請洽人事（人事管理 → 額度帳）`,
    );
  }
}

export async function createRequest(db: Db, input: CreateRequestInput, userId: number) {
  assertRequestShape(input);
  if (input.kind === "leave") {
    const [lt] = await db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.id, input.leaveTypeId!));
    if (!lt) throw new AppError(404, `假別不存在: ${input.leaveTypeId}`);
    if (!lt.active) throw new AppError(422, `假別「${lt.name}」已停用`);
    await assertQuota(db, input.employeeId, input.leaveTypeId!, input.startAt!, input.minutes!);
  }
  const chain = await buildApprovalChain(db, input.employeeId);
  return db.transaction(async (tx) => {
    const [req] = await tx
      .insert(schema.hrRequests)
      .values({
        kind: input.kind,
        employeeId: input.employeeId,
        status: chain.length === 0 ? "approved" : "pending",
        reason: input.reason ?? "",
        leaveTypeId: input.leaveTypeId ?? null,
        startAt: input.startAt ? new Date(input.startAt) : null,
        endAt: input.endAt ? new Date(input.endAt) : null,
        minutes: input.minutes ?? null,
        dayType: input.dayType ?? null,
        workDate: input.workDate ?? null,
        direction: input.direction ?? null,
        claimedTime: input.claimedTime ?? null,
        decidedAt: chain.length === 0 ? new Date() : null,
      })
      .returning();
    for (let i = 0; i < chain.length; i++) {
      await tx.insert(schema.hrRequestSteps).values({
        requestId: req!.id,
        stepNo: i + 1,
        approverEmployeeId: chain[i]!,
        status: i === 0 ? "pending" : "waiting",
      });
    }
    let applied = req!;
    if (chain.length === 0) applied = await applyApprovedEffects(tx, req!);
    return { ...applied, autoApproved: chain.length === 0 };
  });
}

/**
 * 核准生效：忘打卡寫入更正卡。請假不必寫什麼——額度的「已用」本來就從核准單推導；
 * 加班同理（月彙總與薪資批直接讀核准單）。
 */
async function applyApprovedEffects(tx: Db, req: typeof schema.hrRequests.$inferSelect) {
  if (req.kind !== "punch_correction") return req;
  // 台北固定 UTC+8：申請人填的「那天幾點」直接落成 UTC 時刻
  const punchedAt = new Date(`${req.workDate}T${req.claimedTime}:00+08:00`);
  const [punchRow] = await tx
    .insert(schema.punches)
    .values({
      employeeId: req.employeeId,
      punchedAt,
      direction: req.direction!,
      workDate: req.workDate!, // 出勤日以申請人自填為準，不重推歸屬日
      sourceIp: "",
      method: "correction",
      memo: `補卡申請 #${req.id}`,
    })
    .returning();
  const [updated] = await tx
    .update(schema.hrRequests)
    .set({ correctionPunchId: punchRow!.id })
    .where(eq(schema.hrRequests.id, req.id))
    .returning();
  return updated!;
}

export async function decideStep(
  db: Db,
  input: { requestId: number; action: "approve" | "reject"; comment?: string | undefined },
  actor: { userId: number; employeeId: number | null; isAdmin: boolean },
) {
  return db.transaction(async (tx) => {
    const [req] = await tx.select().from(schema.hrRequests).where(eq(schema.hrRequests.id, input.requestId));
    if (!req) throw new AppError(404, `申請單不存在: ${input.requestId}`);
    if (req.status !== "pending") {
      throw new AppError(422, `這張申請單已${req.status === "approved" ? "核准" : req.status === "rejected" ? "駁回" : "取消"}，不能再簽`);
    }
    const steps = await tx
      .select()
      .from(schema.hrRequestSteps)
      .where(eq(schema.hrRequestSteps.requestId, req.id))
      .orderBy(asc(schema.hrRequestSteps.stepNo));
    const current = steps.find((s) => s.status === "pending");
    if (!current) throw new AppError(500, `申請單 #${req.id} 狀態為簽核中卻沒有待簽的關卡（資料不一致）`);
    if (!actor.isAdmin && current.approverEmployeeId !== actor.employeeId) {
      throw new AppError(403, "這一關的簽核人不是你（管理者可代簽）");
    }
    const now = new Date();
    await tx
      .update(schema.hrRequestSteps)
      .set({
        status: input.action === "approve" ? "approved" : "rejected",
        comment: input.comment ?? "",
        decidedAt: now,
        decidedByUserId: actor.userId,
      })
      .where(eq(schema.hrRequestSteps.id, current.id));
    if (input.action === "reject") {
      const remaining = steps.filter((s) => s.stepNo > current.stepNo);
      if (remaining.length) {
        await tx
          .update(schema.hrRequestSteps)
          .set({ status: "skipped" })
          .where(inArray(schema.hrRequestSteps.id, remaining.map((s) => s.id)));
      }
      const [updated] = await tx
        .update(schema.hrRequests)
        .set({ status: "rejected", decidedAt: now })
        .where(eq(schema.hrRequests.id, req.id))
        .returning();
      return updated!;
    }
    const next = steps.find((s) => s.stepNo > current.stepNo && s.status === "waiting");
    if (next) {
      await tx.update(schema.hrRequestSteps).set({ status: "pending" }).where(eq(schema.hrRequestSteps.id, next.id));
      return req;
    }
    const [updated] = await tx
      .update(schema.hrRequests)
      .set({ status: "approved", decidedAt: now })
      .where(eq(schema.hrRequests.id, req.id))
      .returning();
    return applyApprovedEffects(tx, updated!);
  });
}

export async function cancelRequest(db: Db, requestId: number, employeeId: number | null) {
  return db.transaction(async (tx) => {
    const [req] = await tx.select().from(schema.hrRequests).where(eq(schema.hrRequests.id, requestId));
    if (!req) throw new AppError(404, `申請單不存在: ${requestId}`);
    if (req.employeeId !== employeeId) throw new AppError(403, "只能取消自己的申請單");
    if (req.status !== "pending") throw new AppError(422, "只有簽核中的申請單可以取消");
    await tx
      .update(schema.hrRequestSteps)
      .set({ status: "skipped" })
      .where(and(eq(schema.hrRequestSteps.requestId, requestId), inArray(schema.hrRequestSteps.status, ["waiting", "pending"])));
    const [updated] = await tx
      .update(schema.hrRequests)
      .set({ status: "canceled", decidedAt: new Date() })
      .where(eq(schema.hrRequests.id, requestId))
      .returning();
    return updated!;
  });
}

async function decorateRequests(db: Db, rows: (typeof schema.hrRequests.$inferSelect)[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const steps = await db
    .select({ step: schema.hrRequestSteps, approverName: schema.employees.name })
    .from(schema.hrRequestSteps)
    .innerJoin(schema.employees, eq(schema.hrRequestSteps.approverEmployeeId, schema.employees.id))
    .where(inArray(schema.hrRequestSteps.requestId, ids))
    .orderBy(asc(schema.hrRequestSteps.stepNo));
  const employees = await db.select({ id: schema.employees.id, name: schema.employees.name }).from(schema.employees);
  const leaveTypes = await db.select().from(schema.leaveTypes);
  const empName = new Map(employees.map((e) => [e.id, e.name]));
  const ltName = new Map(leaveTypes.map((l) => [l.id, l.name]));
  return rows.map((r) => ({
    ...r,
    employeeName: empName.get(r.employeeId) ?? `#${r.employeeId}`,
    leaveTypeName: r.leaveTypeId ? (ltName.get(r.leaveTypeId) ?? null) : null,
    steps: steps
      .filter((s) => s.step.requestId === r.id)
      .map((s) => ({ ...s.step, approverName: s.approverName })),
  }));
}

export async function myRequests(db: Db, employeeId: number) {
  const rows = await db
    .select()
    .from(schema.hrRequests)
    .where(eq(schema.hrRequests.employeeId, employeeId))
    .orderBy(desc(schema.hrRequests.createdAt))
    .limit(100);
  return decorateRequests(db, rows);
}

export async function pendingApprovals(db: Db, approverEmployeeId: number) {
  const stepRows = await db
    .select({ requestId: schema.hrRequestSteps.requestId })
    .from(schema.hrRequestSteps)
    .where(
      and(eq(schema.hrRequestSteps.approverEmployeeId, approverEmployeeId), eq(schema.hrRequestSteps.status, "pending")),
    );
  if (!stepRows.length) return [];
  const rows = await db
    .select()
    .from(schema.hrRequests)
    .where(inArray(schema.hrRequests.id, stepRows.map((s) => s.requestId)))
    .orderBy(asc(schema.hrRequests.createdAt));
  return decorateRequests(db, rows.filter((r) => r.status === "pending"));
}

export async function listRequests(
  db: Db,
  q: { status?: string | undefined; kind?: string | undefined },
) {
  const conds = [];
  if (q.status) conds.push(eq(schema.hrRequests.status, q.status));
  if (q.kind) conds.push(eq(schema.hrRequests.kind, q.kind));
  const rows = await db
    .select()
    .from(schema.hrRequests)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.hrRequests.createdAt))
    .limit(500);
  return decorateRequests(db, rows);
}

// ── 行事曆 ──

export async function listCalendar(db: Db, year: number) {
  return db
    .select()
    .from(schema.calendarDays)
    .where(and(gte(schema.calendarDays.day, `${year}-01-01`), lte(schema.calendarDays.day, `${year}-12-31`)))
    .orderBy(asc(schema.calendarDays.day));
}

/** 批次貼上（人事行政局公告使用者自己抄）：同日 upsert——行事曆是政策不是事實，可改 */
export async function setCalendarDays(db: Db, entries: { day: string; kind: string; name?: string | undefined }[]) {
  for (const e of entries) {
    if (e.kind !== "holiday" && e.kind !== "makeup_workday") {
      throw new AppError(422, `行事曆的類型只能是 holiday（放假）或 makeup_workday（補班），收到「${e.kind}」（${e.day}）`);
    }
  }
  let count = 0;
  for (const e of entries) {
    await db
      .insert(schema.calendarDays)
      .values({ day: e.day, kind: e.kind, name: e.name ?? "" })
      .onConflictDoUpdate({ target: schema.calendarDays.day, set: { kind: e.kind, name: e.name ?? "" } });
    count++;
  }
  return { saved: count };
}

export async function deleteCalendarDay(db: Db, day: string) {
  const [row] = await db.delete(schema.calendarDays).where(eq(schema.calendarDays.day, day)).returning();
  if (!row) throw new AppError(404, `行事曆上沒有 ${day} 這一天`);
  return { ok: true };
}
