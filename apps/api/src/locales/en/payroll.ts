import type { Dictionary } from "@tw-erp/core";

export const payroll: Dictionary = {
  "員工不存在: {id}": "Employee not found: {id}",
  "{name} 已有 {validFrom} 生效的薪資列（#{id}）。薪資檔是歷次紀錄——填錯的話請新增一列從更正生效日起用，並在備註寫明更正了哪一列": "{name} already has a salary record effective {validFrom} (#{id}). Salary records are a history — to correct a mistake, add a new record effective from the correction date and note which record it replaces.",
  "日型必須是 {types} 之一（收到「{raw}」）": "Day type must be one of {types} (received \"{raw}\")",
  "{dayType}第 {fromMinutes} 分鐘起的費率已存在（#{id}），請先刪除再新增": "An overtime rate for {dayType} starting at minute {fromMinutes} already exists (#{id}). Delete it before adding a new one.",
  "加班費率不存在: {id}": "Overtime rate not found: {id}",
  "月份格式須為 YYYY-MM（收到「{raw}」）": "Month must be in YYYY-MM format (received \"{raw}\")",
  "{month} 已有發薪作業（#{id}，{state}）": "A pay run already exists for {month} (#{id}, {state})",
  "發薪作業不存在: {id}": "Pay run not found: {id}",
  "已定案的發薪作業不可重算——計算快照就是當初發薪的依據": "A finalized pay run cannot be recalculated — its snapshot is the record of what was paid.",
  "薪資明細不存在: {id}": "Payroll item not found: {id}",
  "已定案的發薪作業不可調整": "A finalized pay run cannot be adjusted",
  "這個發薪作業已定案過": "This pay run has already been finalized",
  "發薪作業沒有任何明細，不能定案": "This pay run has no items and cannot be finalized",
  "毛額為 0——所有員工都沒算出薪資（多半是薪資檔沒建），定案沒有意義": "Gross pay is 0 — no employee has a computed salary (usually because no salary records exist). There is nothing to finalize.",
};
