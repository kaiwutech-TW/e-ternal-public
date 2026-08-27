import type { Dictionary } from "@tw-erp/core";

export const opening: Dictionary = {
  "原單日期 {docDate} 晚於開帳日 {entryDate}——期初欠款必須在開帳日之前就存在。若這是開帳之後的新交易，請開正式的銷貨單／進貨單，不要走期初導入": "Source document date {docDate} is later than the opening date {entryDate}. Opening balances must already exist before the opening date; if this is a new transaction after opening, create a regular sales or purchase invoice instead of an opening-balance import",
  "交易對象不存在: {id}": "Contact not found: {id}",
  "{name} 不是客戶，不能建期初應收（請先到「客戶與商品」頁勾選為客戶）": "{name} is not a customer, so an opening receivable cannot be created (mark them as a customer on the Customers & Products page first)",
  "{name} 不是供應商，不能建期初應付（請先到「客戶與商品」頁勾選為供應商）": "{name} is not a supplier, so an opening payable cannot be created (mark them as a supplier on the Customers & Products page first)",
  "應收/應付或累積盈虧科目未初始化（請重跑 migrate/seed）": "Accounts receivable/payable or retained earnings account is not initialized (re-run migrate/seed)",
};
