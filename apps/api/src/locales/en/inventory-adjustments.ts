import type { Dictionary } from "@tw-erp/core";

export const inventoryAdjustments: Dictionary = {
  "同一商品在一張調整單裡只能出現一次（請把差異併成一筆）": "A product can only appear once per adjustment (combine the differences into one line).",
  "商品不存在: {id}": "Product not found: {id}",
  "「{name}」是服務項目，不入庫存，沒有可盤點或報廢的數量": "\"{name}\" is a service item; it is not stocked and has no quantity to count or write off.",
  "「{name}」的調整量為 0——沒有差異的商品請直接不列": "Adjustment quantity for \"{name}\" is 0 — leave out products with no difference.",
  "「{name}」的調整量為正數（+{qty}），但原因是{reason}——報廢只會讓庫存變少。多出來的貨請把原因改成「盤點差異」": "Adjustment quantity for \"{name}\" is positive (+{qty}) but the reason is {reason} — write-offs can only reduce stock. For surplus stock, change the reason to \"Count difference\".",
  "「{name}」在庫 {onHand}，欲調減 {qty}——帳上沒有那麼多可以扣。若實際數量就是比帳上少，請用盤點（實盤量填實際數字），系統會算出正確的差異": "\"{name}\" has {onHand} on hand but you are reducing by {qty} — there is not enough on the books. If the actual quantity really is lower, use a stock count (enter the counted quantity) and the system will compute the correct difference.",
  "「{name}」帳上在庫為 {onHand}，沒有移動平均成本可以給盤盈計價。帳上不存在的貨請先建立成本基礎：導入期用「設定」頁的庫存開帳，日常請補登進貨單": "\"{name}\" has {onHand} on hand on the books, so there is no moving-average cost to value the surplus. Establish a cost basis first: use inventory opening balances on the Settings page during onboarding, or record a purchase invoice in day-to-day use.",
  "同一商品在盤點清單裡出現多次——每個商品只填一個實盤量": "A product appears more than once in the count list — enter one counted quantity per product.",
  "實盤量不可為負數（商品 {id}）——最少就是 0": "Counted quantity cannot be negative (product {id}) — the minimum is 0.",
};
