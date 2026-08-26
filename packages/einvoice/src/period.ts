/** 字軌期別：雙月為一期，以奇數月起算（例：2026-07 與 2026-08 同屬期別 202607） */
export function periodOf(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(isoDate);
  if (!m) throw new Error(`日期須為 YYYY-MM-DD: ${isoDate}`);
  const year = m[1]!;
  const month = Number(m[2]!);
  if (month < 1 || month > 12) throw new Error(`月份不合法: ${isoDate}`);
  const start = month - ((month - 1) % 2);
  return `${year}${String(start).padStart(2, "0")}`;
}

/**
 * 下一個字軌期別（B7 尾款）：202607 → 202609；202611 → 202701（跨年）。
 * 發票要連號使用，下期開始前要先建好字軌——「下期字軌還沒建」的提醒（Dashboard）
 * 與這裡的期別演算是同一條規則，不在前端另抄一份。
 */
export function nextPeriod(period: string): string {
  const m = /^(\d{4})(\d{2})$/.exec(period);
  if (!m) throw new Error(`期別須為 YYYYMM: ${period}`);
  const month = Number(m[2]!);
  if (month % 2 !== 1 || month > 11) throw new Error(`期別月份須為奇數月（01/03/…/11）: ${period}`);
  return month === 11 ? `${Number(m[1]!) + 1}01` : `${m[1]!}${String(month + 2).padStart(2, "0")}`;
}
