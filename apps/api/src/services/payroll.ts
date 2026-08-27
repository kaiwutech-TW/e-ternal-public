/**
 * 薪資（0041）：員工薪資檔（歷次）、加班費率、發薪作業（草稿→定案過帳）。
 *
 * ★ 設計紀律（與稅法參數同一條，違反者重做）：**系統不內建任何法定數字**——
 *   加班倍率、時薪除數、勞健保金額、假別給薪比率全部使用者自填。缺哪個參數就
 *   **大聲**寫進該員工的 warnings 並把那一項算 0，絕不靜默套一個「常見值」。
 *
 * ★ 計算明細整包快照進 payroll_items.detail：定案後改費率／補打卡／改假別比率，
 *   已定案的薪資單一個位元都不動（費率快照教訓的第 N 次應用）。
 *   草稿可整批重算（手動調整項與備註保留），定案不可動。
 *
 * ★ 定案過帳（chart.ts ACCOUNT 常數，全是系統科目）：
 *   借 6111 薪資支出（毛額）、6113 勞健保費（雇主）、6114 勞工退休金（雇主提繳）
 *   貸 2202 應付薪資（實發）、2212 代扣勞健保費（員工負擔）、2203 應付費用（雇主應繳）
 *
 * ★ 實際發薪的沖銷走**手工傳票**（借 2202／貸 銀行存款），**不是收付款單**——
 *   收付款單的對象必須是供應商、借方寫死應付帳款（services/ledger.ts），沖不到 2202。
 *   要改這裡的文案前先確認 ledger 真的做得到，否則就是「說了程式沒做的事」。
 *   扣繳稅款本批不算：員工薪資的扣繳稅額表未內建，要扣請用「手動調整減項」並自行留依據。
 */
import { ACCOUNT } from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { monthlySummary, type EmployeeMonthSummary } from "./attendance.ts";
import { DAY_TYPE_LABELS } from "./hr-leave.ts";
import { assertPeriodOpen } from "./period.ts";

// ── 員工薪資檔（歷次紀錄：調薪新增一列，舊列不動）──

export async function listSalaries(db: Db, employeeId?: number) {
  const rows = await db
    .select({ salary: schema.employeeSalaries, employeeName: schema.employees.name })
    .from(schema.employeeSalaries)
    .innerJoin(schema.employees, eq(schema.employeeSalaries.employeeId, schema.employees.id))
    .where(employeeId === undefined ? undefined : eq(schema.employeeSalaries.employeeId, employeeId))
    .orderBy(asc(schema.employeeSalaries.employeeId), desc(schema.employeeSalaries.validFrom));
  return rows.map((r) => ({ ...r.salary, employeeName: r.employeeName }));
}

export interface SalaryInput {
  employeeId: number;
  validFrom: string;
  payType: "monthly" | "hourly";
  baseAmount: number;
  hourlyDivisor?: number | null | undefined;
  mealAllowance?: number | undefined;
  mealAllowanceInBase?: boolean | undefined;
  laborInsEmployee?: number | undefined;
  laborInsEmployer?: number | undefined;
  healthInsEmployee?: number | undefined;
  healthInsEmployer?: number | undefined;
  pensionEmployer?: number | undefined;
  sourceNote?: string | undefined;
  note?: string | undefined;
}

export async function createSalary(db: Db, input: SalaryInput, userId: number) {
  const [emp] = await db.select().from(schema.employees).where(eq(schema.employees.id, input.employeeId));
  if (!emp) throw new AppError(404, "員工不存在: {id}", { id: input.employeeId });
  const [dup] = await db
    .select({ id: schema.employeeSalaries.id })
    .from(schema.employeeSalaries)
    .where(
      and(
        eq(schema.employeeSalaries.employeeId, input.employeeId),
        eq(schema.employeeSalaries.validFrom, input.validFrom),
      ),
    );
  if (dup) {
    throw new AppError(
      409,
      "{name} 已有 {validFrom} 生效的薪資列（#{id}）。薪資檔是歷次紀錄——填錯的話請新增一列從更正生效日起用，並在備註寫明更正了哪一列",
      { name: emp.name, validFrom: input.validFrom, id: dup.id },
    );
  }
  const [row] = await db
    .insert(schema.employeeSalaries)
    .values({
      employeeId: input.employeeId,
      validFrom: input.validFrom,
      payType: input.payType,
      baseAmount: input.baseAmount,
      hourlyDivisor: input.hourlyDivisor ?? null,
      mealAllowance: input.mealAllowance ?? 0,
      mealAllowanceInBase: input.mealAllowanceInBase ?? false,
      laborInsEmployee: input.laborInsEmployee ?? 0,
      laborInsEmployer: input.laborInsEmployer ?? 0,
      healthInsEmployee: input.healthInsEmployee ?? 0,
      healthInsEmployer: input.healthInsEmployer ?? 0,
      pensionEmployer: input.pensionEmployer ?? 0,
      sourceNote: input.sourceNote ?? "",
      note: input.note ?? "",
      createdBy: userId,
    })
    .returning();
  return row!;
}

// ── 加班費率（倍率使用者自填）──

export async function listOvertimeRates(db: Db) {
  return db
    .select()
    .from(schema.overtimeRates)
    .orderBy(asc(schema.overtimeRates.dayType), asc(schema.overtimeRates.fromMinutes));
}

export async function createOvertimeRate(
  db: Db,
  input: {
    dayType: string;
    fromMinutes: number;
    multiplierBp: number;
    /** 「以固定時數計」：非 NULL＝這一級不看實際分鐘，一律以此分鐘數計酬（例假日做 6 給 8） */
    fixedMinutes?: number | null | undefined;
    sourceNote?: string | undefined;
  },
) {
  if (!(input.dayType in DAY_TYPE_LABELS)) {
    throw new AppError(422, "日型必須是 {types} 之一（收到「{raw}」）", { types: Object.keys(DAY_TYPE_LABELS).join("/"), raw: input.dayType });
  }
  const [dup] = await db
    .select({ id: schema.overtimeRates.id })
    .from(schema.overtimeRates)
    .where(
      and(eq(schema.overtimeRates.dayType, input.dayType), eq(schema.overtimeRates.fromMinutes, input.fromMinutes)),
    );
  if (dup) throw new AppError(409, "{dayType}第 {fromMinutes} 分鐘起的費率已存在（#{id}），請先刪除再新增", { dayType: DAY_TYPE_LABELS[input.dayType], fromMinutes: input.fromMinutes, id: dup.id });
  const [row] = await db
    .insert(schema.overtimeRates)
    .values({ ...input, fixedMinutes: input.fixedMinutes ?? null, sourceNote: input.sourceNote ?? "" })
    .returning();
  return row!;
}

type OvertimeRateRow = typeof schema.overtimeRates.$inferSelect;

/**
 * 單一張加班單（＝單日）的計酬「加權分鐘」。級距**按單**套用——
 * golden sample 逐筆核對的結論：兩天各加班 2 小時是「兩次第一級」，
 * 不是月合計 4 小時拆成兩級（按月合計會多算錢）。
 * fixed_minutes 級距：加班時數一進入該級（minutes > from）就以固定分鐘數計酬，
 * 不看實際落在級內幾分鐘（例假日「0-8 小時以 8 小時計」＝做 6 給 8 的形狀）。
 */
export function overtimeWeightedMinutes(minutes: number, tiers: OvertimeRateRow[]): number {
  let weighted = 0;
  for (let i = 0; i < tiers.length; i++) {
    const from = tiers[i]!.fromMinutes;
    const to = i + 1 < tiers.length ? tiers[i + 1]!.fromMinutes : Infinity;
    const mult = tiers[i]!.multiplierBp / 10_000;
    if (tiers[i]!.fixedMinutes !== null) {
      if (minutes > from) weighted += tiers[i]!.fixedMinutes! * mult;
    } else {
      const seg = Math.max(0, Math.min(minutes, to) - from);
      weighted += seg * mult;
    }
  }
  return weighted;
}

export async function deleteOvertimeRate(db: Db, id: number) {
  // 費率表是「之後怎麼算」的政策，可刪——已定案薪資單的計算快照在 detail 裡，動不到
  const [row] = await db.delete(schema.overtimeRates).where(eq(schema.overtimeRates.id, id)).returning();
  if (!row) throw new AppError(404, "加班費率不存在: {id}", { id });
  return { ok: true };
}

// ── 發薪作業 ──

interface ComputedItem {
  employeeId: number;
  employeeName: string;
  basePay: number;
  mealAllowance: number;
  overtimePay: number;
  leaveDeduction: number;
  lateEarlyDeduction: number;
  absenceDeduction: number;
  laborInsEmployee: number;
  healthInsEmployee: number;
  laborInsEmployer: number;
  healthInsEmployer: number;
  pensionEmployer: number;
  detail: Record<string, unknown>;
}

function monthEnd(month: string): string {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

/** 依月份計算全員薪資（純計算不落地；createRun/recalcRun 才寫） */
async function computePayroll(db: Db, month: string): Promise<ComputedItem[]> {
  const summaries = await monthlySummary(db, month);
  const salaryRows = await db.select().from(schema.employeeSalaries).orderBy(asc(schema.employeeSalaries.validFrom));
  const rates = await db
    .select()
    .from(schema.overtimeRates)
    .orderBy(asc(schema.overtimeRates.fromMinutes));
  const leaveTypes = await db.select().from(schema.leaveTypes);
  const asOf = monthEnd(month);
  // 加班單逐張取（級距按單套用，見 overtimeWeightedMinutes）——月彙總的日型合計只拿來顯示
  const otRequests = await db
    .select()
    .from(schema.hrRequests)
    .where(
      and(
        eq(schema.hrRequests.kind, "overtime"),
        eq(schema.hrRequests.status, "approved"),
        gte(schema.hrRequests.workDate, `${month}-01`),
        lte(schema.hrRequests.workDate, asOf),
      ),
    );
  const out: ComputedItem[] = [];
  for (const s of summaries) {
    const warnings: string[] = [];
    // 該員工在月底當天生效的薪資列（validFrom 最新且 ≤ 月底）
    const mine = salaryRows.filter((r) => r.employeeId === s.employeeId && r.validFrom <= asOf);
    const salary = mine[mine.length - 1];
    if (!salary) {
      out.push({
        employeeId: s.employeeId,
        employeeName: s.employeeName,
        basePay: 0,
        mealAllowance: 0,
        overtimePay: 0,
        leaveDeduction: 0,
        lateEarlyDeduction: 0,
        absenceDeduction: 0,
        laborInsEmployee: 0,
        healthInsEmployee: 0,
        laborInsEmployer: 0,
        healthInsEmployer: 0,
        pensionEmployer: 0,
        detail: { warnings: ["未設薪資檔（薪資 → 員工薪資檔），本次全部算 0——不是這個人不用發薪"], summary: s },
      });
      continue;
    }
    // 時薪：月薪制＝(本薪＋伙食津貼若設定計入基底)÷除數（除數使用者自填）；時薪制＝本薪就是時薪。
    // 取到小數兩位再往下乘——golden sample 逐筆核對出來的慣例（270.8333→270.83），
    // 不取整的話大量加班的員工會差個位數
    const mealInBase = salary.payType === "monthly" && salary.mealAllowanceInBase;
    const hourlyBase = salary.baseAmount + (mealInBase ? salary.mealAllowance : 0);
    let hourlyRate: number | null = null;
    if (salary.payType === "hourly") hourlyRate = salary.baseAmount;
    else if (salary.hourlyDivisor && salary.hourlyDivisor > 0) {
      hourlyRate = Math.round((hourlyBase / salary.hourlyDivisor) * 100) / 100;
    } else warnings.push("月薪制未設「時薪換算除數」——加班費、請假與缺勤扣款無法換算，全部算 0。請在薪資檔補除數與依據");

    const basePay =
      salary.payType === "monthly" ? salary.baseAmount : Math.round((s.workedMinutes / 60) * salary.baseAmount);
    // 伙食津貼：月薪制固定加項整額入帳；時薪制的按時折算沒有唯一算法，明講不算
    let mealAllowance = 0;
    if (salary.mealAllowance > 0) {
      if (salary.payType === "monthly") mealAllowance = salary.mealAllowance;
      else warnings.push("時薪制的伙食津貼折算本批未實作：需要的話用手動調整加項並留備註");
    }
    if (salary.payType === "hourly" && Object.keys(s.leaveByType).length > 0) {
      warnings.push("時薪制的有薪假折算本批未實作：核准的請假時數未計酬，需要的話用手動調整加項並留備註");
    }

    /**
     * 應稅/免稅拆分（純算術分攤，不涉法規判斷）：扣款的時薪基底含伙食津貼時，
     * 本薪側與津貼側**各自用全精度時薪算、各自四捨五入後相加**——總額可能比未拆分
     * 多 1 元，是拆分進位的正常現象。**不能先取兩位小數再按比例拆**：全精度基底算出來的
     * 3 小時可能是 587.5→588，先把時薪取兩位再乘會變 587.49→587——平行試跑實際差過 2 元。
     * 基底不含伙食津貼時整額歸本薪側。
     */
    const divisor = salary.hourlyDivisor && salary.hourlyDivisor > 0 ? salary.hourlyDivisor : null;
    const splitByBase = (minutesTimesRatio: number): { taxable: number; exempt: number } => {
      if (divisor === null) return { taxable: 0, exempt: 0 };
      const taxableRaw = (minutesTimesRatio / 60) * (salary.baseAmount / divisor);
      if (!mealInBase || salary.mealAllowance <= 0) {
        return { taxable: Math.round(taxableRaw), exempt: 0 };
      }
      return {
        taxable: Math.round(taxableRaw),
        exempt: Math.round((minutesTimesRatio / 60) * (salary.mealAllowance / divisor)),
      };
    };

    // 加班費：逐張加班單（＝逐日）套級距，再彙總
    let overtimePay = 0;
    const otBreakdown: Record<string, { minutes: number; pay: number }> = {};
    const warnedNoRate = new Set<string>();
    for (const req of otRequests) {
      if (req.employeeId !== s.employeeId) continue;
      const dayType = req.dayType ?? "workday";
      const minutes = req.minutes ?? 0;
      const tiers = rates.filter((r) => r.dayType === dayType);
      if (!tiers.length) {
        if (!warnedNoRate.has(dayType)) {
          warnedNoRate.add(dayType);
          warnings.push(`「${DAY_TYPE_LABELS[dayType] ?? dayType}」的加班費率未設定（薪資 → 加班費率），該日型的加班算 0`);
        }
        continue;
      }
      if (hourlyRate === null) continue; // 上面已警告過除數
      const pay = (overtimeWeightedMinutes(minutes, tiers) / 60) * hourlyRate;
      overtimePay += pay;
      const agg = otBreakdown[dayType] ?? { minutes: 0, pay: 0 };
      agg.minutes += minutes;
      agg.pay = Math.round(agg.pay + pay);
      otBreakdown[dayType] = agg;
    }

    // 請假扣款（月薪制）：按假別給薪比率扣「不給薪的那部分」；比率未填＝明講不扣。
    // 各假別以「加權分鐘」（分鐘×不給薪比率）累加，最後兩側各自算錢取整（見 splitByBase）
    let leaveWeightedMinutes = 0;
    if (salary.payType === "monthly" && hourlyRate !== null) {
      for (const [code, minutes] of Object.entries(s.leaveByType)) {
        const lt = leaveTypes.find((l) => l.code === code);
        if (!lt) continue;
        if (lt.payRatioPercent === null) {
          warnings.push(`假別「${lt.name}」未設定給薪比率（人事管理 → 假別），該假 ${minutes} 分鐘未計扣款`);
          continue;
        }
        leaveWeightedMinutes += minutes * ((100 - lt.payRatioPercent) / 100);
      }
    }
    const leaveSplit = splitByBase(leaveWeightedMinutes);
    const leaveDeduction = leaveSplit.taxable + leaveSplit.exempt;

    // 遲到早退扣款（月薪制）：分鐘 × 時薪 ÷ 60，按分鐘比例非級距（golden sample 逐筆核對）
    let lateEarlyDeduction = 0;
    let lateEarlySplit = { taxable: 0, exempt: 0 };
    if (salary.payType === "monthly" && hourlyRate !== null && s.lateMinutes + s.earlyLeaveMinutes > 0) {
      lateEarlySplit = splitByBase(s.lateMinutes + s.earlyLeaveMinutes);
      lateEarlyDeduction = lateEarlySplit.taxable + lateEarlySplit.exempt;
    }

    // 缺勤扣款（月薪制）：有排班、無卡、無假的時數不給薪——這是算術不是法規判斷；
    // 公司政策不同（如口頭准假）請用手動調整加項補回並留備註
    let absenceDeduction = 0;
    if (salary.payType === "monthly" && hourlyRate !== null && s.absentMinutes > 0) {
      absenceDeduction = (s.absentMinutes / 60) * hourlyRate;
    }

    out.push({
      employeeId: s.employeeId,
      employeeName: s.employeeName,
      basePay,
      mealAllowance,
      overtimePay: Math.round(overtimePay),
      leaveDeduction,
      lateEarlyDeduction,
      absenceDeduction: Math.round(absenceDeduction),
      laborInsEmployee: salary.laborInsEmployee,
      healthInsEmployee: salary.healthInsEmployee,
      laborInsEmployer: salary.laborInsEmployer,
      healthInsEmployer: salary.healthInsEmployer,
      pensionEmployer: salary.pensionEmployer,
      detail: {
        salaryRowId: salary.id,
        payType: salary.payType,
        baseAmount: salary.baseAmount,
        hourlyDivisor: salary.hourlyDivisor,
        mealAllowanceInBase: salary.mealAllowanceInBase,
        hourlyRate,
        otBreakdown,
        // 應免稅拆分快照（算術分攤；加班費的免稅上限標記是另一站，本批不拆加班費）
        leaveSplit,
        lateEarlySplit,
        summary: s satisfies EmployeeMonthSummary,
        warnings,
      },
    });
  }
  return out;
}

function netOf(i: {
  basePay: number;
  mealAllowance: number;
  overtimePay: number;
  leaveDeduction: number;
  lateEarlyDeduction: number;
  absenceDeduction: number;
  otherEarning: number;
  otherDeduction: number;
  laborInsEmployee: number;
  healthInsEmployee: number;
}): { gross: number; net: number } {
  const gross =
    i.basePay + i.mealAllowance + i.overtimePay
    - i.leaveDeduction - i.lateEarlyDeduction - i.absenceDeduction
    + i.otherEarning - i.otherDeduction;
  return { gross, net: gross - i.laborInsEmployee - i.healthInsEmployee };
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function createRun(db: Db, month: string, userId: number) {
  if (!MONTH_RE.test(month)) throw new AppError(400, "月份格式須為 YYYY-MM（收到「{raw}」）", { raw: month });
  const [dup] = await db.select().from(schema.payrollRuns).where(eq(schema.payrollRuns.month, month));
  if (dup) {
    const state = dup.status === "draft" ? "草稿——要更新數字請用「重算」" : "已定案";
    throw new AppError(409, "{month} 已有發薪作業（#{id}，{state}）", { month, id: dup.id, state });
  }
  const items = await computePayroll(db, month);
  return db.transaction(async (tx) => {
    const [run] = await tx.insert(schema.payrollRuns).values({ month, createdBy: userId }).returning();
    for (const i of items) {
      const { net } = netOf({ ...i, otherEarning: 0, otherDeduction: 0 });
      await tx.insert(schema.payrollItems).values({ runId: run!.id, ...toRow(i), netPay: net });
    }
    return getRun(tx, run!.id);
  });
}

function toRow(i: ComputedItem) {
  return {
    employeeId: i.employeeId,
    basePay: i.basePay,
    mealAllowance: i.mealAllowance,
    overtimePay: i.overtimePay,
    leaveDeduction: i.leaveDeduction,
    lateEarlyDeduction: i.lateEarlyDeduction,
    absenceDeduction: i.absenceDeduction,
    laborInsEmployee: i.laborInsEmployee,
    healthInsEmployee: i.healthInsEmployee,
    laborInsEmployer: i.laborInsEmployer,
    healthInsEmployer: i.healthInsEmployer,
    pensionEmployer: i.pensionEmployer,
    detail: i.detail,
  };
}

async function requireRun(db: Db, id: number) {
  const [run] = await db.select().from(schema.payrollRuns).where(eq(schema.payrollRuns.id, id));
  if (!run) throw new AppError(404, "發薪作業不存在: {id}", { id });
  return run;
}

export async function getRun(db: Db, id: number) {
  const run = await requireRun(db, id);
  const items = await db
    .select({ item: schema.payrollItems, employeeName: schema.employees.name })
    .from(schema.payrollItems)
    .innerJoin(schema.employees, eq(schema.payrollItems.employeeId, schema.employees.id))
    .where(eq(schema.payrollItems.runId, id))
    .orderBy(asc(schema.payrollItems.employeeId));
  return { ...run, items: items.map((r) => ({ ...r.item, employeeName: r.employeeName })) };
}

export async function listRuns(db: Db) {
  return db.select().from(schema.payrollRuns).orderBy(desc(schema.payrollRuns.month));
}

/** 重算（僅草稿）：出勤與參數的最新狀態重新取數；手動調整項與備註按員工保留 */
export async function recalcRun(db: Db, id: number) {
  const run = await requireRun(db, id);
  if (run.status !== "draft") throw new AppError(422, "已定案的發薪作業不可重算——計算快照就是當初發薪的依據");
  const items = await computePayroll(db, run.month);
  return db.transaction(async (tx) => {
    const old = await tx.select().from(schema.payrollItems).where(eq(schema.payrollItems.runId, id));
    const manual = new Map(old.map((o) => [o.employeeId, { otherEarning: o.otherEarning, otherDeduction: o.otherDeduction, memo: o.memo }]));
    await tx.delete(schema.payrollItems).where(eq(schema.payrollItems.runId, id));
    for (const i of items) {
      const m = manual.get(i.employeeId) ?? { otherEarning: 0, otherDeduction: 0, memo: "" };
      const { net } = netOf({ ...i, otherEarning: m.otherEarning, otherDeduction: m.otherDeduction });
      await tx.insert(schema.payrollItems).values({ runId: id, ...toRow(i), ...m, netPay: net });
    }
    return getRun(tx, id);
  });
}

/** 手動調整（僅草稿）：加項（獎金津貼）／減項（自行計算的扣繳稅款等）——系統不算的，人來補 */
export async function patchItem(
  db: Db,
  itemId: number,
  input: { otherEarning?: number | undefined; otherDeduction?: number | undefined; memo?: string | undefined },
) {
  const [item] = await db.select().from(schema.payrollItems).where(eq(schema.payrollItems.id, itemId));
  if (!item) throw new AppError(404, "薪資明細不存在: {id}", { id: itemId });
  const run = await requireRun(db, item.runId);
  if (run.status !== "draft") throw new AppError(422, "已定案的發薪作業不可調整");
  const merged = {
    ...item,
    otherEarning: input.otherEarning ?? item.otherEarning,
    otherDeduction: input.otherDeduction ?? item.otherDeduction,
    memo: input.memo ?? item.memo,
  };
  const { net } = netOf(merged);
  const [updated] = await db
    .update(schema.payrollItems)
    .set({ otherEarning: merged.otherEarning, otherDeduction: merged.otherDeduction, memo: merged.memo, netPay: net })
    .where(eq(schema.payrollItems.id, itemId))
    .returning();
  return updated!;
}

/**
 * 定案：計提傳票以**月底日**入帳（月底計提、次月發放的慣例；發放日的付款走收付款單沖 2202）。
 * 借 6111（毛額）6113（雇主勞健保）6114（勞退提繳）／貸 2202（實發）2212（員工保費）2203（雇主應繳）
 */
export async function finalizeRun(db: Db, id: number, userId: number) {
  return db.transaction(async (tx) => {
    const run = await requireRun(tx, id);
    if (run.status !== "draft") throw new AppError(422, "這個發薪作業已定案過");
    const entryDate = monthEnd(run.month);
    await assertPeriodOpen(tx, entryDate);
    const items = await tx.select().from(schema.payrollItems).where(eq(schema.payrollItems.runId, id));
    if (!items.length) throw new AppError(422, "發薪作業沒有任何明細，不能定案");
    let gross = 0;
    let net = 0;
    let insEmployee = 0;
    let insEmployer = 0;
    let pension = 0;
    for (const i of items) {
      const r = netOf(i);
      gross += r.gross;
      net += r.net;
      insEmployee += i.laborInsEmployee + i.healthInsEmployee;
      insEmployer += i.laborInsEmployer + i.healthInsEmployer;
      pension += i.pensionEmployer;
    }
    if (gross <= 0) throw new AppError(422, "毛額為 0——所有員工都沒算出薪資（多半是薪資檔沒建），定案沒有意義");
    const codes = [
      ACCOUNT.SALARY_EXPENSE,
      ACCOUNT.LABOR_HEALTH_INS_EXPENSE,
      ACCOUNT.PENSION_EXPENSE,
      ACCOUNT.SALARY_PAYABLE,
      ACCOUNT.WITHHOLDING_SUPPLEMENT_PAYABLE,
      ACCOUNT.ACCRUED_EXPENSE,
    ];
    const accountRows = await tx.select().from(schema.accounts).where(inArray(schema.accounts.code, codes));
    const idOf = new Map(accountRows.map((a) => [a.code, a.id]));
    const need = (code: string) => {
      const acctId = idOf.get(code);
      if (!acctId) throw new AppError(500, "科目未初始化: {code}（請重跑 migrate/seed）", { code });
      return acctId;
    };
    const [entry] = await tx
      .insert(schema.journalEntries)
      .values({
        entryDate,
        memo: `薪資 ${run.month} 發薪作業 #${id}（${items.length} 人）`,
        sourceType: "payroll",
        sourceId: id,
      })
      .returning();
    const lines = [
      { code: ACCOUNT.SALARY_EXPENSE, debit: gross, credit: 0 },
      { code: ACCOUNT.LABOR_HEALTH_INS_EXPENSE, debit: insEmployer, credit: 0 },
      { code: ACCOUNT.PENSION_EXPENSE, debit: pension, credit: 0 },
      { code: ACCOUNT.SALARY_PAYABLE, debit: 0, credit: net },
      { code: ACCOUNT.WITHHOLDING_SUPPLEMENT_PAYABLE, debit: 0, credit: insEmployee },
      { code: ACCOUNT.ACCRUED_EXPENSE, debit: 0, credit: insEmployer + pension },
    ].filter((l) => l.debit > 0 || l.credit > 0);
    await tx
      .insert(schema.journalLines)
      .values(lines.map((l) => ({ entryId: entry!.id, accountId: need(l.code), debit: l.debit, credit: l.credit })));
    const [updated] = await tx
      .update(schema.payrollRuns)
      .set({ status: "finalized", journalEntryId: entry!.id, finalizedAt: new Date(), finalizedBy: userId })
      .where(eq(schema.payrollRuns.id, id))
      .returning();
    return { ...updated!, journalEntryId: entry!.id };
  });
}
