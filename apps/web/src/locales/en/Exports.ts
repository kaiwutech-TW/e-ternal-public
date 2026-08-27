import type { Dictionary } from "@tw-erp/core";

export const Exports: Dictionary = {
  "傳票明細": "Journal entry detail",
  "一列一分錄，含科目與摘要": "One row per entry line, with account and memo",
  "銷項發票": "Output invoices",
  "本系統開立之電子發票（含作廢）": "E-invoices issued by this system (including voided)",
  "全部進貨單，未登錄發票者留空": "All purchase invoices; invoice fields left blank where none was recorded",
  "費用報銷明細": "Expense claim detail",
  "一列一明細，含發票號碼、賣方統編、可扣抵稅額；已作廢的照列並標注":
    "One row per line item, with invoice number, seller Tax ID, and deductible VAT; voided claims are included and flagged",
  "已下載 {name}（{rows} 筆）": "Downloaded {name} ({rows} rows)",
  "此期間（{from} ～ {to}）沒有發票或折讓證明單可匯出。": "No invoices or allowance notes to export for {from} – {to}.",
  "已下載 {n} 個 XML 檔（開立 F0401 {issued} 張、作廢 F0501 {canceled} 張、折讓 G0401 {allowance} 張、作廢折讓 G0501 {allowanceCanceled} 張）。檔名照 MIG 慣例，可直接放入 Turnkey 上傳目錄。":
    "Downloaded {n} XML files (F0401 issued: {issued}, F0501 voided: {canceled}, G0401 allowances: {allowance}, G0501 voided allowances: {allowanceCanceled}). File names follow the MIG convention and can go straight into the Turnkey upload folder.",
  "起日": "From",
  "迄日": "To",
  "CSV 為 UTF-8 含 BOM，Excel 可直接開啟；金額為整數新台幣元。": "CSV files are UTF-8 with BOM and open directly in Excel; amounts are whole NT dollars.",
  "報表": "Report",
  "下載 CSV": "Download CSV",
  "電子發票 XML": "E-invoice XML",
  "期間內全部發票的 F0401＋已作廢者的 F0501＋銷貨折讓的 G0401 與已作廢折讓的 G0501（依證明單日期歸期），逐檔下載（檔名照 MIG 慣例，供 Turnkey 上傳）":
    "F0401 for every invoice in the period, F0501 for voided ones, plus G0401 for sales allowances and G0501 for voided allowances (by allowance note date), downloaded file by file (MIG file naming, ready for Turnkey upload)",
  "下載 XML": "Download XML",
};
