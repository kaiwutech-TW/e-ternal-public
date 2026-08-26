-- 期初應收／應付單（gap-analysis-2608 的 B6，第一批第 2 項）。
--
-- 為什麼做這一批：既有公司導入的第一天就有客戶欠款與應付貨款，但期初只有手工傳票一條路——
-- 進得了總帳、進不了子帳。partner_balances／open_documents／ar_aging 三處都只讀
-- sales／purchases／cash_docs，期初欠款在收款畫面勾不到，一收款就變成負數「預收」，
-- 儀表板與資產負債表同時開著會顯示兩個不同的應收數字（實測見 gap-analysis B6）。
-- 用假銷貨單補建也不行：/sales 強制要庫存商品，且必然拋轉收入與銷項稅額，
-- 會汙染損益表並讓期初欠款混進 401 的當期銷項。
--
-- 設計：
-- * 一筆＝一張原始欠款單據。entry_date（開帳日）驅動傳票與鎖帳，doc_date（原單日期）
--   與 due_date（到期日）驅動帳齡分桶——分開存才能既讓開帳集中在導入日，又保留催款所需的時間軸。
-- * 拋轉傳票（服務層依 core 的 ACCOUNT 取號，不在此寫死科目代號）：
--   應收＝借應收帳款、貸累積盈虧；應付＝借累積盈虧、貸應付帳款。
--   與庫存開帳「只建 movement、不拋傳票」刻意不同：存貨只是期初傳票裡的一列（對方科目分散），
--   期初應收付的對方科目唯一，系統拋轉才能保證總帳與子帳必然一致。
--   代價：使用者的期初手工傳票**不得再含應收付科目**（重複入帳），SOP 第⑥步已同步改寫。
-- * 不進 401：vat.ts 只讀 invoices／purchases／expense_items，本表天然隔離——
--   期初欠款不是當期銷項進項，這正是不能用銷貨單權宜補建的原因。
-- * 收付款沖銷：cash_doc_allocations.target_type 沿用 doc_source 既有的 'opening'（0005 加的），
--   target_id 指向本表；應收／應付共用一個 id 空間，target_type 一個值就夠。
-- * 金額必為正（這張表只收「對方還欠／我還欠」的單據面餘額）；期初的預收預付是負債／資產
--   科目餘額，不在子帳體系裡，請直接入期初手工傳票。
CREATE TYPE opening_balance_kind AS ENUM ('receivable', 'payable');

CREATE TABLE opening_balances (
  id serial PRIMARY KEY,
  kind opening_balance_kind NOT NULL,
  partner_id integer NOT NULL REFERENCES partners(id),
  -- 開帳日：傳票日期與鎖帳（assertPeriodOpen）看它；服務層要求 doc_date <= entry_date
  entry_date date NOT NULL,
  -- 原單日期（原始出貨／進貨日）：帳齡分桶與收付款畫面排序看它
  doc_date date NOT NULL,
  -- 收付款到期日；NULL＝未約定，帳齡退回以原單日期估算（與 sales.due_date 同語意，0022）
  due_date date,
  amount integer NOT NULL CHECK (amount > 0),
  memo text NOT NULL DEFAULT '',
  journal_entry_id integer REFERENCES journal_entries(id),
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
