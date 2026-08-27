import type { Dictionary } from "@tw-erp/core";

export const reports: Dictionary = {
  "科目不存在: {code}": "Account not found: {code}",
  "尚未設定任何現金科目，現金流量表無法計算。請確認系統啟動時有執行科目種子（migrate 腳本），或到「會計科目」頁把現金/銀行科目勾選為現金科目": "No cash accounts are configured, so the cash flow statement cannot be calculated. Make sure the account seed (migrate script) ran at startup, or mark your cash/bank accounts as cash accounts on the Chart of Accounts page.",
};
