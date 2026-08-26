/**
 * 期初應收／應付單（gap-analysis-2608 B6）：既有公司導入時，把每一筆未收未付的舊單建進子帳。
 *
 * 與庫存開帳的分工（同一個「期初導入」哲學的兩半）：
 * - 庫存開帳只建 movement 不拋傳票——存貨只是期初傳票裡的一列，對方科目分散在整張開帳傳票。
 * - 期初應收付**由系統拋轉傳票**（應收＝借應收帳款、貸累積盈虧；應付反向）——
 *   對方科目唯一，系統拋轉才能保證總帳與子帳必然一致；使用者的期初手工傳票
 *   因此**不得再含應收付科目**（SOP 第⑥步）。
 * - 兩者都不進 401：期初不是當期銷項進項（vat.ts 只讀 invoices/purchases/expense_items）。
 *
 * 沖銷路徑：openDocuments／partnerBalances／arAging（ledger.ts、orders.ts）都認得本表，
 * 收付款單以 cash_doc_allocations.target_type='opening' 立沖。
 */
import { ACCOUNT } from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { desc, eq } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";
import { allocatedByTarget } from "./balances.ts";
import { assertDateOrder } from "./dates.ts";
import { assertPeriodOpen } from "./period.ts";

export interface OpeningBalanceInput {
  kind: "receivable" | "payable";
  partnerId: number;
  /** 開帳日：傳票日期與鎖帳看它（通常＝導入日／期初日） */
  entryDate: string;
  /** 原單日期（原始出貨／進貨日）：帳齡分桶看它 */
  docDate: string;
  /** 收付款到期日；未約定則不填，帳齡退回以原單日期估算 */
  dueDate?: string | undefined;
  amount: number; // 未收／未付餘額（整數元）
  memo?: string | undefined;
}

export async function createOpeningBalance(db: Db, input: OpeningBalanceInput, userId: number) {
  return db.transaction(async (tx) => {
    await assertPeriodOpen(tx, input.entryDate);
    // R2：到期日早於原單日一定是打錯（與銷貨/進貨的 dueDate 同一條規則）
    assertDateOrder(
      { date: input.docDate, label: "原單日期" },
      { date: input.dueDate, label: "付款到期日" },
    );
    if (input.docDate > input.entryDate) {
      throw new AppError(
        422,
        `原單日期 ${input.docDate} 晚於開帳日 ${input.entryDate}——期初欠款必須在開帳日之前就存在。` +
          `若這是開帳之後的新交易，請開正式的銷貨單／進貨單，不要走期初導入`,
      );
    }
    const [partner] = await tx.select().from(schema.partners).where(eq(schema.partners.id, input.partnerId));
    if (!partner) throw new AppError(404, `交易對象不存在: ${input.partnerId}`);
    if (input.kind === "receivable" && !partner.isCustomer) {
      throw new AppError(422, `${partner.name} 不是客戶，不能建期初應收（請先到「客戶與商品」頁勾選為客戶）`);
    }
    if (input.kind === "payable" && !partner.isSupplier) {
      throw new AppError(422, `${partner.name} 不是供應商，不能建期初應付（請先到「客戶與商品」頁勾選為供應商）`);
    }

    const accounts = await tx.select().from(schema.accounts);
    const idOf = (code: string) => accounts.find((a) => a.code === code)?.id;
    const subjectId = idOf(input.kind === "receivable" ? ACCOUNT.ACCOUNTS_RECEIVABLE : ACCOUNT.ACCOUNTS_PAYABLE);
    // 對方科目用既有的開帳權益科目（累積盈虧）：期初的資產負債差額本來就歸屬它，
    // 使用者期初傳票裡的累積盈虧金額須把本表拋轉的部分讓出來（SOP 第⑥步有算式）
    const equityId = idOf(ACCOUNT.RETAINED_EARNINGS);
    if (!subjectId || !equityId) throw new AppError(500, "應收/應付或累積盈虧科目未初始化（請重跑 migrate/seed）");

    const memo =
      input.memo?.trim() ||
      (input.kind === "receivable" ? `期初應收 - ${partner.name}` : `期初應付 - ${partner.name}`);
    const [doc] = await tx
      .insert(schema.openingBalances)
      .values({
        kind: input.kind,
        partnerId: input.partnerId,
        entryDate: input.entryDate,
        docDate: input.docDate,
        dueDate: input.dueDate ?? null,
        amount: input.amount,
        memo,
        createdBy: userId,
      })
      .returning();
    const [entry] = await tx
      .insert(schema.journalEntries)
      .values({ entryDate: input.entryDate, memo, sourceType: "opening", sourceId: doc!.id })
      .returning();
    await tx.insert(schema.journalLines).values(
      input.kind === "receivable"
        ? [
            { entryId: entry!.id, accountId: subjectId, debit: input.amount, credit: 0 },
            { entryId: entry!.id, accountId: equityId, debit: 0, credit: input.amount },
          ]
        : [
            { entryId: entry!.id, accountId: equityId, debit: input.amount, credit: 0 },
            { entryId: entry!.id, accountId: subjectId, debit: 0, credit: input.amount },
          ],
    );
    await tx
      .update(schema.openingBalances)
      .set({ journalEntryId: entry!.id })
      .where(eq(schema.openingBalances.id, doc!.id));
    return { ...doc!, journalEntryId: entry!.id };
  });
}

/** 期初應收付清單（含已沖銷金額）：設定頁顯示用，欄位白名單挑選 */
export async function listOpeningBalances(db: Db) {
  const rows = await db
    .select({
      id: schema.openingBalances.id,
      kind: schema.openingBalances.kind,
      partnerId: schema.openingBalances.partnerId,
      partnerName: schema.partners.name,
      entryDate: schema.openingBalances.entryDate,
      docDate: schema.openingBalances.docDate,
      dueDate: schema.openingBalances.dueDate,
      amount: schema.openingBalances.amount,
      memo: schema.openingBalances.memo,
      journalEntryId: schema.openingBalances.journalEntryId,
      // 0030 作廢層：清單留著已作廢的單（append-only 軌跡），前端標記＋合計排除
      voidedAt: schema.openingBalances.voidedAt,
      voidReason: schema.openingBalances.voidReason,
    })
    .from(schema.openingBalances)
    .innerJoin(schema.partners, eq(schema.openingBalances.partnerId, schema.partners.id))
    .orderBy(desc(schema.openingBalances.id));
  const allocated = await allocatedByTarget(db, "opening");
  // 已作廢的單未沖餘額以 0 表達：懸空檢查保證作廢時沒有有效沖銷，殘餘的 amount 已被反向傳票收回
  return rows.map((r) => ({
    ...r,
    allocated: allocated.get(r.id) ?? 0,
    remaining: r.voidedAt ? 0 : r.amount - (allocated.get(r.id) ?? 0),
  }));
}
