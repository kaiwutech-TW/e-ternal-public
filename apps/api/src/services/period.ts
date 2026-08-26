/**
 * 月結關帳＋年度結轉（缺口第二層批次 B）。
 * - 關帳：period_closes 一列一個月、須依序關；「關至點」＝max(period)；重開＝刪最新一列
 * - 鎖帳：assertPeriodOpen(date) 由所有拋轉傳票的服務呼叫，落入已關期間一律 409
 * - 月結檢查：折舊已提（擋）、前月已關（擋）、庫存帳與存貨科目差額（僅提醒）、報銷待核（僅提醒）
 * - 年度結轉：12 個月全關後，收入/費用結清至 3351 累積盈虧（傳票 closing、日期 12-31，
 *   刻意繞過鎖帳——結轉是關帳後的系統分錄）；損益表已排除 closing 分錄（ledger.ts）
 */
import { ACCOUNT, monthlyDepreciation } from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { and, desc, eq, gte, lte, ne, or, isNull } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";

// 結轉對象改由 core 的 ACCOUNT 提供，與科目維護的「系統科目不可停用」共用同一份清單
const RETAINED_EARNINGS_CODE = ACCOUNT.RETAINED_EARNINGS;

function nextMonth(period: string): string {
  const [y, m] = [Number(period.slice(0, 4)), Number(period.slice(5, 7))];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export async function closedThrough(db: Db): Promise<string | null> {
  const [latest] = await db
    .select()
    .from(schema.periodCloses)
    .orderBy(desc(schema.periodCloses.period))
    .limit(1);
  return latest?.period ?? null;
}

/** 所有拋轉傳票的服務在寫入前呼叫；entryDate 落入已關期間 → 409 */
export async function assertPeriodOpen(db: Db, entryDate: string): Promise<void> {
  const through = await closedThrough(db);
  if (through && entryDate.slice(0, 7) <= through) {
    throw new AppError(409, `${entryDate.slice(0, 7)} 已關帳（帳務關至 ${through}），如需調整請先重開該期間`);
  }
}

/**
 * 報銷單的兩個關帳面：費用傳票以**單據日**入帳，可扣抵明細卻以**發票日**進 401
 * （services/vat.ts 的進項取數）。兩個日期可能落在不同期間——收據累積兩個月才整理時，
 * 8 月核准一張帶 6 月發票的單，費用進 8 月、進項稅卻加進可能已申報的 6 月。
 *
 * 核准與作廢共用這一份：作廢端本來就兩個日期都檢查（void.ts），核准端只檢查單據日——
 * 同一個事實兩套判斷、寬鬆的那套在入口，結果是「進得去、出不來」（核准成功但作廢被擋）。
 */
export async function assertClaimPeriodsOpen(
  db: Db,
  claim: { claimDate: string },
  items: Array<{ deductible: boolean; invoiceDate: string | null; invoiceNumber?: string | null }>,
): Promise<void> {
  await assertPeriodOpen(db, claim.claimDate);
  const through = await closedThrough(db);
  if (!through) return;
  for (const item of items) {
    if (!item.deductible || !item.invoiceDate) continue;
    if (item.invoiceDate.slice(0, 7) <= through) {
      throw new AppError(
        409,
        `可扣抵發票（${item.invoiceNumber ?? "?"}）的日期 ${item.invoiceDate} 屬於已關帳期間（帳務關至 ${through}）。` +
          `進項稅額以發票日期歸入 401 期別，核准會把稅額加進可能已申報的那一期——` +
          `請先到「報表」頁重開該期間，或把這筆改為不可扣抵`,
      );
    }
  }
}

export interface CheckItem {
  key: string;
  label: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
}

/** 月結前檢查：折舊已提（擋）、前月已關（擋）、庫存帳與存貨科目差額（提醒）、報銷待核（提醒） */
export async function checkPeriod(db: Db, period: string): Promise<CheckItem[]> {
  const items: CheckItem[] = [];

  const through = await closedThrough(db);
  const sequentialOk = through === null || period === nextMonth(through);
  items.push({
    key: "sequential",
    label: "依序關帳",
    ok: sequentialOk,
    blocking: true,
    detail: through
      ? sequentialOk
        ? `目前關至 ${through}，本期 ${period} 為下一期`
        : `目前關至 ${through}，下一個可關期間是 ${nextMonth(through)}`
      : "尚未關過帳，本期將為起始關帳月",
  });

  // 折舊：本期應提而未提的使用中資產（已作廢的登錄不再長折舊，0031）
  const assets = await db
    .select()
    .from(schema.fixedAssets)
    .where(and(eq(schema.fixedAssets.status, "active"), isNull(schema.fixedAssets.voidedAt)));
  const deps = await db.select().from(schema.assetDepreciations);
  const provided = new Set(deps.filter((d) => d.period === period).map((d) => d.assetId));
  const accumulatedOf = new Map<number, number>();
  for (const d of deps) accumulatedOf.set(d.assetId, (accumulatedOf.get(d.assetId) ?? 0) + d.amount);
  const pending = assets.filter((a) => {
    if (a.startDate.slice(0, 7) > period) return false;
    if (provided.has(a.id)) return false;
    const remaining = a.cost - a.salvage - (accumulatedOf.get(a.id) ?? 0);
    return remaining > 0 && monthlyDepreciation(a.cost, a.salvage, a.usefulYears) > 0;
  });
  items.push({
    key: "depreciation",
    label: "本月折舊已計提",
    ok: pending.length === 0,
    blocking: true,
    detail: pending.length
      ? `尚有 ${pending.length} 筆資產未提本期折舊：${pending.map((a) => a.name).join("、")}（請至「固定資產」頁執行）`
      : "本期折舊已全數計提（或無應提資產）",
  });

  // 庫存帳與存貨科目的差額（B6-b）：庫存開帳刻意不拋轉傳票，忘了補那張期初傳票的話，
  // 資產負債表會永久少一整批存貨、借貸卻照樣平衡，沒有任何紅字，通常要到報稅或盤點才發現。
  // 僅提醒不硬擋：差額也可能是使用者刻意的（評價調整、盤點差異走手工傳票），系統沒有立場斷言誰對。
  // 兩邊都取「目前」總額而非期末餘額：inventory_movements 沒有單據日（只有 created_at），
  // 切不出精確的期末庫存帳；而進銷貨永遠同時寫兩邊，取目前值時差額仍然只反映
  // 「沒補的開帳傳票」或「只動了單邊的手工調整」，不會因為關的是上個月而誤報。
  const movements = await db.select().from(schema.inventoryMovements);
  const inventoryLedger = movements.reduce(
    (s, mv) => s + (mv.direction === "in" ? mv.amount : -mv.amount),
    0,
  );
  const [invAccount] = await db.select().from(schema.accounts).where(eq(schema.accounts.code, ACCOUNT.INVENTORY));
  const invLines = invAccount
    ? await db
        .select({ debit: schema.journalLines.debit, credit: schema.journalLines.credit })
        .from(schema.journalLines)
        .where(eq(schema.journalLines.accountId, invAccount.id))
    : [];
  const inventoryAccountBalance = invLines.reduce((s, l) => s + l.debit - l.credit, 0);
  const invDiff = inventoryLedger - inventoryAccountBalance;
  const invName = invAccount ? `${invAccount.code} ${invAccount.name}` : ACCOUNT.INVENTORY;
  items.push({
    key: "inventory",
    label: "庫存帳與存貨科目相符",
    ok: invDiff === 0,
    blocking: false,
    detail:
      invDiff === 0
        ? `庫存明細帳合計與 ${invName} 餘額一致（${inventoryLedger} 元）`
        : `庫存明細帳合計 ${inventoryLedger} 元、${invName} 餘額 ${inventoryAccountBalance} 元，差 ${invDiff} 元` +
          `——最常見的原因是庫存開帳後忘了補期初傳票（請至「傳票」頁以差額借記 ${invName}），` +
          `或有只動存貨科目、沒動庫存明細的手工傳票`,
  });

  // 報銷待核（單據日在本期）：僅提醒，不擋
  const [y, m] = [Number(period.slice(0, 4)), Number(period.slice(5, 7))];
  const lastDay = `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  const claims = await db
    .select()
    .from(schema.expenseClaims)
    .where(
      and(
        eq(schema.expenseClaims.status, "submitted"),
        gte(schema.expenseClaims.claimDate, `${period}-01`),
        lte(schema.expenseClaims.claimDate, lastDay),
      ),
    );
  items.push({
    key: "claims",
    label: "本月報銷已審核",
    ok: claims.length === 0,
    blocking: false,
    detail: claims.length
      ? `尚有 ${claims.length} 件本月報銷待核（核准日若落在本期會被鎖擋，屆時以次月日期核准）`
      : "本月無待核報銷",
  });

  // 已核准未付（R13）：單據日在本期或更早、錢還沒還員工的。僅提醒不擋——
  // 月結時最容易忘的就是「這個月要發多少報銷款」，而付款傳票跨期入帳是合法的
  const unpaidClaims = await db
    .select()
    .from(schema.expenseClaims)
    .where(
      and(
        eq(schema.expenseClaims.status, "approved"),
        isNull(schema.expenseClaims.voidedAt),
        lte(schema.expenseClaims.claimDate, lastDay),
      ),
    );
  items.push({
    key: "claims-unpaid",
    label: "已核准報銷已付款",
    ok: unpaidClaims.length === 0,
    blocking: false,
    detail: unpaidClaims.length
      ? `尚有 ${unpaidClaims.length} 件已核准報銷未付款（合計 ${unpaidClaims.reduce((s, cl) => s + cl.total, 0)} 元）` +
        `——「報銷」頁的待付彙總可看每位員工各欠多少`
      : "已核准報銷均已付款",
  });

  return items;
}

export async function listCloses(db: Db) {
  const closes = await db.select().from(schema.periodCloses).orderBy(desc(schema.periodCloses.period));
  return { closedThrough: closes[0]?.period ?? null, closes };
}

export async function closePeriod(db: Db, period: string, userId: number) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new AppError(400, "期間格式須為 YYYY-MM");
  return db.transaction(async (tx) => {
    const items = await checkPeriod(tx, period);
    const blockers = items.filter((i) => i.blocking && !i.ok);
    if (blockers.length) {
      throw new AppError(422, `月結檢查未通過：${blockers.map((b) => b.detail).join("；")}`);
    }
    const [row] = await tx.insert(schema.periodCloses).values({ period, closedBy: userId }).returning();
    return { ...row!, checks: items };
  });
}

/** 重開最近一個已關期間；該年度已結轉則須先處理結轉分錄 */
export async function reopenLatest(db: Db) {
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select()
      .from(schema.periodCloses)
      .orderBy(desc(schema.periodCloses.period))
      .limit(1);
    if (!latest) throw new AppError(404, "沒有已關帳的期間");
    const year = Number(latest.period.slice(0, 4));
    const [closingEntry] = await tx
      .select()
      .from(schema.journalEntries)
      .where(and(eq(schema.journalEntries.sourceType, "closing"), eq(schema.journalEntries.sourceId, year)));
    if (closingEntry) {
      throw new AppError(409, `${year} 年度已結轉（傳票 #${closingEntry.id}），重開該年度期間前請先聯絡記帳士處理結轉分錄`);
    }
    await tx.delete(schema.periodCloses).where(eq(schema.periodCloses.id, latest.id));
    return { reopened: latest.period };
  });
}

/** 年度結轉：收入/費用（排除既有 closing）結清至 3351；回傳結轉摘要 */
export async function yearClose(db: Db, year: number, _userId: number) {
  return db.transaction(async (tx) => {
    const through = await closedThrough(tx);
    if (!through || through < `${year}-12`) {
      throw new AppError(422, `年度結轉前須先關帳至 ${year}-12（目前關至 ${through ?? "未關帳"}）`);
    }
    const [existing] = await tx
      .select()
      .from(schema.journalEntries)
      .where(and(eq(schema.journalEntries.sourceType, "closing"), eq(schema.journalEntries.sourceId, year)));
    if (existing) throw new AppError(409, `${year} 年度已結轉（傳票 #${existing.id}）`);

    const rows = await tx
      .select({
        accountId: schema.journalLines.accountId,
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
          gte(schema.journalEntries.entryDate, `${year}-01-01`),
          lte(schema.journalEntries.entryDate, `${year}-12-31`),
          or(isNull(schema.journalEntries.sourceType), ne(schema.journalEntries.sourceType, "closing")),
        ),
      );

    const byAccount = new Map<number, { code: string; type: string; net: number }>();
    for (const r of rows) {
      if (r.type !== "revenue" && r.type !== "expense") continue;
      const row = byAccount.get(r.accountId) ?? { code: r.code, type: r.type, net: 0 };
      row.net += r.debit - r.credit; // 借正貸負
      byAccount.set(r.accountId, row);
    }
    const lines = [];
    let netIncome = 0;
    for (const [accountId, r] of byAccount) {
      if (r.net === 0) continue;
      // 結清：借餘（費用）→ 貸方沖平；貸餘（收入）→ 借方沖平
      lines.push(r.net > 0 ? { accountId, debit: 0, credit: r.net } : { accountId, debit: -r.net, credit: 0 });
      netIncome += -r.net; // 收入貸餘為正貢獻
    }
    if (!lines.length) throw new AppError(422, `${year} 年度無損益資料可結轉`);

    const [re] = await tx.select().from(schema.accounts).where(eq(schema.accounts.code, RETAINED_EARNINGS_CODE));
    if (!re) throw new AppError(500, `科目未初始化: ${RETAINED_EARNINGS_CODE}（請重跑 migrate/seed）`);
    if (netIncome > 0) lines.push({ accountId: re.id, debit: 0, credit: netIncome });
    else if (netIncome < 0) lines.push({ accountId: re.id, debit: -netIncome, credit: 0 });

    const [entry] = await tx
      .insert(schema.journalEntries)
      .values({
        entryDate: `${year}-12-31`,
        memo: `${year} 年度損益結轉（本期損益 ${netIncome} 元轉入累積盈虧）`,
        sourceType: "closing",
        sourceId: year,
      })
      .returning();
    await tx.insert(schema.journalLines).values(lines.map((l) => ({ entryId: entry!.id, ...l })));
    return { year, netIncome, journalEntryId: entry!.id, accountsClosed: byAccount.size };
  });
}

export async function listYearCloses(db: Db) {
  return db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.sourceType, "closing"))
    .orderBy(desc(schema.journalEntries.entryDate));
}
