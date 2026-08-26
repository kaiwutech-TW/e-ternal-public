-- Phase 1 初始 schema：主檔、進銷單據、庫存異動、最小會計
-- 金額欄位一律整數新台幣元（台灣發票金額為整數）；數量/單價/單位成本用 numeric

CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');
CREATE TYPE movement_direction AS ENUM ('in', 'out');
CREATE TYPE doc_source AS ENUM ('purchase', 'sale');

CREATE TABLE partners (
  id serial PRIMARY KEY,
  name text NOT NULL,
  tax_id char(8),
  is_customer boolean NOT NULL DEFAULT false,
  is_supplier boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id serial PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  unit text NOT NULL DEFAULT '個',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  type account_type NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_entries (
  id serial PRIMARY KEY,
  entry_date date NOT NULL,
  memo text NOT NULL DEFAULT '',
  source_type doc_source,
  source_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_lines (
  id serial PRIMARY KEY,
  entry_id integer NOT NULL REFERENCES journal_entries(id),
  account_id integer NOT NULL REFERENCES accounts(id),
  debit integer NOT NULL DEFAULT 0,
  credit integer NOT NULL DEFAULT 0,
  CONSTRAINT one_side_only CHECK (debit = 0 OR credit = 0),
  CONSTRAINT non_negative CHECK (debit >= 0 AND credit >= 0)
);

CREATE TABLE purchases (
  id serial PRIMARY KEY,
  partner_id integer NOT NULL REFERENCES partners(id),
  doc_date date NOT NULL,
  subtotal integer NOT NULL,
  tax integer NOT NULL,
  total integer NOT NULL,
  journal_entry_id integer REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_lines (
  id serial PRIMARY KEY,
  purchase_id integer NOT NULL REFERENCES purchases(id),
  product_id integer NOT NULL REFERENCES products(id),
  qty numeric(12,3) NOT NULL,
  unit_price numeric(12,2) NOT NULL,
  amount integer NOT NULL
);

CREATE TABLE sales (
  id serial PRIMARY KEY,
  partner_id integer NOT NULL REFERENCES partners(id),
  doc_date date NOT NULL,
  subtotal integer NOT NULL,
  tax integer NOT NULL,
  total integer NOT NULL,
  cogs integer NOT NULL,
  journal_entry_id integer REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sale_lines (
  id serial PRIMARY KEY,
  sale_id integer NOT NULL REFERENCES sales(id),
  product_id integer NOT NULL REFERENCES products(id),
  qty numeric(12,3) NOT NULL,
  unit_price numeric(12,2) NOT NULL,
  amount integer NOT NULL,
  cost integer NOT NULL
);

CREATE TABLE inventory_movements (
  id serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES products(id),
  direction movement_direction NOT NULL,
  qty numeric(12,3) NOT NULL,
  unit_cost numeric(14,4) NOT NULL,
  amount integer NOT NULL,
  source_type doc_source NOT NULL,
  source_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX idx_journal_lines_account ON journal_lines(account_id);
CREATE INDEX idx_movements_product ON inventory_movements(product_id);
