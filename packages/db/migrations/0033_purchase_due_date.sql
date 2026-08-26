-- 應付帳齡（第三批雜項 ①）：purchases 補付款到期日。
--
-- 為什麼：ap-aging 要照 ar-aging 的規則「帳齡看**到期日**，不是單據日」分逾期桶——
-- 月結 60 天的供應商第 45 天還在「未到期」，貨到付款第 1 天就逾期。sales 的 due_date
-- 在 0022 就補了，purchases 一直沒有對應欄位，應付帳齡連端點都做不出來（gap B9 段實測）。
--
-- 欄位語意照抄 sales.due_date（同一條規則兩邊一致，帳齡函式才能共用）：
--   建單時「逐單覆寫 > 供應商付款條件（doc_date＋payment_term_days）> NULL（未約定）」。
--   NULL＝未約定或本欄位出現前的舊單——帳齡退回以單據日估算並在回應 notes 出聲，
--   系統沒有立場替「未約定」的單據斷言它何時到期。
ALTER TABLE purchases ADD COLUMN due_date date;
COMMENT ON COLUMN purchases.due_date IS '付款到期日（doc_date＋供應商付款條件天數的預設，可覆寫）；NULL＝未約定或 0033 前的舊單，應付帳齡退回以單據日估算';
