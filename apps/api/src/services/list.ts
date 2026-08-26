/**
 * 清單查詢的共用形狀（R3）。
 *
 * 九個主要清單端點（sales/purchases/invoices/journal-entries/expense-claims/
 * cash-docs/quotes/orders/purchase-orders）都收同一組參數：
 * - from / to：日期範圍（各端點各自對「單據日期」欄位，含兩端）
 * - partnerId：交易對象（有對象的單據才收；發票、傳票、報銷沒有）
 * - limit / offset：分頁。**回應形狀不變（仍是陣列）**，總筆數放 X-Total-Count 標頭——
 *   既有前端與 agent 腳本直接吃陣列的地方一行都不用改，要分頁的呼叫端自己讀標頭。
 *
 * 預設 limit 200：第二年起的清單頁不再是「全表撈出來 Ctrl+F」；
 * 參數驗證（格式、from<=to、上限）在路由層的 listQuery()（app.ts）。
 */
export interface ListFilter {
  from?: string | undefined;
  to?: string | undefined;
  partnerId?: number | undefined;
  limit: number;
  offset: number;
}

/** 服務層清單的回傳形狀：rows 原樣給路由當陣列回，total 進 X-Total-Count */
export interface ListResult<T> {
  rows: T[];
  total: number;
}
