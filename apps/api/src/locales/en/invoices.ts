import type { Dictionary } from "@tw-erp/core";

export const invoices: Dictionary = {
  "期別 {period} 沒有可用的發票號碼（字軌尚未建立或已用完）。請至「設定」頁的「電子發票字軌區間」新增本期核准的區間後再開立":
    "No invoice numbers available for period {period} (the invoice track has not been set up or is used up). Go to Settings → e-Invoice Track Ranges and add the approved range for this period before issuing",
  "捐贈發票（donateMark=1）必須帶捐贈碼 npoban——受贈機構的愛心碼，向對方或財政部愛心碼查詢平台取得":
    "A donated invoice (donateMark=1) requires the donation code (npoban) — the charity's Love Code, available from the charity or the Ministry of Finance Love Code lookup",
  "帶了捐贈碼 npoban 但 donateMark 不是 1——要捐贈請同時帶 donateMark:\"1\"，不捐贈請拿掉 npoban":
    "A donation code (npoban) was given but donateMark is not 1 — to donate, also send donateMark:\"1\"; otherwise remove npoban",
  "銷貨單不存在: {saleId}": "Sales invoice not found: {saleId}",
  "銷貨單 {saleId} 已沖銷，不可開立發票": "Sales invoice {saleId} has been reversed; an e-invoice cannot be issued",
  "銷貨單 {saleId} 已開立發票 {invoiceNumber}": "Sales invoice {saleId} already has e-invoice {invoiceNumber}",
  "銷貨單 {saleId} 的日期 {docDate} 屬於已關帳期間（帳務關至 {through}），開立發票會改掉該期間（可能已申報）的銷項數字。請改以當期日期另開一張銷貨單再開立發票，或先重開該期間並同步處理已申報的 401":
    "Sales invoice {saleId} is dated {docDate}, which falls in a closed period (books closed through {through}). Issuing an e-invoice would change that period's output VAT figures, which may already be filed. Create a new sales invoice dated in the current period and issue from it, or reopen the period and amend the filed VAT return (Form 401)",
  "交易對象不存在: {partnerId}": "Contact not found: {partnerId}",
  "B2B 發票需要買方統編: {name}": "A B2B e-invoice requires the buyer's Tax ID: {name}",
  "資產不存在: {assetId}": "Fixed asset not found: {assetId}",
  "資產 #{assetId}（{name}）已作廢登錄，沒有可開立發票的處分": "Asset #{assetId} ({name}) has been voided; there is no disposal to invoice",
  "資產 #{assetId}（{name}）目前不是已處分狀態——處分發票開的是「處分」這筆銷售，請先執行處分（處分表單可同時勾選開立發票）":
    "Asset #{assetId} ({name}) is not disposed — a disposal invoice bills the disposal sale itself. Dispose of the asset first (the disposal form can issue the invoice at the same time)",
  "資產 #{assetId}（{name}）的處分價款為 0（報廢），沒有銷售額，不需開立發票":
    "Asset #{assetId} ({name}) was disposed for NT$0 (scrapped); there is no sale amount, so no invoice is needed",
  "資產 #{assetId}（{name}）的處分未計銷項稅額（處分時選了不計稅）。本系統發票模組僅支援應稅發票——確屬應稅請先作廢處分、以計稅重新處分後再開立；免稅等其他情形請以外部方式開立並自行併入申報":
    "The disposal of asset #{assetId} ({name}) recorded no output VAT (non-taxable was selected). The invoicing module only supports taxable invoices — if it is taxable, void the disposal, redo it with VAT, then issue; for tax-exempt and other cases, issue the invoice externally and include it in your return yourself",
  "資產 #{assetId} 的處分已開立發票 {invoiceNumber}": "The disposal of asset #{assetId} already has e-invoice {invoiceNumber}",
  "資產 #{assetId} 的處分日 {disposedAt} 屬於已關帳期間（帳務關至 {through}），開立發票會改掉該期間（可能已申報）的銷項數字。請先重開該期間並同步處理已申報的 401":
    "Asset #{assetId} was disposed on {disposedAt}, which falls in a closed period (books closed through {through}). Issuing an e-invoice would change that period's output VAT figures, which may already be filed. Reopen the period first and amend the filed VAT return (Form 401)",
  "發票不存在: {invoiceId}": "E-invoice not found: {invoiceId}",
  "發票已作廢: {invoiceNumber}": "E-invoice already voided: {invoiceNumber}",
  "發票 {invoiceNumber} 的發票日期 {invoiceDate} 屬於已關帳期間（帳務關至 {through}），作廢會改掉該期間（可能已申報）的銷項數字。若貨已退回或雙方議價，請改開「退貨／折讓」單以當期認列；確定要作廢請先重開該期間，並同步處理已申報的 401":
    "E-invoice {invoiceNumber} is dated {invoiceDate}, which falls in a closed period (books closed through {through}). Voiding it would change that period's output VAT figures, which may already be filed. If goods were returned or the price was renegotiated, record a return/allowance note in the current period instead; to void anyway, reopen the period first and amend the filed VAT return (Form 401)",
  "發票 {invoiceNumber} 的發票日期 {invoiceDate} 屬於已關帳期間（帳務關至 {through}），作廢會改掉該期間（可能已申報）的銷項數字。確定要作廢請先重開該期間，並同步處理已申報的 401":
    "E-invoice {invoiceNumber} is dated {invoiceDate}, which falls in a closed period (books closed through {through}). Voiding it would change that period's output VAT figures, which may already be filed. To void anyway, reopen the period first and amend the filed VAT return (Form 401)",
  "發票 {invoiceNumber} 是處分發票（資產 #{assetId}），沒有銷貨單可沖銷——要連動沖回處分請帶 reverseDisposal":
    "E-invoice {invoiceNumber} is a disposal invoice (asset #{assetId}); there is no sales invoice to reverse — to reverse the disposal as well, pass reverseDisposal",
  "發票 {invoiceNumber} 是銷貨發票（銷貨單 #{saleId}），沒有資產處分可沖回——要連動沖銷銷貨單請帶 reverseSale":
    "E-invoice {invoiceNumber} is a sales invoice (sales invoice #{saleId}); there is no asset disposal to reverse — to reverse the sales invoice as well, pass reverseSale",
  "本期（{period}）發票號碼只剩 {remaining} 張可開，用完後將無法開立發票。請儘早至「設定」頁的「電子發票字軌區間」新增區間": "Only {remaining} invoice numbers remain for this period ({period}); once they run out, no invoices can be issued. Add a range under \"E-invoice track ranges\" on the Settings page as soon as possible",
  "這張發票的銷貨單 #{saleId} 是零稅率、但還沒登錄證明文件號碼（經海關＝出口報單號碼；非經海關＝外匯證明文件號碼等）。取得後請到銷貨頁補登，申報零稅率銷售額需以證明文件為依據。": "Sales invoice #{saleId} behind this invoice is zero-rated but has no supporting document number yet (via customs = export declaration number; not via customs = foreign exchange certificate number, etc.). Add it on the Sales page once available; zero-rated sales must be filed with supporting documents.",
  "發票開立日期": "invoice issue date",
  "作廢日期": "void date",
};
