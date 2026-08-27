/**
 * 單據的作廢層（migration 0025，B4）。統一設計原則（違反＝重做）：
 *
 * ★ 更正＝**作廢＋重開**，不是就地改。
 *   - 已拋轉傳票的單據：產生「反向傳票」（原傳票借貸互換，sourceType 沿用原單據來源別、
 *     sourceId 指向原單、memo 註明「作廢沖轉 #原單號」），總帳靠兩張傳票對沖歸零；
 *     單據面的彙總（餘額／帳齡／401／年度彙總／匯出）一律以 voided_at 排除。
 *   - 原單標 voided_at／voided_by／void_reason（理由必填），**永不刪除**——
 *     作廢是 append-only 紀律的同一件事：留原單、留反向傳票、留理由。
 *   - 未拋轉傳票的單據（報價單）直接標作廢，沒有反向傳票。
 *   - 作廢不可再作廢（409）；要「還原一次作廢」的正路是重開一張新單。
 *
 * ★ 關帳鎖的兩種嚴格度（為什麼不一樣，見各函式註解）：
 *   - 收付款單／手工傳票／扣繳單／期初應收付單：反向傳票日期預設＝原單日期；落在已關帳期間
 *     → 409 並指路「帶 voidDate 以開放期間的日期（例如今天）沖轉，或先重開期間」。
 *     這些單據的彙總不是按期間申報的檔案，跨期沖轉可行。
 *   - 銷貨單／進貨單／退回折讓單：**原單日期**所屬期間已關就不可作廢——月報表與 401 依單據／
 *     發票／證明單日期歸期，作廢會回溯改掉（可能已申報的）該期數字。銷貨進貨的出路是
 *     退回／折讓單以當期認列（與發票作廢的既有規則同一條，invoices.ts）；退回折讓單本身
 *     沒有再下一層的沖抵單據，出路只剩重開期間。
 */
import { schema } from "@tw-erp/db";
import { and, eq, isNull } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { lockProducts, onHand } from "./documents.ts";
import { closedThrough } from "./period.ts";

export interface VoidInput {
  reason: string;
  /** 反向傳票日期；未帶＝原單日期。僅收付款單／手工傳票／扣繳單接受（見檔頭） */
  voidDate?: string | undefined;
}

/** 已作廢的單不可再作廢：反向傳票再沖一次會把帳沖成反向餘額 */
function assertNotVoided(
  label: string,
  id: number,
  doc: { voidedAt: Date | null; voidReason: string | null },
): void {
  if (doc.voidedAt) {
    throw new AppError(
      409,
      "{label} #{id} 已於 {date} 作廢（理由：{reason}），不可再作廢。要恢復這筆交易請重開一張新單",
      { label, id, date: doc.voidedAt.toISOString().slice(0, 10), reason: doc.voidReason ?? "未記錄" },
    );
  }
}

/**
 * 反向傳票日期的兩道檢查。
 * ① voidDate 不得早於原單日期（與 applyPrepaid「沖用日不得早於收付款日」同型）：
 *    反向傳票落在原單之前，兩個日期之間的每一天餘額都會暫時反向——
 *    「先沖銷、後發生」的帳，任何以中間日期為基準的報表（資產負債表、帳齡）都會看到
 *    一筆負的現金或負的應收，而兩張單本身都是對的，錯的只有順序。
 * ② 關帳檢查：與 assertPeriodOpen 同一條規則，但訊息要指出作廢特有的兩條出路——
 *    以開放期間的日期沖轉（voidDate），或先重開期間。
 */
async function assertReversalDateOpen(tx: Db, date: string, originalDate: string): Promise<void> {
  if (date < originalDate) {
    throw new AppError(
      422,
      "沖轉日 {date} 早於原單日期 {originalDate}——反向傳票不能落在原單發生之前，否則兩個日期之間的期間餘額會暫時反向（帳上出現「先沖銷、後發生」）。請帶原單日期當天或之後的 voidDate",
      { date, originalDate },
    );
  }
  const through = await closedThrough(tx);
  if (through && date.slice(0, 7) <= through) {
    throw new AppError(
      409,
      "反向傳票日期 {date} 屬於已關帳期間（帳務關至 {through}）。請在作廢時帶 voidDate 以開放期間的日期（例如今天）沖轉，或先到「報表」頁重開該期間",
      { date, through },
    );
  }
}

/**
 * 銷貨／進貨／期初單作廢前的懸空檢查：這張單是否已被**有效（未作廢）**的收付款單沖銷——
 * 建單時立沖（allocations）與事後預收/預付沖用（fromPrepaid）都算。
 * 放行的話沖銷列會懸空：收付款單還活著、它沖的單卻消失了，彙總各自解讀——
 * 帳齡把那筆錢當「未指定沖銷」再拿去 FIFO 沖別張單，partner-balances 的對象餘額直接變負。
 * 解鎖的正路是先作廢收付款單（voidCashDoc 會把立沖釋放、預收沖用一併反向），再作廢本單。
 */
async function assertNotSettledByCashDoc(
  tx: Db,
  targetType: "sale" | "purchase" | "opening",
  targetId: number,
  label: string,
): Promise<void> {
  const rows = await tx
    .select({
      cashDocId: schema.cashDocAllocations.cashDocId,
      fromPrepaid: schema.cashDocAllocations.fromPrepaid,
      kind: schema.cashDocs.kind,
    })
    .from(schema.cashDocAllocations)
    .innerJoin(schema.cashDocs, eq(schema.cashDocAllocations.cashDocId, schema.cashDocs.id))
    .where(
      and(
        eq(schema.cashDocAllocations.targetType, targetType),
        eq(schema.cashDocAllocations.targetId, targetId),
        isNull(schema.cashDocs.voidedAt),
      ),
    );
  if (rows.length) {
    const docLabel = rows[0]!.kind === "receipt" ? "收款單" : "付款單";
    const how = rows.some((r) => r.fromPrepaid)
      ? rows.every((r) => r.fromPrepaid)
        ? `以${rows[0]!.kind === "receipt" ? "預收" : "預付"}餘額沖用`
        : "立沖並沖用"
      : "立沖";
    const ids = [...new Set(rows.map((r) => r.cashDocId))].sort((a, b) => a - b);
    throw new AppError(
      409,
      "{label} #{id} 已被{docLabel} {ids} {how}，不可直接作廢——硬廢會讓那筆沖銷懸空（{docLabel}還活著、被沖的單卻消失，對象餘額會變負）。請先作廢{docLabel} {ids} 再作廢本單",
      { label, id: targetId, docLabel, ids: ids.map((i) => `#${i}`).join("、"), how },
    );
  }
}

/** 產生反向傳票：原傳票借貸互換。回傳新傳票 id */
async function insertReversalEntry(
  tx: Db,
  originalEntryId: number,
  opts: {
    entryDate: string;
    memo: string;
    sourceType: (typeof schema.journalEntries.$inferSelect)["sourceType"];
    sourceId: number;
  },
): Promise<number> {
  const origLines = await tx
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, originalEntryId));
  if (!origLines.length) throw new AppError(500, "傳票 #{id} 沒有分錄，無法沖轉", { id: originalEntryId });
  const [entry] = await tx
    .insert(schema.journalEntries)
    .values({ entryDate: opts.entryDate, memo: opts.memo, sourceType: opts.sourceType, sourceId: opts.sourceId })
    .returning();
  await tx.insert(schema.journalLines).values(
    origLines.map((l) => ({ entryId: entry!.id, accountId: l.accountId, debit: l.credit, credit: l.debit })),
  );
  return entry!.id;
}

// ---------------------------------------------------------------- 收付款單

/**
 * 作廢收付款單：反向傳票沖現金與應收/應付。
 * 立沖紀錄（cash_doc_allocations）保留原列不刪——彙總與未沖餘額的計算一律排除
 * 已作廢收付款單的沖銷（ledger.ts／orders.ts），原單據的未沖餘額隨作廢自動回復。
 */
export async function voidCashDoc(db: Db, id: number, input: VoidInput, userId: number) {
  return db.transaction(async (tx) => {
    const [doc] = await tx.select().from(schema.cashDocs).where(eq(schema.cashDocs.id, id)).for("update");
    if (!doc) throw new AppError(404, "收付款單不存在: {id}", { id });
    const label = doc.kind === "receipt" ? "收款單" : "付款單";
    assertNotVoided(label, id, doc);
    if (!doc.journalEntryId) throw new AppError(422, "{label} #{id} 沒有原始傳票，無法沖轉（資料異常，請聯絡管理者）", { label, id });

    const reversalDate = input.voidDate ?? doc.docDate;
    await assertReversalDateOpen(tx, reversalDate, doc.docDate);
    const reversalEntryId = await insertReversalEntry(tx, doc.journalEntryId, {
      entryDate: reversalDate,
      memo: `作廢沖轉 ${label} #${id}：${input.reason}`,
      sourceType: doc.kind,
      sourceId: id,
    });
    // 0027（B9）：這張單的預收/預付若已被事後沖用，那些沖用傳票（借 2231 貸 1144／
    // 借 2144 貸 1212）也要一併反向——只沖原傳票會讓 2231/1212 留下負餘額，
    // 而被沖用的單據卻顯示已沖畢。沖用列本身保留（軌跡），彙總靠本單的 voided_at 排除，
    // 所以被沖用單據的未沖餘額隨作廢自動回復
    const applications = await tx
      .select()
      .from(schema.cashDocAllocations)
      .where(and(eq(schema.cashDocAllocations.cashDocId, id), eq(schema.cashDocAllocations.fromPrepaid, true)));
    const applicationEntryIds = [...new Set(applications.map((a) => a.journalEntryId).filter((e): e is number => e !== null))];
    for (const entryId of applicationEntryIds) {
      await insertReversalEntry(tx, entryId, {
        entryDate: reversalDate,
        memo: `作廢沖轉 ${label} #${id} 的${doc.kind === "receipt" ? "預收" : "預付"}沖銷（傳票 #${entryId}）：${input.reason}`,
        sourceType: doc.kind,
        sourceId: id,
      });
    }
    const [updated] = await tx
      .update(schema.cashDocs)
      .set({ voidedAt: new Date(), voidedBy: userId, voidReason: input.reason, reversalEntryId })
      .where(eq(schema.cashDocs.id, id))
      .returning();
    return { ...updated!, reversalEntryId };
  });
}

// ---------------------------------------------------------------- 手工傳票

/**
 * 作廢手工傳票。**只收 source_type='manual'**：系統拋轉的傳票必須作廢其來源單據——
 * 只沖傳票會讓單據還活著（餘額、彙總照算），總帳卻已歸零，兩邊從此各說各話。
 */
export async function voidManualEntry(db: Db, id: number, input: VoidInput, userId: number) {
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(schema.journalEntries)
      .where(eq(schema.journalEntries.id, id))
      .for("update");
    if (!entry) throw new AppError(404, "傳票不存在: {id}", { id });
    if (entry.sourceType !== "manual") {
      throw new AppError(
        422,
        "傳票 #{id} 是系統自動拋轉的（來源：{sourceType} #{sourceId}），不可直接作廢。請到該單據所在的頁面作廢那張單，傳票會隨之沖轉——只沖傳票會讓單據面的餘額與彙總跟總帳對不起來",
        { id, sourceType: entry.sourceType ?? "未知", sourceId: entry.sourceId ?? "?" },
      );
    }
    assertNotVoided("傳票", id, entry);
    // 反向沖轉傳票不可再被作廢：沖掉「作廢時產生的反向傳票」等於偷偷復活原傳票——
    // 原單標著已作廢、數字卻活著，檔頭「作廢不可再作廢；要恢復請重開新單」的原則被繞過。
    // （系統拋轉的反向傳票已被上面的 sourceType 檢查擋住，這裡補的是手工傳票的反向傳票）
    const [reversalOf] = await tx
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(eq(schema.journalEntries.reversalEntryId, id));
    if (reversalOf) {
      throw new AppError(
        422,
        "傳票 #{id} 是作廢傳票 #{originalId} 時產生的反向沖轉傳票，不可單獨作廢——這等於悄悄恢復已作廢的傳票 #{originalId}。若原傳票其實是對的，請照原內容重開一張新傳票",
        { id, originalId: reversalOf.id },
      );
    }

    const reversalDate = input.voidDate ?? entry.entryDate;
    await assertReversalDateOpen(tx, reversalDate, entry.entryDate);
    // 反向傳票也是 manual、sourceId 指向原傳票：兩張在清單上互相解釋得了對方
    const reversalEntryId = await insertReversalEntry(tx, id, {
      entryDate: reversalDate,
      memo: `作廢沖轉 傳票 #${id}：${input.reason}`,
      sourceType: "manual",
      sourceId: id,
    });
    const [updated] = await tx
      .update(schema.journalEntries)
      .set({ voidedAt: new Date(), voidedBy: userId, voidReason: input.reason, reversalEntryId })
      .where(eq(schema.journalEntries.id, id))
      .returning();
    return { ...updated!, reversalEntryId };
  });
}

// ---------------------------------------------------------------- 扣繳支出單

/**
 * 作廢扣繳支出單（B4 實測「最貴的一格」）：反向傳票沖費用／2211／2212／現金四行，
 * 年度彙總（憑單取數來源）以 voided_at 排除——打錯的單作廢重開後，
 * 受領人不會再被掛上不存在的所得。
 */
export async function voidWithholdingPayment(db: Db, id: number, input: VoidInput, userId: number) {
  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(schema.withholdingPayments)
      .where(eq(schema.withholdingPayments.id, id))
      .for("update");
    if (!payment) throw new AppError(404, "扣繳支出單不存在: {id}", { id });
    assertNotVoided("扣繳支出單", id, payment);
    if (!payment.journalEntryId) {
      throw new AppError(422, "扣繳支出單 #{id} 沒有原始傳票，無法沖轉（資料異常，請聯絡管理者）", { id });
    }

    const reversalDate = input.voidDate ?? payment.payDate;
    await assertReversalDateOpen(tx, reversalDate, payment.payDate);
    const reversalEntryId = await insertReversalEntry(tx, payment.journalEntryId, {
      entryDate: reversalDate,
      memo: `作廢沖轉 扣繳支出單 #${id}：${input.reason}`,
      sourceType: "withholding",
      sourceId: id,
    });
    const [updated] = await tx
      .update(schema.withholdingPayments)
      .set({ voidedAt: new Date(), voidedBy: userId, voidReason: input.reason, reversalEntryId })
      .where(eq(schema.withholdingPayments.id, id))
      .returning();
    return { ...updated!, reversalEntryId };
  });
}

// ---------------------------------------------------------------- 銷貨單

/**
 * 由訂單出貨產生的銷貨單作廢時，把已出貨量退回訂單（依商品對回明細，最舊的明細先退），
 * 並重推訂單狀態：closed → partial／open。不退的話貨已回倉、訂單卻記著「已出清」，
 * 這張訂單從此出不了貨也結不了案。
 *
 * 例外：**短交結案**（closed_at 非 NULL，0032）的訂單不隨作廢翻回 open／partial——
 * 結案是使用者明示的營業決定（「到此為止，剩餘量不再出貨」），出貨單打錯是另一件事；
 * 讓作廢悄悄復活訂單，等於組合操作繞過了結案時對使用者說過的那句話（訂單也會無聲回到
 * 在手訂單 backlog），而且會留下 status=open 卻掛著 closed_at 的自相矛盾。
 * 出貨量照樣退回（數量軌跡要對）；要繼續交易的正路是開一張新訂單（ship 的 409 已指路）。
 */
async function rollbackOrderShipment(tx: Db, sale: typeof schema.sales.$inferSelect): Promise<void> {
  if (!sale.orderId) return;
  const [order] = await tx.select().from(schema.orders).where(eq(schema.orders.id, sale.orderId));
  const orderLines = await tx.select().from(schema.orderLines).where(eq(schema.orderLines.orderId, sale.orderId));
  const saleLines = await tx.select().from(schema.saleLines).where(eq(schema.saleLines.saleId, sale.id));
  const shippedOf = new Map(orderLines.map((l) => [l.id, Number(l.shippedQty)]));
  for (const sl of saleLines) {
    let remaining = Number(sl.qty);
    for (const ol of orderLines.filter((o) => o.productId === sl.productId)) {
      if (remaining <= 0) break;
      const shipped = shippedOf.get(ol.id) ?? 0;
      if (shipped <= 0) continue;
      const back = Math.min(shipped, remaining);
      shippedOf.set(ol.id, shipped - back);
      remaining -= back;
    }
  }
  for (const ol of orderLines) {
    const next = shippedOf.get(ol.id) ?? 0;
    if (next !== Number(ol.shippedQty)) {
      await tx.update(schema.orderLines).set({ shippedQty: String(next) }).where(eq(schema.orderLines.id, ol.id));
    }
  }
  const anyShipped = orderLines.some((l) => (shippedOf.get(l.id) ?? 0) > 0);
  const fully = orderLines.every((l) => (shippedOf.get(l.id) ?? 0) >= Number(l.qty));
  const derived = fully ? ("closed" as const) : anyShipped ? ("partial" as const) : ("open" as const);
  await tx
    .update(schema.orders)
    .set({ status: order?.closedAt ? "closed" : derived })
    .where(eq(schema.orders.id, sale.orderId));
}

/**
 * 銷貨單作廢的共用核心：反向傳票＋庫存按**原出庫成本**回補＋訂單出貨量退回＋標記。
 * 兩個入口共用：獨立作廢（POST /sales/:id/void）與發票作廢連動沖銷（invoices.ts cancelInvoice）。
 * 呼叫端負責各自的前置檢查（發票狀態、關帳）；這裡把關「已沖銷／有退回單／已被收款單沖銷」三個共通條件。
 */
export async function voidSaleCore(
  tx: Db,
  saleId: number,
  opts: { entryDate: string; reason: string; userId: number | null },
): Promise<number> {
  const [sale] = await tx.select().from(schema.sales).where(eq(schema.sales.id, saleId)).for("update");
  if (!sale) throw new AppError(404, "銷貨單不存在: {id}", { id: saleId });
  if (sale.reversalEntryId) throw new AppError(409, "銷貨單 {id} 已沖銷（傳票 #{entryId}）", { id: saleId, entryId: sale.reversalEntryId });
  if (!sale.journalEntryId) throw new AppError(422, "銷貨單 {id} 無原始傳票，無法沖銷", { id: saleId });
  // 整單沖銷與退回單都會產生迴轉效果，兩條路都走就是雙重沖銷（存貨回補兩次、收入減兩次）。
  // 已作廢的退回單不算（0030）：它的迴轉效果已被自己的反向傳票收回，把全部退回單作廢後
  // 原單就回到「從未退過」的狀態，理當可以整單作廢
  const [existingReturn] = await tx
    .select({ id: schema.salesReturns.id })
    .from(schema.salesReturns)
    .where(and(eq(schema.salesReturns.saleId, saleId), isNull(schema.salesReturns.voidedAt)));
  if (existingReturn) {
    throw new AppError(
      409,
      "銷貨單 {id} 已有退回／折讓單（#{returnId}），不可再整單沖銷（要退掉剩下的部分，請到銷貨頁對這張單再開一張退回單）",
      { id: saleId, returnId: existingReturn.id },
    );
  }
  // 已被有效收款單立沖或預收沖用 → 409 指路先作廢收款單（兩個入口——獨立作廢與
  // 發票作廢連動沖銷——都要擋，所以放在共用核心）
  await assertNotSettledByCashDoc(tx, "sale", saleId, "銷貨單");

  const reversalEntryId = await insertReversalEntry(tx, sale.journalEntryId, {
    entryDate: opts.entryDate,
    memo: `作廢沖轉 銷貨單 #${saleId}：${opts.reason}`,
    sourceType: "sale",
    sourceId: saleId,
  });

  // 庫存以原出庫成本回補（不是今天的均價）：作廢＝當作沒賣過，貨用當初出去的成本回來
  const outMoves = await tx
    .select()
    .from(schema.inventoryMovements)
    .where(
      and(
        eq(schema.inventoryMovements.sourceType, "sale"),
        eq(schema.inventoryMovements.sourceId, saleId),
        eq(schema.inventoryMovements.direction, "out"),
      ),
    );
  if (outMoves.length > 0) {
    await tx.insert(schema.inventoryMovements).values(
      outMoves.map((m) => ({
        productId: m.productId,
        direction: "in" as const,
        qty: m.qty,
        unitCost: m.unitCost,
        amount: m.amount,
        sourceType: "sale" as const,
        sourceId: saleId,
        // 回補異動與反向傳票同日（獨立作廢＝原單日；發票作廢連動＝作廢日）：明細帳與總帳同期
        docDate: opts.entryDate,
      })),
    );
  }

  await rollbackOrderShipment(tx, sale);

  await tx
    .update(schema.sales)
    .set({ reversalEntryId, voidedAt: new Date(), voidedBy: opts.userId, voidReason: opts.reason })
    .where(eq(schema.sales.id, saleId));
  return reversalEntryId;
}

/**
 * 獨立作廢銷貨單（未開發票、或發票已作廢者）。
 * - 有 issued 發票 → 409 指路先作廢發票：發票是對外開出去的憑證，單據不能先於憑證消失。
 * - 原單日期所屬期間已關 → 409：該期報表（可能連同 401）已定案，出路是退回單以當期認列。
 */
export async function voidSale(db: Db, saleId: number, input: { reason: string }, userId: number) {
  return db.transaction(async (tx) => {
    const [sale] = await tx.select().from(schema.sales).where(eq(schema.sales.id, saleId));
    if (!sale) throw new AppError(404, "銷貨單不存在: {id}", { id: saleId });
    const [issued] = await tx
      .select({ invoiceNumber: schema.invoices.invoiceNumber })
      .from(schema.invoices)
      .where(and(eq(schema.invoices.saleId, saleId), eq(schema.invoices.status, "issued")));
    if (issued) {
      throw new AppError(
        409,
        "銷貨單 {id} 已開立發票 {invoiceNumber} 且未作廢，不可直接作廢銷貨單。請先到「電子發票」頁作廢該發票（作廢時可勾選連動沖銷銷貨單），或改開退回／折讓單",
        { id: saleId, invoiceNumber: issued.invoiceNumber },
      );
    }
    const through = await closedThrough(tx);
    if (through && sale.docDate.slice(0, 7) <= through) {
      throw new AppError(
        409,
        "銷貨單 {id} 的日期 {docDate} 屬於已關帳期間（帳務關至 {through}），作廢會回溯改掉該期間（可能已申報）的數字。請改開退回／折讓單以當期認列，或先到「報表」頁重開該期間",
        { id: saleId, docDate: sale.docDate, through },
      );
    }
    const reversalEntryId = await voidSaleCore(tx, saleId, {
      entryDate: sale.docDate,
      reason: input.reason,
      userId,
    });
    const [updated] = await tx.select().from(schema.sales).where(eq(schema.sales.id, saleId));
    return { ...updated!, reversalEntryId };
  });
}

// ---------------------------------------------------------------- 進貨單

/**
 * 作廢進貨單：反向傳票＋庫存以**原入庫成本**沖出＋採購單收貨量退回＋標記。
 * - 有退出／折讓單 → 409（雙重沖銷）。
 * - 原單日期所屬期間已關 → 409：401 的進項依進貨單日期歸期，作廢會改掉可能已申報的數字。
 * - 在庫檢查（數量與帳面金額都要夠）：這批貨若已賣出，原成本沖不回來——
 *   硬沖會把在庫金額打成負數，之後每一筆銷貨都會在均價計算炸掉。出路是進貨退出單。
 */
export async function voidPurchase(db: Db, purchaseId: number, input: { reason: string }, userId: number) {
  return db.transaction(async (tx) => {
    const [purchase] = await tx
      .select()
      .from(schema.purchases)
      .where(eq(schema.purchases.id, purchaseId))
      .for("update");
    if (!purchase) throw new AppError(404, "進貨單不存在: {id}", { id: purchaseId });
    assertNotVoided("進貨單", purchaseId, purchase);
    if (!purchase.journalEntryId) throw new AppError(422, "進貨單 {id} 無原始傳票，無法沖銷", { id: purchaseId });
    // 已作廢退出單不算（0030）：理由同銷貨側
    const [existingReturn] = await tx
      .select({ id: schema.purchaseReturns.id })
      .from(schema.purchaseReturns)
      .where(and(eq(schema.purchaseReturns.purchaseId, purchaseId), isNull(schema.purchaseReturns.voidedAt)));
    if (existingReturn) {
      throw new AppError(
        409,
        "進貨單 {id} 已有退出／折讓單（#{returnId}），不可再整單作廢（要退掉剩下的部分，請到進貨頁對這張單再開一張退出單）",
        { id: purchaseId, returnId: existingReturn.id },
      );
    }
    // 已被有效付款單立沖或預付沖用 → 409 指路先作廢付款單（與銷貨側同一條規則）
    await assertNotSettledByCashDoc(tx, "purchase", purchaseId, "進貨單");
    const through = await closedThrough(tx);
    if (through && purchase.docDate.slice(0, 7) <= through) {
      throw new AppError(
        409,
        "進貨單 {id} 的日期 {docDate} 屬於已關帳期間（帳務關至 {through}），作廢會回溯改掉該期間（可能已申報）的進項數字。請改開退出／折讓單以當期認列，或先到「報表」頁重開該期間",
        { id: purchaseId, docDate: purchase.docDate, through },
      );
    }

    // 原入庫異動＝要沖回去的量與金額（服務項目不入庫存，進貨單本來就收不了服務項目）
    const inMoves = await tx
      .select()
      .from(schema.inventoryMovements)
      .where(
        and(
          eq(schema.inventoryMovements.sourceType, "purchase"),
          eq(schema.inventoryMovements.sourceId, purchaseId),
          eq(schema.inventoryMovements.direction, "in"),
        ),
      );
    // 讀 onHand 之前先取商品鎖（全站統一取鎖順序，理由見 documents.ts 的 lockProducts）
    await lockProducts(tx, inMoves.map((m) => m.productId));
    const needed = new Map<number, { qty: number; amount: number }>();
    for (const m of inMoves) {
      const cur = needed.get(m.productId) ?? { qty: 0, amount: 0 };
      needed.set(m.productId, { qty: cur.qty + Number(m.qty), amount: cur.amount + m.amount });
    }
    for (const [productId, need] of needed) {
      const stock = await onHand(tx, productId);
      if (stock.qty < need.qty || stock.amount < need.amount) {
        const [product] = await tx.select().from(schema.products).where(eq(schema.products.id, productId));
        throw new AppError(
          409,
          "商品「{name}」目前在庫 {stockQty}（帳面 {stockAmount} 元），不足以沖回這張進貨的 {needQty}（{needAmount} 元）——這批貨可能已賣出或退回。請改開進貨退出／折讓單處理仍在庫的部分；已賣出的部分本來就沖不回來",
          { name: product?.name ?? `#${productId}`, stockQty: stock.qty, stockAmount: stock.amount, needQty: need.qty, needAmount: need.amount },
        );
      }
    }
    if (inMoves.length > 0) {
      await tx.insert(schema.inventoryMovements).values(
        inMoves.map((m) => ({
          productId: m.productId,
          direction: "out" as const,
          qty: m.qty,
          unitCost: m.unitCost,
          amount: m.amount,
          sourceType: "purchase" as const,
          sourceId: purchaseId,
          // 回沖異動與反向傳票同日（＝原單日期；原單所屬期間已關就作廢不了，見上方檢查）
          docDate: purchase.docDate,
        })),
      );
    }

    const reversalEntryId = await insertReversalEntry(tx, purchase.journalEntryId, {
      entryDate: purchase.docDate,
      memo: `作廢沖轉 進貨單 #${purchaseId}：${input.reason}`,
      sourceType: "purchase",
      sourceId: purchaseId,
    });

    // 由採購單收貨產生的進貨單：收貨量退回、重推採購單狀態（closed → partial／open）。
    // 短交結案（closed_at 非 NULL）的採購單不隨作廢翻回——理由同 rollbackOrderShipment
    if (purchase.purchaseOrderId) {
      const [po] = await tx
        .select()
        .from(schema.purchaseOrders)
        .where(eq(schema.purchaseOrders.id, purchase.purchaseOrderId));
      const poLines = await tx
        .select()
        .from(schema.purchaseOrderLines)
        .where(eq(schema.purchaseOrderLines.purchaseOrderId, purchase.purchaseOrderId));
      const purchaseLines = await tx
        .select()
        .from(schema.purchaseLines)
        .where(eq(schema.purchaseLines.purchaseId, purchaseId));
      const receivedOf = new Map(poLines.map((l) => [l.id, Number(l.receivedQty)]));
      for (const pl of purchaseLines) {
        let remaining = Number(pl.qty);
        for (const ol of poLines.filter((o) => o.productId === pl.productId)) {
          if (remaining <= 0) break;
          const received = receivedOf.get(ol.id) ?? 0;
          if (received <= 0) continue;
          const back = Math.min(received, remaining);
          receivedOf.set(ol.id, received - back);
          remaining -= back;
        }
      }
      for (const ol of poLines) {
        const next = receivedOf.get(ol.id) ?? 0;
        if (next !== Number(ol.receivedQty)) {
          await tx
            .update(schema.purchaseOrderLines)
            .set({ receivedQty: String(next) })
            .where(eq(schema.purchaseOrderLines.id, ol.id));
        }
      }
      const anyReceived = poLines.some((l) => (receivedOf.get(l.id) ?? 0) > 0);
      const fully = poLines.every((l) => (receivedOf.get(l.id) ?? 0) >= Number(l.qty));
      const derived = fully ? ("closed" as const) : anyReceived ? ("partial" as const) : ("open" as const);
      await tx
        .update(schema.purchaseOrders)
        .set({ status: po?.closedAt ? "closed" : derived })
        .where(eq(schema.purchaseOrders.id, purchase.purchaseOrderId));
    }

    const [updated] = await tx
      .update(schema.purchases)
      .set({ voidedAt: new Date(), voidedBy: userId, voidReason: input.reason, reversalEntryId })
      .where(eq(schema.purchases.id, purchaseId))
      .returning();
    return { ...updated!, reversalEntryId };
  });
}

// ---------------------------------------------------------------- 庫存調整單

/**
 * 作廢庫存調整單（migration 0026，B8）：反向傳票＋庫存以**原成本**反向回補＋標記。
 * - 原單日期所屬期間已關 → 409（與銷貨／進貨同一嚴格度）：月報表的存貨與盤損依單據日歸期，
 *   跨期沖轉會回溯改掉已定案的數字，所以刻意不收 voidDate——出路是重開期間，
 *   或在開放期間開一張方向相反的新調整單。
 * - 原單是盤盈（in）的部分作廢時要沖出庫存：那批「多出來的貨」若已賣掉，
 *   在庫不足會 409——與進貨單作廢同一條規則。
 */
export async function voidInventoryAdjustment(db: Db, id: number, input: { reason: string }, userId: number) {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(schema.inventoryAdjustments)
      .where(eq(schema.inventoryAdjustments.id, id))
      .for("update");
    if (!doc) throw new AppError(404, "庫存調整單不存在: {id}", { id });
    assertNotVoided("庫存調整單", id, doc);
    const through = await closedThrough(tx);
    if (through && doc.docDate.slice(0, 7) <= through) {
      throw new AppError(
        409,
        "庫存調整單 {id} 的日期 {docDate} 屬於已關帳期間（帳務關至 {through}），作廢會回溯改掉該期間已定案的存貨與盤損數字。請在開放期間開一張方向相反的新調整單，或先到「報表」頁重開該期間",
        { id, docDate: doc.docDate, through },
      );
    }

    // 原異動＝要反向回補的量與金額（in→out、out→in，都用原單當時的成本快照）
    const moves = await tx
      .select()
      .from(schema.inventoryMovements)
      .where(and(eq(schema.inventoryMovements.sourceType, "adjustment"), eq(schema.inventoryMovements.sourceId, id)));
    await lockProducts(tx, moves.map((m) => m.productId));
    // 盤盈（in）作廢＝把那批貨沖出去：已賣掉就沖不回來（與進貨單作廢同一條規則）
    const needed = new Map<number, { qty: number; amount: number }>();
    for (const m of moves.filter((m) => m.direction === "in")) {
      const cur = needed.get(m.productId) ?? { qty: 0, amount: 0 };
      needed.set(m.productId, { qty: cur.qty + Number(m.qty), amount: cur.amount + m.amount });
    }
    for (const [productId, need] of needed) {
      const stock = await onHand(tx, productId);
      if (stock.qty < need.qty || stock.amount < need.amount) {
        const [product] = await tx.select().from(schema.products).where(eq(schema.products.id, productId));
        throw new AppError(
          409,
          "商品「{name}」目前在庫 {stockQty}（帳面 {stockAmount} 元），不足以沖回這張調整單盤盈的 {needQty}（{needAmount} 元）——那批貨可能已賣出。請改開一張方向相反的新調整單處理仍在庫的部分",
          { name: product?.name ?? `#${productId}`, stockQty: stock.qty, stockAmount: stock.amount, needQty: need.qty, needAmount: need.amount },
        );
      }
    }
    if (moves.length > 0) {
      await tx.insert(schema.inventoryMovements).values(
        moves.map((m) => ({
          productId: m.productId,
          direction: m.direction === "in" ? ("out" as const) : ("in" as const),
          qty: m.qty,
          unitCost: m.unitCost,
          amount: m.amount,
          sourceType: "adjustment" as const,
          sourceId: id,
          // 回沖異動與反向傳票同日（＝原單日期；已關帳的期間在上方已擋）
          docDate: doc.docDate,
        })),
      );
    }

    // 0 元調整單（極小數量四捨五入成 0 元）的傳票沒有分錄，沒有東西可沖
    let reversalEntryId: number | null = null;
    if (doc.journalEntryId && doc.totalIn + doc.totalOut > 0) {
      reversalEntryId = await insertReversalEntry(tx, doc.journalEntryId, {
        entryDate: doc.docDate,
        memo: `作廢沖轉 庫存調整單 #${id}：${input.reason}`,
        sourceType: "adjustment",
        sourceId: id,
      });
    }

    const [updated] = await tx
      .update(schema.inventoryAdjustments)
      .set({ voidedAt: new Date(), voidedBy: userId, voidReason: input.reason, reversalEntryId })
      .where(eq(schema.inventoryAdjustments.id, id))
      .returning();
    return { ...updated!, reversalEntryId };
  });
}

// ---------------------------------------------------------------- 退回／折讓單

/**
 * 退回折讓單作廢共通的關帳檢查（0030）：與銷貨／進貨單同一嚴格度，刻意不收 voidDate。
 * 兩個歸期都要看——docDate 驅動當期損益與庫存（儀表板月營收扣它），
 * cert 生效日（certDate ?? docDate）驅動 401 減項歸期（與 updateReturnCertificate 同一條規則）：
 * 任一落在已關帳期間，作廢就會回溯改掉可能已申報的數字，出路是重開期間。
 */
async function assertReturnPeriodsOpen(
  tx: Db,
  label: string,
  id: number,
  doc: { docDate: string; certNo: string | null; certDate: string | null },
): Promise<void> {
  const through = await closedThrough(tx);
  if (!through) return;
  if (doc.docDate.slice(0, 7) <= through) {
    throw new AppError(
      409,
      "{label} {id} 的日期 {docDate} 屬於已關帳期間（帳務關至 {through}），作廢會回溯改掉該期間已定案的損益與庫存數字。請先到「報表」頁重開該期間",
      { label, id, docDate: doc.docDate, through },
    );
  }
  if (doc.certNo) {
    const effective = doc.certDate ?? doc.docDate;
    if (effective.slice(0, 7) <= through) {
      throw new AppError(
        409,
        "{label} {id} 的證明單 {certNo}（歸期 {effective}）屬於已關帳期間（帳務關至 {through}），作廢會把已申報期間的 401 減項抽走。請先到「報表」頁重開該期間，並同步處理已申報的 401",
        { label, id, certNo: doc.certNo, effective, through },
      );
    }
  }
}

/**
 * 反向回沖退回折讓單寫過的庫存異動（0030）：in→out、out→in，都用原單當時的成本快照——
 * 與 voidInventoryAdjustment 同一套。銷退作廢＝把回補的貨再沖出去（原 in → out，
 * 在庫不足 409：退回來的貨可能又賣掉了）；進退作廢＝把沖出的貨按原成本補回來（原 out → in）。
 * 銷貨端折讓沒寫過異動，這裡自然是空集合；進貨端折讓寫過 qty=0 的金額異動（沖 1301 帳面），
 * 一樣反向補回——分錄沖了、庫存明細帳不跟上，總帳與存貨明細會靜默對不起來。
 */
async function reverseReturnMovements(
  tx: Db,
  sourceType: "sale_return" | "purchase_return",
  returnId: number,
  label: string,
  /** 回沖異動的單據日期（0035）＝原退回折讓單日期，與反向傳票同日（已關帳期間在呼叫端已擋） */
  docDate: string,
): Promise<void> {
  const moves = await tx
    .select()
    .from(schema.inventoryMovements)
    .where(and(eq(schema.inventoryMovements.sourceType, sourceType), eq(schema.inventoryMovements.sourceId, returnId)));
  if (!moves.length) return;
  await lockProducts(tx, moves.map((m) => m.productId));
  // 原 in（銷退回補）要沖出去：數量與帳面金額都要夠（與進貨單作廢同一條規則）
  const needed = new Map<number, { qty: number; amount: number }>();
  for (const m of moves.filter((m) => m.direction === "in")) {
    const cur = needed.get(m.productId) ?? { qty: 0, amount: 0 };
    needed.set(m.productId, { qty: cur.qty + Number(m.qty), amount: cur.amount + m.amount });
  }
  for (const [productId, need] of needed) {
    const stock = await onHand(tx, productId);
    if (stock.qty < need.qty || stock.amount < need.amount) {
      const [product] = await tx.select().from(schema.products).where(eq(schema.products.id, productId));
      throw new AppError(
        409,
        "商品「{name}」目前在庫 {stockQty}（帳面 {stockAmount} 元），不足以沖回{label}回補的 {needQty}（{needAmount} 元）——退回來的貨可能已經再賣出。已賣出的部分沖不回來；若只是要修正金額，請重開一張正確的退回／折讓單",
        { name: product?.name ?? `#${productId}`, stockQty: stock.qty, stockAmount: stock.amount, label, needQty: need.qty, needAmount: need.amount },
      );
    }
  }
  await tx.insert(schema.inventoryMovements).values(
    moves.map((m) => ({
      productId: m.productId,
      direction: m.direction === "in" ? ("out" as const) : ("in" as const),
      qty: m.qty,
      unitCost: m.unitCost,
      amount: m.amount,
      sourceType,
      sourceId: returnId,
      docDate,
    })),
  );
}

/**
 * 作廢銷貨退回／折讓單（0030）：反向傳票＋庫存反向回沖＋標記。
 * 作廢後 returnable 餘量自動回復（priorSaleReturns 排除已作廢單）、401 減項與
 * G0401 批次同步排除；折讓單已登錄證明單號碼的，作廢後改產 G0501 作廢折讓證明單
 * （allowance-xml.ts saleAllowanceG0501——訊息內容全部可從本函式落的欄位重現）。
 */
export async function voidSaleReturn(db: Db, id: number, input: { reason: string }, userId: number) {
  return db.transaction(async (tx) => {
    const [doc] = await tx.select().from(schema.salesReturns).where(eq(schema.salesReturns.id, id)).for("update");
    if (!doc) throw new AppError(404, "銷貨退回／折讓單不存在: {id}", { id });
    const label = doc.kind === "return" ? "銷貨退回單" : "銷貨折讓單";
    assertNotVoided(label, id, doc);
    if (!doc.journalEntryId) throw new AppError(422, "{label} #{id} 沒有原始傳票，無法沖轉（資料異常，請聯絡管理者）", { label, id });
    await assertReturnPeriodsOpen(tx, label, id, doc);

    await reverseReturnMovements(tx, "sale_return", id, label, doc.docDate);
    const reversalEntryId = await insertReversalEntry(tx, doc.journalEntryId, {
      entryDate: doc.docDate,
      memo: `作廢沖轉 ${label} #${id}：${input.reason}`,
      sourceType: "sale_return",
      sourceId: id,
    });
    const [updated] = await tx
      .update(schema.salesReturns)
      .set({ voidedAt: new Date(), voidedBy: userId, voidReason: input.reason, reversalEntryId })
      .where(eq(schema.salesReturns.id, id))
      .returning();
    return { ...updated!, reversalEntryId };
  });
}

/** 作廢進貨退出／折讓單（0030）：與銷貨端對稱——退出的貨按原成本補回、折讓的 1301 帳面回復 */
export async function voidPurchaseReturn(db: Db, id: number, input: { reason: string }, userId: number) {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(schema.purchaseReturns)
      .where(eq(schema.purchaseReturns.id, id))
      .for("update");
    if (!doc) throw new AppError(404, "進貨退出／折讓單不存在: {id}", { id });
    const label = doc.kind === "return" ? "進貨退出單" : "進貨折讓單";
    assertNotVoided(label, id, doc);
    if (!doc.journalEntryId) throw new AppError(422, "{label} #{id} 沒有原始傳票，無法沖轉（資料異常，請聯絡管理者）", { label, id });
    await assertReturnPeriodsOpen(tx, label, id, doc);

    await reverseReturnMovements(tx, "purchase_return", id, label, doc.docDate);
    const reversalEntryId = await insertReversalEntry(tx, doc.journalEntryId, {
      entryDate: doc.docDate,
      memo: `作廢沖轉 ${label} #${id}：${input.reason}`,
      sourceType: "purchase_return",
      sourceId: id,
    });
    const [updated] = await tx
      .update(schema.purchaseReturns)
      .set({ voidedAt: new Date(), voidedBy: userId, voidReason: input.reason, reversalEntryId })
      .where(eq(schema.purchaseReturns.id, id))
      .returning();
    return { ...updated!, reversalEntryId };
  });
}

// ---------------------------------------------------------------- 期初應收付單

/**
 * 作廢期初應收付單（0030）：反向傳票沖轉開帳分錄——應收單原傳票是借 1144 貸 3351，
 * 反向即貸 1144 借 3351（應付單對稱：借 2144 貸 3351 的反向）。
 * - 已被有效收付款單立沖或預收/預付沖用 → 懸空 409（與銷貨／進貨同一條規則）：
 *   放行會讓沖銷列懸空，對象餘額變負。先作廢收付款單即可解鎖。
 * - 期初單不進 401 也不按期間申報（0023 檔頭），跨期沖轉可行——比照收付款單收 voidDate
 *   （未帶＝開帳日 entry_date；開帳期間已關就以開放期間的日期沖）。
 */
export async function voidOpeningBalance(db: Db, id: number, input: VoidInput, userId: number) {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(schema.openingBalances)
      .where(eq(schema.openingBalances.id, id))
      .for("update");
    if (!doc) throw new AppError(404, "期初應收／應付單不存在: {id}", { id });
    const label = doc.kind === "receivable" ? "期初應收單" : "期初應付單";
    assertNotVoided(label, id, doc);
    if (!doc.journalEntryId) throw new AppError(422, "{label} #{id} 沒有原始傳票，無法沖轉（資料異常，請聯絡管理者）", { label, id });
    await assertNotSettledByCashDoc(tx, "opening", id, label);

    const reversalDate = input.voidDate ?? doc.entryDate;
    await assertReversalDateOpen(tx, reversalDate, doc.entryDate);
    const reversalEntryId = await insertReversalEntry(tx, doc.journalEntryId, {
      entryDate: reversalDate,
      memo: `作廢沖轉 ${label} #${id}：${input.reason}`,
      sourceType: "opening",
      sourceId: id,
    });
    const [updated] = await tx
      .update(schema.openingBalances)
      .set({ voidedAt: new Date(), voidedBy: userId, voidReason: input.reason, reversalEntryId })
      .where(eq(schema.openingBalances.id, id))
      .returning();
    return { ...updated!, reversalEntryId };
  });
}

// ---------------------------------------------------------------- 固定資產（0031，B14）

/**
 * 作廢固定資產登錄（登錄打錯：成本多一個零、類別選錯、根本不存在的資產）。
 * 登錄不拋轉取得傳票（assets.ts 檔頭的刻意設計），所以與報價單同型——直接標記、沒有反向傳票。
 * - 已提折舊 → 409 指路處分：折舊傳票是帳上的真實軌跡，「登錄錯誤」在第一張折舊傳票
 *   落地後就不成立了。要下帳走處分（價款 0＝報廢），折舊差額以手工傳票調整。
 * - 已處分 → 409：帳已沖轉。處分本身是誤操作的話先作廢處分（資產回到使用中）。
 * - 作廢後 runDepreciation／月結檢查／處分一律排除這筆資產。
 */
export async function voidFixedAsset(db: Db, id: number, input: { reason: string }, userId: number) {
  return db.transaction(async (tx) => {
    const [asset] = await tx.select().from(schema.fixedAssets).where(eq(schema.fixedAssets.id, id)).for("update");
    if (!asset) throw new AppError(404, "資產不存在: {id}", { id });
    assertNotVoided("資產", id, asset);
    if (asset.status === "disposed") {
      throw new AppError(
        409,
        "資產 #{id}（{name}）已於 {date} 處分，帳已沖轉，不可作廢登錄。若處分本身是誤操作，請先「作廢處分」（資產會回到使用中）；確認登錄也有誤時再作廢資產",
        { id, name: asset.name, date: asset.disposedAt ?? "?" },
      );
    }
    const deps = await tx.select().from(schema.assetDepreciations).where(eq(schema.assetDepreciations.assetId, id));
    if (deps.length > 0) {
      const accumulated = deps.reduce((s, d) => s + d.amount, 0);
      throw new AppError(
        409,
        "資產 #{id}（{name}）已提折舊 {periods} 期（累計 {accumulated} 元），不可作廢——折舊傳票是帳上的真實軌跡，作廢登錄會讓它們無從解釋。要讓這筆資產下帳，請走「處分」（價款 0＝報廢）；折舊金額有誤的部分請以手工傳票調整",
        { id, name: asset.name, periods: deps.length, accumulated },
      );
    }
    const [updated] = await tx
      .update(schema.fixedAssets)
      .set({ voidedAt: new Date(), voidedBy: userId, voidReason: input.reason })
      .where(eq(schema.fixedAssets.id, id))
      .returning();
    return updated!;
  });
}

/**
 * 作廢資產處分（處分是誤操作：日期／價款打錯、根本沒賣）：反向傳票沖回處分損益、
 * 累計折舊、價款與銷項稅額（原處分傳票借貸互換），資產回到 active 繼續提折舊。
 * - 處分時補提的折舊**留著**：那是資產真實存在期間的折舊，被作廢的是「賣掉」這件事。
 * - 關帳鎖與銷貨單同一嚴格度：處分損益與銷項稅額依處分日歸期，原處分日所屬期間已關
 *   → 409、不收 voidDate，出路是重開期間。
 * - disposed_at／disposal_entry_id 保留當軌跡；之後再處分會覆寫（完整歷程都在傳票上）。
 * - 處分已開立發票（0034）→ 409 指路先作廢發票：與銷貨單同一條規則——發票是對外開出去的
 *   憑證，處分不能先於憑證消失（發票作廢時可勾選連動沖回處分，走 voidAssetDisposalCore）。
 */
export async function voidAssetDisposal(db: Db, id: number, input: { reason: string }, userId: number) {
  return db.transaction(async (tx) => {
    const [issued] = await tx
      .select({ invoiceNumber: schema.invoices.invoiceNumber })
      .from(schema.invoices)
      .where(and(eq(schema.invoices.assetId, id), eq(schema.invoices.status, "issued")));
    if (issued) {
      throw new AppError(
        409,
        "資產 #{id} 的處分已開立發票 {invoiceNumber} 且未作廢，不可直接作廢處分。請先到「電子發票」頁作廢該發票（作廢時可勾選連動沖回處分）",
        { id, invoiceNumber: issued.invoiceNumber },
      );
    }
    return voidAssetDisposalCore(tx, id, input, userId);
  });
}

/**
 * 作廢處分的共用核心（0034 起兩個入口）：獨立作廢（POST /fixed-assets/:id/dispose/void）
 * 與處分發票作廢連動（invoices.ts cancelInvoice 的 reverseDisposal）。
 * 發票狀態的把關在各自的呼叫端——獨立作廢要求先廢發票；連動路徑的發票在同一交易內已標作廢。
 */
export async function voidAssetDisposalCore(tx: Db, id: number, input: { reason: string }, userId: number | null) {
  const [asset] = await tx.select().from(schema.fixedAssets).where(eq(schema.fixedAssets.id, id)).for("update");
  if (!asset) throw new AppError(404, "資產不存在: {id}", { id });
  if (asset.status !== "disposed") {
    throw new AppError(
      409,
      "資產 #{id}（{name}）目前不是已處分狀態，沒有可作廢的處分{prev}",
      {
        id,
        name: asset.name,
        prev: asset.disposalVoidedAt
          ? `（上一次處分已於 ${asset.disposalVoidedAt.toISOString().slice(0, 10)} 作廢，理由：${asset.disposalVoidReason ?? "未記錄"}）`
          : "",
      },
    );
    }
    if (!asset.disposalEntryId || !asset.disposedAt) {
      throw new AppError(422, "資產 #{id} 沒有處分傳票，無法沖轉（資料異常，請聯絡管理者）", { id });
    }
    const through = await closedThrough(tx);
    if (through && asset.disposedAt.slice(0, 7) <= through) {
      throw new AppError(
        409,
        "資產 #{id} 的處分日 {date} 屬於已關帳期間（帳務關至 {through}），作廢會回溯改掉該期已定案的處分損益與銷項稅額。請先到「報表」頁重開該期間",
        { id, date: asset.disposedAt, through },
      );
    }
    const reversalEntryId = await insertReversalEntry(tx, asset.disposalEntryId, {
      entryDate: asset.disposedAt,
      memo: `作廢沖轉 資產處分 #${id}（${asset.name}）：${input.reason}`,
      sourceType: "disposal",
      sourceId: id,
    });
    const [updated] = await tx
      .update(schema.fixedAssets)
      .set({
        status: "active",
        disposalReversalEntryId: reversalEntryId,
        disposalVoidedAt: new Date(),
        disposalVoidedBy: userId,
        disposalVoidReason: input.reason,
      })
      .where(eq(schema.fixedAssets.id, id))
      .returning();
    return { ...updated!, reversalEntryId };
}

// ---------------------------------------------------------------- 報價單

/**
 * 作廢報價單：未拋轉傳票，直接標記。與「失單」(lost) 是兩件事——
 * 失單是客戶沒成交（成交率的分母），作廢是單子本身建錯（不該進任何統計）。
 * open 與 lost 都可作廢；won（已轉訂單）不可——訂單已經帶著這份金額在跑。
 */
export async function voidQuote(db: Db, id: number, input: { reason: string }, userId: number) {
  return db.transaction(async (tx) => {
    const [quote] = await tx.select().from(schema.quotes).where(eq(schema.quotes.id, id)).for("update");
    if (!quote) throw new AppError(404, "報價單不存在: {id}", { id });
    assertNotVoided("報價單", id, quote);
    if (quote.status === "won") {
      throw new AppError(
        409,
        "報價單 {id} 已成交並轉為訂單 #{orderId}，不可作廢。要取消這筆交易請先處理訂單（未出貨可取消；已出貨請作廢銷貨單或開退回單）",
        { id, orderId: quote.orderId ?? "?" },
      );
    }
    const [updated] = await tx
      .update(schema.quotes)
      .set({ voidedAt: new Date(), voidedBy: userId, voidReason: input.reason })
      .where(eq(schema.quotes.id, id))
      .returning();
    return updated!;
  });
}

// ---------------------------------------------------------------- 報銷單（0036，R11）

/**
 * 作廢報銷單：反向傳票沖回核准傳票（已付款的連付款傳票一起沖）＋標記。
 * status 保持原值（「它曾被核准」是事實）；401 與彙總以 voided_at 排除。
 * 手工反向傳票救不了 401（vat.ts 的進項直接 join expense_items，不讀總帳）——
 * 這正是這個入口存在的理由：多打一個 0 的單被核准後，唯一能同時修正總帳與 401 的路。
 *
 * 關帳鎖走**嚴格**的那一種（同銷貨／進貨，見檔頭）：401 的報銷進項依**發票日期**歸期，
 * 核准傳票依單據日入帳，付款傳票依付款日——三種日期任何一個落在已關帳期間，
 * 作廢都會回溯改掉（可能已申報／已出表的）該期數字，一律 409 指路重開期間。
 * 不收 voidDate：跨期沖轉救得了總帳、救不了 401（發票的歸期不會跟著 voidDate 走）。
 */
export async function voidExpenseClaim(db: Db, id: number, input: { reason: string }, userId: number) {
  return db.transaction(async (tx) => {
    const [claim] = await tx.select().from(schema.expenseClaims).where(eq(schema.expenseClaims.id, id)).for("update");
    if (!claim) throw new AppError(404, "報銷單不存在: {id}", { id });
    assertNotVoided("報銷單", id, claim);
    if (claim.status === "submitted" || claim.status === "rejected") {
      throw new AppError(
        409,
        "報銷單 #{id} 尚未核准（{state}），沒有傳票可沖。{hint}",
        {
          id,
          state: claim.status === "submitted" ? "送審中" : "已退回",
          hint: claim.status === "submitted" ? "送審中的單請用「退回」" : "被退回的單可直接修改重送，或放著不管",
        },
      );
    }
    if (!claim.journalEntryId) throw new AppError(422, "報銷單 #{id} 無原始傳票，無法沖轉（資料異常，請聯絡管理者）", { id });

    const through = await closedThrough(tx);
    const assertOpen = (date: string, label: string) => {
      if (through && date.slice(0, 7) <= through) {
        throw new AppError(
          409,
          "報銷單 #{id} 的{label} {date} 屬於已關帳期間（帳務關至 {through}），作廢會回溯改掉該期間（可能已申報）的數字。請先到「報表」頁重開該期間",
          { id, label, date, through },
        );
      }
    };
    assertOpen(claim.claimDate, "單據日期");
    // 可扣抵明細以發票日期進 401（services/vat.ts）：發票落在已關期間的，該期扣抵已定案
    const items = await tx.select().from(schema.expenseItems).where(eq(schema.expenseItems.claimId, id));
    for (const item of items) {
      if (item.deductible && item.invoiceDate) assertOpen(item.invoiceDate, `可扣抵發票（${item.invoiceNumber ?? "?"}）日期`);
    }

    const reversalEntryId = await insertReversalEntry(tx, claim.journalEntryId, {
      entryDate: claim.claimDate,
      memo: `作廢沖轉 報銷單 #${id}：${input.reason}`,
      sourceType: "expense",
      sourceId: id,
    });
    // 已付款（員工代墊的兩段式）：付款傳票也要沖，否則現金沖回來了、2201 卻留著負餘額。
    // 公司支付的單 paidJournalEntryId 與 journalEntryId 是同一張，沖一次就夠
    let paidReversalEntryId: number | null = null;
    if (claim.paidJournalEntryId && claim.paidJournalEntryId !== claim.journalEntryId) {
      const [payEntry] = await tx
        .select()
        .from(schema.journalEntries)
        .where(eq(schema.journalEntries.id, claim.paidJournalEntryId));
      if (payEntry) assertOpen(payEntry.entryDate, "付款日期");
      paidReversalEntryId = await insertReversalEntry(tx, claim.paidJournalEntryId, {
        entryDate: payEntry?.entryDate ?? claim.claimDate,
        memo: `作廢沖轉 報銷單 #${id} 的付款：${input.reason}`,
        sourceType: "expense",
        sourceId: id,
      });
    }
    const [updated] = await tx
      .update(schema.expenseClaims)
      .set({ voidedAt: new Date(), voidedBy: userId, voidReason: input.reason, reversalEntryId, paidReversalEntryId })
      .where(eq(schema.expenseClaims.id, id))
      .returning();
    return updated!;
  });
}
