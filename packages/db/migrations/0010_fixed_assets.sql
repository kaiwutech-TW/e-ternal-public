-- 固定資產管理＋自動折舊（缺口第二層批次 A，見 docs/gap-analysis-2607.md）
-- 設計：資產登錄不拋轉取得傳票（取得入帳走進貨/手工傳票，與庫存開帳同哲學），本模組只管折舊與處分
-- 折舊：平均法（直線法），殘值預設 成本÷(耐用年數+1)（所得稅法 54 條），按月計提、末期收斂
-- 計提冪等：同資產同期間唯一，重跑只補新資產

ALTER TYPE doc_source ADD VALUE 'depreciation';
ALTER TYPE doc_source ADD VALUE 'disposal';

CREATE TYPE asset_status AS ENUM ('active', 'disposed');

CREATE TABLE fixed_assets (
  id serial PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,                        -- core ASSET_CATEGORIES key（電腦/辦公/機器/運輸/什項…）
  asset_code text NOT NULL,                      -- 成本科目（登錄時由類別帶入後固定）
  accum_code text NOT NULL,                      -- 累計折舊科目
  cost integer NOT NULL CHECK (cost > 0),        -- 取得成本（整數元）
  salvage integer NOT NULL CHECK (salvage >= 0), -- 殘值（預設 cost/(年數+1)，可改）
  useful_years integer NOT NULL CHECK (useful_years > 0),
  start_date date NOT NULL,                      -- 啟用日（當月起提）
  memo text NOT NULL DEFAULT '',
  status asset_status NOT NULL DEFAULT 'active',
  disposed_at date,
  disposal_entry_id integer REFERENCES journal_entries(id),
  created_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE asset_depreciations (
  id serial PRIMARY KEY,
  asset_id integer NOT NULL REFERENCES fixed_assets(id),
  period char(7) NOT NULL,                       -- YYYY-MM
  amount integer NOT NULL CHECK (amount > 0),
  journal_entry_id integer NOT NULL REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, period)
);
