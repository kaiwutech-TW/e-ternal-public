-- 員工費用報銷＋合約管理（10 人小公司日常流程，見 docs/gap-analysis-2607.md 增補）
-- 報銷流程：員工送出（submitted）→ 會計核准（approved，拋轉費用傳票）→ 付款（paid，沖其他應付款）
-- 單據影像以 base64 存 DB（前端縮圖後上傳）；電子發票 QR 辨識欄位存明細

ALTER TYPE doc_source ADD VALUE 'expense';

CREATE TYPE claim_status AS ENUM ('submitted', 'approved', 'rejected', 'paid');
CREATE TYPE expense_doc_type AS ENUM ('einvoice', 'receipt', 'other');
CREATE TYPE contract_status AS ENUM ('draft', 'active', 'ended', 'terminated');

CREATE TABLE employees (
  id serial PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE expense_claims (
  id serial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id),
  claim_date date NOT NULL,
  status claim_status NOT NULL DEFAULT 'submitted',
  memo text NOT NULL DEFAULT '',
  total integer NOT NULL,
  reject_reason text,
  journal_entry_id integer REFERENCES journal_entries(id),      -- 核准時的費用傳票
  paid_journal_entry_id integer REFERENCES journal_entries(id), -- 付款時的沖帳傳票
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE expense_items (
  id serial PRIMARY KEY,
  claim_id integer NOT NULL REFERENCES expense_claims(id),
  account_code text NOT NULL,          -- 由報銷分類對應的費用科目
  description text NOT NULL DEFAULT '',
  doc_type expense_doc_type NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),  -- 含稅總額（整數元）
  tax integer NOT NULL DEFAULT 0,              -- 可扣抵時的進項稅額
  deductible boolean NOT NULL DEFAULT false,   -- 進項稅可扣抵（統編發票且非交際費）
  invoice_number char(10),
  invoice_date date,
  seller_tax_id char(8),
  image text,                                  -- base64 縮圖
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contracts (
  id serial PRIMARY KEY,
  partner_id integer REFERENCES partners(id),
  counterparty text NOT NULL,
  title text NOT NULL,
  amount integer,
  sign_date date,
  start_date date NOT NULL,
  end_date date,
  status contract_status NOT NULL DEFAULT 'active',
  memo text NOT NULL DEFAULT '',
  file_name text,
  file_data text,                              -- base64 附件（PDF/圖片）
  created_at timestamptz NOT NULL DEFAULT now()
);
