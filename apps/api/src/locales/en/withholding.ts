import type { Dictionary } from "@tw-erp/core";

export const withholding: Dictionary = {
  "會計科目不存在: {code}（請到「會計科目」頁新增這個代號，或改填一個已存在的費用科目）": "Account not found: {code}. Add this code on the Chart of Accounts page, or use an existing expense account.",
  "{code} {name} 不是費用類科目，不能當扣繳類別的費用科目（扣繳支出單的借方是認列的費用；若這確實是費用請到「會計科目」頁改它的類別，或改填 6xxx 開頭的費用科目）": "{code} {name} is not an expense account and cannot be used as the expense account for a withholding category. (The debit side of a withholding payment is the recognized expense. If this really is an expense, change its type on the Chart of Accounts page, or use an expense account starting with 6xxx.)",
  "扣繳類別不存在: {id}": "Withholding category not found: {id}",
  "{code} {name} 不是費用類科目，不能當扣繳類別的費用科目": "{code} {name} is not an expense account and cannot be used as the expense account for a withholding category.",
  "未提供要修改的欄位（可改：label、expenseAccountCode、taxRateBp、supplementRateBp、sourceNote、active）": "No fields to update (allowed: label, expenseAccountCode, taxRateBp, supplementRateBp, sourceNote, active).",
  "代扣合計 {withheld} 元超過給付總額 {gross} 元，實付金額會變成負數。請確認給付總額是「未扣繳前的總額」（不是實際匯出去的錢），或調低代扣金額": "Total withheld NT${withheld} exceeds the gross payment NT${gross}, which would make the net amount negative. Make sure the gross amount is the total before withholding (not the amount actually transferred), or reduce the withheld amounts.",
  "扣繳類別已停用: {label}（請在扣繳設定啟用它，或改選其他類別）": "Withholding category is inactive: {label}. Activate it in Withholding settings, or choose another category.",
  "交易對象不存在: {id}": "Contact not found: {id}",
  "{name} 不是個人。扣繳支出單只處理「付款給自然人」的情形（個人房東、個人接案者等），因為年度憑單彙總是依受領人分組的。若他確實是個人，請到「客戶與商品」頁把這筆交易對象改為「個人」（統一編號要清空）；若這筆付款是別的情形而你仍需要記錄代扣，請用「傳票」頁開一張手工傳票（借費用／貸代扣款／貸現金），但那筆不會進入年度彙總": "{name} is not an individual. Withholding payments only cover payments to natural persons (individual landlords, freelancers, etc.), because the annual withholding statement summary is grouped by recipient. If this contact is in fact an individual, mark them as \"Individual\" on the Contacts & Products page (and clear the Tax ID). If this payment is a different situation and you still need to record withholding, create a manual journal voucher on the Journal Vouchers page (debit expense / credit withholding payable / credit cash) — note it will not appear in the annual summary.",
  "科目不存在: {id}": "Account not found: {id}",
  "科目已停用，不可再過帳: {code} {name}（請改選其他現金科目，或先啟用它）": "Account is inactive and cannot be posted to: {code} {name}. Choose another cash account, or activate it first.",
  "扣繳類別「{label}」對應的費用科目 {code} 不存在（請到「會計科目」頁新增它，或在扣繳設定改成別的費用科目）": "The expense account {code} for withholding category \"{label}\" does not exist. Add it on the Chart of Accounts page, or pick a different expense account in Withholding settings.",
  "科目已停用，不可再過帳: {code} {name}（請在扣繳設定把「{label}」改成別的費用科目，或到「會計科目」頁啟用它）": "Account is inactive and cannot be posted to: {code} {name}. Change \"{label}\" to a different expense account in Withholding settings, or activate the account on the Chart of Accounts page.",
  "代扣款科目未初始化（2211／2212），請重新啟動服務讓科目種子灌入": "Withholding payable accounts (2211/2212) are not initialized. Restart the service to seed the accounts.",
};
