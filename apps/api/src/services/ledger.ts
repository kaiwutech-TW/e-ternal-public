/**
 * 帳務完整性批次：手工傳票、收付款單（沖應收/應付）、庫存開帳、資產負債表/損益表。
 * 缺口依據：docs/gap-analysis-2607.md 第一層（市售 ERP 標配、記帳士門檻）。
 */
import { ACCOUNT, assertBalanced, type EntryLine } from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { partnerBalanceMaps, settlementMaps } from "./balances.ts";
import { assertNotFarFuture } from "./dates.ts";
import type { ListFilter, ListResult } from "./list.ts";
import { assertPeriodOpen } from "./period.ts";
import { apOffsetByPurchase, arOffsetBySale } from "./returns.ts";

export interface ManualEntryInput {
  entryDate: string; // YYYY-MM-DD
  memo: string;
  /** 行摘要選填（0038）：單頭 memo 是「這張傳票為什麼存在」，行 memo 是「這一行在動什麼」 */
  lines: Array<EntryLine & { memo?: string | undefined }>;
}

export async function createManualEntry(db: Db, input: ManualEntryInput) {
  try {
    assertBalanced(input.lines);
  } catch (e) {
    throw new AppError(400, (e as Error).message);
  }
  return db.transaction(async (tx) => {
    // R2：年份打錯的未來傳票當場擋下（過去日期不擋——補登歷史分錄是正常作業）
    assertNotFarFuture(input.entryDate, "傳票日期");
    await assertPeriodOpen(tx, input.entryDate);
    const accounts = await tx.select().from(schema.accounts);
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const codeToId = new Map(accounts.map((a) => [a.code, a.id]));
    for (const l of input.lines) {
      const account = byCode.get(l.accountCode);
      if (!account) throw new AppError(422, "科目不存在: {code}", { code: l.accountCode });
      // 停用的科目不得再過帳，否則「停用」只是把下拉選單藏起來：手打代號或程式化呼叫照樣入得進去，
      // 而使用者以為這個科目已經封存（既有分錄與餘額仍完整保留，這裡擋的只有「新增」）。
      if (!account.active) {
        throw new AppError(400, "科目已停用，不可再過帳: {code} {name}（請改用其他科目，或先啟用它）", { code: account.code, name: account.name });
      }
    }
    const [entry] = await tx
      .insert(schema.journalEntries)
      .values({ entryDate: input.entryDate, memo: input.memo, sourceType: "manual", sourceId: null })
      .returning();
    await tx.insert(schema.journalLines).values(
      input.lines.map((l) => ({
        entryId: entry!.id,
        accountId: codeToId.get(l.accountCode)!,
        debit: l.debit,
        credit: l.credit,
        memo: l.memo?.trim() ?? "",
      })),
    );
    return entry!;
  });
}

/**
 * 傳票清單（含借方合計），新到舊。R3 起收 ListFilter（from/to/limit/offset）並回總筆數；
 * 借方合計只查頁內傳票的分錄——原本每次開頁把整張 journal_lines（全系統最大的表）搬回來加總。
 */
export async function listJournalEntries(
  db: Db,
  f: ListFilter,
): Promise<ListResult<typeof schema.journalEntries.$inferSelect & { totalDebit: number }>> {
  const where = and(
    f.from ? gte(schema.journalEntries.entryDate, f.from) : undefined,
    f.to ? lte(schema.journalEntries.entryDate, f.to) : undefined,
  );
  const [agg] = await db.select({ total: count() }).from(schema.journalEntries).where(where);
  const entries = await db
    .select()
    .from(schema.journalEntries)
    .where(where)
    .orderBy(desc(schema.journalEntries.entryDate), desc(schema.journalEntries.id))
    .limit(f.limit)
    .offset(f.offset);
  const ids = entries.map((e) => e.id);
  const lines = ids.length
    ? await db
        .select({ entryId: schema.journalLines.entryId, debit: schema.journalLines.debit })
        .from(schema.journalLines)
        .where(inArray(schema.journalLines.entryId, ids))
    : [];
  const totalByEntry = new Map<number, number>();
  for (const l of lines) totalByEntry.set(l.entryId, (totalByEntry.get(l.entryId) ?? 0) + l.debit);
  return { rows: entries.map((e) => ({ ...e, totalDebit: totalByEntry.get(e.id) ?? 0 })), total: agg!.total };
}

export interface CashDocInput {
  kind: "receipt" | "payment";
  partnerId: number;
  docDate: string;
  amount: number; // 整數元
  accountId: number; // 收付使用的現金/銀行科目
  memo?: string | undefined;
  /**
   * 立沖：指定沖銷哪些銷貨（收款）/進貨（付款）單；未指定部分為對象層級（帳齡以 FIFO 補沖）。
   * targetType 未帶＝收款沖銷貨、付款沖進貨（0023 前的舊行為）；'opening'＝沖期初應收付單。
   */
  allocations?: { targetId: number; amount: number; targetType?: "sale" | "purchase" | "opening" | undefined }[] | undefined;
}

/**
 * 某對象的未沖單據（供立沖 UI 勾選）：remaining > 0 的銷貨/進貨，
 * 加上期初應收付單（0023，B6：既有公司的舊欠款也要能在收款畫面勾到）。
 * docType 區分單據來源——sale/purchase/opening 各自是獨立的 id 空間，沖銷必須帶著它。
 *
 * remaining 的口徑（R6 統一，與帳齡同一套）＝退回後淨額 − 已立沖 − FIFO 分攤：
 * 未指定沖銷的收付款餘額（settlementMaps 的 pool）依日期沖最舊的單。修正前這裡
 * 只認立沖紀錄——客戶匯了 200,000 沒立沖，清單仍顯示每張單全額未沖，
 * 會計照它開下一張收款單就會再收一次（帳齡與 partner-balances 早就說沖掉了）。
 */
export async function openDocuments(
  db: Db,
  partnerId: number,
  kind: "receipt" | "payment",
  asOf?: string,
) {
  return (await openDocumentsAll(db, partnerId, kind, asOf)).filter((d) => d.remaining > 0);
}

/**
 * openDocuments 的不過濾版本：沖畢（remaining ≤ 0）的單也列。
 * 收付款單詳細（getCashDoc）要顯示「沖了哪幾張、那些單現在還剩多少」，
 * 被沖畢的單若被過濾掉就對不到明細了。
 */
export async function openDocumentsAll(
  db: Db,
  partnerId: number,
  kind: "receipt" | "payment",
  asOf?: string,
) {
  const targetType = kind === "receipt" ? ("sale" as const) : ("purchase" as const);
  // R2：帶 asOf（收付款日）時，日期晚於 asOf 的單據不列——1/15 的收款沖不到 6/8 的銷貨。
  // 修正前只有退回沖銷按 asOf 篩，單據本身不篩，於是那筆錢在兩個日期之間從帳齡表整個消失
  //（收款日視角已沖、單據日視角未收，同日資產負債表 1144 還會是負的）
  const docs =
    kind === "receipt"
      ? await db
          .select({ id: schema.sales.id, docDate: schema.sales.docDate, total: schema.sales.total })
          .from(schema.sales)
          .where(
            and(
              eq(schema.sales.partnerId, partnerId),
              isNull(schema.sales.reversalEntryId),
              asOf ? lte(schema.sales.docDate, asOf) : undefined,
            ),
          )
      : await db
          .select({ id: schema.purchases.id, docDate: schema.purchases.docDate, total: schema.purchases.total })
          .from(schema.purchases)
          // 已作廢進貨單（0025）不再是可沖銷的應付對象
          .where(
            and(
              eq(schema.purchases.partnerId, partnerId),
              isNull(schema.purchases.voidedAt),
              asOf ? lte(schema.purchases.docDate, asOf) : undefined,
            ),
          );
  const openings = await db
    .select()
    .from(schema.openingBalances)
    .where(
      and(
        eq(schema.openingBalances.partnerId, partnerId),
        eq(schema.openingBalances.kind, kind === "receipt" ? "receivable" : "payable"),
        // 已作廢期初單（0030）不再是可沖銷對象
        isNull(schema.openingBalances.voidedAt),
        asOf ? lte(schema.openingBalances.docDate, asOf) : undefined,
      ),
    );
  // 立沖與 FIFO pool 一律取自 balances.ts 的 settlementMaps（帳齡吃同一份）：
  // 收付款單與事後沖用都以 asOf 為基準——修正前這裡的立沖合計不看日期，
  // 一張未來日期的沖用會讓某張單在今天的清單上提早消失，與帳齡矛盾
  const maps = await settlementMaps(db, kind, asOf, partnerId);
  // 退回沖銷以「收付款日」為基準（asOf），不是以「現在」。不篩日期有兩個後果——
  // ①與帳齡表（依基準日篩）在同一時點互相矛盾
  // ②客戶今天把錢匯來，卻因為系統裡有一張未來日期的退回單而顯示已沖畢，當天收不了款
  const returned =
    kind === "receipt" ? await arOffsetBySale(db, asOf) : await apOffsetByPurchase(db, asOf);
  const rows = [
    ...docs.map((d) => {
      const net = d.total - (returned.get(d.id) ?? 0);
      return {
        docType: targetType as "sale" | "purchase" | "opening",
        id: d.id,
        docDate: d.docDate,
        total: net,
        returned: returned.get(d.id) ?? 0,
        allocated: maps.allocatedByDoc.get(d.id) ?? 0,
        fifoApplied: 0,
        remaining: 0,
      };
    }),
    // 期初單沒有退回的概念（原單不在系統裡，退貨請照正式退回流程沖一般應收）
    ...openings.map((o) => ({
      docType: "opening" as const,
      id: o.id,
      docDate: o.docDate,
      total: o.amount,
      returned: 0,
      allocated: maps.allocatedByOpening.get(o.id) ?? 0,
      fifoApplied: 0,
      remaining: 0,
    })),
  ].sort((a, b) => a.docDate.localeCompare(b.docDate) || a.id - b.id);
  // FIFO：未指定沖銷的收付款餘額沖最舊的單（與帳齡同一條規則；同日的先後以排序為準，
  // 對象層級的合計不受先後影響）。pool 沖完仍有剩＝罕見殘餘（帳齡列在 credit 欄）
  let pool = maps.unallocatedByPartner.get(partnerId) ?? 0;
  for (const d of rows) {
    d.fifoApplied = Math.min(pool, Math.max(0, d.total - d.allocated));
    pool -= d.fifoApplied;
    d.remaining = d.total - d.allocated - d.fifoApplied;
  }
  return rows;
}

/**
 * 立沖目標找不到時的補充診斷（R2）：若目標其實存在、只是單據日期晚於本次的沖銷基準日，
 * 訊息要點名那兩個日期——只回「不存在、非本對象或已沖畢」會讓使用者
 * 對著一張明明在清單上的單發呆（它只是日期比收款日晚，被基準日篩掉了）。
 */
async function assertAllocTargetNotLater(
  db: Db,
  partnerId: number,
  kind: "receipt" | "payment",
  a: { targetType: "sale" | "purchase" | "opening"; targetId: number },
  asOf: string,
  asOfLabel: string,
  label: string,
): Promise<void> {
  const later = (await openDocumentsAll(db, partnerId, kind)).find(
    (d) => d.docType === a.targetType && d.id === a.targetId && d.docDate > asOf,
  );
  if (later) {
    throw new AppError(
      422,
      "{label} 的單據日期（{docDate}）晚於{asOfLabel}（{asOf}）——不能沖銷日期在後面的單據。請把{asOfLabel}改成不早於 {docDate}，或先不指定沖銷這張單（沖不掉的部分會掛預收/預付，之後可再沖用）",
      { label, docDate: later.docDate, asOfLabel, asOf },
    );
  }
}

/** 收款單：借 現金/銀行、貸 應收帳款；付款單：借 應付帳款、貸 現金/銀行 */
export async function createCashDoc(db: Db, input: CashDocInput) {
  return db.transaction(async (tx) => {
    // R2：年份打錯的未來收付款當場擋下（過去日期不擋——補登歷史收付是正常作業）
    assertNotFarFuture(input.docDate, input.kind === "receipt" ? "收款日期" : "付款日期");
    await assertPeriodOpen(tx, input.docDate);
    const [partner] = await tx.select().from(schema.partners).where(eq(schema.partners.id, input.partnerId));
    if (!partner) throw new AppError(404, "交易對象不存在: {id}", { id: input.partnerId });
    if (input.kind === "receipt" && !partner.isCustomer) throw new AppError(422, "非客戶: {name}", { name: partner.name });
    if (input.kind === "payment" && !partner.isSupplier) throw new AppError(422, "非供應商: {name}", { name: partner.name });

    // 立沖驗證：加總不得超過收付金額；單筆不得超過該單據未沖餘額；單據須屬同一對象。
    // targetType 未帶＝沖銷貨/進貨（舊行為）；sale 與 opening 是各自的 id 空間，鍵必須含型別
    const defaultTargetType = input.kind === "receipt" ? ("sale" as const) : ("purchase" as const);
    const allocations = (input.allocations ?? []).map((a) => ({
      ...a,
      targetType: a.targetType ?? defaultTargetType,
    }));
    const open = await openDocuments(tx, input.partnerId, input.kind, input.docDate);
    if (allocations.length) {
      const sum = allocations.reduce((s, a) => s + a.amount, 0);
      if (sum > input.amount) throw new AppError(422, "沖銷合計 {sum} 超過收付金額 {amount}", { sum, amount: input.amount });
      const openByKey = new Map(open.map((d) => [`${d.docType}:${d.id}`, d]));
      for (const a of allocations) {
        if (a.amount <= 0) throw new AppError(422, "沖銷金額須為正整數");
        const label = a.targetType === "opening" ? `期初單 #${a.targetId}` : `單據 #${a.targetId}`;
        const target = openByKey.get(`${a.targetType}:${a.targetId}`);
        if (!target) {
          await assertAllocTargetNotLater(
            tx, input.partnerId, input.kind, a, input.docDate,
            input.kind === "receipt" ? "收款日期" : "付款日期", label,
          );
          throw new AppError(422, "{label} 不存在、非本對象或已沖畢", { label });
        }
        if (a.amount > target.remaining) {
          throw new AppError(422, "{label} 未沖餘額 {remaining}，欲沖 {amount}", { label, remaining: target.remaining, amount: a.amount });
        }
      }
    }

    // 溢收／溢付（0027，B9）：超過「該對象還欠多少」的部分不沖應收/應付——
    // 收款掛 2231 預收款項（負債）、付款掛 1212 預付貨款（資產），應收/應付不為負。
    // 以對象的未沖總額為界，而不是只看本次指定沖銷：未指定沖銷的部分仍是對象層級
    // 的應收/應付沖抵（帳齡 FIFO 補沖），只有整個對象都沖不掉的餘額才是預收/預付。
    // openDocuments 的 remaining 已含「先前未指定沖銷的收付款 FIFO 沖最舊」（R6 統一口徑，
    // balances.ts），直接加總就是「該對象還欠多少」——不再另算一套 priorUnallocated。
    // pool 以本單日期為基準（與上面立沖驗證同一個 asOf）：日期晚於本單的收付款
    // 不影響本單的溢收切分，unapplied 是建單當下的單據事實（0027 檔頭）
    const outstanding = open.reduce((s, d) => s + d.remaining, 0);
    const unapplied = Math.max(0, input.amount - outstanding);

    const accounts = await tx.select().from(schema.accounts);
    const cashAccount = accounts.find((a) => a.id === input.accountId);
    if (!cashAccount) throw new AppError(404, "科目不存在: {id}", { id: input.accountId });
    // 必須是「現金科目」而不只是資產類：現金流量表只認 is_cash 的科目，
    // 收款記進非現金資產（例如建了銀行科目卻忘了勾現金）會讓這筆錢出現在資產負債表與試算表，
    // 卻從現金流量表與儀表板現金水位整筆消失，兩張表對不起來且毫無徵兆。
    if (!cashAccount.isCash) {
      throw new AppError(
        422,
        "{code} {name} 不是現金科目，不能當收付科目（若這是銀行帳戶，請到「會計科目」頁把它勾選為現金科目，收付的錢才會進現金流量表）",
        { code: cashAccount.code, name: cashAccount.name },
      );
    }
    // 與手工傳票同一條規則：停用的科目不得再過帳。內建的 1101/1103 是系統科目停不掉，
    // 但使用者自建的銀行科目（例如「銀行存款－玉山」）停用後仍可用 id 指定，這裡一併擋下。
    if (!cashAccount.active) {
      throw new AppError(400, "科目已停用，不可再過帳: {code} {name}", { code: cashAccount.code, name: cashAccount.name });
    }
    const arId = accounts.find((a) => a.code === ACCOUNT.ACCOUNTS_RECEIVABLE)?.id;
    const apId = accounts.find((a) => a.code === ACCOUNT.ACCOUNTS_PAYABLE)?.id;
    if (!arId || !apId) throw new AppError(500, "應收/應付科目未初始化");
    const advanceId = accounts.find((a) => a.code === ACCOUNT.ADVANCE_RECEIPT)?.id;
    const prepayId = accounts.find((a) => a.code === ACCOUNT.PREPAYMENT)?.id;
    if (!advanceId || !prepayId) throw new AppError(500, "預收/預付科目未初始化");

    const memo =
      input.memo?.trim() ||
      (input.kind === "receipt" ? `收款單 - ${partner.name}` : `付款單 - ${partner.name}`);
    const [doc] = await tx
      .insert(schema.cashDocs)
      .values({
        kind: input.kind,
        partnerId: input.partnerId,
        docDate: input.docDate,
        amount: input.amount,
        accountId: input.accountId,
        memo,
        unappliedAmount: unapplied,
      })
      .returning();
    const [entry] = await tx
      .insert(schema.journalEntries)
      .values({ entryDate: input.docDate, memo, sourceType: input.kind, sourceId: doc!.id })
      .returning();
    // 沖抵應收/應付的部分＝金額 − 溢收溢付；兩者任一為 0 就不落那一行（0 元分錄沒有資訊）
    const settled = input.amount - unapplied;
    const journalLines = (
      input.kind === "receipt"
        ? [
            { accountId: input.accountId, debit: input.amount, credit: 0 },
            { accountId: arId, debit: 0, credit: settled },
            { accountId: advanceId, debit: 0, credit: unapplied },
          ]
        : [
            { accountId: apId, debit: settled, credit: 0 },
            { accountId: prepayId, debit: unapplied, credit: 0 },
            { accountId: input.accountId, debit: 0, credit: input.amount },
          ]
    )
      .filter((l) => l.debit + l.credit > 0)
      .map((l) => ({ ...l, entryId: entry!.id }));
    await tx.insert(schema.journalLines).values(journalLines);
    if (allocations.length) {
      await tx.insert(schema.cashDocAllocations).values(
        allocations.map((a) => ({
          cashDocId: doc!.id,
          targetType: a.targetType,
          targetId: a.targetId,
          amount: a.amount,
        })),
      );
    }
    await tx.update(schema.cashDocs).set({ journalEntryId: entry!.id }).where(eq(schema.cashDocs.id, doc!.id));
    return { ...doc!, journalEntryId: entry!.id, allocations };
  });
}

/**
 * 某對象仍有預收（收款單）/預付（付款單）餘額的收付款單（0027，B9）。
 * remaining ＝建單時掛 2231/1212 的金額 − 事後已沖用合計；已作廢單不計
 * （作廢的反向傳票已把 2231/1212 沖回，餘額當然歸零）。
 */
export async function prepaidDocs(db: Db, partnerId: number, kind: "receipt" | "payment") {
  const docs = await db
    .select()
    .from(schema.cashDocs)
    .where(
      and(
        eq(schema.cashDocs.partnerId, partnerId),
        eq(schema.cashDocs.kind, kind),
        isNull(schema.cashDocs.voidedAt),
        gt(schema.cashDocs.unappliedAmount, 0),
      ),
    )
    .orderBy(asc(schema.cashDocs.docDate), asc(schema.cashDocs.id));
  if (!docs.length) return [];
  const apps = await db
    .select()
    .from(schema.cashDocAllocations)
    .where(
      and(
        eq(schema.cashDocAllocations.fromPrepaid, true),
        inArray(schema.cashDocAllocations.cashDocId, docs.map((d) => d.id)),
      ),
    );
  const appliedBy = new Map<number, number>();
  for (const a of apps) appliedBy.set(a.cashDocId, (appliedBy.get(a.cashDocId) ?? 0) + a.amount);
  return docs
    .map((d) => ({
      id: d.id,
      docDate: d.docDate,
      memo: d.memo,
      unapplied: d.unappliedAmount,
      applied: appliedBy.get(d.id) ?? 0,
      remaining: d.unappliedAmount - (appliedBy.get(d.id) ?? 0),
    }))
    .filter((d) => d.remaining > 0);
}

/**
 * 收付款單詳細（R6）：沖了哪幾張單、各沖多少、那些單現在還剩多少。
 * 修正前立沖關係只在建立當下回應一次，之後 GET /cash-docs 原表直出、/cash-docs/:id 404——
 * 客戶打來問「7 月匯的那 30,240 是付哪張單」，畫面上查不到。
 *
 * targetRemaining 用「當下」口徑（不帶 asOf 的 openDocumentsAll，含 FIFO）；
 * null＝目標單已作廢/沖銷，不在可沖清單裡（立沖紀錄照列，是軌跡）。
 * 對外形狀白名單：逐欄挑選，不直出資料列。
 */
export async function getCashDoc(db: Db, id: number) {
  const [doc] = await db.select().from(schema.cashDocs).where(eq(schema.cashDocs.id, id));
  if (!doc) throw new AppError(404, "收付款單不存在: {id}", { id });
  const [partner] = await db.select().from(schema.partners).where(eq(schema.partners.id, doc.partnerId));
  const allocs = await db
    .select()
    .from(schema.cashDocAllocations)
    .where(eq(schema.cashDocAllocations.cashDocId, id))
    .orderBy(asc(schema.cashDocAllocations.id));
  const targets = await openDocumentsAll(db, doc.partnerId, doc.kind);
  const byKey = new Map(targets.map((d) => [`${d.docType}:${d.id}`, d]));
  const prepaidApplied = allocs.filter((a) => a.fromPrepaid).reduce((s, a) => s + a.amount, 0);
  return {
    id: doc.id,
    kind: doc.kind,
    partnerId: doc.partnerId,
    partnerName: partner?.name ?? `#${doc.partnerId}`,
    docDate: doc.docDate,
    amount: doc.amount,
    accountId: doc.accountId,
    memo: doc.memo,
    journalEntryId: doc.journalEntryId,
    unappliedAmount: doc.unappliedAmount,
    // 預收/預付還剩多少可沖用；已作廢＝反向傳票已把 2231/1212 沖回，剩 0
    prepaidRemaining: doc.voidedAt ? 0 : doc.unappliedAmount - prepaidApplied,
    voidedAt: doc.voidedAt,
    voidReason: doc.voidReason,
    reversalEntryId: doc.reversalEntryId,
    // 立沖與事後沖用明細（作廢單的紀錄照列——軌跡；彙總早已以 voided_at 排除）
    allocations: allocs.map((a) => {
      const target = byKey.get(`${a.targetType}:${a.targetId}`);
      return {
        targetType: a.targetType,
        targetId: a.targetId,
        amount: a.amount,
        fromPrepaid: a.fromPrepaid,
        allocDate: a.allocDate, // 事後沖用日；建立時立沖為 null（那筆含在本單原傳票裡）
        journalEntryId: a.journalEntryId, // 事後沖用自己的傳票；立沖為 null
        targetDocDate: target?.docDate ?? null,
        targetTotal: target?.total ?? null, // 退回後淨額
        targetRemaining: target ? target.remaining : null, // 該單當下未沖餘額（含 FIFO 口徑）
      };
    }),
  };
}

export interface ApplyPrepaidInput {
  applyDate: string; // YYYY-MM-DD，受關帳鎖
  allocations: { targetId: number; amount: number; targetType?: "sale" | "purchase" | "opening" | undefined }[];
}

/**
 * 用收付款單的預收/預付餘額沖銷之後的單據（0027，B9）。
 * 與建立收付款單的立沖同一套驗證（同對象、單筆不超過目標未沖餘額），
 * 差別在這裡要生自己的傳票：收款側借 2231 貸 1144（「欠客戶的貨」轉為「沖掉客戶欠款」）、
 * 付款側借 2144 貸 1212。沖用日受關帳鎖；沖用列（from_prepaid）落在既有 allocations 表，
 * 之後這些目標單據的未沖餘額計算（allocatedByTarget）自動涵蓋。
 */
export async function applyPrepaid(db: Db, cashDocId: number, input: ApplyPrepaidInput) {
  return db.transaction(async (tx) => {
    await assertPeriodOpen(tx, input.applyDate);
    const [doc] = await tx.select().from(schema.cashDocs).where(eq(schema.cashDocs.id, cashDocId)).for("update");
    if (!doc) throw new AppError(404, "收付款單不存在: {id}", { id: cashDocId });
    const label = doc.kind === "receipt" ? "收款單" : "付款單";
    const balanceLabel = doc.kind === "receipt" ? "預收" : "預付";
    if (doc.voidedAt) {
      throw new AppError(409, "{label} #{id} 已作廢，沒有{balanceLabel}餘額可沖用（請改用其他有餘額的單，或先收付款）", { label, id: cashDocId, balanceLabel });
    }
    if (doc.unappliedAmount <= 0) {
      throw new AppError(422, "{label} #{id} 沒有{balanceLabel}餘額——這張單建立時沒有溢{dir}", { label, id: cashDocId, balanceLabel, dir: doc.kind === "receipt" ? "收" : "付" });
    }
    if (input.applyDate < doc.docDate) {
      throw new AppError(422, "沖用日 {applyDate} 早於{label}日期 {docDate}——錢還沒收付就不能拿它的餘額沖銷", { applyDate: input.applyDate, label, docDate: doc.docDate });
    }

    const prior = await tx
      .select()
      .from(schema.cashDocAllocations)
      .where(and(eq(schema.cashDocAllocations.cashDocId, cashDocId), eq(schema.cashDocAllocations.fromPrepaid, true)));
    const remaining = doc.unappliedAmount - prior.reduce((s, a) => s + a.amount, 0);
    if (!input.allocations.length) throw new AppError(422, "至少要指定一筆要沖銷的單據");
    const sum = input.allocations.reduce((s, a) => s + a.amount, 0);
    if (sum > remaining) {
      throw new AppError(422, "{label} #{id} 的{balanceLabel}餘額剩 {remaining}，欲沖 {sum}", { label, id: cashDocId, balanceLabel, remaining, sum });
    }

    const defaultTargetType = doc.kind === "receipt" ? ("sale" as const) : ("purchase" as const);
    const allocations = input.allocations.map((a) => ({ ...a, targetType: a.targetType ?? defaultTargetType }));
    const open = await openDocuments(tx, doc.partnerId, doc.kind, input.applyDate);
    const openByKey = new Map(open.map((d) => [`${d.docType}:${d.id}`, d]));
    for (const a of allocations) {
      if (a.amount <= 0) throw new AppError(422, "沖銷金額須為正整數");
      const targetLabel = a.targetType === "opening" ? `期初單 #${a.targetId}` : `單據 #${a.targetId}`;
      const target = openByKey.get(`${a.targetType}:${a.targetId}`);
      if (!target) {
        await assertAllocTargetNotLater(tx, doc.partnerId, doc.kind, a, input.applyDate, "沖用日", targetLabel);
        throw new AppError(422, "{label} 不存在、非本對象或已沖畢", { label: targetLabel });
      }
      if (a.amount > target.remaining) {
        throw new AppError(422, "{label} 未沖餘額 {remaining}，欲沖 {amount}", { label: targetLabel, remaining: target.remaining, amount: a.amount });
      }
    }

    const accounts = await tx.select().from(schema.accounts);
    const idOf = (code: string) => accounts.find((a) => a.code === code)?.id;
    const arId = idOf(ACCOUNT.ACCOUNTS_RECEIVABLE);
    const apId = idOf(ACCOUNT.ACCOUNTS_PAYABLE);
    const advanceId = idOf(ACCOUNT.ADVANCE_RECEIPT);
    const prepayId = idOf(ACCOUNT.PREPAYMENT);
    if (!arId || !apId || !advanceId || !prepayId) throw new AppError(500, "應收/應付或預收/預付科目未初始化");

    const targetsText = allocations
      .map((a) => `${a.targetType === "opening" ? "期初單" : doc.kind === "receipt" ? "銷貨單" : "進貨單"} #${a.targetId}`)
      .join("、");
    const memo = `${balanceLabel}沖銷 ${label} #${cashDocId} → ${targetsText}`;
    const [entry] = await tx
      .insert(schema.journalEntries)
      .values({ entryDate: input.applyDate, memo, sourceType: doc.kind, sourceId: cashDocId })
      .returning();
    const journalLines =
      doc.kind === "receipt"
        ? [
            { entryId: entry!.id, accountId: advanceId, debit: sum, credit: 0 },
            { entryId: entry!.id, accountId: arId, debit: 0, credit: sum },
          ]
        : [
            { entryId: entry!.id, accountId: apId, debit: sum, credit: 0 },
            { entryId: entry!.id, accountId: prepayId, debit: 0, credit: sum },
          ];
    await tx.insert(schema.journalLines).values(journalLines);
    await tx.insert(schema.cashDocAllocations).values(
      allocations.map((a) => ({
        cashDocId,
        targetType: a.targetType,
        targetId: a.targetId,
        amount: a.amount,
        fromPrepaid: true,
        allocDate: input.applyDate,
        journalEntryId: entry!.id,
      })),
    );
    return { cashDocId, journalEntryId: entry!.id, applied: sum, remaining: remaining - sum, allocations };
  });
}

/**
 * 各交易對象未收/未付餘額（單據面：銷貨/進貨總額 − 退回沖銷 − 收付款；已沖銷銷貨不計）。
 * 退回同樣只扣 ar_offset／ap_offset——掛 2201 的退款是負債不是應收的減項。
 * 預收/預付（0027，B9）分開列（prepaidReceived／prepaidPaid），不與應收/應付淨額互抵——
 * 資產負債表不得以淨額表達，這裡的分列就是 2231/1212 與 1144/2144 在單據面的對照。
 */
export async function partnerBalances(db: Db) {
  const partners = await db.select().from(schema.partners);
  // 餘額本體在 balances.ts（R6 單一事實來源）：退回折讓的沖應收付上限也吃同一份
  const { ar, ap, prepaidReceived, prepaidPaid } = await partnerBalanceMaps(db);
  return partners
    .map((p) => ({
      partnerId: p.id,
      name: p.name,
      ar: ar.get(p.id) ?? 0,
      ap: ap.get(p.id) ?? 0,
      prepaidReceived: prepaidReceived.get(p.id) ?? 0,
      prepaidPaid: prepaidPaid.get(p.id) ?? 0,
    }))
    .filter((r) => r.ar !== 0 || r.ap !== 0 || r.prepaidReceived !== 0 || r.prepaidPaid !== 0);
}

export interface OpeningLineInput {
  productId: number;
  qty: number;
  unitCost: number;
}

/**
 * 庫存開帳：只建立庫存量與平均成本基礎（movement，sourceId 固定 0），不拋轉傳票——
 * 存貨科目餘額請併入期初開帳的手工傳票（與市售系統「期初庫存/期初科目餘額分開輸入」相同）。
 * 回傳 totalAmount（B6-b）：那張手工傳票要借記存貨科目的金額就是它，
 * 不回傳的話老闆得自己拿計算機把逐列的數量×成本加一遍，而加錯不會有任何紅字。
 */
export async function inventoryOpening(db: Db, input: { docDate: string; lines: OpeningLineInput[] }) {
  return db.transaction(async (tx) => {
    await assertPeriodOpen(tx, input.docDate);
    for (const l of input.lines) {
      const [product] = await tx.select().from(schema.products).where(eq(schema.products.id, l.productId));
      if (!product) throw new AppError(404, "商品不存在: {id}", { id: l.productId });
      if (product.isService) {
        throw new AppError(422, "{name} 是服務項目，不入庫存，不能列入庫存開帳", { name: product.name });
      }
    }
    const rows = input.lines.map((l) => ({
      productId: l.productId,
      direction: "in" as const,
      qty: String(l.qty),
      unitCost: l.unitCost.toFixed(4),
      amount: Math.round(l.qty * l.unitCost),
      sourceType: "opening" as const,
      sourceId: 0,
      // 開帳日落地（0035）：明細帳的期初列要按真正的開帳日歸期，不是按操作者哪天按下送出
      docDate: input.docDate,
    }));
    await tx.insert(schema.inventoryMovements).values(rows);
    return { lines: input.lines.length, totalAmount: rows.reduce((s, r) => s + r.amount, 0) };
  });
}

async function accountNets(db: Db, from: string | null, to: string, excludeClosing = false) {
  const rows = await db
    .select({
      code: schema.accounts.code,
      name: schema.accounts.name,
      type: schema.accounts.type,
      debit: schema.journalLines.debit,
      credit: schema.journalLines.credit,
    })
    .from(schema.journalLines)
    .innerJoin(schema.journalEntries, eq(schema.journalLines.entryId, schema.journalEntries.id))
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
    .where(
      and(
        from
          ? and(gte(schema.journalEntries.entryDate, from), lte(schema.journalEntries.entryDate, to))
          : lte(schema.journalEntries.entryDate, to),
        // 年度結轉分錄會把收入/費用歸零——損益表須排除，資產負債表則須納入
        excludeClosing
          ? or(isNull(schema.journalEntries.sourceType), ne(schema.journalEntries.sourceType, "closing"))
          : undefined,
      ),
    )
    .orderBy(asc(schema.accounts.code));
  const byCode = new Map<string, { code: string; name: string; type: string; debit: number; credit: number }>();
  for (const r of rows) {
    const row = byCode.get(r.code) ?? { code: r.code, name: r.name, type: r.type, debit: 0, credit: 0 };
    row.debit += r.debit;
    row.credit += r.credit;
    byCode.set(r.code, row);
  }
  return [...byCode.values()];
}

/** 損益表：收入（貸−借）− 費用（借−貸）＝本期損益 */
export async function incomeStatement(db: Db, from: string, to: string) {
  const nets = await accountNets(db, from, to, true);
  const revenue = nets
    .filter((r) => r.type === "revenue")
    .map((r) => ({ code: r.code, name: r.name, amount: r.credit - r.debit }));
  const expense = nets
    .filter((r) => r.type === "expense")
    .map((r) => ({ code: r.code, name: r.name, amount: r.debit - r.credit }));
  const totalRevenue = revenue.reduce((s, r) => s + r.amount, 0);
  const totalExpense = expense.reduce((s, r) => s + r.amount, 0);
  return { from, to, revenue, expense, totalRevenue, totalExpense, netIncome: totalRevenue - totalExpense };
}

/** 資產負債表（asOf 累計）：權益含「本期損益」調節項，資產＝負債＋權益必平 */
export async function balanceSheet(db: Db, asOf: string) {
  const nets = await accountNets(db, null, asOf);
  const section = (type: string, sign: 1 | -1) =>
    nets
      .filter((r) => r.type === type)
      .map((r) => ({ code: r.code, name: r.name, amount: sign * (r.debit - r.credit) }))
      .filter((r) => r.amount !== 0);
  const assets = section("asset", 1);
  const liabilities = section("liability", -1);
  const equity = section("equity", -1);
  const earnings = nets.reduce(
    (s, r) => (r.type === "revenue" ? s + r.credit - r.debit : r.type === "expense" ? s - (r.debit - r.credit) : s),
    0,
  );
  const totalAssets = assets.reduce((s, r) => s + r.amount, 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + r.amount, 0);
  const totalEquity = equity.reduce((s, r) => s + r.amount, 0) + earnings;
  return {
    asOf,
    assets,
    liabilities,
    equity: [...equity, { code: "", name: "本期損益（累計）", amount: earnings }],
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}
