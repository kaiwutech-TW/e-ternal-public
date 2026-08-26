-- 主檔欄位補齊：partners／products／employees／sales（gap-analysis-2608 的 B1、B2、B3 與 3.1-3.3）。
--
-- 為什麼做這一批：2026-08 以一家假公司實跑十條業務流程，發現三張主檔都「只夠建立、不夠營運」——
--   ① partners 只有名稱與統編（B1）：催收沒電話、出貨沒地址、電子發票的買方永遠殘缺；
--      最嚴重的下游是**付款條件缺席讓應收管理整體失準**——帳齡以出貨日分桶、
--      儀表板把「逾期」硬寫成 30 天，月結 60 天的客戶第 45 天被標逾期、
--      貨到付款的客戶第 20 天反而顯示安全，方向剛好相反。
--   ② products 只有 SKU／品名／單位（B2）：沒有售價（每張單手打單價），
--      更沒有「服務項目」旗標——createSale 對每一行檢查在庫量，
--      於是運費、安裝費、顧問費開不了單，純服務業完全無法使用本系統。
--   ③ employees 只有姓名（B3）：active 欄存在但整個 codebase 沒有任何一行會把它寫成 false，
--      「員工已停用」的把關是永遠跑不到的死碼——離職三年的同事還在報銷下拉選單裡。
--
-- 欄位取捨（照 gap-analysis 第五節第 1 項的清單，沒列的刻意不加）：
--   金額一律整數新台幣元；NULL 一律表示「未設定／未約定」而不是 0——
--   payment_term_days NULL＝未約定付款條件（帳齡退回以單據日估算），0＝貨到付款（當天到期）；
--   credit_limit NULL＝不設限，被超過時只提示不阻擋（授信是商業判斷，不是系統判斷）；
--   list_price NULL＝未定價（開單時仍可手填），開單帶入後可覆寫。

-- === partners（B1／3.1）===
ALTER TABLE partners ADD COLUMN contact_person text;
ALTER TABLE partners ADD COLUMN phone text;
ALTER TABLE partners ADD COLUMN email text;
ALTER TABLE partners ADD COLUMN address text;
ALTER TABLE partners ADD COLUMN ship_to_address text;
ALTER TABLE partners ADD COLUMN payment_term_days integer;
ALTER TABLE partners ADD COLUMN credit_limit integer;
-- 業務負責人：分業績、客戶找承辦人用。指向員工主檔而非使用者——會跑客戶但不登入系統的業務也存在
ALTER TABLE partners ADD COLUMN sales_owner_employee_id integer REFERENCES employees(id);
ALTER TABLE partners ADD COLUMN note text;
-- 負數天期／負數額度沒有商業意義，寫進去只會讓帳齡與提示算出無法解釋的結果
ALTER TABLE partners ADD CONSTRAINT ck_partners_payment_term_days
  CHECK (payment_term_days IS NULL OR payment_term_days >= 0);
ALTER TABLE partners ADD CONSTRAINT ck_partners_credit_limit
  CHECK (credit_limit IS NULL OR credit_limit >= 0);

-- 統編唯一（R5 的一半）：tax_id 有值時不得重複——同一家公司建兩筆會讓應收餘額、
-- 對帳單、401 進項統計各自看到半套。partial index 是因為 NULL（個人、外國客戶）本來就會大量重複。
-- 先驗再建：R5 說過「重複資料一律不擋」，升級中的舊庫可能已有重複統編，
-- CREATE UNIQUE INDEX 直接失敗的話錯誤訊息只有英文約束名，使用者不知道該去修哪幾筆
DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg(tax_id || '（' || names || '）', '、') INTO dup
  FROM (
    SELECT tax_id, string_agg(name, '、') AS names
    FROM partners WHERE tax_id IS NOT NULL
    GROUP BY tax_id HAVING count(*) > 1
  ) t;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION '無法升級：交易對象主檔有重複的統一編號：%。請先在「客戶與商品」頁把重複的對象整併（把單據較少的那筆統編清空或改名標記停用），再重新啟動', dup;
  END IF;
END $$;
CREATE UNIQUE INDEX uq_partners_tax_id ON partners (tax_id) WHERE tax_id IS NOT NULL;

-- === products（B2／3.2）===
-- list_price 是**售價**側；標準成本刻意不加（移動加權平均是本系統的成本事實來源，
-- 見 gap-analysis「刻意不做的事」）。條碼／課稅別／客戶專屬價不在本批（見 3.2，另批處理）。
ALTER TABLE products ADD COLUMN list_price integer;
ALTER TABLE products ADD COLUMN category text;
-- 服務項目（運費、安裝費、顧問費）：不入庫存——銷貨時跳過在庫檢查、成本 0、不寫庫存異動。
-- 這是「純服務業開不了單」（B2）的解法。進貨側刻意**不**接受服務項目：
-- 進貨拋轉一律借記存貨科目，服務費記成存貨會讓資產負債表虛胖，外包費用請走報銷或手工傳票
ALTER TABLE products ADD COLUMN is_service boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN min_stock integer;
ALTER TABLE products ADD COLUMN note text;
ALTER TABLE products ADD CONSTRAINT ck_products_list_price
  CHECK (list_price IS NULL OR list_price >= 0);
ALTER TABLE products ADD CONSTRAINT ck_products_min_stock
  CHECK (min_stock IS NULL OR min_stock >= 0);

-- === employees（B3／3.3）===
-- active 欄 0001 就有，缺的是把它寫成 false 的入口（PATCH /employees/:id，本批在應用層補）。
-- 部門欄刻意不加：整套系統沒有部門維度（傳票、報銷、報表都沒有），
-- 加一個孤兒欄位只會讓人以為做得出部門別費用分析（見 3.3 的註記）
ALTER TABLE employees ADD COLUMN title text;
ALTER TABLE employees ADD COLUMN phone text;
ALTER TABLE employees ADD COLUMN email text;
ALTER TABLE employees ADD COLUMN hire_date date;
ALTER TABLE employees ADD COLUMN note text;

-- === sales.due_date（B1 的下游：帳齡與逾期）===
-- 收款到期日：建單時由 doc_date + partner.payment_term_days 預設，可逐單覆寫。
-- NULL＝未約定（或本欄位出現前的舊單）：帳齡退回以單據日估算並在回應標註，
-- 前 30 天不算逾期（沿用舊行為——對沒有約定的單據，系統沒有立場斷言它何時逾期）
ALTER TABLE sales ADD COLUMN due_date date;
COMMENT ON COLUMN sales.due_date IS '收款到期日（doc_date + 付款條件天數的預設，可覆寫）；NULL＝未約定或舊單，帳齡退回以單據日估算';
