import type { Dictionary } from "@tw-erp/core";

export const period: Dictionary = {
  "{period} 已關帳（帳務關至 {through}），如需調整請先重開該期間": "{period} is closed (books closed through {through}). Reopen the period before making changes.",
  "可扣抵發票（{invoiceNumber}）的日期 {invoiceDate} 屬於已關帳期間（帳務關至 {through}）。進項稅額以發票日期歸入 401 期別，核准會把稅額加進可能已申報的那一期——請先到「報表」頁重開該期間，或把這筆改為不可扣抵": "Deductible invoice ({invoiceNumber}) is dated {invoiceDate}, which falls in a closed period (books closed through {through}). Input VAT is assigned to the Form 401 period by invoice date, so approving would add tax to a period that may already be filed. Reopen the period on the Reports page, or mark this item non-deductible.",
  "月結檢查未通過：{details}": "Month-end close checks failed: {details}",
  "沒有已關帳的期間": "No closed periods.",
  "{year} 年度已結轉（傳票 #{entryId}），重開該年度期間前請先聯絡記帳士處理結轉分錄": "Fiscal year {year} has already been closed (journal voucher #{entryId}). Contact your accountant about the closing entry before reopening a period in that year.",
  "年度結轉前須先關帳至 {year}-12（目前關至 {through}）": "Close the books through {year}-12 before running the year-end close (currently closed through {through}).",
  "{year} 年度已結轉（傳票 #{entryId}）": "Fiscal year {year} has already been closed (journal voucher #{entryId}).",
  "{year} 年度無損益資料可結轉": "No profit-and-loss data to close for fiscal year {year}.",
};
