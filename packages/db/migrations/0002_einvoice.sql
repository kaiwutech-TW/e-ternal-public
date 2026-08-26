-- Phase 2：電子發票——公司基本檔（Seller 資訊）、字軌配號、發票

CREATE TYPE invoice_status AS ENUM ('issued', 'canceled');
CREATE TYPE invoice_mode AS ENUM ('B2B', 'B2C');

-- 單公司先行（DECISIONS 2026-07-21）：固定一列
CREATE TABLE company_profile (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name text NOT NULL,
  tax_id char(8) NOT NULL,
  address text,
  person_in_charge text,
  telephone text,
  email text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 字軌配號：稽徵機關核准後於平台取得的號碼區間；next_no 為下一個可用號
CREATE TABLE invoice_tracks (
  id serial PRIMARY KEY,
  period char(6) NOT NULL,          -- 期別（雙月，奇數月起算）YYYYMM
  track char(2) NOT NULL,           -- 字軌兩碼大寫字母
  range_start integer NOT NULL,
  range_end integer NOT NULL,
  next_no integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_range CHECK (range_start <= range_end AND next_no >= range_start),
  CONSTRAINT uq_track_range UNIQUE (period, track, range_start)
);

CREATE TABLE invoices (
  id serial PRIMARY KEY,
  sale_id integer NOT NULL UNIQUE REFERENCES sales(id),
  invoice_number char(10) NOT NULL UNIQUE,
  invoice_date date NOT NULL,
  mode invoice_mode NOT NULL,
  buyer_tax_id char(8),
  buyer_name text NOT NULL,
  sales_amount integer NOT NULL,
  tax_amount integer NOT NULL,
  total_amount integer NOT NULL,
  random_number char(4) NOT NULL,
  print_mark char(1) NOT NULL,
  status invoice_status NOT NULL DEFAULT 'issued',
  cancel_reason text,
  canceled_at timestamptz,
  xml text NOT NULL,
  cancel_xml text,
  created_at timestamptz NOT NULL DEFAULT now()
);
