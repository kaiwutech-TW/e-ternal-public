-- 銷售前段（角色化流程第二批）：報價單 → 訂單 → 出貨轉銷貨單
-- 報價：open（洽談中）→ won（成交，轉訂單）/ lost（未成交）
-- 訂單：open（未出貨）→ partial（部分出貨）→ closed（出清結案）；canceled 僅限未出貨
-- 出貨＝以剩餘量開銷貨單（沿用既有 create sale 拋轉存貨與傳票），sales.order_id 回連

CREATE TYPE quote_status AS ENUM ('open', 'won', 'lost');
CREATE TYPE order_status AS ENUM ('open', 'partial', 'closed', 'canceled');

CREATE TABLE quotes (
  id serial PRIMARY KEY,
  partner_id integer NOT NULL REFERENCES partners(id),
  quote_date date NOT NULL,
  status quote_status NOT NULL DEFAULT 'open',
  memo text NOT NULL DEFAULT '',
  subtotal integer NOT NULL,
  tax integer NOT NULL,
  total integer NOT NULL,
  order_id integer,                              -- won 時產生的訂單（後補 FK，orders 在下方建立）
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quote_lines (
  id serial PRIMARY KEY,
  quote_id integer NOT NULL REFERENCES quotes(id),
  product_id integer NOT NULL REFERENCES products(id),
  qty numeric(12,3) NOT NULL,
  unit_price numeric(12,2) NOT NULL,
  amount integer NOT NULL
);

CREATE TABLE orders (
  id serial PRIMARY KEY,
  partner_id integer NOT NULL REFERENCES partners(id),
  order_date date NOT NULL,
  status order_status NOT NULL DEFAULT 'open',
  memo text NOT NULL DEFAULT '',
  subtotal integer NOT NULL,
  tax integer NOT NULL,
  total integer NOT NULL,
  quote_id integer REFERENCES quotes(id),        -- 由報價轉入時回連
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_lines (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders(id),
  product_id integer NOT NULL REFERENCES products(id),
  qty numeric(12,3) NOT NULL,
  unit_price numeric(12,2) NOT NULL,
  amount integer NOT NULL,
  shipped_qty numeric(12,3) NOT NULL DEFAULT 0   -- 已出貨量（出貨時累加，決定訂單狀態）
);

ALTER TABLE quotes ADD CONSTRAINT quotes_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);
ALTER TABLE sales ADD COLUMN order_id integer REFERENCES orders(id);
