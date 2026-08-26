/**
 * 單據自動拋轉傳票規則。規格書：docs/specs/posting-rules.md
 * 不變量：每張傳票借貸必平（assertBalanced 於建立時強制）。
 */
import { ACCOUNT } from "./chart.ts";

export interface EntryLine {
  accountCode: string;
  debit: number;
  credit: number;
}

export function assertBalanced(lines: readonly EntryLine[]): void {
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  if (debit !== credit) throw new Error(`傳票借貸不平: 借 ${debit} ≠ 貸 ${credit}`);
  for (const l of lines) {
    if (l.debit < 0 || l.credit < 0 || (l.debit !== 0 && l.credit !== 0)) {
      throw new Error(`傳票明細不合法: ${JSON.stringify(l)}`);
    }
  }
}

/** 賒購進貨：借 商品存貨(未稅)、進項稅額；貸 應付帳款(含稅) */
export function purchaseEntryLines(doc: { subtotal: number; tax: number; total: number }): EntryLine[] {
  const lines: EntryLine[] = [
    { accountCode: ACCOUNT.INVENTORY, debit: doc.subtotal, credit: 0 },
    { accountCode: ACCOUNT.INPUT_TAX, debit: doc.tax, credit: 0 },
    { accountCode: ACCOUNT.ACCOUNTS_PAYABLE, debit: 0, credit: doc.total },
  ];
  assertBalanced(lines);
  return lines;
}

/**
 * 銷貨退回／折讓的分錄。
 *
 * 收入減項走 4109 而不是紅字沖 4101：
 * 1. assertBalanced 禁止負數借貸，「紅字」只能實作成借記 4101，結果是總帳的銷貨收入
 *    出現借方發生額、毛額被永久抹掉只剩淨額，「本月賣了多少、退了多少」再也分不開。
 * 2. 損益表不必改程式——incomeStatement 對 revenue 算 credit−debit，4109 的借餘
 *    自然成為一行負數，totalRevenue 自動是淨額。
 *
 * 對方科目由呼叫端拆分成「沖應收／掛其他應付／退現金」三段（services/returns.ts），
 * 這裡只負責把拆好的金額擺進借貸——一律沖 1144 會讓已收款的銷貨退貨把應收沖成負數。
 *
 * restock=false（折讓：貨沒退、只是少收錢）時不產生存貨與成本兩行，這是折讓與退回的唯一實質差別。
 */
export function saleReturnEntryLines(doc: {
  subtotal: number; // 退回／折讓的未稅額
  tax: number;
  total: number;
  cogs: number; // 退回成本（折讓為 0）
  arOffset: number;
  payableAmount: number;
  cashAmount: number;
  cashAccountCode?: string | undefined;
  restock: boolean;
}): EntryLine[] {
  const lines: EntryLine[] = [
    { accountCode: ACCOUNT.SALES_RETURN, debit: doc.subtotal, credit: 0 },
    { accountCode: ACCOUNT.OUTPUT_TAX, debit: doc.tax, credit: 0 },
    // 這兩行即使為 0 也寫出，與 saleEntryLines 的固定行數一致：對帳的人一眼就看得出
    // 「這張退貨沖了多少應收、掛了多少應付客戶」，而不是靠某一行有沒有出現去推論
    { accountCode: ACCOUNT.ACCOUNTS_RECEIVABLE, debit: 0, credit: doc.arOffset },
    { accountCode: ACCOUNT.OTHER_PAYABLE, debit: 0, credit: doc.payableAmount },
  ];
  // 現金科目是使用者選的（可能是自建的銀行帳戶科目），沒有退現金時無從決定要寫哪一個科目，因此為 0 就不寫
  if (doc.cashAmount > 0) {
    if (!doc.cashAccountCode) throw new Error(`退現 ${doc.cashAmount} 元但未指定現金科目`);
    lines.push({ accountCode: doc.cashAccountCode, debit: 0, credit: doc.cashAmount });
  }
  if (doc.restock) {
    lines.push({ accountCode: ACCOUNT.INVENTORY, debit: doc.cogs, credit: 0 });
    lines.push({ accountCode: ACCOUNT.COGS, debit: 0, credit: doc.cogs });
  }
  assertBalanced(lines);
  return lines;
}

/**
 * 進貨退出／折讓的分錄。
 *
 * 沒有「進貨退出」科目：本系統是永續盤存制，進貨當初借的就是 1301 商品存貨（purchaseEntryLines），
 * 退出直接貸 1301 即可；定期盤存制教科書上的 5xxx「進貨退出」在這裡沒有對應物。
 *
 * invCredit 是實際沖減存貨帳面的金額：退出＝當下移動平均成本 × 退出數量（與銷貨出庫同一條規則）、
 * 折讓＝折讓金額 × 在庫比例（見 core/returns.ts 的檔頭與 allowanceInvCredit）。
 *
 * costDiff = 退款金額 − invCredit，是**雙向**的，走 5101 銷貨成本：
 * - 退款 > 帳面（先買貴的、後買便宜的，賣掉一批才退還當初那批貴的）→ 貸 5101：
 *   那個差額本來就是先前銷貨在平均法下多認的成本。
 * - 退款 < 帳面（退還的是便宜那批）→ 借 5101：已售出的貨真實成本比帳上認的高，補認回去。
 * 走 5101 而不是新增一個「進貨退出價差」科目：後者大多數時候餘額為 0，使用者也看不懂，
 * 而這個差額的經濟實質確實就是已售出商品的成本更正。
 */
export function purchaseReturnEntryLines(doc: {
  subtotal: number;
  tax: number;
  total: number;
  apOffset: number;
  receivableAmount: number;
  cashAmount: number;
  cashAccountCode?: string | undefined;
  invCredit: number; // 沖減存貨帳面的金額（可能大於 subtotal）
  costDiff: number; // subtotal − invCredit，可正可負
}): EntryLine[] {
  const lines: EntryLine[] = [
    { accountCode: ACCOUNT.ACCOUNTS_PAYABLE, debit: doc.apOffset, credit: 0 },
    { accountCode: ACCOUNT.OTHER_RECEIVABLE, debit: doc.receivableAmount, credit: 0 },
  ];
  if (doc.cashAmount > 0) {
    if (!doc.cashAccountCode) throw new Error(`退現 ${doc.cashAmount} 元但未指定現金科目`);
    lines.push({ accountCode: doc.cashAccountCode, debit: doc.cashAmount, credit: 0 });
  }
  lines.push({ accountCode: ACCOUNT.INVENTORY, debit: 0, credit: doc.invCredit });
  lines.push({ accountCode: ACCOUNT.INPUT_TAX, debit: 0, credit: doc.tax });
  // costDiff 為負＝沖存貨的金額大於退款額（退還的是便宜批次），已售商品的成本被低估，借回 5101
  if (doc.costDiff > 0) lines.push({ accountCode: ACCOUNT.COGS, debit: 0, credit: doc.costDiff });
  else if (doc.costDiff < 0) lines.push({ accountCode: ACCOUNT.COGS, debit: -doc.costDiff, credit: 0 });
  assertBalanced(lines);
  return lines;
}

/**
 * 賒銷銷貨：借 應收帳款(含稅)、銷貨成本；貸 銷貨收入(未稅)、銷項稅額、商品存貨。
 * zeroRated（0028，B12）＝零稅率銷貨：收入貸 4102 而不是 4101——401 的零稅率銷售額
 * 與應稅分欄取數，混在 4101 就分不出來（tax 此時應為 0，由呼叫端保證）。
 */
export function saleEntryLines(doc: {
  subtotal: number;
  tax: number;
  total: number;
  cogs: number;
  zeroRated?: boolean;
}): EntryLine[] {
  const lines: EntryLine[] = [
    { accountCode: ACCOUNT.ACCOUNTS_RECEIVABLE, debit: doc.total, credit: 0 },
    { accountCode: doc.zeroRated ? ACCOUNT.SALES_REVENUE_ZERO : ACCOUNT.SALES_REVENUE, debit: 0, credit: doc.subtotal },
    { accountCode: ACCOUNT.OUTPUT_TAX, debit: 0, credit: doc.tax },
    { accountCode: ACCOUNT.COGS, debit: doc.cogs, credit: 0 },
    { accountCode: ACCOUNT.INVENTORY, debit: 0, credit: doc.cogs },
  ];
  assertBalanced(lines);
  return lines;
}
