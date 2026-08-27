-- expense_items 依賣方統編查歷史分類候選的索引（W7）。
--
-- ★ 為什麼現在才要：在 GET /expense-categories/suggestions 之前，沒有任何查詢
--   以 seller_tax_id 當條件——這一欄一直只是被寫進去、跟著整張單一起讀出來。
--   那支端點是第一個，而且落在熱路徑上：使用者掃完一張收據就問一次，
--   批次上傳一次進來十幾筆就是十幾個不同賣方各問一次。沒有索引的話，
--   每一次都是整張 expense_items 的循序掃描，而這張表只會愈長愈大。
--
-- ★ 為什麼是這三欄（seller_tax_id, account_code, claim_id）：
--   查詢長這樣——WHERE seller_tax_id = ? AND account_code IN (…)
--   GROUP BY account_code，聚合是 count(distinct claim_id)。
--   - seller_tax_id 放第一：唯一的等值條件，選擇性最高，決定要掃多少列。
--   - account_code 放第二：IN 清單能當成索引條件直接過濾掉已下架的舊科目，
--     而且它是 GROUP BY 的鍵，順著索引出來就已經分好組。
--   - claim_id 放第三：聚合唯一要讀的另一欄。放進索引之後這個查詢碰不到 heap
--     （index-only scan），不放的話每一列都要回表拿一個整數。
--   刻意**不**含 status／voided_at：那兩欄在 expense_claims 上，不是這張表的欄位；
--   母體的過濾靠 join 到 expense_claims 的主鍵完成。
--
-- ★ 為什麼是 partial index（WHERE seller_tax_id IS NOT NULL）：
--   seller_tax_id 是選填欄位（claimInput 裡 .optional()），而且常常是空的——
--   手開收據與「其他」憑證上通常根本沒有統編可填。查詢永遠帶等值條件，
--   NULL 的列一列都用不到；把它們放進索引只是讓索引長大、快取命中率變差。
--
-- IF NOT EXISTS：套用紀錄（schema_migrations）已經擋掉重跑，這是第二層——
-- 手動補套過同一段 SQL 的庫（或紀錄被人工補登過的庫）不該在升級時整個起不來，
-- 那正是 test/migrations.test.ts 那支冪等測試在守的路徑。
CREATE INDEX IF NOT EXISTS idx_expense_items_seller_category
  ON expense_items (seller_tax_id, account_code, claim_id)
  WHERE seller_tax_id IS NOT NULL;
