-- 加班費率補「固定時數計」模式（golden sample 對數字的產物，2026-08-13）
--
-- 實機考察＋2026-07 薪資單逐筆核對發現兩件事：
-- 1. 級距是**按日（按單）**套用的，不是按月合計——兩天各 2 小時是「兩次第一級」，
--    不是「4 小時＝第一級＋第二級」。這在服務層修（services/payroll.ts）。
-- 2. 某些日型的第一級距是「以固定時數計」（工作未滿仍按整段給付）需要新欄位：
--    fixed_minutes 非 NULL 時，該級距不看實際分鐘，一律以 fixed_minutes 計酬。
ALTER TABLE overtime_rates ADD COLUMN fixed_minutes integer;
