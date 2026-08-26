-- 薪資長尾（之一）：伙食津貼＋遲到早退扣款＋請假扣款應免稅拆分
--
-- ★ 伙食津貼是「每月固定加項」欄位，金額使用者自填（整數元）。
--   它的免稅額度是法定數字——本批**不**內建、不標記、不驗算（長尾另站「免稅上限標記」
--   再處理）；應稅/免稅的拆分僅按「本薪:伙食津貼」比例做算術分攤，不涉法規判斷。
--
-- ★ meal_allowance_in_base：時薪換算基底要不要含伙食津貼，是公司政策
--   （golden sample 公司＝(本薪＋伙食津貼)÷240；也有公司只除本薪）——使用者自選，
--   預設 false＝維持既有行為（只除本薪），絕不靜默改變既有員工的算法。
--
-- ★ 遲到早退扣款＝(遲到＋早退分鐘)×時薪÷60（按分鐘比例，非級距；golden sample 逐筆核對）。
--   快照欄位進 payroll_items，計算明細（含應免稅拆分）照舊整包進 detail。

ALTER TABLE employee_salaries
  ADD COLUMN meal_allowance integer NOT NULL DEFAULT 0,
  ADD COLUMN meal_allowance_in_base boolean NOT NULL DEFAULT false;

ALTER TABLE payroll_items
  ADD COLUMN meal_allowance integer NOT NULL DEFAULT 0,
  ADD COLUMN late_early_deduction integer NOT NULL DEFAULT 0;
