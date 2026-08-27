import type { Dictionary } from "@tw-erp/core";

export const purchaseOrders: Dictionary = {
  "交易對象不存在: {id}": "Contact not found: {id}",
  "非供應商: {name}": "Not a supplier: {name}",
  "採購單不存在: {id}": "Purchase order not found: {id}",
  "採購單 #{id} 已結案（結案＝到此為止，剩餘量不再收貨），不可收貨。要繼續進貨請開一張新採購單": "Purchase order #{id} is closed (closed = no further receipts against the remaining quantity) and cannot receive goods. Create a new purchase order to continue purchasing.",
  "採購單 #{id} 已取消（取消＝這張單從沒發生），不可收貨。要進貨請開一張新採購單": "Purchase order #{id} is canceled (canceled = treated as never issued) and cannot receive goods. Create a new purchase order to purchase.",
  "沒有可收貨的明細": "No lines to receive",
  "採購單明細不存在: {id}": "Purchase order line not found: {id}",
  "收貨量必須大於 0（明細 {id}）": "Received quantity must be greater than 0 (line {id})",
  "收貨量超過剩餘量: 明細 {id} 剩 {remaining}，欲收 {qty}": "Received quantity exceeds the remaining quantity: line {id} has {remaining} remaining, attempted to receive {qty}",
  "僅未收貨的採購單可取消（取消＝這張單從沒發生；目前 {status}）。已有收貨的採購單請改用「結案」（結案＝到此為止：已收貨的進貨單與憑證留著，剩餘量不再收）；收錯的貨請先到進貨頁作廢該張進貨單": "Only purchase orders with no receipts can be canceled (canceled = treated as never issued; current status: {status}). For orders with receipts, use \"Close\" instead (closed = stop here: received purchase invoices and vouchers are kept, the remaining quantity is no longer received). If goods were received in error, void that purchase invoice on the Purchases page first.",
  "採購單 #{id} 已於 {date} 短交結案（原因：{reason}），不可再結案": "Purchase order #{id} was short-closed on {date} (reason: {reason}) and cannot be closed again",
  "採購單 #{id} 已全數收訖、自動結案，不需再結案": "Purchase order #{id} was fully received and closed automatically; no further close is needed",
  "採購單 #{id} 已取消（取消＝這張單從沒發生），沒有可結案的內容": "Purchase order #{id} is canceled (canceled = treated as never issued); there is nothing to close",
};
