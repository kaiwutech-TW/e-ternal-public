-- 月結關帳＋年度結轉（缺口第二層批次 B）
-- 關帳：period_closes 一列一個月，須依序關（關至點＝max period）；重開＝刪最新一列
-- 鎖帳：所有拋轉傳票的路徑在 entry_date 落入已關期間時一律 409（services/period.ts assertPeriodOpen）
-- 年度結轉：收入/費用結清至 3351 累積盈虧，傳票 source_type='closing'、source_id=年度；損益表排除 closing

ALTER TYPE doc_source ADD VALUE 'closing';

CREATE TABLE period_closes (
  id serial PRIMARY KEY,
  period char(7) NOT NULL UNIQUE,               -- YYYY-MM
  closed_by integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
