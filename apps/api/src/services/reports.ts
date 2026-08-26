/**
 * 明細分類帳＋現金流量表（缺口第二層批次 C）。
 * - 明細分類帳：單一科目期初餘額＋逐筆分錄＋累計餘額（資產/費用借正、負債/權益/收入貸正）
 * - 現金流量表（直接法）：現金/銀行科目的每張傳票，依「對方科目」分類——
 *   權益 3xxx 與借款類 → 籌資；固定資產與存出保證金或處分分錄 → 投資；其餘 → 營業（詳見 classify()）。
 *   期初現金＋三類淨流＝期末現金，與資產負債表現金數必然一致（同一資料來源）。
 */
import { FINANCING_ACCOUNT_CODES, INVESTING_ACCOUNT_CODES } from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { and, asc, eq, gte, lte, lt, sql } from "drizzle-orm";
import { AppError, type Db } from "../db.ts";

/** 明細分類帳：期初＋逐筆＋累計餘額 */
export async function ledgerReport(db: Db, accountCode: string, from: string, to: string) {
  const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.code, accountCode));
  if (!account) throw new AppError(404, `科目不存在: ${accountCode}`);
  // 借餘科目（資產/費用）借正；貸餘科目（負債/權益/收入）貸正
  const sign = account.type === "asset" || account.type === "expense" ? 1 : -1;

  const base = db
    .select({
      entryId: schema.journalEntries.id,
      entryDate: schema.journalEntries.entryDate,
      memo: schema.journalEntries.memo,
      debit: schema.journalLines.debit,
      credit: schema.journalLines.credit,
    })
    .from(schema.journalLines)
    .innerJoin(schema.journalEntries, eq(schema.journalLines.entryId, schema.journalEntries.id));

  const before = await base.where(
    and(eq(schema.journalLines.accountId, account.id), lt(schema.journalEntries.entryDate, from)),
  );
  const opening = before.reduce((s, r) => s + sign * (r.debit - r.credit), 0);

  const inRange = await db
    .select({
      entryId: schema.journalEntries.id,
      entryDate: schema.journalEntries.entryDate,
      // 行摘要優先（0038）：手工傳票的每一行各自在調什麼，明細分類帳要看得出來；
      // 行沒填（自動拋轉或舊資料）退回單頭摘要
      memo: sql<string>`coalesce(nullif(${schema.journalLines.memo}, ''), ${schema.journalEntries.memo})`,
      debit: schema.journalLines.debit,
      credit: schema.journalLines.credit,
    })
    .from(schema.journalLines)
    .innerJoin(schema.journalEntries, eq(schema.journalLines.entryId, schema.journalEntries.id))
    .where(
      and(
        eq(schema.journalLines.accountId, account.id),
        gte(schema.journalEntries.entryDate, from),
        lte(schema.journalEntries.entryDate, to),
      ),
    )
    .orderBy(asc(schema.journalEntries.entryDate), asc(schema.journalEntries.id));

  let balance = opening;
  const lines = inRange.map((r) => {
    balance += sign * (r.debit - r.credit);
    return { ...r, balance };
  });
  return {
    account: { code: account.code, name: account.name, type: account.type },
    from,
    to,
    opening,
    lines,
    closing: balance,
  };
}

export type CashFlowActivity = "operating" | "investing" | "financing";

/**
 * 整張傳票的現金變動歸類（依對方科目）：
 * - 投資：處分分錄，或 INVESTING_ACCOUNT_CODES（固定資產、存出保證金）與 14xx 固定資產群（1144 應收除外）
 * - 籌資：權益 3xxx（增減資、盈餘分配）＋ FINANCING_ACCOUNT_CODES（借款本金、股東往來）
 * - 其餘：營業
 *
 * 判斷順序（投資先於籌資）是有意義的，改動前請先看 settlement-reports 那支順序迴歸測試：
 * 「借款直接買設備」的混合傳票（借 1421 設備／貸 2101 借款＋貸 1103 銀行）同時命中兩個條件，
 * 而這張傳票的現金流出是「錢花在設備上」，先判籌資會整張被歸成籌資活動，
 * 投資活動看起來完全沒買東西、籌資活動卻莫名流出——資本支出在報表上直接消失。
 *
 * 為什麼不用 2xxx 前綴判斷負債：2144 應付帳款、2201 其他應付款是不折不扣的營業活動，
 * 前綴一刀切會把「付貨款」算成還債。因此借款類逐碼列舉於 core。
 *
 * 已知限制（誠實記錄，見 docs/specs/chart-of-accounts.md「已知的實作缺口」）：
 * 使用者自建的借款／投資類科目（例如自行新增 2102「短期借款－玉山」）不會被自動歸類，
 * 會落進營業活動，讓老闆把借來的錢看成營業現金流入。正解是給 accounts 加一個
 * 「現金流量活動別」欄位讓使用者於建立科目時指定（本次未做）——在那之前，
 * 自建借款科目請沿用 2101／2301／2204，或人工調整報表。
 */
function classify(counterpartCodes: string[], sourceType: string | null): CashFlowActivity {
  if (sourceType === "disposal") return "investing";
  if (counterpartCodes.some((c) => INVESTING_ACCOUNT_CODES.includes(c) || (c.startsWith("14") && c !== "1144"))) {
    return "investing";
  }
  if (counterpartCodes.some((c) => c.startsWith("3") || FINANCING_ACCOUNT_CODES.includes(c))) return "financing";
  return "operating";
}

/** 現金流量表（直接法）：現金科目分錄按對方科目分類三大活動 */
export async function cashFlow(db: Db, from: string, to: string) {
  // 現金科目一律以 accounts.is_cash 為準（種子科目由 seedAccounts 校正、自建科目由使用者勾選）。
  // 寫死 1101/1103 的後果實測過：使用者自建的 1104 銀行存款收了款，整張傳票被判 cashDelta=0 略過，
  // 錢在資產負債表上、現金流量表卻看不到——連種子的 1102 零用金都會漏
  const cashAccounts = await db.select().from(schema.accounts).where(eq(schema.accounts.isCash, true));
  // 一個現金科目都沒有時寧可報錯，也不要回一張全 0 的報表：資產負債表照樣列著現金，
  // 兩張表對不起來卻沒有任何徵兆，看報表的人會以為公司真的沒有現金進出。
  // 正常情況不會發生（seedAccounts 每次啟動會把 1101/1102/1103 校正為現金科目），
  // 會走到這裡代表 migration 跑了但 seed 沒跑（例如部署把兩者拆成不同 job）。
  if (cashAccounts.length === 0) {
    throw new AppError(
      500,
      "尚未設定任何現金科目，現金流量表無法計算。請確認系統啟動時有執行科目種子（migrate 腳本），" +
        "或到「會計科目」頁把現金/銀行科目勾選為現金科目",
    );
  }
  const cashIds = new Set(cashAccounts.map((a) => a.id));

  const rows = await db
    .select({
      entryId: schema.journalEntries.id,
      entryDate: schema.journalEntries.entryDate,
      memo: schema.journalEntries.memo,
      sourceType: schema.journalEntries.sourceType,
      accountId: schema.journalLines.accountId,
      code: schema.accounts.code,
      debit: schema.journalLines.debit,
      credit: schema.journalLines.credit,
    })
    .from(schema.journalLines)
    .innerJoin(schema.journalEntries, eq(schema.journalLines.entryId, schema.journalEntries.id))
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
    .orderBy(asc(schema.journalEntries.entryDate), asc(schema.journalEntries.id));

  let opening = 0;
  const byEntry = new Map<
    number,
    { entryDate: string; memo: string; sourceType: string | null; cashDelta: number; counterparts: string[] }
  >();
  for (const r of rows) {
    const isCash = cashIds.has(r.accountId);
    if (isCash && r.entryDate < from) opening += r.debit - r.credit;
    if (r.entryDate < from || r.entryDate > to) continue;
    const e = byEntry.get(r.entryId) ?? {
      entryDate: r.entryDate,
      memo: r.memo,
      sourceType: r.sourceType,
      cashDelta: 0,
      counterparts: [],
    };
    if (isCash) e.cashDelta += r.debit - r.credit;
    else e.counterparts.push(r.code);
    byEntry.set(r.entryId, e);
  }

  const detail = [];
  const totals: Record<CashFlowActivity, number> = { operating: 0, investing: 0, financing: 0 };
  for (const [entryId, e] of byEntry) {
    if (e.cashDelta === 0) continue;
    const activity = classify(e.counterparts, e.sourceType);
    totals[activity] += e.cashDelta;
    detail.push({ entryId, date: e.entryDate, memo: e.memo, activity, amount: e.cashDelta });
  }
  detail.sort((a, b) => a.date.localeCompare(b.date) || a.entryId - b.entryId);

  const net = totals.operating + totals.investing + totals.financing;
  return {
    from,
    to,
    opening,
    operating: totals.operating,
    investing: totals.investing,
    financing: totals.financing,
    net,
    closing: opening + net,
    detail,
  };
}
