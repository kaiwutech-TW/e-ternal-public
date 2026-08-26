/**
 * 共用日期驗證（R2）。兩條規則，兩個入口：
 *
 * 1. assertNotFarFuture —— 「不合理的未來日期」：超過今天＋1 年一律 422。
 *    ⚠️ 刻意**不擋過去日期**：補登歷史單據（去年的進貨、上季的報銷）是正常作業，
 *    擋了等於逼使用者造假日期。門檻取一年是「打錯年份」與「預開單據」的分界——
 *    真的要預開明年以後的單，幾乎可以確定是 2026 打成 2062 這類手滑。
 *
 * 2. assertDateOrder —— 單據內兩個日期的先後（certDate ≥ docDate、dueDate ≥ docDate、
 *    作廢日 ≥ 開立日……）。訊息必須講清楚**是哪兩個日期矛盾**、各是多少——
 *    只回「日期錯誤」的話，使用者要對著表單上四五個日期欄一個一個猜。
 *
 * 格式（YYYY-MM-DD）一律由 zod 在路由層擋，這裡假設進來的字串已是合法日期字面值，
 * 直接做字典序比較（ISO 日期的字典序＝時間序）。
 */
import { AppError } from "../db.ts";

/** 今天（本機時區）的 YYYY-MM-DD */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 今天＋1 年（2/29 起算就落到隔年 3/1，邊界誤差一天無妨——這是打錯年份的偵測，不是期限） */
function oneYearFromToday(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 未來日期超過今天＋1 年 → 422。date 為空（undefined/null）＝欄位沒填，不在此檢查。
 * label 用使用者看得懂的欄位名（「單據日期」「給付日期」），不是程式欄位名。
 */
export function assertNotFarFuture(date: string | null | undefined, label: string): void {
  if (!date) return;
  const limit = oneYearFromToday();
  if (date > limit) {
    throw new AppError(
      422,
      `${label}（${date}）晚於今天（${todayIso()}）超過一年——多半是年份打錯了，請核對後修正。` +
        `補登過去日期的單據不受此限制`,
    );
  }
}

/**
 * 月份期間（YYYY-MM）不得晚於今天所在月 → 422。
 * 折舊 run 專用，門檻比「今天＋1 年」嚴：提前計提未來月份之後，中間被跳過的期間
 * 會因 asset×period 冪等而**永遠補不回**（資產頁累計數與總帳從此差一個月，且沒有撤銷入口），
 * 所以未來的月份一個都不放行。過去月份照常（上線補提歷史折舊是正常作業，月結會逐月把關）。
 */
export function assertMonthNotFuture(period: string, label: string): void {
  const cur = todayIso().slice(0, 7);
  if (period > cur) {
    throw new AppError(
      422,
      `${label}（${period}）晚於本月（${cur}）——折舊只能提到當月為止。` +
        `先提了未來月份，中間被跳過的期間會永遠補不回（每資產每期只提一次），請到了那個月再執行`,
    );
  }
}

/**
 * later 不得早於 earlier → 422。任一邊為空＝該欄未填，不在此檢查（選填欄位留空是合法的）。
 * 訊息點名兩個日期各是誰、各是多少——使用者一眼看出該改哪一格。
 */
export function assertDateOrder(
  earlier: { date: string | null | undefined; label: string },
  later: { date: string | null | undefined; label: string },
): void {
  if (!earlier.date || !later.date) return;
  if (later.date < earlier.date) {
    throw new AppError(
      422,
      `${later.label}（${later.date}）早於${earlier.label}（${earlier.date}）——` +
        `${later.label}不可能在${earlier.label}之前，請核對是哪一個日期填錯`,
    );
  }
}
