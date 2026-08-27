import type { Dictionary } from "@tw-erp/core";

export const orders: Dictionary = {
  "交易對象不存在: {partnerId}": "Contact not found: {partnerId}",
  "非客戶: {name}": "Not a customer: {name}",
  "報價單不存在: {id}": "Quote not found: {id}",
  "報價單非洽談中（目前 {status}）": "Quote is not open (current status: {status})",
  "報價單已成交，不可再轉訂單": "Quote has already been won and cannot be converted to an order again",
  "報價單已結案，不可再轉訂單": "Quote has been closed and cannot be converted to an order",
  "訂單不存在: {orderId}": "Order not found: {orderId}",
  "訂單 #{orderId} 已結案（結案＝到此為止，剩餘量不再出貨），不可出貨。要繼續交易請開一張新訂單":
    "Order #{orderId} is closed (closed = finished; remaining quantities will not ship) and cannot be shipped. To continue, create a new order",
  "訂單 #{orderId} 已取消（取消＝這張單從沒發生），不可出貨。要交易請開一張新訂單":
    "Order #{orderId} is canceled (canceled = as if it never happened) and cannot be shipped. To proceed, create a new order",
  "沒有可出貨的明細": "No lines to ship",
  "訂單明細不存在: {orderLineId}": "Order line not found: {orderLineId}",
  "出貨量必須大於 0（明細 {orderLineId}）": "Ship quantity must be greater than 0 (line {orderLineId})",
  "出貨量超過剩餘量: 明細 {orderLineId} 剩 {remaining}，欲出 {qty}": "Ship quantity exceeds remaining: line {orderLineId} has {remaining} left, {qty} requested",
  "僅未出貨的訂單可取消（取消＝這張單從沒發生；目前 {status}）。已有出貨的訂單請改用「結案」（結案＝到此為止：已出貨的銷貨單與憑證留著，剩餘量不再出）；出錯的出貨請先到銷貨頁作廢該張銷貨單":
    "Only unshipped orders can be canceled (canceled = as if it never happened; current status: {status}). For orders with shipments, use \"Close\" instead (closed = finished: shipped sales invoices and vouchers stay, remaining quantities will not ship); for a wrong shipment, void that sales invoice on the Sales page first",
  "訂單 #{orderId} 已於 {closedAt} 短交結案（原因：{reason}），不可再結案":
    "Order #{orderId} was short-closed on {closedAt} (reason: {reason}) and cannot be closed again",
  "訂單 #{orderId} 已全數出清、自動結案，不需再結案": "Order #{orderId} was fully shipped and closed automatically; no further close is needed",
  "訂單 #{orderId} 已取消（取消＝這張單從沒發生），沒有可結案的內容": "Order #{orderId} is canceled (canceled = as if it never happened); there is nothing to close",
  "有 {n} 張未收銷貨單沒有收款到期日（客戶未約定付款條件，或是到期日功能上線前的舊單），改以單據日期估算、前 30 天不列入逾期。要精確分桶，請到「客戶與商品」頁補客戶的付款條件天數（之後的新單自動帶入）": "{n} unpaid sales invoices have no due date (the customer has no payment terms, or the invoice predates the due-date feature), so the document date is used instead and the first 30 days are not counted as overdue. For accurate aging buckets, add the customer's payment terms (days) on the Customers & Products page; new invoices will pick them up automatically",
  "有 {n} 張未付進貨單沒有付款到期日（供應商未約定付款條件，或是到期日功能上線前的舊單），改以單據日期估算、前 30 天不列入逾期。要精確分桶，請到「客戶與商品」頁補供應商的付款條件天數（之後的新單自動帶入）": "{n} unpaid purchase invoices have no due date (the supplier has no payment terms, or the invoice predates the due-date feature), so the document date is used instead and the first 30 days are not counted as overdue. For accurate aging buckets, add the supplier's payment terms (days) on the Customers & Products page; new invoices will pick them up automatically",
};
