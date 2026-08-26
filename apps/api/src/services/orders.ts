/**
 * 銷售前段：報價單 → 訂單 → 出貨（轉銷貨單）＋應收帳齡。
 * - 報價 open → won（轉訂單，一次性）/ lost；金額計算與銷貨同規則（未稅小計＋營業稅，費率依開單日解析）
 * - 訂單狀態由出貨量推導：open（未出貨）→ partial → closed（全數出清）；canceled 僅限未出貨
 * - 出貨即開銷貨單：沿用 createSale（庫存檢查、移動平均成本、拋轉傳票），sales.order_id 回連
 * - 應收帳齡：收款以 FIFO 沖最舊銷貨（尚無立沖帳，此為對象層級的近似），未沖餘額按單據日分桶
 */
import { calcTax, lineAmount } from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { and, count, desc, eq, getTableColumns, gte, inArray, isNull, lte } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { settlementMaps } from "./balances.ts";
import { assertNotFarFuture } from "./dates.ts";
import { assertZeroTaxShape, createSale, type DocLineInput, type ZeroTaxFields } from "./documents.ts";
import type { ListFilter } from "./list.ts";
import { apOffsetByPurchase, arOffsetBySale } from "./returns.ts";
import { resolveVatRate } from "./tax-parameters.ts";

export interface QuoteInput extends ZeroTaxFields {
  partnerId: number;
  quoteDate: string;
  memo?: string | undefined;
  /** 預計交期（0035）：未帶＝未約定（NULL）——系統不替「沒談交期」的單捏造日期 */
  expectedDate?: string | undefined;
  lines: DocLineInput[];
}

/**
 * 課稅別的稅額解析（0032）：零稅率的 0% 是課稅別的事實、不是參數表的費率——
 * 不解析稅法參數，也就不會帶出「找不到營業稅率設定」的回退警告（與 createSale 同一條規則）。
 * 證明文件號碼在報價/訂單階段幾乎必空（出口報單在報關後才有），這裡不出聲；
 * 出貨開銷貨單時 createSale 若仍空白會提醒，補登入口在銷貨單那一層。
 */
async function resolveRateFor(tx: Db, taxType: "1" | "2", date: string) {
  return taxType === "2" ? { rateBp: 0, rate: 0, notes: [] as string[] } : resolveVatRate(tx, date);
}

/**
 * 報價／訂單的稅額是**估價**，不是帳。真正入帳的是出貨當日由 createSale 重算的那一份
 * （shipOrder 走 createSale(tx, { docDate })）。
 * 即使如此仍要依開單日解析費率：拿一個過期費率報價給客戶，成交後照當日費率開單，
 * 差額是自己吃掉的——估價要估得準才有用。
 */
function computeTotals(lines: DocLineInput[], rate: number) {
  const withAmounts = lines.map((l) => ({ ...l, amount: lineAmount(l.qty, l.unitPrice) }));
  const subtotal = withAmounts.reduce((s, l) => s + l.amount, 0);
  const tax = calcTax(subtotal, rate);
  return { withAmounts, subtotal, tax, total: subtotal + tax };
}

async function requireCustomer(db: Db, partnerId: number) {
  const [partner] = await db.select().from(schema.partners).where(eq(schema.partners.id, partnerId));
  if (!partner) throw new AppError(404, `交易對象不存在: ${partnerId}`);
  if (!partner.isCustomer) throw new AppError(422, `非客戶: ${partner.name}`);
  return partner;
}

export async function createQuote(db: Db, input: QuoteInput, createdBy: number) {
  return db.transaction(async (tx) => {
    // R2：年份打錯的未來報價當場擋下（過去日期不擋——補登歷史報價是正常作業）
    assertNotFarFuture(input.quoteDate, "報價日期");
    // 課稅別（0032）：報價階段就要收——外銷客戶的報價若被當成應稅計了稅，客戶看到的總額就是錯的
    const taxType = assertZeroTaxShape(input);
    await requireCustomer(tx, input.partnerId);
    const vat = await resolveRateFor(tx, taxType, input.quoteDate);
    const { withAmounts, subtotal, tax, total } = computeTotals(input.lines, vat.rate);
    const [quote] = await tx
      .insert(schema.quotes)
      .values({
        partnerId: input.partnerId,
        quoteDate: input.quoteDate,
        memo: input.memo ?? "",
        expectedDate: input.expectedDate ?? null,
        subtotal,
        tax,
        total,
        vatRateBp: vat.rateBp,
        taxType,
        zeroTaxViaCustoms: taxType === "2" ? input.zeroTaxViaCustoms! : null,
        zeroTaxCertNo: taxType === "2" ? input.zeroTaxCertNo?.trim() || null : null,
        createdBy,
      })
      .returning();
    await tx.insert(schema.quoteLines).values(
      withAmounts.map((l) => ({
        quoteId: quote!.id,
        productId: l.productId,
        qty: String(l.qty),
        unitPrice: String(l.unitPrice),
        amount: l.amount,
      })),
    );
    return { ...quote!, taxNotes: vat.notes };
  });
}

/** 頁內對象名稱：只查這一頁用得到的 id（原本整張 partners 全撈，R3/N+1 一併收掉） */
async function partnerNamesFor(db: Db, partnerIds: number[]): Promise<Map<number, string>> {
  if (!partnerIds.length) return new Map();
  const rows = await db
    .select({ id: schema.partners.id, name: schema.partners.name })
    .from(schema.partners)
    .where(inArray(schema.partners.id, [...new Set(partnerIds)]));
  return new Map(rows.map((p) => [p.id, p.name]));
}

/** R3：from/to 對報價日期＋partnerId＋limit/offset；回總筆數。明細只查頁內報價單 */
export async function listQuotes(db: Db, f: ListFilter) {
  const where = and(
    f.from ? gte(schema.quotes.quoteDate, f.from) : undefined,
    f.to ? lte(schema.quotes.quoteDate, f.to) : undefined,
    f.partnerId ? eq(schema.quotes.partnerId, f.partnerId) : undefined,
  );
  const [agg] = await db.select({ total: count() }).from(schema.quotes).where(where);
  const quotes = await db
    .select()
    .from(schema.quotes)
    .where(where)
    .orderBy(desc(schema.quotes.id))
    .limit(f.limit)
    .offset(f.offset);
  const ids = quotes.map((q) => q.id);
  const nameOf = await partnerNamesFor(db, quotes.map((q) => q.partnerId));
  const lines = ids.length
    ? await db.select().from(schema.quoteLines).where(inArray(schema.quoteLines.quoteId, ids))
    : [];
  return {
    rows: quotes.map((q) => ({
      ...q,
      partnerName: nameOf.get(q.partnerId) ?? `#${q.partnerId}`,
      lines: lines.filter((l) => l.quoteId === q.id),
    })),
    total: agg!.total,
  };
}

export async function setQuoteLost(db: Db, id: number) {
  const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, id));
  if (!quote) throw new AppError(404, `報價單不存在: ${id}`);
  if (quote.status !== "open") throw new AppError(409, `報價單非洽談中（目前 ${quote.status}）`);
  const [updated] = await db
    .update(schema.quotes)
    .set({ status: "lost" })
    .where(eq(schema.quotes.id, id))
    .returning();
  return updated!;
}

/** 報價成交 → 產生訂單（明細複製、報價標記 won 並回連訂單；一張報價只能轉一次） */
export async function convertQuote(db: Db, id: number, orderDate: string, createdBy: number) {
  return db.transaction(async (tx) => {
    // R2：與 createOrder 同一條規則——訂單日期年份打錯當場擋下
    assertNotFarFuture(orderDate, "訂單日期");
    const [quote] = await tx.select().from(schema.quotes).where(eq(schema.quotes.id, id));
    if (!quote) throw new AppError(404, `報價單不存在: ${id}`);
    if (quote.status !== "open") throw new AppError(409, `報價單已${quote.status === "won" ? "成交" : "結案"}，不可再轉訂單`);
    const lines = await tx.select().from(schema.quoteLines).where(eq(schema.quoteLines.quoteId, id));

    const [order] = await tx
      .insert(schema.orders)
      .values({
        partnerId: quote.partnerId,
        orderDate,
        memo: quote.memo,
        // 交期是報價時談好的承諾之一（0035）：與價格同理原樣搬，成交不該讓交期消失
        expectedDate: quote.expectedDate,
        subtotal: quote.subtotal,
        tax: quote.tax,
        total: quote.total,
        // 轉單搬的是「談好的價」，稅額整組沿用報價單，費率快照當然也要沿用同一格
        vatRateBp: quote.vatRateBp,
        // 課稅別三欄（0032）同理原樣搬：報完零稅率的價、轉單變回應稅，出貨就會多課一次營業稅
        taxType: quote.taxType,
        zeroTaxViaCustoms: quote.zeroTaxViaCustoms,
        zeroTaxCertNo: quote.zeroTaxCertNo,
        quoteId: quote.id,
        createdBy,
      })
      .returning();
    await tx.insert(schema.orderLines).values(
      lines.map((l) => ({
        orderId: order!.id,
        productId: l.productId,
        qty: l.qty,
        unitPrice: l.unitPrice,
        amount: l.amount,
      })),
    );
    await tx.update(schema.quotes).set({ status: "won", orderId: order!.id }).where(eq(schema.quotes.id, id));
    // 刻意**直接複製報價單的金額**、不依 orderDate 重算：轉單是把「談好的價」原封搬過來，
    // 客戶看到的總額不該因為系統這一天解析到別的費率而變動。真正入帳的數字在出貨時重算（見 shipOrder）
    return order!;
  });
}

export async function createOrder(
  db: Db,
  input: Omit<QuoteInput, "quoteDate"> & { orderDate: string },
  createdBy: number,
) {
  return db.transaction(async (tx) => {
    // R2：年份打錯的未來訂單當場擋下（過去日期不擋——補登歷史訂單是正常作業）
    assertNotFarFuture(input.orderDate, "訂單日期");
    const taxType = assertZeroTaxShape(input);
    await requireCustomer(tx, input.partnerId);
    const vat = await resolveRateFor(tx, taxType, input.orderDate);
    const { withAmounts, subtotal, tax, total } = computeTotals(input.lines, vat.rate);
    const [order] = await tx
      .insert(schema.orders)
      .values({
        partnerId: input.partnerId,
        orderDate: input.orderDate,
        memo: input.memo ?? "",
        expectedDate: input.expectedDate ?? null,
        subtotal,
        tax,
        total,
        vatRateBp: vat.rateBp,
        taxType,
        zeroTaxViaCustoms: taxType === "2" ? input.zeroTaxViaCustoms! : null,
        zeroTaxCertNo: taxType === "2" ? input.zeroTaxCertNo?.trim() || null : null,
        createdBy,
      })
      .returning();
    await tx.insert(schema.orderLines).values(
      withAmounts.map((l) => ({
        orderId: order!.id,
        productId: l.productId,
        qty: String(l.qty),
        unitPrice: String(l.unitPrice),
        amount: l.amount,
      })),
    );
    return { ...order!, taxNotes: vat.notes };
  });
}

/**
 * R3＋N+1 修正：原本一次拉五張全表（orders/partners/products/order_lines/sales）
 * 在記憶體 O(n×m) 配對；改為每個關聯各一次查詢、且只查頁內訂單的 id。
 * 回傳形狀不變（partnerName／lines（productName、remainingQty）／saleIds）。
 */
export async function listOrders(db: Db, f: ListFilter) {
  const where = and(
    f.from ? gte(schema.orders.orderDate, f.from) : undefined,
    f.to ? lte(schema.orders.orderDate, f.to) : undefined,
    f.partnerId ? eq(schema.orders.partnerId, f.partnerId) : undefined,
  );
  const [agg] = await db.select({ total: count() }).from(schema.orders).where(where);
  const orders = await db
    .select()
    .from(schema.orders)
    .where(where)
    .orderBy(desc(schema.orders.id))
    .limit(f.limit)
    .offset(f.offset);
  const ids = orders.map((o) => o.id);
  const nameOf = await partnerNamesFor(db, orders.map((o) => o.partnerId));
  // 明細帶品名：join 一次拿齊，不再整張 products 進記憶體
  const lines = ids.length
    ? await db
        .select({ ...getTableColumns(schema.orderLines), productName: schema.products.name })
        .from(schema.orderLines)
        .leftJoin(schema.products, eq(schema.orderLines.productId, schema.products.id))
        .where(inArray(schema.orderLines.orderId, ids))
    : [];
  // 已作廢（沖銷）的銷貨單不列入關聯連結：出貨量已隨作廢退回（rollbackOrderShipment），
  // 連結若還在，訂單頁會指向一張「已出貨 0」卻掛著出貨紀錄的單，兩邊對不起來
  const sales = ids.length
    ? await db
        .select({ id: schema.sales.id, orderId: schema.sales.orderId })
        .from(schema.sales)
        .where(and(inArray(schema.sales.orderId, ids), isNull(schema.sales.reversalEntryId)))
    : [];
  return {
    rows: orders.map((o) => ({
      ...o,
      partnerName: nameOf.get(o.partnerId) ?? `#${o.partnerId}`,
      lines: lines
        .filter((l) => l.orderId === o.id)
        .map(({ productName, ...l }) => ({
          ...l,
          productName: productName ?? `#${l.productId}`,
          remainingQty: Number(l.qty) - Number(l.shippedQty),
        })),
      saleIds: sales.filter((s) => s.orderId === o.id).map((s) => s.id),
    })),
    total: agg!.total,
  };
}

export interface ShipLineInput {
  orderLineId: number;
  qty: number;
}

/** 出貨：未指定明細＝剩餘全出。開銷貨單（含庫存/傳票）、累計已出貨量、推導訂單狀態 */
export async function shipOrder(
  db: Db,
  orderId: number,
  input: { docDate: string; lines?: ShipLineInput[] | undefined },
) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    if (!order) throw new AppError(404, `訂單不存在: ${orderId}`);
    if (order.status === "canceled" || order.status === "closed") {
      throw new AppError(
        409,
        order.status === "closed"
          ? `訂單 #${orderId} 已結案（結案＝到此為止，剩餘量不再出貨），不可出貨。要繼續交易請開一張新訂單`
          : `訂單 #${orderId} 已取消（取消＝這張單從沒發生），不可出貨。要交易請開一張新訂單`,
      );
    }
    const orderLines = await tx.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, orderId));
    const byId = new Map(orderLines.map((l) => [l.id, l]));

    const shipLines =
      input.lines ??
      orderLines
        .filter((l) => Number(l.qty) - Number(l.shippedQty) > 0)
        .map((l) => ({ orderLineId: l.id, qty: Number(l.qty) - Number(l.shippedQty) }));
    if (!shipLines.length) throw new AppError(422, "沒有可出貨的明細");

    for (const s of shipLines) {
      const line = byId.get(s.orderLineId);
      if (!line) throw new AppError(404, `訂單明細不存在: ${s.orderLineId}`);
      const remaining = Number(line.qty) - Number(line.shippedQty);
      if (s.qty <= 0) throw new AppError(422, `出貨量必須大於 0（明細 ${s.orderLineId}）`);
      if (s.qty > remaining) {
        throw new AppError(422, `出貨量超過剩餘量: 明細 ${s.orderLineId} 剩 ${remaining}，欲出 ${s.qty}`);
      }
    }

    // 課稅別三欄（0032）原樣帶入銷貨單：外銷訂單的出貨終於不再被硬當成應稅計稅。
    // 證明文件號碼若訂單上已有（罕見，通常事後補在銷貨單）也一起帶；零稅率缺號碼的提醒由 createSale 出聲
    const sale = await createSale(tx, {
      partnerId: order.partnerId,
      docDate: input.docDate,
      taxType: order.taxType as "1" | "2" | "3",
      zeroTaxViaCustoms: order.zeroTaxViaCustoms ?? undefined,
      zeroTaxCertNo: order.zeroTaxCertNo ?? undefined,
      lines: shipLines.map((s) => {
        const line = byId.get(s.orderLineId)!;
        return { productId: line.productId, qty: s.qty, unitPrice: Number(line.unitPrice) };
      }),
    });
    await tx.update(schema.sales).set({ orderId }).where(eq(schema.sales.id, sale.id));
    // createSale 已依出貨日重算稅額；它的費率警告要跟著浮上來，否則出貨這條路徑會靜默走回退值

    for (const s of shipLines) {
      const line = byId.get(s.orderLineId)!;
      await tx
        .update(schema.orderLines)
        .set({ shippedQty: String(Number(line.shippedQty) + s.qty) })
        .where(eq(schema.orderLines.id, s.orderLineId));
    }

    const after = await tx.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, orderId));
    const fullyShipped = after.every((l) => Number(l.shippedQty) >= Number(l.qty));
    const status = fullyShipped ? "closed" : "partial";
    const [updated] = await tx
      .update(schema.orders)
      .set({ status })
      .where(eq(schema.orders.id, orderId))
      .returning();
    return { order: updated!, saleId: sale.id, taxNotes: sale.taxNotes };
  });
}

export async function cancelOrder(db: Db, orderId: number) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    if (!order) throw new AppError(404, `訂單不存在: ${orderId}`);
    if (order.status !== "open") {
      throw new AppError(
        409,
        `僅未出貨的訂單可取消（取消＝這張單從沒發生；目前 ${order.status}）。` +
          `已有出貨的訂單請改用「結案」（結案＝到此為止：已出貨的銷貨單與憑證留著，剩餘量不再出）；` +
          `出錯的出貨請先到銷貨頁作廢該張銷貨單`,
      );
    }
    const [updated] = await tx
      .update(schema.orders)
      .set({ status: "canceled" })
      .where(eq(schema.orders.id, orderId))
      .returning();
    return updated!;
  });
}

/**
 * 短交結案（0032）：partial（客戶砍單、斷貨）與 open（整單放棄但想留紀錄）都可結案。
 * 結案與取消的語意分工：取消＝這張單從沒發生（僅限完全未出貨）；結案＝到此為止——
 * 已出貨的銷貨單、發票、傳票全部留著，只是剩餘量不再期待出貨。
 * 不動任何已開出的單據、不拋轉傳票（訂單本身不入帳），所以不套關帳鎖。
 * 理由必填：短交是營業事實（誰砍的單、為什麼），三個月後看報表要答得出來。
 */
export async function closeOrder(db: Db, orderId: number, reason: string, closedBy: number) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    if (!order) throw new AppError(404, `訂單不存在: ${orderId}`);
    if (order.status === "closed") {
      throw new AppError(
        409,
        order.closedAt
          ? `訂單 #${orderId} 已於 ${order.closedAt.toISOString().slice(0, 10)} 短交結案（原因：${order.closeReason ?? "未記錄"}），不可再結案`
          : `訂單 #${orderId} 已全數出清、自動結案，不需再結案`,
      );
    }
    if (order.status === "canceled") {
      throw new AppError(409, `訂單 #${orderId} 已取消（取消＝這張單從沒發生），沒有可結案的內容`);
    }
    const [updated] = await tx
      .update(schema.orders)
      .set({ status: "closed", closedAt: new Date(), closedBy, closeReason: reason })
      .where(eq(schema.orders.id, orderId))
      .returning();
    return updated!;
  });
}

const AGING_BUCKETS = ["notDue", "d0_30", "d31_60", "d61_90", "d90plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

function bucketOfDays(days: number): Exclude<AgingBucket, "notDue"> {
  if (days <= 30) return "d0_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90plus";
}

/**
 * 一張未收銷貨單落在哪個桶、算不算逾期（B1 修正：帳齡看**到期日**，不是出貨日）。
 *
 * - 有 due_date（建單時由客戶付款條件推出或逐單覆寫）：過了到期日才是逾期，
 *   天數從到期日起算——月結 60 天的客戶第 45 天在「未到期」桶，貨到付款第 1 天就進逾期桶。
 * - 沒有 due_date（0022 之前的舊單，或客戶未約定付款條件）：退回舊行為——
 *   以單據日估算、前 30 天不算逾期。系統沒有立場替「未約定」的單據斷言它何時到期，
 *   所以這條回退必須在回應裡標註（notes），不能讓兩種算法混在同一張表裡而看不出來。
 */
function bucketOf(
  doc: { docDate: string; dueDate: string | null },
  asOf: string,
): { bucket: AgingBucket; overdue: boolean; fallback: boolean } {
  const days = (from: string) => Math.floor((Date.parse(asOf) - Date.parse(from)) / 86_400_000);
  if (doc.dueDate) {
    const overdueDays = days(doc.dueDate);
    if (overdueDays <= 0) return { bucket: "notDue", overdue: false, fallback: false };
    return { bucket: bucketOfDays(overdueDays), overdue: true, fallback: false };
  }
  const sinceDoc = days(doc.docDate);
  return { bucket: bucketOfDays(sinceDoc), overdue: sinceDoc > 30, fallback: true };
}

/**
 * 帳齡引擎（應收／應付共用，asOf 當日視角）：立沖優先——收付款單指定沖銷的金額直接沖對應單據；
 * 未指定沖銷的收付款餘額以 FIFO 沖該對象最舊的剩餘未沖。溢收溢付（掛 2231／1212）列 credit 欄。
 * 分桶依到期日（見 bucketOf）；overdue＝已過期未沖合計，儀表板的「逾期應收」直接取它，
 * 不再是「總額 − 30 天內」的硬編碼（那個算法對月結 60 與貨到付款的對象方向剛好相反）。
 *
 * 兩側的差異全部收在這裡的 side 分歧（漏一處就是兩張表各說各話）：
 * 單據表（sales↔purchases）、期初單 kind、收付款 kind、退回沖銷（ar_offset↔ap_offset）、
 * allocations 的 targetType（sale↔purchase；opening 兩側同名）、fallback 提示的措辭。
 */
async function aging(db: Db, asOf: string, side: "ar" | "ap") {
  const docsRaw =
    side === "ar"
      ? await db
          .select({
            id: schema.sales.id,
            partnerId: schema.sales.partnerId,
            docDate: schema.sales.docDate,
            dueDate: schema.sales.dueDate,
            total: schema.sales.total,
          })
          .from(schema.sales)
          .where(and(isNull(schema.sales.reversalEntryId), lte(schema.sales.docDate, asOf)))
      : // 已作廢進貨單（0025）以 voided_at 排除（銷貨的作廢旗標是 reversal_entry_id，0004 的歷史差異）
        await db
          .select({
            id: schema.purchases.id,
            partnerId: schema.purchases.partnerId,
            docDate: schema.purchases.docDate,
            dueDate: schema.purchases.dueDate,
            total: schema.purchases.total,
          })
          .from(schema.purchases)
          .where(and(isNull(schema.purchases.voidedAt), lte(schema.purchases.docDate, asOf)));
  // 期初應收付單（0023，B6）：以「原單日期」進帳齡分桶——舊對象的舊欠款導入後
  // 要立刻出現在催款／排款視角，而且要按它真正的帳齡算，不是按開帳日重新起算
  const openings = await db
    .select()
    .from(schema.openingBalances)
    .where(
      and(
        eq(schema.openingBalances.kind, side === "ar" ? "receivable" : "payable"),
        lte(schema.openingBalances.docDate, asOf),
        // 已作廢期初單（0030）不進帳齡：那筆舊欠款已被反向傳票收回
        isNull(schema.openingBalances.voidedAt),
      ),
    );
  // 收付款的沖銷狀態（立沖合計、FIFO pool、預收/預付餘額）一律取自 balances.ts 的
  // settlementMaps（R6 單一事實來源）：open-documents 吃同一份，兩張表不再各說各話。
  // 口徑細節（作廢排除、asOf 篩選、opening 分開累計）都收在那裡
  const {
    allocatedByDoc,
    allocatedByOpening,
    unallocatedByPartner: paidBy,
    prepaidByPartner: prepaidBy,
  } = await settlementMaps(db, side === "ar" ? "receipt" : "payment", asOf);
  // 退回沖回應收/應付的部分：帳齡看的是「還欠多少」，退貨當然要扣。
  // 只扣 ar_offset/ap_offset 是因為掛 2201 的退款與退現金已經不在應收應付體系裡了。
  // 必須傳 asOf：與單據/收付款一樣只認基準日之前的退回單，否則一張 8/15 的退貨會回頭
  // 改掉 7/31 的帳齡，跟同一天的資產負債表 1144/2144 對不起來（帳齡卡片有基準日選擇器，一定會被查）
  const returned = side === "ar" ? await arOffsetBySale(db, asOf) : await apOffsetByPurchase(db, asOf);
  const partners = await db.select().from(schema.partners);
  const nameOf = new Map(partners.map((p) => [p.id, p.name]));

  // 單據與期初單合成同一條時間軸（FIFO 沖最舊時兩者一視同仁）：
  // afterAllocation 先各自算好（退回只會發生在銷貨/進貨單上），分桶只需要日期與淨額
  interface AgingDoc {
    docDate: string;
    dueDate: string | null;
    afterAllocation: number;
  }
  const byPartner = new Map<number, AgingDoc[]>();
  const push = (partnerId: number, doc: AgingDoc) => {
    const list = byPartner.get(partnerId) ?? [];
    list.push(doc);
    byPartner.set(partnerId, list);
  };
  for (const d of docsRaw) {
    push(d.partnerId, {
      docDate: d.docDate,
      dueDate: d.dueDate,
      // 退回後淨額 → 再扣立沖
      afterAllocation: d.total - (returned.get(d.id) ?? 0) - (allocatedByDoc.get(d.id) ?? 0),
    });
  }
  for (const o of openings) {
    push(o.partnerId, {
      docDate: o.docDate,
      dueDate: o.dueDate,
      afterAllocation: o.amount - (allocatedByOpening.get(o.id) ?? 0),
    });
  }

  const rows = [];
  let fallbackCount = 0; // 沒有到期日、退回以單據日估算的未沖單據數（要在回應標註）
  for (const [partnerId, docs] of byPartner) {
    docs.sort((a, b) => a.docDate.localeCompare(b.docDate));
    let pool = paidBy.get(partnerId) ?? 0;
    const buckets: Record<AgingBucket, number> = { notDue: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    let overdue = 0;
    for (const doc of docs) {
      const applied = Math.min(pool, Math.max(0, doc.afterAllocation));
      pool -= applied;
      const unpaid = doc.afterAllocation - applied;
      if (unpaid > 0) {
        const b = bucketOf(doc, asOf);
        buckets[b.bucket] += unpaid;
        if (b.overdue) overdue += unpaid;
        if (b.fallback) fallbackCount += 1;
      }
    }
    const total = (Object.values(buckets) as number[]).reduce((s, v) => s + v, 0);
    // 預收/預付＝掛在 2231/1212 的餘額（0027，B9）；pool 沖完仍有剩是罕見殘餘
    //（例如收付款後原單才被退回），一併列出讓數字對得起來
    const credit = pool + (prepaidBy.get(partnerId) ?? 0);
    if (total > 0 || credit > 0) {
      rows.push({ partnerId, name: nameOf.get(partnerId) ?? `#${partnerId}`, ...buckets, total, overdue, credit });
    }
  }
  // 有收付款但從無單據的對象（純預收/預付：FIFO pool 或 2231/1212 餘額都可能單獨存在）
  const creditOnly = new Map<number, number>();
  for (const [partnerId, received] of paidBy) {
    creditOnly.set(partnerId, (creditOnly.get(partnerId) ?? 0) + received);
  }
  for (const [partnerId, prepaid] of prepaidBy) {
    creditOnly.set(partnerId, (creditOnly.get(partnerId) ?? 0) + prepaid);
  }
  for (const [partnerId, credit] of creditOnly) {
    if (!byPartner.has(partnerId) && credit > 0) {
      rows.push({
        partnerId,
        name: nameOf.get(partnerId) ?? `#${partnerId}`,
        notDue: 0,
        d0_30: 0,
        d31_60: 0,
        d61_90: 0,
        d90plus: 0,
        total: 0,
        overdue: 0,
        credit,
      });
    }
  }
  rows.sort((a, b) => b.total - a.total);
  const notes: string[] = [];
  if (fallbackCount > 0) {
    notes.push(
      side === "ar"
        ? `有 ${fallbackCount} 張未收銷貨單沒有收款到期日（客戶未約定付款條件，或是到期日功能上線前的舊單），` +
            `改以單據日期估算、前 30 天不列入逾期。要精確分桶，請到「客戶與商品」頁補客戶的付款條件天數（之後的新單自動帶入）`
        : `有 ${fallbackCount} 張未付進貨單沒有付款到期日（供應商未約定付款條件，或是到期日功能上線前的舊單），` +
            `改以單據日期估算、前 30 天不列入逾期。要精確分桶，請到「客戶與商品」頁補供應商的付款條件天數（之後的新單自動帶入）`,
    );
  }
  return {
    asOf,
    rows,
    notes,
    totals: {
      notDue: rows.reduce((s, r) => s + r.notDue, 0),
      d0_30: rows.reduce((s, r) => s + r.d0_30, 0),
      d31_60: rows.reduce((s, r) => s + r.d31_60, 0),
      d61_90: rows.reduce((s, r) => s + r.d61_90, 0),
      d90plus: rows.reduce((s, r) => s + r.d90plus, 0),
      total: rows.reduce((s, r) => s + r.total, 0),
      overdue: rows.reduce((s, r) => s + r.overdue, 0),
      credit: rows.reduce((s, r) => s + r.credit, 0),
    },
  };
}

/** 應收帳齡：credit 欄＝預收（2231）＋未指定沖銷的收款殘餘 */
export async function arAging(db: Db, asOf: string) {
  return aging(db, asOf, "ar");
}

/** 應付帳齡（0033）：與應收同一顆引擎，credit 欄＝預付（1212）＋未指定沖銷的付款殘餘 */
export async function apAging(db: Db, asOf: string) {
  return aging(db, asOf, "ap");
}
