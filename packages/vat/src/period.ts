/** 申報期別與 B2C 內含稅拆算（第 20 點(十五)1(1)：總額÷(1+徵收率)×徵收率 四捨五入＝稅額） */

/** 'YYYYMM'（西元，奇數月起始期別）→ { rocPeriod: 'yyymm'（迄月）, months: ['YYYY-MM','YYYY-MM'] } */
export function rocPeriodOf(period: string): { rocPeriod: string; months: [string, string] } {
  const m = /^(\d{4})(\d{2})$/.exec(period);
  if (!m) throw new Error(`期別須為 YYYYMM: ${period}`);
  const year = Number(m[1]!);
  const startMonth = Number(m[2]!);
  if (startMonth % 2 === 0 || startMonth < 1 || startMonth > 11) {
    throw new Error(`期別起始月須為奇數月: ${period}`);
  }
  const endMonth = startMonth + 1;
  const roc = year - 1911;
  return {
    rocPeriod: `${String(roc).padStart(3, "0")}${String(endMonth).padStart(2, "0")}`,
    months: [
      `${year}-${String(startMonth).padStart(2, "0")}`,
      `${year}-${String(endMonth).padStart(2, "0")}`,
    ],
  };
}

/**
 * 期別 → 實際的起訖日期（含）。
 *
 * 為什麼需要這支：迄月的最後一天不能寫死 31。雙月制的六個期別裡，迄月是
 * 2 月（28/29 天）、4 月、6 月的就有三個，`${迄月}-31` 會組出 2026-02-31 這種
 * 不存在的日期，Postgres 直接以 date/time field value out of range 拒絕整個查詢——
 * 也就是說一整年有一半的申報期根本產不出申報檔（2026-07-29 實測發現）。
 * 原本的測試只用 202607（迄月 8 月剛好 31 天）所以一路綠燈。
 */
export function periodDateRange(period: string): { from: string; to: string } {
  const { months } = rocPeriodOf(period);
  const [monthStart, monthEnd] = months;
  const year = Number(monthEnd.slice(0, 4));
  const month = Number(monthEnd.slice(5, 7));
  return { from: `${monthStart}-01`, to: `${monthEnd}-${String(lastDayOfMonth(year, month)).padStart(2, "0")}` };
}

/**
 * 上一個申報期別（雙月制）：202607 → 202605；跨年 202601 → 202511。
 * 留抵承轉要靠它找上一期的申報紀錄——本期第 88 欄「上期累積留抵」＝上期第 95 欄「累積留抵」。
 */
export function previousPeriod(period: string): string {
  const { months } = rocPeriodOf(period); // 借用它的格式與奇數月驗證
  const year = Number(months[0].slice(0, 4));
  const startMonth = Number(months[0].slice(5, 7));
  return startMonth === 1 ? `${year - 1}11` : `${year}${String(startMonth - 2).padStart(2, "0")}`;
}

/** 該年月的天數。閏年：四年一閏、百年不閏、四百年再閏 */
export function lastDayOfMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * B2C 發票總額（內含稅）拆為申報用銷售額與稅額：
 * 稅額 ＝ 總額 ÷ (1＋徵收率) × 徵收率，四捨五入；銷售額 ＝ 總額 − 稅額。
 *
 * ⚠️ `rate` 的預設值是**回退值**，不是「正確的徵收率」——它是本系統在稅法參數功能出現前
 * 一直在用的那個數字，留著只是為了讓這支純函式在沒有呼叫端上下文時仍可測。
 * 服務層（apps/api/src/services/vat.ts）一律依**該張發票自己的日期**解析費率後明確傳入。
 */
export function splitB2CTotal(total: number, rate = 0.05): { salesAmount: number; taxAmount: number } {
  if (!Number.isInteger(total) || total < 0) throw new Error(`總額須為非負整數: ${total}`);
  const taxAmount = Math.round((total / (1 + rate)) * rate);
  return { salesAmount: total - taxAmount, taxAmount };
}
