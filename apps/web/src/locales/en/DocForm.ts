import type { Dictionary } from "@tw-erp/core";

export const DocForm: Dictionary = {
  "請選供應商": "Select a supplier",
  "請選客戶": "Select a customer",
  "供應商": "Supplier",
  "客戶": "Customer",
  "— 請選擇 —": "— Select —",
  "日期": "Date",
  "{n} 天": "{n} days",
  "收款到期日（留空＝依客戶付款條件：{term}）": "Due date (blank = customer payment terms: {term})",
  "收款到期日（留空＝依客戶付款條件，此客戶未約定）": "Due date (blank = customer payment terms; none set for this customer)",
  "付款到期日（留空＝依供應商付款條件：{term}）": "Due date (blank = supplier payment terms: {term})",
  "付款到期日（留空＝依供應商付款條件，此供應商未約定）": "Due date (blank = supplier payment terms; none set for this supplier)",
  "課稅別": "Tax type",
  "應稅": "Taxable",
  "零稅率（經海關出口）": "Zero-rated (export via customs)",
  "零稅率（非經海關）": "Zero-rated (not via customs)",
  "出口報單號碼（可留空，之後補登）": "Export declaration no. (optional, can be added later)",
  "外匯證明等文件號碼（可留空，之後補登）": "Foreign-exchange proof document no. (optional, can be added later)",
  "系統不驗證文件內容": "The system does not verify the document",
  "零稅率單稅額為 0、收入記「銷貨收入－零稅率」。申報零稅率銷售額需檢附證明文件（經海關＝出口報單；非經海關＝取得外匯證明文件等）——號碼還沒拿到可先開單，之後回到銷貨單列表補登；系統只登錄號碼，不驗證文件真偽。":
    "Zero-rated documents carry 0 tax and post revenue to \"Sales revenue – zero-rated\". Zero-rated sales must be filed with supporting documents (via customs = export declaration; not via customs = foreign-exchange proof, etc.). You can create the document before you have the number and add it later from the sales invoice list; the system only records the number and does not verify the document.",
  "{name} 目前未收餘額 {ar} 元": "{name}: outstanding receivables NT${ar}",
  "／信用額度 {limit} 元": " / credit limit NT${limit}",
  "（未設信用額度）": " (no credit limit set)",
  "——本單未稅 {amount} 元加上未收餘額將超過信用額度，是否續開請自行斟酌（系統不擋）":
    ". This document (NT${amount} before tax) plus outstanding receivables will exceed the credit limit. Proceed at your own discretion; the system will not block it.",
  "商品": "Product",
  "（服務）": " (service)",
  "＋明細": "+ Line",
  "建立進貨單（依單據日期套用你設定的營業稅率、自動拋轉傳票）": "Create purchase invoice (applies the VAT rate you set for the document date and posts the voucher automatically)",
  "建立銷貨單（依單據日期套用你設定的營業稅率、自動拋轉傳票）": "Create sales invoice (applies the VAT rate you set for the document date and posts the voucher automatically)",
};
