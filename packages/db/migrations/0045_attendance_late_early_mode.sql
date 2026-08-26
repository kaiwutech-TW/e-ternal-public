-- 遲到早退的計法是「公司政策形狀」，不只一種（golden sample 第二輪的發現）：
--
--   schedule（預設，現行行為）：與班別表定起訖比——晚進＝遲到、早出＝早退，各吃彈性分鐘。
--   shortfall（補時制）：不看幾點來，只看當日打卡工時（扣休息）補不補得滿表定工時；
--     不足的分鐘數記為早退。golden 公司實測就是這一型——09:46 進 19:26 出不算遲到，
--     10:20 就走的那天記 400 分鐘（表定 480 − 實到 80）。
--
-- 兩種都是合法政策，使用者自選；預設 schedule＝不改變既有部署的行為。
ALTER TABLE attendance_settings
  ADD COLUMN late_early_mode text NOT NULL DEFAULT 'schedule';
