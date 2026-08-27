/** 多個服務共用的錯誤句。index 最後 spread，統一的值在這裡勝出。 */
import type { Dictionary } from "@tw-erp/core";

export const common: Dictionary = {
  // --- 跨頁統一詞（scripts/i18n-scan.mjs 衝突偵測後裁定；各頁字典不得再定義這些 key）---
  "公司基本檔未設定（PUT /company-profile）": "Company profile is not set up (PUT /company-profile)",
  "帳號或密碼錯誤": "Incorrect username or password",
  "公司基本檔未設定": "Company profile is not set up",
  "科目未初始化: {code}（請重跑 migrate/seed）": "Account not initialized: {code} (re-run migrate/seed)",
  "期間格式須為 YYYY-MM": "Period must be in YYYY-MM format",
  "科目未初始化: {code}": "Account not initialized: {code}",
  "{code} {name} 不是現金科目，不能當付款科目（若這是銀行帳戶，請到「會計科目」頁把它勾選為現金科目，付出的錢才會進現金流量表）": "{code} {name} is not a cash account and cannot be used as the payment account (if this is a bank account, mark it as a cash account on the Chart of Accounts page so payments flow into the cash flow statement)",
};
