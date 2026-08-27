/** app.ts（路由層）的 AppError 訊息。服務層的句子放同名檔：services/ledger.ts → en/ledger.ts */
import type { Dictionary } from "@tw-erp/core";

export const app: Dictionary = {
  "帳號或密碼錯誤": "Incorrect username or password",
  "sellerTaxId 須為 8 位數字（收到「{value}」）": "sellerTaxId must be 8 digits (got \"{value}\")",
  "網址中的 {name} 必須是正整數（收到「{raw}」）": "{name} in the URL must be a positive integer (got \"{raw}\")",
  "網址中的 {name} 超出範圍（收到「{raw}」）": "{name} in the URL is out of range (got \"{raw}\")",
  "{name} 須為真實存在的日期（YYYY-MM-DD，收到「{v}」）": "{name} must be a real date (YYYY-MM-DD, got \"{v}\")",
  "{name} 須為非負整數（收到「{v}」）": "{name} must be a non-negative integer (got \"{v}\")",
  "{name} 須在 {min}–{max} 之間（收到 {n}）": "{name} must be between {min} and {max} (got {n})",
};
