import type { Dictionary } from "@tw-erp/core";

export const documents: Dictionary = {
  "免稅銷售目前開不了單：免稅（兼營）公司申報營業稅要用 403 申報書，本系統只支援 401（專營應稅）。請以官方申報軟體或洽記帳士處理免稅銷售，勿以本系統的應稅／零稅率單據代替":
    "Tax-exempt sales cannot be recorded: businesses with exempt (mixed) sales file VAT on Form 403, and this system only supports Form 401 (fully taxable). Handle tax-exempt sales with the official filing software or your accountant; do not substitute taxable or zero-rated documents here",
  "零稅率單據必須指明「經海關出口」或「非經海關」——兩者在 401 申報書落在不同欄位（經海關＝出口報單；非經海關＝外匯證明等），系統無從替你決定":
    "A zero-rated document must specify whether it was exported through customs or not — the two go in different boxes on Form 401 (through customs = export declaration; not through customs = foreign exchange proof, etc.), and the system cannot decide for you",
  "非零稅率單據不可帶零稅率欄位（經海關註記／證明文件號碼）——請先把課稅別選為零稅率":
    "Zero-rate fields (customs flag / supporting document number) are only allowed on zero-rated documents — set the tax type to zero-rated first",
  "科目未初始化: {accountCode}": "Account not initialized: {accountCode}",
  "交易對象不存在: {id}": "Contact not found: {id}",
  "非供應商: {name}": "Not a supplier: {name}",
  "非客戶: {name}": "Not a customer: {name}",
  "商品不存在: {id}": "Product not found: {id}",
  "付款到期日（{dueDate}）不可早於單據日期（{docDate}）。留空可依供應商付款條件自動推算":
    "Payment due date ({dueDate}) cannot be earlier than the document date ({docDate}). Leave it blank to derive it from the supplier's payment terms",
  "「{name}」是服務項目，不入庫存，進貨單收不了它。外包費用（運費、委外服務）請走「費用報銷」或「傳票」頁入帳；付給個人的委外費用請用「扣繳」頁開支出單":
    "\"{name}\" is a service item and is not stocked, so it cannot go on a purchase invoice. Record outsourced costs (freight, contracted services) via Expense Claims or Journal Vouchers; for payments to individuals, create a payment on the Withholding page",
  "收款到期日（{dueDate}）不可早於單據日期（{docDate}）。留空可依客戶付款條件自動推算":
    "Receipt due date ({dueDate}) cannot be earlier than the document date ({docDate}). Leave it blank to derive it from the customer's payment terms",
  "庫存不足: 商品 {productId} 在庫 {onHand}，欲售 {qty}": "Insufficient stock: product {productId} has {onHand} on hand, {qty} requested",
  "銷貨單不存在: {id}": "Sales invoice not found: {id}",
  "銷貨單不存在: {saleId}": "Sales invoice not found: {saleId}",
  "銷貨單 {saleId} 不是零稅率單據（課稅別 {taxType}），沒有證明文件欄可補登":
    "Sales invoice {saleId} is not zero-rated (tax type {taxType}); it has no supporting document field to fill in",
  "銷貨單 {saleId} 已作廢／沖銷，不可補登證明文件——如仍有這筆外銷，請重開一張正確的單":
    "Sales invoice {saleId} has been voided/reversed; the supporting document cannot be added — if the export still stands, create a new, correct invoice",
  "商品不存在: {productId}": "Product not found: {productId}",
  "「{name}」是服務項目，不入庫存，沒有異動明細帳": "\"{name}\" is a service item and is not stocked; it has no stock movement ledger",
};
