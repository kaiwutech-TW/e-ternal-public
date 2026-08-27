/** 跨頁共用（按鈕、狀態詞、側欄）。頁面專屬的句子放同名檔：pages/Expenses.tsx → en/Expenses.ts */
import type { Dictionary } from "@tw-erp/core";

export const common: Dictionary = {
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
