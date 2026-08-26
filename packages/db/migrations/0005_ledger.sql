-- 帳務完整性批次（市售 ERP 缺口盤點 docs/gap-analysis-2607.md 第一層）：
-- 手工傳票、收款單/付款單（沖應收應付）、期初開帳（庫存）
-- doc_source 擴充：manual＝手工傳票、receipt/payment＝收付款單、opening＝庫存開帳（sourceId 固定 0）

ALTER TYPE doc_source ADD VALUE 'manual';
ALTER TYPE doc_source ADD VALUE 'receipt';
ALTER TYPE doc_source ADD VALUE 'payment';
ALTER TYPE doc_source ADD VALUE 'opening';

CREATE TYPE cash_doc_kind AS ENUM ('receipt', 'payment');

-- 收款單（客戶沖應收）／付款單（供應商沖應付）；account_id＝收付使用的現金/銀行科目
CREATE TABLE cash_docs (
  id serial PRIMARY KEY,
  kind cash_doc_kind NOT NULL,
  partner_id integer NOT NULL REFERENCES partners(id),
  doc_date date NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  account_id integer NOT NULL REFERENCES accounts(id),
  memo text NOT NULL DEFAULT '',
  journal_entry_id integer REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
