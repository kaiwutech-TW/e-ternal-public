import type { Dictionary } from "@tw-erp/core";

export const attendance: Dictionary = {
  "attendance_settings 沒有預設列（migration 0039 應已建立）": "attendance_settings has no default row (migration 0039 should have created it)",
  "這個網路位置不在允許打卡的範圍內（限公司網路）。在外面工作請改送補卡申請，或請管理者調整出勤設定的 IP 白名單": "This network location is not allowed for clocking in/out (company network only). If you are working off-site, submit a punch correction instead, or ask an admin to update the IP allowlist in attendance settings",
  "班別不存在: {id}": "Shift not found: {id}",
  "班別已停用: {code} {name}": "Shift is inactive: {code} {name}",
  "一次最多排 92 天（本次 {n} 天）——請確認起迄日期沒打錯，要更長請分次": "You can schedule at most 92 days at a time (this request: {n} days). Check the start and end dates, or split the range into batches",
  "迄日（{to}）不可早於起日（{from}）": "End date ({to}) cannot be earlier than start date ({from})",
  "月份格式須為 YYYY-MM（收到「{month}」）": "Month must be in YYYY-MM format (received \"{month}\")",
};
