import type { Dictionary } from "@tw-erp/core";

export const vat: Dictionary = {
  "公司稅籍編號或縣市別未設定（PUT /company-profile）": "Company tax registration number or city code is not set (PUT /company-profile)",
  "公司基本檔標記為「兼營免稅／特種稅額」：兼營的營業稅申報要用 403 申報書（含不得扣抵比例計算），本系統目前只支援 401（專營應稅），不產出 401 以免錯用申報書類別。請以財政部申報軟體或洽記帳士辦理 403 申報；若貴公司實為專營應稅，請到「設定」頁取消該標記": "The company profile is flagged as \"mixed taxable/exempt (special tax) business\". Mixed businesses must file a VAT return on Form 403 (including the non-deductible ratio calculation). This system only supports Form 401 (fully taxable), so no 401 file is produced to avoid filing on the wrong form. File Form 403 with the MOF filing software or through your bookkeeper; if your company is actually fully taxable, clear the flag on the Settings page",
  "進項發票之供應商缺少統一編號": "The supplier on an input invoice has no Tax ID",
  "申報人身分證統一編號超過 10 碼或含全形字元，請到「設定」頁公司基本檔更正": "The filer's National ID exceeds 10 characters or contains full-width characters. Correct it in the company profile on the Settings page",
  "期別 {period} 已有申報紀錄（#{id}）。更正申報請先刪除該期紀錄（只能刪最新一期）再重新存檔——刪除後其後期別的留抵承轉會跟著改變，請依期別順序重存": "A VAT return already exists for period {period} (#{id}). To file an amendment, delete that period's record first (only the latest period can be deleted), then save again. Deleting it changes the carried-forward credit for later periods, so re-save them in period order",
  "已存在較晚期別（{later}）的申報紀錄，不可回頭補存 {period}——較晚期別的上期留抵已經定案，往回插一期會讓它失去來歷。若順序真的錯了，請從最新一期開始逐期刪除後依序重存": "A VAT return for a later period ({later}) already exists, so {period} cannot be saved retroactively. The later period's opening credit is already fixed; inserting an earlier period would break its lineage. If the order is really wrong, delete returns one period at a time starting from the latest, then re-save them in order",
  "期別 {period} 沒有申報紀錄": "No VAT return found for period {period}",
  "期別 {later} 的申報紀錄以 {period} 的期末留抵為基礎，不可先刪除 {period}。請從最新一期開始逐期刪除": "The VAT return for period {later} is based on the closing credit of {period}, so {period} cannot be deleted first. Delete returns one period at a time starting from the latest",
};
