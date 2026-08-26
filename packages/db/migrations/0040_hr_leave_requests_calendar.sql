-- HR 第一批後半（之一）：假別、額度帳、三種申請＋簽核鏈、行事曆
--
-- ★ 內建法定假別只 seed「名稱」：名稱是結構不是數字（市面上的出勤系統也都內建這份清單）。
--   給薪比率、年資對照天數一律 NULL 留給使用者自填＋依據來源欄——與稅法參數同一條紀律
--   （docs/specs/hr-attendance.md 第三節）。內建假別只能停用不能刪（is_system）。
--
-- ★ 額度帳只存「給了多少」：已用額度不落地，一律由「已核准的請假申請」即時推導——
--   兩處記數字遲早對不上，單一事實來源選在事實（核准單）那一邊。
--
-- ★ 簽核鏈在**提交當下快照**成 hr_request_steps 列：之後改組織圖（換主管、搬部門）
--   不影響在途單的簽核者——與費率快照同一個教訓（歷史不能跟著現在的設定漂）。
--
-- ★ 三種申請（請假／加班／忘打卡）同一張表：欄位大半共用（人、期間、事由、狀態、簽核鏈），
--   各自成表會複製三份簽核機制。kind 區分，專屬欄位可為 NULL，服務層按 kind 驗形狀。

CREATE TABLE leave_types (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,          -- annual/comp/personal…；建立後不可改（額度帳與申請對著它）
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,   -- 內建法定假別：只能停用不能刪
  active boolean NOT NULL DEFAULT true,
  -- 給薪比率（%，0-100）：NULL＝使用者尚未查證填入。系統不預填任何比率——
  -- 病假半薪、事假不給薪等都是勞基法數字，一律使用者自填（算薪時未填則明講不算）
  pay_ratio_percent integer,
  source_note text NOT NULL DEFAULT '',       -- 比率的依據來源（條號／函釋），與稅法參數同形
  -- 最小申請單位（分鐘）：純作業慣例非法定數字，預設 30 只是輸入輔助，可自由改
  min_unit_minutes integer NOT NULL DEFAULT 30,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 內建法定假別清單（名稱來自實機考察的內建清單；順序照它）
INSERT INTO leave_types (code, name, is_system) VALUES
  ('annual',        '特休',           true),
  ('comp',          '補休',           true),
  ('personal',      '事假',           true),
  ('sick',          '病假',           true),
  ('marriage',      '婚假',           true),
  ('funeral',       '喪假',           true),
  ('family_care',   '家庭照顧假',     true),
  ('menstrual',     '生理假',         true),
  ('maternity',     '產假',           true),
  ('prenatal',      '產檢假',         true),
  ('paternity',     '陪產檢及陪產假', true),
  ('official',      '公假',           true),
  ('occupational',  '公傷病假',       true);

-- 額度帳：某員工×某假別×某年度，給了幾分鐘（精確到分——特休按比例會出現 76 時 48 分）
CREATE TABLE leave_balances (
  id serial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id),
  leave_type_id integer NOT NULL REFERENCES leave_types(id),
  year integer NOT NULL,              -- 額度所屬年度（曆年制／週年制的換算由使用者在給假時自行決定）
  granted_minutes integer NOT NULL,
  note text NOT NULL DEFAULT '',      -- 給假依據（年資 N 年、對照表哪一列——使用者自填）
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES users(id),
  UNIQUE (employee_id, leave_type_id, year)
);

-- 三種申請單（kind: 'leave' | 'overtime' | 'punch_correction'）
CREATE TABLE hr_requests (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  employee_id integer NOT NULL REFERENCES employees(id),
  status text NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | canceled
  reason text NOT NULL DEFAULT '',
  -- 請假專屬
  leave_type_id integer REFERENCES leave_types(id),
  start_at timestamptz,
  end_at timestamptz,
  minutes integer,                    -- 請假／加班時數（分）：起訖只是憑據，扣額度與算薪都看這欄
  -- 加班專屬：日型（workday 平日／restday 休息日／regular_off 例假日／holiday 國定假日）
  -- 存申請人選的值，倍率之後在薪資批對照 overtime_rates——系統不判斷「這天是什麼日」
  day_type text,
  -- 忘打卡專屬：補哪一天、哪個方向、幾點——核准後由系統寫入 punches（method='correction'）
  work_date date,
  direction text,
  claimed_time text,                  -- 'HH:MM'（台北時間）；與 punches 的落地換算在服務層
  correction_punch_id integer REFERENCES punches(id),  -- 核准後回填：這張單產生了哪筆更正卡
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX hr_requests_employee_idx ON hr_requests (employee_id, created_at);

-- 簽核鏈（提交時快照）：step_no 由 1 起，同時間只有一關 pending
CREATE TABLE hr_request_steps (
  id serial PRIMARY KEY,
  request_id integer NOT NULL REFERENCES hr_requests(id),
  step_no integer NOT NULL,
  approver_employee_id integer NOT NULL REFERENCES employees(id),
  status text NOT NULL DEFAULT 'waiting',   -- waiting | pending | approved | rejected | skipped
  comment text NOT NULL DEFAULT '',
  decided_at timestamptz,
  decided_by_user_id integer REFERENCES users(id),
  UNIQUE (request_id, step_no)
);

-- 行事曆：國定假日／補班日，使用者自填或批次貼上（系統不內建任何年度的行事曆——
-- 人事行政局每年公告，屬「使用者自己查證」的範圍）
CREATE TABLE calendar_days (
  day date PRIMARY KEY,
  kind text NOT NULL,                 -- 'holiday'（放假）| 'makeup_workday'（補班）
  name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
