/**
 * 週期性支出（0047）：每月／每季／每年固定要付出去的錢（設計紀律見 migration 檔頭）。
 *
 * 一句話版本：**這是計畫不是負債**。不產傳票、不進應付帳款、不進儀表板的應付數字——
 * 真正的負債只在單據過帳當下存在。這張表只回答一個問題：這個月有哪幾筆錢要付出去。
 *
 * ★ 零斷言紀律（DECISIONS 2026-08-01）在這裡的三個落點：
 *   ① 週期只能是「每 N 個月」的純數字，系統不提供任何以稅目/險種命名的範本
 *   ② basis（依據）必填，由使用者寫下自己查到的出處
 *   ③ 所有文案的主詞只能是「你設定的」——不得出現期限、日前、應於、逾期未申報
 *
 * ★ 「這期付了沒」一律推導，不存狀態欄（與 contract_installments 同一條紀律）：
 *   指向的報銷單／傳票存在且未作廢＝已結清。存了狀態就會漂移。
 */
import { schema } from "@tw-erp/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";

/** 一次展開的期數上限：與 generateSchedule 同一個理由——擋下「打錯年份生出 300 期」的失手 */
const MAX_GENERATED_ITEMS = 60;

async function requirePayable(db: Db, id: number) {
  const [row] = await db.select().from(schema.recurringPayables).where(eq(schema.recurringPayables.id, id));
  if (!row) throw new AppError(404, "週期性支出不存在: {id}", { id });
  return row;
}

async function requireItem(db: Db, payableId: number, itemId: number) {
  const [row] = await db
    .select()
    .from(schema.recurringPayableItems)
    .where(and(eq(schema.recurringPayableItems.id, itemId), eq(schema.recurringPayableItems.payableId, payableId)));
  if (!row) throw new AppError(404, "這筆週期性支出沒有這一期: {id}", { id: itemId });
  return row;
}

export interface PayableItemView {
  id: number;
  seq: number;
  dueDate: string;
  amount: number;
  description: string;
  expenseClaimId: number | null;
  journalEntryId: number | null;
  /** 已結清＝指向的報銷單／傳票存在且未作廢（作廢後回到 false，可重來） */
  settled: boolean;
}

/** 一次撈出所有關聯單據的存活狀態（不逐列查——N+1 是既有批次已列為要避免的形狀） */
async function settledSet(db: Db, rows: Array<{ expenseClaimId: number | null; journalEntryId: number | null }>) {
  const claimIds = rows.map((r) => r.expenseClaimId).filter((x): x is number => x !== null);
  const entryIds = rows.map((r) => r.journalEntryId).filter((x): x is number => x !== null);
  const claims = claimIds.length
    ? await db
        .select({ id: schema.expenseClaims.id, voidedAt: schema.expenseClaims.voidedAt })
        .from(schema.expenseClaims)
        .where(inArray(schema.expenseClaims.id, claimIds))
    : [];
  // 傳票沒有作廢欄位（作廢是另開反向傳票），存在即算數
  const entries = entryIds.length
    ? await db
        .select({ id: schema.journalEntries.id })
        .from(schema.journalEntries)
        .where(inArray(schema.journalEntries.id, entryIds))
    : [];
  return {
    claims: new Set(claims.filter((c) => !c.voidedAt).map((c) => c.id)),
    entries: new Set(entries.map((e) => e.id)),
  };
}

function toView(
  r: typeof schema.recurringPayableItems.$inferSelect,
  alive: { claims: Set<number>; entries: Set<number> },
): PayableItemView {
  return {
    id: r.id,
    seq: r.seq,
    dueDate: r.dueDate,
    amount: r.amount,
    description: r.description,
    expenseClaimId: r.expenseClaimId,
    journalEntryId: r.journalEntryId,
    settled:
      (r.expenseClaimId !== null && alive.claims.has(r.expenseClaimId)) ||
      (r.journalEntryId !== null && alive.entries.has(r.journalEntryId)),
  };
}

export async function listPayables(db: Db) {
  const rows = await db.select().from(schema.recurringPayables).orderBy(desc(schema.recurringPayables.id));
  const partnerIds = rows.map((r) => r.partnerId).filter((x): x is number => x !== null);
  const partners = partnerIds.length
    ? await db
        .select({ id: schema.partners.id, name: schema.partners.name })
        .from(schema.partners)
        .where(inArray(schema.partners.id, partnerIds))
    : [];
  const nameOf = new Map(partners.map((p) => [p.id, p.name]));
  return rows.map((r) => ({ ...r, partnerName: r.partnerId ? (nameOf.get(r.partnerId) ?? null) : null }));
}

export interface PayableInput {
  name: string;
  partnerId?: number | null | undefined;
  defaultAccountCode?: string | undefined;
  basis: string;
  intervalMonths: number;
  dayOfMonth: number;
  defaultAmount?: number | undefined;
  startDate: string;
  endDate?: string | null | undefined;
  memo?: string | undefined;
}

export async function createPayable(db: Db, input: PayableInput, userId: number) {
  // 依據欄空白＝這條紀錄沒有出處。擋在這裡而不是只寫 NOT NULL——空字串一樣是空
  if (!input.basis.trim()) {
    throw new AppError(
      422,
      "請填「依據」：這筆錢為什麼是這個金額、這個頻率，來源是什麼（合約條款、帳單、你查到的規定）。系統不預設任何金額或頻率，也不判斷你該不該付——這一欄是你自己的紀錄",
    );
  }
  if (input.endDate && input.endDate < input.startDate) {
    throw new AppError(422, "結束日（{endDate}）不可早於開始日（{startDate}）", { endDate: input.endDate, startDate: input.startDate });
  }
  if (input.defaultAccountCode) {
    const [acct] = await db
      .select({ code: schema.accounts.code, active: schema.accounts.active })
      .from(schema.accounts)
      .where(eq(schema.accounts.code, input.defaultAccountCode));
    if (!acct) throw new AppError(404, "會計科目不存在: {code}", { code: input.defaultAccountCode });
    if (!acct.active) throw new AppError(422, "會計科目 {code} 已停用", { code: input.defaultAccountCode });
  }
  const [row] = await db
    .insert(schema.recurringPayables)
    .values({
      name: input.name,
      partnerId: input.partnerId ?? null,
      defaultAccountCode: input.defaultAccountCode ?? null,
      basis: input.basis.trim(),
      intervalMonths: input.intervalMonths,
      dayOfMonth: input.dayOfMonth,
      defaultAmount: input.defaultAmount ?? 0,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      memo: input.memo ?? "",
      createdBy: userId,
    })
    .returning();
  return row!;
}

type PayablePatch = { [K in keyof PayableInput]?: PayableInput[K] | undefined } & { status?: string | undefined };

export async function updatePayable(db: Db, id: number, patch: PayablePatch) {
  await requirePayable(db, id);
  if (patch.basis !== undefined && !patch.basis.trim()) {
    throw new AppError(422, "「依據」不可清空——沒有出處的週期性支出，下一個看到它的人（包括你自己）無從判斷對不對");
  }
  if (Object.keys(patch).length === 0) throw new AppError(400, "未提供要修改的欄位");
  const [row] = await db
    .update(schema.recurringPayables)
    .set(patch)
    .where(eq(schema.recurringPayables.id, id))
    .returning();
  return row!;
}

export async function listItems(db: Db, payableId: number): Promise<PayableItemView[]> {
  const rows = await db
    .select()
    .from(schema.recurringPayableItems)
    .where(eq(schema.recurringPayableItems.payableId, payableId))
    .orderBy(asc(schema.recurringPayableItems.seq));
  if (!rows.length) return [];
  const alive = await settledSet(db, rows);
  return rows.map((r) => toView(r, alive));
}

/**
 * 展開排程：從 start_date 到 to（含），每 interval_months 一期、每期落在 day_of_month。
 * 系統只做日期算術——金額與起訖全部使用者給。大小月取月底（1/31 起排的下一期是 2/28）。
 * 觸發只能是使用者按按鈕：不得由任何系統事件（期別結束、發薪定案）自動生成。
 */
export async function generateItems(db: Db, payableId: number, to: string): Promise<PayableItemView[]> {
  const p = await requirePayable(db, payableId);
  const from = p.startDate;
  const limit = p.endDate && p.endDate < to ? p.endDate : to;
  const [fy, fm] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [ty, tm] = [Number(limit.slice(0, 4)), Number(limit.slice(5, 7))];
  const span = (ty - fy) * 12 + (tm - fm);
  if (span < 0) throw new AppError(422, "展開到 {limit} 早於開始月（{from}）", { limit: limit.slice(0, 7), from: from.slice(0, 7) });
  const count = Math.floor(span / p.intervalMonths) + 1;
  if (count > MAX_GENERATED_ITEMS) {
    throw new AppError(
      422,
      "一次最多展開 {max} 期（本次會展開 {count} 期）——請確認年份沒有打錯；真的要更長請分次展開",
      { max: MAX_GENERATED_ITEMS, count },
    );
  }
  const existing = await db
    .select({ seq: schema.recurringPayableItems.seq, dueDate: schema.recurringPayableItems.dueDate })
    .from(schema.recurringPayableItems)
    .where(eq(schema.recurringPayableItems.payableId, payableId));
  const taken = new Set(existing.map((e) => e.dueDate));
  let nextSeq = existing.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
  const values: Array<typeof schema.recurringPayableItems.$inferInsert> = [];
  for (let i = 0; i < count; i++) {
    const y = fy + Math.floor((fm - 1 + i * p.intervalMonths) / 12);
    const m = ((fm - 1 + i * p.intervalMonths) % 12) + 1;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = Math.min(p.dayOfMonth, lastDay);
    const dueDate = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (taken.has(dueDate)) continue; // 重複展開不生重複期
    values.push({ payableId, seq: nextSeq++, dueDate, amount: p.defaultAmount, description: "" });
  }
  if (!values.length) return listItems(db, payableId);
  if (p.defaultAmount <= 0) {
    throw new AppError(422, "每期金額必須大於 0——請先在這筆週期性支出上填「每期金額」再展開");
  }
  await db.insert(schema.recurringPayableItems).values(values);
  return listItems(db, payableId);
}

export async function updateItem(
  db: Db,
  payableId: number,
  itemId: number,
  patch: { dueDate?: string | undefined; amount?: number | undefined; description?: string | undefined },
): Promise<PayableItemView[]> {
  const row = await requireItem(db, payableId, itemId);
  const alive = await settledSet(db, [row]);
  if (toView(row, alive).settled) {
    throw new AppError(409, "第 {seq} 期已結清，金額與日期以那張單為準。要改請先解除結清", { seq: row.seq });
  }
  await db
    .update(schema.recurringPayableItems)
    .set({
      ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
      ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
    })
    .where(eq(schema.recurringPayableItems.id, itemId));
  return listItems(db, payableId);
}

export async function deleteItem(db: Db, payableId: number, itemId: number): Promise<void> {
  const row = await requireItem(db, payableId, itemId);
  const alive = await settledSet(db, [row]);
  if (toView(row, alive).settled) {
    throw new AppError(409, "第 {seq} 期已結清，不能刪除。要取消這期請先解除結清", { seq: row.seq });
  }
  await db.delete(schema.recurringPayableItems).where(eq(schema.recurringPayableItems.id, itemId));
}

/**
 * 結清：把一張**既有**的報銷單或手工傳票指到這一期。不生成任何單據——
 * 報銷單走既有報銷流程（公司支付動線的進項稅會正確進 401）、傳票走手工傳票頁。
 * 與 0046 的勾對同形：只動指標，勾錯可解除，指向的單消失就自動回到未結清。
 */
export async function settleItem(
  db: Db,
  payableId: number,
  itemId: number,
  input: { expenseClaimId?: number | undefined; journalEntryId?: number | undefined },
): Promise<PayableItemView[]> {
  const row = await requireItem(db, payableId, itemId);
  const alive = await settledSet(db, [row]);
  if (toView(row, alive).settled) {
    throw new AppError(409, "第 {seq} 期已結清。要換一張請先解除結清", { seq: row.seq });
  }
  const hasClaim = input.expenseClaimId !== undefined;
  const hasEntry = input.journalEntryId !== undefined;
  if (hasClaim === hasEntry) {
    throw new AppError(422, "請指定一張報銷單或一張傳票（兩者擇一）——一期只能對一張單");
  }
  if (hasClaim) {
    const [claim] = await db
      .select()
      .from(schema.expenseClaims)
      .where(eq(schema.expenseClaims.id, input.expenseClaimId!));
    if (!claim) throw new AppError(404, "報銷單不存在: {id}", { id: input.expenseClaimId });
    if (claim.voidedAt) throw new AppError(409, "報銷單 #{id} 已作廢，不能用來結清", { id: claim.id });
    const [taken] = await db
      .select({ payableId: schema.recurringPayableItems.payableId, seq: schema.recurringPayableItems.seq })
      .from(schema.recurringPayableItems)
      .where(eq(schema.recurringPayableItems.expenseClaimId, input.expenseClaimId!));
    if (taken) {
      throw new AppError(409, "報銷單 #{id} 已結清在第 {seq} 期。一張單只能對一期", { id: claim.id, seq: taken.seq });
    }
  } else {
    const [entry] = await db
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(eq(schema.journalEntries.id, input.journalEntryId!));
    if (!entry) throw new AppError(404, "傳票不存在: {id}", { id: input.journalEntryId });
    const [taken] = await db
      .select({ seq: schema.recurringPayableItems.seq })
      .from(schema.recurringPayableItems)
      .where(eq(schema.recurringPayableItems.journalEntryId, input.journalEntryId!));
    if (taken) throw new AppError(409, "傳票 #{id} 已結清在第 {seq} 期。一張單只能對一期", { id: entry.id, seq: taken.seq });
  }
  await db
    .update(schema.recurringPayableItems)
    .set({ expenseClaimId: input.expenseClaimId ?? null, journalEntryId: input.journalEntryId ?? null })
    .where(eq(schema.recurringPayableItems.id, itemId));
  return listItems(db, payableId);
}

/** 解除結清：指標不是單據，改回來不會否認任何事實（那張報銷單/傳票原封不動） */
export async function unsettleItem(db: Db, payableId: number, itemId: number): Promise<PayableItemView[]> {
  const row = await requireItem(db, payableId, itemId);
  if (row.expenseClaimId === null && row.journalEntryId === null) {
    throw new AppError(409, "第 {seq} 期沒有結清紀錄", { seq: row.seq });
  }
  await db
    .update(schema.recurringPayableItems)
    .set({ expenseClaimId: null, journalEntryId: null })
    .where(eq(schema.recurringPayableItems.id, itemId));
  return listItems(db, payableId);
}

export interface DueRow {
  payableId: number;
  payableName: string;
  partnerName: string | null;
  defaultAccountCode: string | null;
  itemId: number;
  seq: number;
  dueDate: string;
  amount: number;
  description: string;
  overdue: boolean;
}

/**
 * 待付清單：未結清且 due_date 落在（今天＋withinDays）以前的期，逾期在前。
 * 只列 active 的週期性支出。與 contracts.billingDue 同形——包含
 * 「指向的單已作廢就自動回到未結清」那段分支（另寫一份必然會漏）。
 */
export async function dueList(db: Db, today: string, withinDays: number): Promise<DueRow[]> {
  const limit = new Date(new Date(`${today}T00:00:00Z`).getTime() + withinDays * 86400_000)
    .toISOString()
    .slice(0, 10);
  const unlinked = await db
    .select({ item: schema.recurringPayableItems, p: schema.recurringPayables })
    .from(schema.recurringPayableItems)
    .innerJoin(schema.recurringPayables, eq(schema.recurringPayableItems.payableId, schema.recurringPayables.id))
    .where(
      and(
        isNull(schema.recurringPayableItems.expenseClaimId),
        isNull(schema.recurringPayableItems.journalEntryId),
        eq(schema.recurringPayables.status, "active"),
      ),
    );
  // 指到已作廢報銷單的期也算未結清（傳票沒有作廢欄位，作廢是另開反向傳票，故不還原）
  const linkedClaims = await db
    .select({ item: schema.recurringPayableItems, p: schema.recurringPayables, claim: schema.expenseClaims })
    .from(schema.recurringPayableItems)
    .innerJoin(schema.recurringPayables, eq(schema.recurringPayableItems.payableId, schema.recurringPayables.id))
    .innerJoin(schema.expenseClaims, eq(schema.recurringPayableItems.expenseClaimId, schema.expenseClaims.id))
    .where(eq(schema.recurringPayables.status, "active"));
  const revived = linkedClaims.filter((r) => r.claim.voidedAt !== null).map(({ item, p }) => ({ item, p }));

  const rows = [...unlinked, ...revived].filter((r) => r.item.dueDate <= limit);
  const partnerIds = rows.map((r) => r.p.partnerId).filter((x): x is number => x !== null);
  const partners = partnerIds.length
    ? await db
        .select({ id: schema.partners.id, name: schema.partners.name })
        .from(schema.partners)
        .where(inArray(schema.partners.id, partnerIds))
    : [];
  const nameOf = new Map(partners.map((x) => [x.id, x.name]));
  return rows
    .sort((a, b) => a.item.dueDate.localeCompare(b.item.dueDate))
    .map((r) => ({
      payableId: r.p.id,
      payableName: r.p.name,
      partnerName: r.p.partnerId ? (nameOf.get(r.p.partnerId) ?? null) : null,
      defaultAccountCode: r.p.defaultAccountCode,
      itemId: r.item.id,
      seq: r.item.seq,
      dueDate: r.item.dueDate,
      amount: r.item.amount,
      description: r.item.description,
      overdue: r.item.dueDate < today,
    }));
}
