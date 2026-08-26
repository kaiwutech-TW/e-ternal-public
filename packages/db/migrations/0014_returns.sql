-- 銷貨退回／折讓、進貨退出／折讓（帳務面）
--
-- 為什麼是獨立單據而不是「負數量的銷貨單」：lineAmount 要求數量為正、calcTax 要求未稅額非負、
-- assertBalanced 禁止負數借貸——三道既有驗證把「開一張反向銷貨單」這條路完全封死，
-- 而且那樣做會讓既有所有 sales 查詢（營收、帳齡、立沖）把退貨算成一筆銷貨。
--
-- 為什麼不沿用 sales.reversal_entry_id：那個旗標的語意是「整張單當作沒發生」，
-- 五處查詢直接用 isNull(reversal_entry_id) 把整張單濾掉。部分退回若沿用它，
-- 客戶買十件退兩件，報表上這筆交易會整筆憑空消失。
--
-- kind 一欄涵蓋退回與折讓：兩者的帳務結構與累計上限邏輯幾乎相同，拆兩張表會讓
-- 累計上限檢查與取數各寫兩份。差別只在退回動庫存與成本、折讓不動（見 services/returns.ts）。
--
-- ★ 本檔絕對不得出現 'sale_return' / 'purchase_return' 字面值（不設 DEFAULT、不 INSERT 種子）：
--   migration runner 是把整份 SQL 一次 exec 送出＝Postgres 隱式單一交易，而 ALTER TYPE ADD VALUE
--   的新值不得在同一交易內被使用，一旦出現字面值會整檔回滾並丟 "unsafe use of new value"。
--   把欄位宣告成 doc_source 型別不算「使用該值」，所以建表是安全的（PGlite 已實測通過）。

ALTER TYPE doc_source ADD VALUE IF NOT EXISTS 'sale_return';
ALTER TYPE doc_source ADD VALUE IF NOT EXISTS 'purchase_return';

CREATE TYPE return_kind AS ENUM ('return', 'allowance');

-- doc_date：貨實際退回日／折讓成立日，驅動庫存異動與帳務分錄（assertPeriodOpen 看的是它）。
-- cert_date：退回折讓證明單的日期（本系統不產生證明單，這裡只登錄外部開立的那張）。
--   與 doc_date 分離是因為進貨退出
--            幾乎必然分離（貨這禮拜退回去、庫存當下就得減，供應商的證明單下個月才寄到）。
-- ar_offset / payable_amount / cash_amount：對方科目的自動拆分結果落地，讓應收帳齡、未沖餘額、
--            對象餘額四處報表直接取數，不必回頭 parse journal_lines 猜哪一行是 1144。
CREATE TABLE sales_returns (
  id serial PRIMARY KEY,
  sale_id integer NOT NULL REFERENCES sales(id),
  partner_id integer NOT NULL REFERENCES partners(id),
  kind return_kind NOT NULL,
  doc_date date NOT NULL,
  cert_date date,
  cert_no text,
  memo text NOT NULL DEFAULT '',
  subtotal integer NOT NULL,
  tax integer NOT NULL,
  total integer NOT NULL,
  cogs integer NOT NULL DEFAULT 0,
  ar_offset integer NOT NULL DEFAULT 0,
  payable_amount integer NOT NULL DEFAULT 0,
  cash_account_id integer REFERENCES accounts(id),
  cash_amount integer NOT NULL DEFAULT 0,
  journal_entry_id integer REFERENCES journal_entries(id),
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_sales_returns_total CHECK (total = subtotal + tax),
  CONSTRAINT ck_sales_returns_settlement CHECK (ar_offset + payable_amount + cash_amount = total),
  CONSTRAINT ck_sales_returns_nonneg CHECK (
    subtotal >= 0 AND tax >= 0 AND cogs >= 0 AND ar_offset >= 0 AND payable_amount >= 0 AND cash_amount >= 0
  )
);
CREATE INDEX idx_sales_returns_sale ON sales_returns (sale_id);
CREATE INDEX idx_sales_returns_date ON sales_returns (doc_date);

-- sale_line_id 必填：取得原單價、原成本（比例攤的基礎）與累計上限的把關對象，三者都靠它。
-- 折讓的 qty 為 0（貨沒退，只是少收錢），所以 qty 允許 0 而 amount 必須為正。
CREATE TABLE sale_return_lines (
  id serial PRIMARY KEY,
  return_id integer NOT NULL REFERENCES sales_returns(id),
  sale_line_id integer NOT NULL REFERENCES sale_lines(id),
  product_id integer NOT NULL REFERENCES products(id),
  qty numeric(12,3) NOT NULL DEFAULT 0,
  unit_price numeric(12,2) NOT NULL,
  amount integer NOT NULL,
  cost integer NOT NULL DEFAULT 0,
  CONSTRAINT ck_sale_return_lines_qty CHECK (qty >= 0),
  -- 退款金額可為 0：折讓已經把這筆明細的額度吃光後，貨仍然要能退回來（見 services/returns.ts）
  CONSTRAINT ck_sale_return_lines_amount CHECK (amount >= 0),
  CONSTRAINT ck_sale_return_lines_cost CHECK (cost >= 0)
);
CREATE INDEX idx_sale_return_lines_return ON sale_return_lines (return_id);
CREATE INDEX idx_sale_return_lines_source ON sale_return_lines (sale_line_id);

-- 進貨退出：inv_credit 是實際沖減存貨帳面的金額（退出＝當下均價 × 退出量；折讓＝折讓額 × 在庫比例），
-- cost_diff = 退款額 − inv_credit，走 5101 銷貨成本。
-- 兩者落地而不是事後推算，是因為移動加權平均下 inv_credit 取決於「退出當下」的在庫帳面金額，
-- 事後任何一筆進銷貨都會讓它算不回來。
--
-- cost_diff 刻意不加 >= 0：它是雙向的。退還的若是「便宜的那批」，沖存貨的均價成本會大於
-- 供應商退的錢（進 100@10 再進 100@2、賣掉 100 個後退便宜那批 100 個：沖存貨 600、退款 200），
-- 差額 −400 是已售商品被低估的成本，必須借回 5101。限制成非負會讓存貨的數量與金額脫鉤
-- （庫存 0 個卻仍背 400 元帳面），之後每一筆銷貨成本都錯到底。
CREATE TABLE purchase_returns (
  id serial PRIMARY KEY,
  purchase_id integer NOT NULL REFERENCES purchases(id),
  partner_id integer NOT NULL REFERENCES partners(id),
  kind return_kind NOT NULL,
  doc_date date NOT NULL,
  cert_date date,
  cert_no text,
  memo text NOT NULL DEFAULT '',
  subtotal integer NOT NULL,
  tax integer NOT NULL,
  total integer NOT NULL,
  inv_credit integer NOT NULL DEFAULT 0,
  cost_diff integer NOT NULL DEFAULT 0,
  ap_offset integer NOT NULL DEFAULT 0,
  receivable_amount integer NOT NULL DEFAULT 0,
  cash_account_id integer REFERENCES accounts(id),
  cash_amount integer NOT NULL DEFAULT 0,
  journal_entry_id integer REFERENCES journal_entries(id),
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_purchase_returns_total CHECK (total = subtotal + tax),
  CONSTRAINT ck_purchase_returns_settlement CHECK (ap_offset + receivable_amount + cash_amount = total),
  CONSTRAINT ck_purchase_returns_cost CHECK (inv_credit + cost_diff = subtotal),
  CONSTRAINT ck_purchase_returns_nonneg CHECK (
    subtotal >= 0 AND tax >= 0 AND inv_credit >= 0
    AND ap_offset >= 0 AND receivable_amount >= 0 AND cash_amount >= 0
  )
);
CREATE INDEX idx_purchase_returns_purchase ON purchase_returns (purchase_id);
CREATE INDEX idx_purchase_returns_date ON purchase_returns (doc_date);

CREATE TABLE purchase_return_lines (
  id serial PRIMARY KEY,
  return_id integer NOT NULL REFERENCES purchase_returns(id),
  purchase_line_id integer NOT NULL REFERENCES purchase_lines(id),
  product_id integer NOT NULL REFERENCES products(id),
  qty numeric(12,3) NOT NULL DEFAULT 0,
  unit_price numeric(12,2) NOT NULL,
  amount integer NOT NULL,
  inv_credit integer NOT NULL DEFAULT 0,
  CONSTRAINT ck_purchase_return_lines_qty CHECK (qty >= 0),
  -- 同上：折讓吃光額度後貨仍要能退出去，退款金額為 0
  CONSTRAINT ck_purchase_return_lines_amount CHECK (amount >= 0),
  CONSTRAINT ck_purchase_return_lines_inv CHECK (inv_credit >= 0)
);
CREATE INDEX idx_purchase_return_lines_return ON purchase_return_lines (return_id);
CREATE INDEX idx_purchase_return_lines_source ON purchase_return_lines (purchase_line_id);
