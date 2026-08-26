/**
 * 扣繳的「算術」——而且只有算術。規格狀態見 docs/specs/withholding.md。
 *
 * ★ 本檔刻意不含任何稅率、門檻、免扣額、身分別（居住者／非居住者）與憑單格式代號。
 *   費率一律來自使用者在「扣繳」頁自己填的設定（withholding_categories.tax_rate_bp），
 *   並由使用者自行在來源欄註明依據。理由：
 *   ① 這些數值每年會變，寫死在程式裡是定時炸彈；
 *   ② 本專案紀律是「法規原文為一級規格」，沒有一級來源就不寫成程式；
 *   ③ 把無法查證的數字寫進程式，等於把猜測包裝成看起來很權威的東西——
 *      使用者會因為「系統算出來的」而不再自己核對。
 *
 * 因此本檔提供的函式只回答一個問題：「給付 X 元、費率 Y bp，乘出來是多少」。
 * 它的結果在服務層只當**預設值**，使用者一律可以覆寫（見 services/withholding.ts）。
 */
import { roundHalfUp } from "./money.ts";

/**
 * 費率的計價單位：basis point＝萬分之一，例如 3.5% = 350 bp。
 * 用 bp 而不是百分點，是為了容納帶小數的費率而不必引入 numeric 或浮點。
 *
 * 這裡與所有註解／文案刻意**不舉實際稅率當例子**：使用者第一次看到費率欄位時，
 * 例子裡的數字就是他最可能照抄的答案——而這個欄位存在的整個目的，
 * 就是逼他自己去查、自己在 source_note 留下依據。舉一個「看起來很像真的」的數字，
 * 等於幫他跳過那一步，而且我們無從得知那個數字是否仍然有效。
 */
export const BP_PER_UNIT = 10_000;

/**
 * 依費率試算扣繳額。**rate 為 null（使用者尚未設定費率）時回 null，不是 0**——
 * 兩者必須分得開：0 是「查過，這類不用扣」，null 是「還沒查」。
 * 混為一談會讓「沒設定」偽裝成「不用扣」，而使用者以為系統已經幫他判斷過了。
 *
 * 進位方式沿用全系統的金額慣例（四捨五入至整數元，見 money.ts）。
 * 實際扣繳稅款的進位規則本專案**未查證**——這也是為什麼試算值一律可覆寫：
 * 使用者拿到繳款單發現差 1 元時，改得動比「系統說的算」重要。
 */
export function withheldByRate(grossAmount: number, rateBp: number | null | undefined): number | null {
  if (rateBp === null || rateBp === undefined) return null;
  if (!Number.isInteger(grossAmount) || grossAmount <= 0) {
    throw new Error(`給付金額須為正整數元: ${grossAmount}`);
  }
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > BP_PER_UNIT) {
    throw new Error(`費率須為 0–${BP_PER_UNIT} 的整數 basis point: ${rateBp}`);
  }
  return roundHalfUp((grossAmount * rateBp) / BP_PER_UNIT);
}

/** bp → 百分比字串（UI 顯示用；350 → "3.5"、1250 → "12.5"） */
export function bpToPercentText(rateBp: number): string {
  return String(rateBp / 100);
}

/** 百分比 → bp（UI 輸入用）；非有限數或超出 0–100 回 null，由呼叫端擋下 */
export function percentToBp(percent: number): number | null {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return Math.round(percent * 100);
}
