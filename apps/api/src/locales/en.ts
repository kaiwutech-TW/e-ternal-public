/**
 * API 錯誤訊息英文字典：key ＝ AppError 的中文原句（含 {x} 佔位）。
 * 缺的 key 回中文；只填 demo 路徑會撞到的訊息。孤兒 key 用 `node scripts/i18n-scan.mjs` 找。
 */
import type { Dictionary } from "@tw-erp/core";

export const en: Dictionary = {
  "帳號或密碼錯誤": "Incorrect username or password",
  "sellerTaxId 須為 8 位數字（收到「{value}」）": "sellerTaxId must be 8 digits (got \"{value}\")",
  "網址中的 {name} 必須是正整數（收到「{raw}」）": "{name} in the URL must be a positive integer (got \"{raw}\")",
  "網址中的 {name} 超出範圍（收到「{raw}」）": "{name} in the URL is out of range (got \"{raw}\")",
  "{name} 須為真實存在的日期（YYYY-MM-DD，收到「{v}」）": "{name} must be a real date (YYYY-MM-DD, got \"{v}\")",
  "{name} 須為非負整數（收到「{v}」）": "{name} must be a non-negative integer (got \"{v}\")",
  "{name} 須在 {min}–{max} 之間（收到 {n}）": "{name} must be between {min} and {max} (got {n})",
};
