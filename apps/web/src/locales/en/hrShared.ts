import type { Dictionary } from "@tw-erp/core";

export const hrShared: Dictionary = {
  // KIND_LABELS
  "請假": "Leave",
  "加班": "Overtime",
  "補卡": "Punch correction",
  // STATUS_LABELS
  "簽核中": "Pending approval",
  "已駁回": "Rejected",
  "已取消": "Canceled",
  // DAY_TYPE_LABELS
  "平日": "Workday",
  "休息日": "Rest day",
  "例假日": "Regular day off",
  "國定假日": "Public holiday",
  // fmtMinutes / requestSummary
  "{h} 時": "{h}h",
  "{h} 時 {r} 分": "{h}h {r}m",
  "{name} {span}（{dur}）": "{name} {span} ({dur})",
  "？": "?",
  "{date} {dayType}（{dur}）": "{date} {dayType} ({dur})",
  "{date} 上班卡補 {time}": "{date} clock-in correction to {time}",
  "{date} 下班卡補 {time}": "{date} clock-out correction to {time}",
};
