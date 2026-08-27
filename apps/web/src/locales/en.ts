/**
 * 英文字典：key ＝ 中文原句（機制與理由見 packages/core/src/i18n.ts）。
 * 缺的 key 會 fallback 顯示中文，所以這份**只填 demo 路徑會碰到的句子**，其餘慢慢補。
 * 孤兒 key（程式碼已沒人用）用 `node scripts/i18n-scan.mjs` 找。
 */
import type { Dictionary } from "@tw-erp/core";

export const en: Dictionary = {
  // --- 通用 ---
  "語言": "Language",
  "外觀：": "Theme: ",
  "淺色": "Light",
  "深色": "Dark",
  "跟隨系統": "System",
  "儲存": "Save",
  "取消": "Cancel",
  "刪除": "Delete",
  "編輯": "Edit",
  "新增": "New",
  "搜尋": "Search",
  "登出": "Sign out",
  "載入中…": "Loading…",
  "{name} 須在 {min}–{max} 之間": "{name} must be between {min} and {max}",
};
