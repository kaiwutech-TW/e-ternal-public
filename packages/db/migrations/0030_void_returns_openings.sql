-- 作廢層蓋到退回／折讓單與期初應收付單（第三批第 2 站；欄位形狀照 0025）。
--
-- 為什麼補這三張表：0025 的作廢層涵蓋了六種單據，但退回折讓單與期初單建錯了仍然改不掉——
-- 退回單打錯數量只能「再開一張反向的？」（沒有這種單），期初單金額打錯只能用手工傳票救總帳
-- （但 partner-balances／帳齡／收付款沖銷清單只讀單據表，永遠不動）。
-- 折讓單的作廢入口同時是 G0501 作廢折讓證明單 XML 的前提（allowance-xml.ts 檔頭 TODO）。
--
-- 統一原則同 0025（更正＝作廢＋重開）：
-- * 已拋轉傳票 → 產反向傳票（reversal_entry_id），原單標 voided_at／voided_by／void_reason，永不刪除。
-- * 退回單（kind=return）作廢要回沖庫存：銷退作廢＝把回補的貨再沖出去（在庫不足 409——
--   退回來的貨可能又賣掉了）；進退作廢＝把沖出的貨按原成本補回來。
--   折讓單（kind=allowance）銷貨端本來就不動庫存；進貨端折讓寫過 qty=0 的金額異動
--   （沖 1301 帳面），作廢時同樣反向補回——分錄沖了、庫存明細帳不跟上，兩邊會靜默對不起來。
-- * 關帳鎖與銷貨／進貨單同一嚴格度：原單日期（與證明單歸期）所屬期間已關 → 409，
--   不收 voidDate——退回折讓的彙總依 doc_date 歸期、401 減項依 cert_date 歸期，跨期沖轉會回溯
--   改掉可能已申報的數字。期初單不進任何申報檔，跨期沖轉可行，比照收付款單收 voidDate。

-- 銷貨退回／折讓單：作廢後 returnable 餘量回復（priorSaleReturns 排除已作廢單）、
-- 401 減項與 G0401 批次排除；已作廢且有證明單號碼的折讓單改產 G0501 作廢訊息
ALTER TABLE sales_returns ADD COLUMN voided_at timestamptz;
ALTER TABLE sales_returns ADD COLUMN voided_by integer REFERENCES users(id);
ALTER TABLE sales_returns ADD COLUMN void_reason text;
ALTER TABLE sales_returns ADD COLUMN reversal_entry_id integer REFERENCES journal_entries(id);

-- 進貨退出／折讓單：對稱
ALTER TABLE purchase_returns ADD COLUMN voided_at timestamptz;
ALTER TABLE purchase_returns ADD COLUMN voided_by integer REFERENCES users(id);
ALTER TABLE purchase_returns ADD COLUMN void_reason text;
ALTER TABLE purchase_returns ADD COLUMN reversal_entry_id integer REFERENCES journal_entries(id);

-- 期初應收付單：反向傳票沖 1144／3351（應收）或 3351／2144（應付）形狀。
-- 已被有效收款單沖銷的期初單不可作廢（懸空 409，指路先作廢收付款單）
ALTER TABLE opening_balances ADD COLUMN voided_at timestamptz;
ALTER TABLE opening_balances ADD COLUMN voided_by integer REFERENCES users(id);
ALTER TABLE opening_balances ADD COLUMN void_reason text;
ALTER TABLE opening_balances ADD COLUMN reversal_entry_id integer REFERENCES journal_entries(id);
