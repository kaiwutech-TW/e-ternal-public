-- HR 第一批後半（之二）：薪資——員工薪資檔、加班費率、發薪作業
--
-- ★ 全部的「錢的參數」使用者自填：月薪／時薪、時薪換算除數、勞健保與勞退各負擔額、
--   加班費倍率。系統只提供結構與算術，不提供任何法定數字（倍率 1.34、除數 240、
--   投保級距都不預填）——與稅法參數同一條紀律，違反者重做。
--
-- ★ 員工薪資檔是「歷次紀錄」不是單值欄位：調薪新增一列（valid_from），舊列不動——
--   重算過去月份要找得到當月那一列。與稅法參數 append-only 同形。
--
-- ★ 發薪作業的計算結果整包快照進 payroll_items.detail（jsonb）：定案後改費率、
--   改假別比率、補打卡都不回頭改已定案的薪資單。要更正就作廢重跑（本批先不做作廢層，
--   draft 可整批重算，finalized 不可動）。
--
-- ★ 過帳（定案時）：借 6111 薪資支出（應發淨額之毛額）、6113 勞健保費（雇主負擔）、
--   6114 勞工退休金（雇主提繳）；貸 2202 應付薪資（實發）、2212 代扣勞健保費（員工負擔）、
--   2203 應付費用（雇主的勞健保與勞退應繳）。科目全部走 chart.ts 既有 is_system 清單，
--   不新增科目。扣繳稅款本批不算（員工薪資扣繳稅額表未內建——手動用調整項）。

-- 發薪定案傳票的來源別（作廢層靠它認得「這張是系統傳票」）
ALTER TYPE doc_source ADD VALUE IF NOT EXISTS 'payroll';

CREATE TABLE employee_salaries (
  id serial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id),
  valid_from date NOT NULL,
  pay_type text NOT NULL,             -- 'monthly' | 'hourly'
  base_amount integer NOT NULL,       -- 月薪或時薪（整數元）
  -- 月薪→時薪的除數（例：240）。NULL＝未設定，算加班費／請假扣款時明講不算——
  -- 這個數字有多種算法（240、30×8、當月實際工時），系統不替使用者選
  hourly_divisor integer,
  -- 勞健保／勞退：每人每月定額，使用者依投保級距表自行查填（系統不內建級距表）
  labor_ins_employee integer NOT NULL DEFAULT 0,   -- 勞保員工負擔
  labor_ins_employer integer NOT NULL DEFAULT 0,   -- 勞保雇主負擔
  health_ins_employee integer NOT NULL DEFAULT 0,  -- 健保員工負擔
  health_ins_employer integer NOT NULL DEFAULT 0,  -- 健保雇主負擔
  pension_employer integer NOT NULL DEFAULT 0,     -- 勞退雇主提繳
  source_note text NOT NULL DEFAULT '',            -- 級距與金額的依據（投保級距表版本等）
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES users(id),
  UNIQUE (employee_id, valid_from)
);

-- 加班費率（倍率使用者自填）：某日型、加班第 N 分鐘起，用多少倍率
-- 例（使用者自己填的形狀）：workday 0 起 13400、workday 120 起 16700（萬分位倍率）
CREATE TABLE overtime_rates (
  id serial PRIMARY KEY,
  day_type text NOT NULL,             -- 與 hr_requests.day_type 同值域
  from_minutes integer NOT NULL,      -- 這一段從加班第幾分鐘（含）開始
  multiplier_bp integer NOT NULL,     -- 倍率（萬分位：13400＝1.34 倍）——使用者自填
  source_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day_type, from_minutes)
);

CREATE TABLE payroll_runs (
  id serial PRIMARY KEY,
  month text NOT NULL UNIQUE,         -- 'YYYY-MM'：本批一月一作業（發薪群組是後續站）
  status text NOT NULL DEFAULT 'draft',   -- draft | finalized
  note text NOT NULL DEFAULT '',
  journal_entry_id integer REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES users(id),
  finalized_at timestamptz,
  finalized_by integer REFERENCES users(id)
);

CREATE TABLE payroll_items (
  id serial PRIMARY KEY,
  run_id integer NOT NULL REFERENCES payroll_runs(id),
  employee_id integer NOT NULL REFERENCES employees(id),
  base_pay integer NOT NULL DEFAULT 0,        -- 本薪（月薪全額或時薪×實際工時）
  overtime_pay integer NOT NULL DEFAULT 0,
  leave_deduction integer NOT NULL DEFAULT 0, -- 請假扣款（按假別給薪比率）
  absence_deduction integer NOT NULL DEFAULT 0, -- 缺勤扣款（有排班無卡無假的時數）
  other_earning integer NOT NULL DEFAULT 0,   -- 手動調整加項（獎金、津貼）
  other_deduction integer NOT NULL DEFAULT 0, -- 手動調整減項（含自行計算的扣繳稅款）
  labor_ins_employee integer NOT NULL DEFAULT 0,
  health_ins_employee integer NOT NULL DEFAULT 0,
  labor_ins_employer integer NOT NULL DEFAULT 0,
  health_ins_employer integer NOT NULL DEFAULT 0,
  pension_employer integer NOT NULL DEFAULT 0,
  net_pay integer NOT NULL DEFAULT 0,         -- 實發＝毛額−員工負擔保費−手動減項
  memo text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}',         -- 計算明細快照（取數來源、警告、各段加班）
  UNIQUE (run_id, employee_id)
);
