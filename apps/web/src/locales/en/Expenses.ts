import type { Dictionary } from "@tw-erp/core";

export const Expenses: Dictionary = {
  // --- 掃描結果提示（scanAdvice / blankSurfaceAdvice）---
  "照片已存，但這張照片裡有不只一張發票（掃到 {n} 個電子發票 QR 左碼）——請一張一張拍，一張照片只放一張發票。系統不替你挑一張：挑錯就是把另一張發票的號碼與金額安到這筆明細上，而畫面上看不出來。這一筆的發票欄位先留空，重拍上傳後會重新辨識。":
    "Photo saved, but it contains more than one invoice ({n} e-invoice left QR codes found). Please photograph one invoice per photo. The system will not pick one for you: picking the wrong one would attach another invoice's number and amount to this line without any visible sign. The invoice fields on this line are left blank; re-upload to scan again.",
  "照片已存，但掃到的 QR 裡沒有電子發票證明聯的左碼——發票號碼、日期、金額都在「左邊」那個 QR 裡，這張可能只拍到右邊那個（右碼放的是品項明細的接續），也可能掃到的是別的 QR。請把左邊那個 QR 一起拍進去、拍大一點正一點，再上傳一次。這張本來就不是電子發票的話，直接手動填金額即可：這筆的發票欄位留空、先不勾可扣抵，可扣抵性由伺服端依你的稅法參數與憑證判定。":
    "Photo saved, but none of the QR codes found is the left QR of an e-invoice receipt. The invoice number, date and amount live in the left QR; this photo may show only the right one (which carries the item detail continuation), or an unrelated QR. Include the left QR, shoot it larger and straighter, and upload again. If this is not an e-invoice, just enter the amount manually: leave the invoice fields blank and the deductible box unchecked for now; the server decides deductibility from your tax parameters and the source document.",
  "照片已存，但整張影像解過一次之後沒有解出任何 QR——請手動填金額：這筆的發票欄位留空、先不勾可扣抵，可扣抵性由伺服端依你的稅法參數與憑證判定。解不出來多半是 QR 太小、太糊或反光（辨識讀的是整張影像，不是只看某幾塊）：這張如果是電子發票，把左邊那個 QR 拍大一點、正一點再試一次。":
    "Photo saved, but no QR code could be decoded from the whole image. Enter the amount manually: leave the invoice fields blank and the deductible box unchecked for now; the server decides deductibility from your tax parameters and the source document. Decoding usually fails because the QR is too small, blurry or glaring (the whole image is scanned, not just certain regions). If this is an e-invoice, shoot the left QR larger and straighter and try again.",
  "掃到電子發票 QR，但欄位沒解出來——請手動填金額，並把這張照片回報給維護者。":
    "An e-invoice QR was found but its fields could not be parsed. Enter the amount manually and report this photo to the maintainer.",
  "照片已存，但辨識時從畫布取回的像素整片同色（一個像素的差別都沒有，等於什麼影像內容都沒拿到）——這張照片的解析度可能超過瀏覽器單張畫布能處理的上限，於是取回的是空白而不是照片，系統因此看不到上面的 QR。請改用截圖、或用較小的尺寸重拍一次再上傳；這一筆的發票欄位先留空、金額請手動填。系統不自動把照片縮小再試：縮小會糊掉小的 QR，那會把「掃不到」換成「掃錯一張」，後者在畫面上看不出來。":
    "Photo saved, but the pixels read back from the canvas during scanning were a single flat colour (not one pixel differed, i.e. no image content was received). This photo's resolution may exceed what the browser can handle on a single canvas, so a blank was returned instead of the photo and the system could not see the QR. Use a screenshot or re-shoot at a smaller size and upload again; the invoice fields on this line are left blank, please enter the amount manually. The system does not shrink the photo and retry on its own: shrinking blurs small QR codes, turning \"no scan\" into \"wrong invoice scanned\", which is invisible on screen.",

  // --- 掃描成功／清除辨識結果 ---
  "已辨識：發票 {no}（{date}）${amount}。": "Recognised: invoice {no} ({date}) ${amount}. ",
  "QR 上的買方統編與公司基本檔相同，這筆先勾可扣抵。": "The buyer Tax ID on the QR matches the company profile, so this line is marked deductible for now. ",
  "公司基本檔還沒填統編，這裡沒有東西可以比對，這筆先不勾可扣抵。": "The company profile has no Tax ID yet, so there is nothing to compare against; this line is left non-deductible for now. ",
  "QR 上的買方統編是 {buyer}、公司基本檔是 {company}，兩者不同，這筆先不勾可扣抵。": "The buyer Tax ID on the QR is {buyer} but the company profile says {company}; they differ, so this line is left non-deductible for now. ",
  "QR 上沒有買方統編，這筆先不勾可扣抵。": "The QR carries no buyer Tax ID, so this line is left non-deductible for now. ",
  "送出後由伺服端自己解析這張 QR 的原文、自己比對買方統編，並依你在「稅法參數」頁設定的值決定落地的稅額。": "On submit the server parses the raw QR itself, checks the buyer Tax ID itself, and sets the final tax amount from the values on your Tax Parameters page.",
  "已清除這張憑證的辨識結果：發票欄位與金額改以你填的為準，伺服端不會再拿那張 QR 的原文跟你填的內容交叉核對，這筆也不再主張可扣抵。要恢復辨識請重新上傳這張憑證的照片。":
    "Scan result cleared for this document: the invoice fields and amount now follow what you enter, the server will no longer cross-check the raw QR against your entries, and this line no longer claims deductibility. Re-upload the photo to scan it again.",
  "已清除這筆的辨識結果，請再按一次送出": "Scan result cleared for this line; press Submit again",

  // --- 選檔護欄（batchSelectionIssue）---
  "一次最多 {max} 張：這張單上已經有 {existing} 張帶著照片的明細，這次又選了 {picked} 張，加起來 {total} 張。張數是這樣來的——收據縮圖是 base64 存進資料庫、跟著同一個 POST 一起送，實測最大的一張是 {worstKb} KB，單次送出的預算 {budget}，所以 {max} 張是「一定塞得下」的張數——縮圖會縮成多大要等真的縮出來才知道，這裡只能取保守值。請分批送出（先送這 {max} 張，核准與否互不影響）。":
    "At most {max} photos at a time: this claim already has {existing} lines with photos, and you selected {picked} more, for {total} in total. Where the limit comes from: receipt thumbnails are stored as base64 and sent in the same POST; the largest measured is {worstKb} KB and the per-submit budget is {budget}, so {max} is the count that is guaranteed to fit. A thumbnail's size is only known after it is made, so this is a conservative figure. Please submit in batches (send these {max} first; approval of each batch is independent).",
  "「{name}」是 {got}，超過單張 {cap} 的上限。辨識要把整張照片展開成未壓縮的像素（約是檔案的十幾倍），這一張展開後會把分頁的記憶體吃光。請用手機相簿的「縮小尺寸」或截圖後再上傳。":
    "\"{name}\" is {got}, over the {cap} limit per photo. Scanning expands the whole photo into uncompressed pixels (roughly 10x+ the file size), and this one would exhaust the tab's memory. Use your phone's \"reduce size\" option or a screenshot, then upload again.",
  "這次選的 {n} 張加起來 {got}，超過單批 {cap} 的上限。這一批是一張一張依序辨識的，這個大小大概要跑十幾秒以上。請分成兩批選。":
    "The {n} photos selected total {got}, over the {cap} limit per batch. Photos are scanned one by one, and this size would take well over ten seconds. Please select them in two batches.",

  // --- 批次結果（batchOutcomeMessage / buildBatchItems）---
  "，另有 {n} 張沒有讀進來（畫面上各留了一列寫著原因——要留就自己填金額與分類，不要就按「刪除這筆」）": "; {n} more could not be read (each left a line on screen stating why; keep it by entering the amount and category yourself, or press \"Delete this line\")",
  "有底色標記的那幾筆是沒有辨識成功的，訊息裡寫著原因。": "Highlighted lines were not recognised; the message on each states why.",
  "這批帶了 {n} 張{unreadableClause}，其餘 {skipped} 張因為總量超過上限沒有帶入（{names}）——收據縮圖跟著同一個 POST 一起送，這一批的縮圖加起來已經到單次送出的預算（{budget}）。請先把這批送出，再選剩下的那幾張。{tail}":
    "Imported {n} photos{unreadableClause}; the remaining {skipped} were not imported because the total exceeded the limit ({names}). Receipt thumbnails are sent in the same POST, and this batch has reached the per-submit budget ({budget}). Submit this batch first, then select the rest. {tail}",
  "已帶入 {n} 張{unreadableClause}——{tail}": "Imported {n} photos{unreadableClause}. {tail}",
  "表單上已經有的明細": "a line already on the form",
  "{file}：掃到的發票號碼 {no} 與{where}相同，同一個發票號碼在同一張報銷單上只能有一筆——這一筆的發票欄位與金額沒有帶入。重複選到同一個檔案就把這一筆刪掉；確定是兩張不同的發票就自己填，並回報給維護者。":
    "{file}: invoice number {no} is the same as {where}. An invoice number may appear only once per expense claim, so this line's invoice fields and amount were not imported. If you selected the same file twice, delete this line; if these really are two different invoices, fill it in yourself and report it to the maintainer.",
  "這一批的「{file}」": "\"{file}\" in this batch",
  "{file}：{note}": "{file}: {note}",
  "{file}：這張沒有讀進來（{reason}），照片與發票欄位都是空的。同一批的其他張不受影響。這一筆要留就自己填金額與分類，不要就按「刪除這筆」。":
    "{file}: could not be read ({reason}); the photo and invoice fields are empty. The other photos in this batch are unaffected. Keep this line by entering the amount and category yourself, or press \"Delete this line\".",

  // --- 稅額來源 ---
  "憑證所載的銷售額回推": "derived from the sales amount on the document",
  "你設定的稅率回推": "derived from your configured tax rate",
  "已記下發票 {no} 要用「{source}」的稅額，請再按一次送出": "Noted: invoice {no} will use the tax amount \"{source}\". Press Submit again.",
  "{source}：{amount} 元": "{source}: NT${amount}",
  "這張發票的進項稅額有兩個來源、數字不一樣，請選一個（沒選就不送出——系統不替你決定哪個數字進 401）：": "This invoice's input VAT has two sources with different figures. Pick one (nothing is submitted until you do; the system will not decide which figure goes into the VAT return for you):",
  "「{voucher}」＝總額減掉 QR 上載的銷售額；「{rate}」＝依你在「稅法參數」頁設定的營業稅率換算。QR 的加密驗證區本系統尚未驗證，可機讀不等於已驗真。": "\"{voucher}\" = total minus the sales amount carried on the QR; \"{rate}\" = calculated at the VAT rate set on your Tax Parameters page. This system has not verified the QR's encrypted validation block; machine-readable does not mean authenticated.",
  "這筆的稅額指定用「{source}」": "Tax amount for this line set to \"{source}\"",

  // --- 表單 ---
  "請選擇報銷人": "Please select a claimant",
  "你的帳號尚未連結員工主檔，請請管理者到「設定」頁連結": "Your account is not linked to an employee record. Ask an admin to link it on the Settings page.",
  "至少一筆有效明細（選分類、填金額）": "At least one valid line is required (choose a category and enter an amount)",
  "報銷單 #{id} 已修改重送，等會計核准": "Expense claim #{id} revised and resubmitted; awaiting approval by Finance",
  "報銷已送出，等會計核准": "Expense claim submitted; awaiting approval by Finance",
  "已帶入原單的收據影像（要換再重新上傳即可）": "Receipt image carried over from the original claim (upload again to replace it)",
  "修改被退回的報銷單 #{id}（送出後重新送審）": "Revise rejected expense claim #{id} (resubmits for approval)",
  "我要報銷（拍照或選檔，電子發票會自動辨識）": "New expense claim (take a photo or choose a file; e-invoices are recognised automatically)",
  "原單明細（含收據影像）已帶入，改完按送出即回到待核准。": "The original lines (including receipt images) have been loaded; edit and submit to return it to pending approval.",
  "取消修改": "Cancel revision",
  "報銷人（可代同事送件）": "Claimant (you may submit on behalf of a colleague)",
  "— 本人 —": "— Myself —",
  "報銷人：{name}": "Claimant: {name}",
  "日期": "Date",
  "誰先出的錢": "Who paid",
  "員工代墊（核准後公司付款還我）": "Employee paid (company reimburses after approval)",
  "公司支付（公司卡／公司帳戶，不必還款）": "Company paid (company card / account, no reimbursement)",
  "公司卡或公司帳戶付的費用也要從這裡報，進項稅才會進 401 申報。核准時由財務指定付款科目（現金科目或公司卡的負債科目），核准即入帳完成，不再有付款步驟。": "Expenses paid by company card or company account must also be claimed here so their input VAT reaches the VAT return. On approval, Finance picks the payment account (a cash account or the company card's liability account); approval posts the entry and there is no separate payment step.",
  "你的帳號尚未連結員工主檔，送出會失敗——請請管理者到「設定」頁的使用者管理連結員工。": "Your account is not linked to an employee record, so submitting will fail. Ask an admin to link it under User management on the Settings page.",
  "單據照片": "Receipt photo",
  "這筆是什麼": "Category",
  "— 請選擇 —": "— Select —",
  "{label}（{hint}）": "{label} ({hint})",
  "金額（發票上的總額）": "Amount (invoice total)",
  "說明（選填）": "Description (optional)",
  "＋再加一張": "+ Add another",
  "這筆帶著掃到的發票 QR 原文（伺服端從它導出進項稅額，並核對發票號碼／日期／賣方統編／總額四欄）。": "This line carries the raw invoice QR that was scanned (the server derives the input VAT from it and cross-checks invoice number, date, seller Tax ID and total).",
  "　剛才送出被伺服端擋下（422）：這四欄裡有欄位與 QR 對不起來（上面那行寫的是哪一欄、兩邊各是什麼）。兩條路——把欄位改回 QR 上的數字，或按這裡清掉這張憑證的辨識結果、改用你自己填的（清掉之後這筆不再主張可扣抵）：": " The server rejected the last submit (422): one of these four fields does not match the QR (the line above says which field and what each side holds). Two ways forward: change the field back to the value on the QR, or click here to clear this document's scan result and use your own entries (this line will then no longer claim deductibility):",
  "修改並重新送審": "Revise and resubmit",
  "送出報銷": "Submit claim",

  // --- 待付彙總 ---
  "待付報銷（公司欠員工 {amount} 元，共 {count} 件）": "Unpaid claims (company owes employees NT${amount}, {count} claims)",
  "員工": "Employee",
  "件數": "Claims",
  "未付金額": "Unpaid amount",
  "只計員工代墊（approved 未付款、未作廢）的單；公司支付的報銷核准即付清，不在此列。": "Counts only employee-paid claims (approved, unpaid, not voided); company-paid claims are settled on approval and are not listed.",

  // --- 清單 ---
  "報銷單（會計：核准後拋轉費用傳票；付款沖其他應付款）": "Expense claims (Finance: approval posts the expense voucher; payment clears other payables)",
  "我的報銷單": "My expense claims",
  "還沒有人送出報銷單": "No expense claims submitted yet",
  "你還沒有報銷單": "You have no expense claims yet",
  "同事墊付的費用用上面的表單送出。電子發票直接拍照或選檔，金額與稅額會自動辨識，不用自己打。": "Submit expenses paid by colleagues with the form above. For e-invoices, just take a photo or choose a file; the amount and tax are recognised automatically.",
  "還沒有員工名冊——報銷單要指定申請人，先到「客戶與商品」把會報帳的同事建起來。": "No employee list yet. Expense claims need a claimant; first add the colleagues who will claim expenses under Contacts & Products.",
  "去建立員工": "Add employees",
  "總額": "Total",
  "可扣抵稅額": "Deductible VAT",
  "狀態": "Status",
  "（公司支付）": " (company paid)",
  "已作廢": "Voided",
  "待核准": "Pending approval",
  "已核准待付款": "Approved, awaiting payment",
  "已退回": "Rejected",
  "已付款": "Paid",
  "明細": "Details",
  "修改重送": "Revise & resubmit",
  "核准": "Approve",
  "付款科目（公司帳戶或卡）": "Payment account (company account or card)",
  "確認核准": "Confirm approval",
  "取消": "Cancel",
  "退回原因": "Reject reason",
  "確認退回": "Confirm rejection",
  "付款科目": "Payment account",
  "付款日期（傳票以這一天入帳）": "Payment date (the voucher is posted on this date)",
  "確認付款": "Confirm payment",
  "作廢": "Void",
  "作廢理由": "Void reason",
  "確認作廢": "Confirm void",

  // --- 明細卡 ---
  "報銷單 #{id}（{name}）": "Expense claim #{id} ({name})",
  "這張單的稅額說明（伺服端依已落地的欄位重建，不是重算——重算會跟著之後改過的稅率參數跑）：": "Tax notes for this claim (rebuilt by the server from the stored fields, not recalculated; a recalculation would follow any later change to the tax rate parameters):",
  "分類": "Category",
  "說明": "Description",
  "單據": "Document",
  "發票號碼": "Invoice no.",
  "金額": "Amount",
  "稅額來源": "Tax source",
  "收據": "Receipt",
  "其他": "Other",
  "報銷單{claim}-明細{item}": "claim{claim}-line{item}",
  "下載憑證": "Download document",

  // --- DeductibleNote（句子被 <strong> 切成片段，英文照順序拼回一句）---
  "這一類在": "On ",
  "（本單日期）判定為": " (this claim's date), this category counts as ",
  "可扣抵": "deductible",
  "不可扣抵": "non-deductible",
  "進項稅": " input VAT",
  "，依據": ", per ",
  "你在「稅法參數」頁設定的值": "the value you set on the Tax Parameters page",
  "（{from} 起": " (from {from}",
  "～{to}": " to {to}",
  "，仍有效": ", still in effect",
  "；依據來源：{note}": "; source: {note}",
  "；未註明依據來源": "; no source noted",
  "）。": ").",
  "，用的是": ", using the ",
  "系統預設值（尚未經查證）": "system default (not yet verified)",
  "。": ".",
  "若你查證後認為不對，可到": "If your own research says otherwise, open the",
  "稅法參數": "Tax Parameters",
  "頁覆寫它並留下依據；": "page to override it and record your source; ",
  "已建立的報銷單稅額不會回頭重算": "tax on existing expense claims will not be recalculated",
  "若你查證後認為不對，請告知財務——他可以在「稅法參數」頁覆寫並留下依據。": "If your own research says otherwise, tell Finance; they can override it on the Tax Parameters page and record the source.",
};
