/**
 * 合約的請款計畫與續約（0037，設計紀律見 migration 檔頭）。
 *
 * 一句話版本：**計畫是計畫，單據是單據**。installment 只是排程，
 * 開單走既有的 createSale（稅額、關帳鎖、到期日推算全部沿用），
 * 計畫列存的是指向那張銷貨單的指標——銷貨單被作廢，計畫列自動回到「未請款」。
 */
import { schema } from "@tw-erp/db";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { createSale, type ZeroTaxFields } from "./documents.ts";

/** 續約提醒的系統預設（逐約可用 renew_notice_days 覆寫） */
export const DEFAULT_RENEW_NOTICE_DAYS = 45;
/** 一次產生排程的上限：月費約打錯年份時，擋下「一次生出 300 期」的失手 */
const MAX_GENERATED_INSTALLMENTS = 60;

export const CONTRACT_KINDS = ["project", "retainer", "maintenance", "other"] as const;

async function requireContract(db: Db, id: number) {
  const [row] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, id));
  if (!row) throw new AppError(404, "合約不存在: {id}", { id });
  return row;
}

async function requireInstallment(db: Db, contractId: number, installmentId: number) {
  const [row] = await db
    .select()
    .from(schema.contractInstallments)
    .where(
      and(
        eq(schema.contractInstallments.id, installmentId),
        eq(schema.contractInstallments.contractId, contractId),
      ),
    );
  if (!row) throw new AppError(404, "合約 #{contractId} 沒有這一期請款計畫: {installmentId}", { contractId, installmentId });
  return row;
}

/**
 * 這一期是否已請款＝指向的銷貨單存在且未作廢。
 * 不另存 status 欄位——存了就會有「銷貨單作廢了但計畫列還寫著已請款」的漂移。
 */
async function billedSaleOf(db: Db, saleId: number | null) {
  if (saleId === null) return null;
  const [sale] = await db.select().from(schema.sales).where(eq(schema.sales.id, saleId));
  if (!sale || sale.voidedAt) return null;
  return sale;
}

/** 進貨側的對應（0046）：這一期是否已勾對＝指向的進貨單存在且未作廢。同一條紀律 */
async function matchedPurchaseOf(db: Db, purchaseId: number | null) {
  if (purchaseId === null) return null;
  const [purchase] = await db.select().from(schema.purchases).where(eq(schema.purchases.id, purchaseId));
  if (!purchase || purchase.voidedAt) return null;
  return purchase;
}

export interface InstallmentView {
  id: number;
  seq: number;
  dueDate: string;
  amount: number;
  description: string;
  saleId: number | null;
  purchaseId: number | null;
  /** 已請款（銷貨側）／已勾對（進貨側）＝指向的單存在且未作廢；單被作廢後回到 false（可重來） */
  billed: boolean;
}

export async function listInstallments(db: Db, contractId: number): Promise<InstallmentView[]> {
  const rows = await db
    .select()
    .from(schema.contractInstallments)
    .where(eq(schema.contractInstallments.contractId, contractId))
    .orderBy(asc(schema.contractInstallments.seq));
  if (!rows.length) return [];
  // 一次撈出所有關聯單據的作廢狀態（不逐列查——R3 批次已把 N+1 列為要避免的形狀）
  const saleIds = rows.map((r) => r.saleId).filter((x): x is number => x !== null);
  const sales = saleIds.length
    ? await db.select({ id: schema.sales.id, voidedAt: schema.sales.voidedAt }).from(schema.sales).where(inArray(schema.sales.id, saleIds))
    : [];
  const aliveSales = new Set(sales.filter((s) => !s.voidedAt).map((s) => s.id));
  const purchaseIds = rows.map((r) => r.purchaseId).filter((x): x is number => x !== null);
  const purchases = purchaseIds.length
    ? await db.select({ id: schema.purchases.id, voidedAt: schema.purchases.voidedAt }).from(schema.purchases).where(inArray(schema.purchases.id, purchaseIds))
    : [];
  const alivePurchases = new Set(purchases.filter((p) => !p.voidedAt).map((p) => p.id));
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    dueDate: r.dueDate,
    amount: r.amount,
    description: r.description,
    saleId: r.saleId,
    purchaseId: r.purchaseId,
    billed:
      (r.saleId !== null && aliveSales.has(r.saleId)) ||
      (r.purchaseId !== null && alivePurchases.has(r.purchaseId)),
  }));
}

export async function addInstallments(
  db: Db,
  contractId: number,
  items: Array<{ dueDate: string; amount: number; description?: string | undefined }>,
): Promise<InstallmentView[]> {
  const contract = await requireContract(db, contractId);
  if (contract.status === "terminated") {
    throw new AppError(409, "已終止的合約不能再排請款計畫。若要繼續合作請建立新合約");
  }
  const existing = await db
    .select({ seq: schema.contractInstallments.seq })
    .from(schema.contractInstallments)
    .where(eq(schema.contractInstallments.contractId, contractId));
  let nextSeq = existing.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
  await db.insert(schema.contractInstallments).values(
    items.map((it) => ({
      contractId,
      seq: nextSeq++,
      dueDate: it.dueDate,
      amount: it.amount,
      description: it.description ?? "",
    })),
  );
  return listInstallments(db, contractId);
}

/**
 * 月費／年費排程產生器：從 from 到 to（含），每月 dayOfMonth 一期。
 * 系統只做算術（日期展開），金額與期間都是使用者給的。
 * 大小月：dayOfMonth 超過該月天數時取月底（1/31 起排的下一期是 2/28）。
 */
export async function generateSchedule(
  db: Db,
  contractId: number,
  input: { monthlyAmount: number; dayOfMonth: number; from: string; to: string; description?: string | undefined },
): Promise<InstallmentView[]> {
  if (input.dayOfMonth < 1 || input.dayOfMonth > 31) throw new AppError(422, "每月請款日必須是 1–31");
  const [fy, fm] = [Number(input.from.slice(0, 4)), Number(input.from.slice(5, 7))];
  const [ty, tm] = [Number(input.to.slice(0, 4)), Number(input.to.slice(5, 7))];
  const months = (ty - fy) * 12 + (tm - fm) + 1;
  if (months <= 0) throw new AppError(422, "迄月（{to}）不可早於起月（{from}）", { to: input.to.slice(0, 7), from: input.from.slice(0, 7) });
  if (months > MAX_GENERATED_INSTALLMENTS) {
    throw new AppError(
      422,
      "一次最多產生 {max} 期（本次會產生 {months} 期）——請確認起迄年份沒有打錯；真的要更長請分次產生",
      { max: MAX_GENERATED_INSTALLMENTS, months },
    );
  }
  const items = Array.from({ length: months }, (_, i) => {
    const y = fy + Math.floor((fm - 1 + i) / 12);
    const m = ((fm - 1 + i) % 12) + 1;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = Math.min(input.dayOfMonth, lastDay);
    return {
      dueDate: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      amount: input.monthlyAmount,
      description: input.description ?? `${y}-${String(m).padStart(2, "0")} 月費`,
    };
  });
  return addInstallments(db, contractId, items);
}

export async function deleteInstallment(db: Db, contractId: number, installmentId: number): Promise<void> {
  const row = await requireInstallment(db, contractId, installmentId);
  if (await billedSaleOf(db, row.saleId)) {
    throw new AppError(
      409,
      "第 {seq} 期已開銷貨單 #{saleId}，不能刪除計畫列。要取消這期請先作廢那張銷貨單（作廢後本期自動回到未請款）",
      { seq: row.seq, saleId: row.saleId },
    );
  }
  if (await matchedPurchaseOf(db, row.purchaseId)) {
    throw new AppError(
      409,
      "第 {seq} 期已勾對進貨單 #{purchaseId}，不能刪除計畫列。要取消這期請先解除勾對",
      { seq: row.seq, purchaseId: row.purchaseId },
    );
  }
  // 未請款的計畫列可以刪：計畫不是單據（設計紀律見 migration 0037 檔頭）
  await db.delete(schema.contractInstallments).where(eq(schema.contractInstallments.id, installmentId));
}

export async function updateInstallment(
  db: Db,
  contractId: number,
  installmentId: number,
  patch: { dueDate?: string | undefined; amount?: number | undefined; description?: string | undefined },
): Promise<InstallmentView[]> {
  const row = await requireInstallment(db, contractId, installmentId);
  if (await billedSaleOf(db, row.saleId)) {
    throw new AppError(
      409,
      "第 {seq} 期已開銷貨單 #{saleId}，金額與日期以那張單為準。要改請先作廢它",
      { seq: row.seq, saleId: row.saleId },
    );
  }
  if (await matchedPurchaseOf(db, row.purchaseId)) {
    throw new AppError(
      409,
      "第 {seq} 期已勾對進貨單 #{purchaseId}，金額與日期以那張單為準。要改請先解除勾對",
      { seq: row.seq, purchaseId: row.purchaseId },
    );
  }
  await db
    .update(schema.contractInstallments)
    .set({
      ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
      ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
    })
    .where(eq(schema.contractInstallments.id, installmentId));
  return listInstallments(db, contractId);
}

/**
 * 這一期開銷貨單。走既有 createSale：稅額（含課稅別）、關帳鎖、
 * 到期日（客戶付款條件）全部沿用——合約請款不是另一種單據，就是一張銷貨單。
 */
export async function billInstallment(
  db: Db,
  contractId: number,
  installmentId: number,
  input: { productId: number; docDate: string } & ZeroTaxFields,
) {
  const contract = await requireContract(db, contractId);
  if (contract.direction !== "sale") {
    throw new AppError(
      409,
      "進貨合約不開請款單——單據來源是對方寄來的發票。請在該期上用「勾對進貨單」把收到的進貨單對上",
    );
  }
  if (contract.status === "terminated") throw new AppError(409, "已終止的合約不能再請款");
  if (contract.partnerId === null) {
    throw new AppError(
      422,
      "這份合約沒有連結交易對象，開不了銷貨單。請先在合約上選擇客戶（交易對象要先建在「客戶與商品」頁）",
    );
  }
  const row = await requireInstallment(db, contractId, installmentId);
  const billedSale = await billedSaleOf(db, row.saleId);
  if (billedSale) {
    throw new AppError(409, "第 {seq} 期已開過銷貨單 #{saleId}。重複請款請先作廢那張單", { seq: row.seq, saleId: billedSale.id });
  }
  // 銷貨單沒有 memo 欄——合約與銷貨單的關聯由 contract_installments.sale_id 承載
  //（畫面上兩邊互相看得到），不靠字串備註
  const sale = await createSale(db, {
    partnerId: contract.partnerId,
    docDate: input.docDate,
    lines: [{ productId: input.productId, qty: 1, unitPrice: row.amount }],
    taxType: input.taxType,
    zeroTaxViaCustoms: input.zeroTaxViaCustoms,
    zeroTaxCertNo: input.zeroTaxCertNo,
  });
  await db
    .update(schema.contractInstallments)
    .set({ saleId: sale.id })
    .where(eq(schema.contractInstallments.id, installmentId));
  return sale;
}

/**
 * 進貨側（0046）：把「對方寄來的發票」（既有進貨單）勾對到這一期。
 * 不生成任何單據——進貨單走既有的進貨流程建立（稅額、關帳鎖、付款條件都在那邊），
 * 這裡只是把計畫列指向它。金額不強制相等（發票常有尾差），畫面並列兩個金額由人判斷——
 * 比對只建議不自動確認（與銀行對帳同一條紀律）。
 */
export async function matchInstallment(db: Db, contractId: number, installmentId: number, purchaseId: number) {
  const contract = await requireContract(db, contractId);
  if (contract.direction !== "purchase") {
    throw new AppError(409, "銷貨合約的期別是開請款單（bill），不是勾對進貨單");
  }
  if (contract.status === "terminated") throw new AppError(409, "已終止的合約不能再勾對付款");
  const row = await requireInstallment(db, contractId, installmentId);
  if (await matchedPurchaseOf(db, row.purchaseId)) {
    throw new AppError(409, "第 {seq} 期已勾對進貨單 #{purchaseId}。要換一張請先解除勾對", { seq: row.seq, purchaseId: row.purchaseId });
  }
  const [purchase] = await db.select().from(schema.purchases).where(eq(schema.purchases.id, purchaseId));
  if (!purchase) throw new AppError(404, "進貨單不存在: {purchaseId}", { purchaseId });
  if (purchase.voidedAt) throw new AppError(409, "進貨單 #{purchaseId} 已作廢，不能勾對", { purchaseId });
  if (contract.partnerId !== null && purchase.partnerId !== contract.partnerId) {
    throw new AppError(
      422,
      "進貨單 #{purchaseId} 的供應商與合約連結的交易對象不同——勾錯對象的單會讓應付與合約對不上。確定是同一家（例如集團內開票主體不同）請先調整合約的交易對象連結",
      { purchaseId },
    );
  }
  // 一張進貨單只能勾一期（任何合約）：同一張發票對兩期＝重複認列付款義務
  const [taken] = await db
    .select({ id: schema.contractInstallments.id, contractId: schema.contractInstallments.contractId, seq: schema.contractInstallments.seq })
    .from(schema.contractInstallments)
    .where(eq(schema.contractInstallments.purchaseId, purchaseId));
  if (taken) {
    throw new AppError(409, "進貨單 #{purchaseId} 已勾對在合約 #{contractId} 第 {seq} 期。一張單只能勾一期", { purchaseId, contractId: taken.contractId, seq: taken.seq });
  }
  await db
    .update(schema.contractInstallments)
    .set({ purchaseId })
    .where(eq(schema.contractInstallments.id, installmentId));
  return listInstallments(db, contractId);
}

/**
 * 解除勾對：勾對只是指標不是單據，勾錯了改回來不會否認任何事實
 * （進貨單本身原封不動）——所以不像銷貨側要走作廢。
 */
export async function unmatchInstallment(db: Db, contractId: number, installmentId: number) {
  const contract = await requireContract(db, contractId);
  if (contract.direction !== "purchase") throw new AppError(409, "只有進貨合約的期別有勾對可解除");
  const row = await requireInstallment(db, contractId, installmentId);
  if (row.purchaseId === null) throw new AppError(409, "第 {seq} 期沒有勾對任何進貨單", { seq: row.seq });
  await db
    .update(schema.contractInstallments)
    .set({ purchaseId: null })
    .where(eq(schema.contractInstallments.id, installmentId));
  return listInstallments(db, contractId);
}

/**
 * 續約＝開新合約成鏈（設計紀律見 migration 0037 檔頭）。
 * 前身自動標 ended——續約這個動作本身就是「舊約到此為止」的宣告。
 */
export async function renewContract(
  db: Db,
  id: number,
  input: { startDate: string; endDate?: string | undefined; amount?: number | undefined; signDate?: string | undefined },
) {
  const old = await requireContract(db, id);
  if (old.status === "terminated") {
    throw new AppError(409, "已終止的合約不能續約——終止是雙方合意的結束。要重啟合作請建立全新合約");
  }
  const [successor] = await db
    .insert(schema.contracts)
    .values({
      partnerId: old.partnerId,
      counterparty: old.counterparty,
      title: old.title,
      kind: old.kind,
      direction: old.direction,
      amount: input.amount ?? old.amount,
      signDate: input.signDate ?? null,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      status: "active",
      memo: old.memo,
      renewNoticeDays: old.renewNoticeDays,
      renewedFromId: old.id,
    })
    .returning();
  await db.update(schema.contracts).set({ status: "ended" }).where(eq(schema.contracts.id, id));
  return successor!;
}

export interface ExpiringContractRow {
  id: number;
  title: string;
  counterparty: string;
  direction: string;
  endDate: string;
  /** 這份約自己的提前提醒天數（NULL 時退回系統預設 45 天） */
  noticeDays: number;
}

/**
 * 快到期的合約：**逐約用自己的 renew_notice_days**（NULL 退回 DEFAULT_RENEW_NOTICE_DAYS）。
 *
 * 這個欄位在 0037 就存在——存得進去、改得動、續約還會複製過去，但整個 repo 沒有任何讀取端：
 * 畫面用的是前端寫死的常數。逐約設 60 天不會有任何變化也不會有任何錯誤，
 * 正是「欄位名稱宣稱了一條程式沒做的規則」的活體標本（TRAPS
 * comment-states-a-rule-the-code-doesnt-enforce）。
 *
 * 已經續約過的自動退出清單——由「有沒有別的合約 renewed_from_id 指向我」反查推導，
 * 不新增任何狀態欄。45 天是商業通知期不是法定期限（系統不提示任何法定期限）。
 */
export async function expiringContracts(db: Db, today: string): Promise<ExpiringContractRow[]> {
  const rows = await db
    .select({
      id: schema.contracts.id,
      title: schema.contracts.title,
      counterparty: schema.contracts.counterparty,
      direction: schema.contracts.direction,
      endDate: schema.contracts.endDate,
      renewNoticeDays: schema.contracts.renewNoticeDays,
    })
    .from(schema.contracts)
    .where(and(eq(schema.contracts.status, "active"), isNotNull(schema.contracts.endDate)));
  const successors = await db
    .select({ from: schema.contracts.renewedFromId })
    .from(schema.contracts)
    .where(isNotNull(schema.contracts.renewedFromId));
  const renewed = new Set(successors.map((s) => s.from));
  const dayAfter = (n: number) =>
    new Date(new Date(`${today}T00:00:00Z`).getTime() + n * 86400_000).toISOString().slice(0, 10);
  return rows
    .filter((r) => !renewed.has(r.id))
    .map((r) => ({ ...r, endDate: r.endDate!, noticeDays: r.renewNoticeDays ?? DEFAULT_RENEW_NOTICE_DAYS }))
    .filter((r) => r.endDate <= dayAfter(r.noticeDays))
    .sort((a, b) => a.endDate.localeCompare(b.endDate));
}

export interface BillingDueRow {
  contractId: number;
  contractTitle: string;
  counterparty: string;
  partnerId: number | null;
  /** 0046：'sale'＝待請款（我方開單）；'purchase'＝待付款（等對方發票來勾對） */
  direction: string;
  installmentId: number;
  seq: number;
  dueDate: string;
  amount: number;
  description: string;
  overdue: boolean;
}

/**
 * 待請款／待付款：未對上單據且 due_date 落在（今天＋withinDays）以前的期，逾期在前。
 * 只列 active 合約——draft 還沒生效、ended/terminated 不該再請款或付款。
 * 兩個方向一次回，前端按 direction 分兩張卡。
 */
export async function billingDue(db: Db, today: string, withinDays: number): Promise<BillingDueRow[]> {
  const limit = new Date(new Date(`${today}T00:00:00Z`).getTime() + withinDays * 86400_000)
    .toISOString()
    .slice(0, 10);
  const rows = await db
    .select({ inst: schema.contractInstallments, contract: schema.contracts })
    .from(schema.contractInstallments)
    .innerJoin(schema.contracts, eq(schema.contractInstallments.contractId, schema.contracts.id))
    .where(
      and(
        isNull(schema.contractInstallments.saleId),
        isNull(schema.contractInstallments.purchaseId),
        eq(schema.contracts.status, "active"),
      ),
    )
    .orderBy(asc(schema.contractInstallments.dueDate));
  // 對上單但單已作廢的期也算「未對上」——一次撈作廢狀態補回來（銷貨/進貨各一趟）
  const linkedSales = await db
    .select({ inst: schema.contractInstallments, contract: schema.contracts, sale: schema.sales })
    .from(schema.contractInstallments)
    .innerJoin(schema.contracts, eq(schema.contractInstallments.contractId, schema.contracts.id))
    .innerJoin(schema.sales, eq(schema.contractInstallments.saleId, schema.sales.id))
    .where(eq(schema.contracts.status, "active"));
  const linkedPurchases = await db
    .select({ inst: schema.contractInstallments, contract: schema.contracts, purchase: schema.purchases })
    .from(schema.contractInstallments)
    .innerJoin(schema.contracts, eq(schema.contractInstallments.contractId, schema.contracts.id))
    .innerJoin(schema.purchases, eq(schema.contractInstallments.purchaseId, schema.purchases.id))
    .where(eq(schema.contracts.status, "active"));
  const revived = [
    ...linkedSales.filter((r) => r.sale.voidedAt !== null).map(({ inst, contract }) => ({ inst, contract })),
    ...linkedPurchases.filter((r) => r.purchase.voidedAt !== null).map(({ inst, contract }) => ({ inst, contract })),
  ];

  return [...rows, ...revived]
    .filter((r) => r.inst.dueDate <= limit)
    .sort((a, b) => a.inst.dueDate.localeCompare(b.inst.dueDate))
    .map((r) => ({
      contractId: r.contract.id,
      contractTitle: r.contract.title,
      counterparty: r.contract.counterparty,
      partnerId: r.contract.partnerId,
      direction: r.contract.direction,
      installmentId: r.inst.id,
      seq: r.inst.seq,
      dueDate: r.inst.dueDate,
      amount: r.inst.amount,
      description: r.inst.description,
      overdue: r.inst.dueDate < today,
    }));
}
