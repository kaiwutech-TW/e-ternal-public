-- 庫存調整單：盤盈／盤虧／報廢的入口（gap-analysis-2608 的 B8，第二批）。
--
-- 為什麼做這一批：實測發現除了「賣掉」與「退給廠商」，沒有任何一條路能把庫存扣掉——
-- 過期報廢只能開手工傳票（總帳動了、庫存子帳一件未動，之後每張銷貨單繼續用虛高的均價
-- 算成本），或開 0 元銷貨單（庫存對了，但報廢掛在某個客戶頭上、損失進了銷貨成本）。
-- 食品貿易的冷凍品過期、罐頭破損、月底盤點短少是每個月的事，不該與多倉調撥同級延後。
--
-- 設計：
-- 1. 盤盈／盤虧／報廢共用一種單。reason 記原因（count 盤點差異／scrap 報廢／expiry 過期），
--    方向在明細不在單頭——一次盤點常常有的商品盤盈、有的盤虧，拆兩張單會讓「這次盤點」
--    變成兩筆不相干的紀錄。
-- 2. 調整量一律以「當下移動平均成本」計價（服務層讀 onHand 現算並落地快照）：
--    盤虧報廢出庫後均價不變，之後的銷貨成本不受影響；盤盈以現有均價入庫同理。
--    金額整數元；全數出清時以帳面殘額出帳，不讓 0 量掛著幾塊錢的殭屍餘額。
-- 3. 自動拋轉傳票：盤盈借 1301 商品存貨、貸 7121 存貨盤盈；盤虧報廢借 7521 存貨盤損、
--    貸 1301。兩碼已加入 chart.ts 的 ACCOUNT（＝系統科目，seedAccounts() 啟動校正，
--    本檔不寫科目種子——寫死清單的教訓見 TRAPS）。
-- 4. 盤點輔助（服務層）：GET 底稿列現有品項與帳面量，POST 收「實盤量」由系統算差異——
--    讓使用者自己算差異，算錯的方向永遠是「帳配合人」，盤點就失去了對帳的意義。
--    底稿的帳面量與實盤量都落在明細（book_qty／counted_qty），差異怎麼來的查得到。
-- 5. 作廢層與 0025 六種單據同一形狀：反向傳票沖總帳、庫存以原成本反向回補、
--    原單標 voided_at／voided_by／void_reason 永不刪除（更正＝作廢＋重開）。
--
-- ★ 本檔不得出現 'adjustment' 字面值（不設 DEFAULT、不 INSERT 用到它）：
--   migration runner 把整份 SQL 一次 exec 送出＝Postgres 隱式單一交易，而 ALTER TYPE
--   ADD VALUE 的新值不得在同一交易內被使用（0014／0015 已踩過並記錄）。
--   把欄位宣告成 doc_source 型別不算「使用該值」，所以建表是安全的。

ALTER TYPE doc_source ADD VALUE IF NOT EXISTS 'adjustment';

CREATE TYPE adjustment_reason AS ENUM ('count', 'scrap', 'expiry');

CREATE TABLE inventory_adjustments (
  id serial PRIMARY KEY,
  doc_date date NOT NULL,
  reason adjustment_reason NOT NULL,
  memo text NOT NULL DEFAULT '',
  -- 盤盈合計（借 1301）／盤虧報廢合計（貸 1301）分開落地：清單頁直接取數，不回頭加總明細
  total_in integer NOT NULL DEFAULT 0,
  total_out integer NOT NULL DEFAULT 0,
  journal_entry_id integer REFERENCES journal_entries(id),
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by integer REFERENCES users(id),
  void_reason text,
  reversal_entry_id integer REFERENCES journal_entries(id)
);

CREATE TABLE inventory_adjustment_lines (
  id serial PRIMARY KEY,
  adjustment_id integer NOT NULL REFERENCES inventory_adjustments(id),
  product_id integer NOT NULL REFERENCES products(id),
  direction movement_direction NOT NULL,
  qty numeric(12,3) NOT NULL CHECK (qty > 0),
  -- 調整當下的移動平均成本快照：事後查「這筆報廢為什麼是這個金額」不必重算歷史
  unit_cost numeric(14,4) NOT NULL,
  amount integer NOT NULL CHECK (amount >= 0),
  -- 盤點入口才有（手動調整為 NULL）：帳面量與實盤量都留下，差異怎麼算出來的一目了然
  book_qty numeric(12,3),
  counted_qty numeric(12,3)
);

CREATE INDEX idx_adjustment_lines_adjustment ON inventory_adjustment_lines(adjustment_id);
