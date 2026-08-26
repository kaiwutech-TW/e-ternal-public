-- 採購前段（角色化流程第三批）：採購單 → 收貨轉進貨單，鏡射銷售前段（migration 0008）
-- 狀態由收貨量推導：open（未到貨）→ partial（部分到貨）→ closed（收清結案）；canceled 僅限未收貨
-- 收貨＝以到貨量開進貨單（沿用既有 create purchase 拋轉存貨與傳票），purchases.purchase_order_id 回連

CREATE TABLE purchase_orders (
  id serial PRIMARY KEY,
  partner_id integer NOT NULL REFERENCES partners(id),
  order_date date NOT NULL,
  status order_status NOT NULL DEFAULT 'open',   -- 沿用 0008 的 order_status enum
  memo text NOT NULL DEFAULT '',
  subtotal integer NOT NULL,
  tax integer NOT NULL,
  total integer NOT NULL,
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_order_lines (
  id serial PRIMARY KEY,
  purchase_order_id integer NOT NULL REFERENCES purchase_orders(id),
  product_id integer NOT NULL REFERENCES products(id),
  qty numeric(12,3) NOT NULL,
  unit_price numeric(12,2) NOT NULL,
  amount integer NOT NULL,
  received_qty numeric(12,3) NOT NULL DEFAULT 0  -- 已收貨量（收貨時累加，決定採購單狀態）
);

ALTER TABLE purchases ADD COLUMN purchase_order_id integer REFERENCES purchase_orders(id);
