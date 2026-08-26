-- HR 出勤地基（第一批之一）：部門樹、員工檔擴充、班別、排班、打卡
--
-- 為什麼做這一批：出勤與薪資自建，才能與既有總帳打通（docs/specs/hr-attendance.md
-- 有完整規格）。目標形狀是數十人、多部門、全職＋部分工時混合、排班制——
-- 規模假設不是「10 人固定班」，所以部門樹與直屬主管（簽核鏈的地基）第一批就要。
--
-- ★ 設計紀律一：**打卡紀錄 append-only**。勞基法要求出勤紀錄逐日記載並保存
--   （條號待查證後補進 spec）——打卡了就是打卡了，打錯不改原紀錄，
--   走「補卡申請」（下一批的申請單）產生更正列，原列永遠留著。
--   這與稅法參數、作廢層是同一條紀律的第三次出現。
--
-- ★ 設計紀律二：**0022 說「整套系統沒有部門維度」的決定就此翻案**，理由記錄在案：
--   當時的判斷基於 10 人無部門的想像；實機考察看到的是多部門＋當層主管簽核。
--   部門先只服務 HR（簽核鏈與出勤報表分組），**不**動會計面（報表的部門別成本
--   歸屬是另一個議題，見 gap-analysis「報表維度」節，不在此偷渡）。
--
-- ★ 設計紀律三：**班別的打卡歸屬日切點**（跨日班的核心解法，抄自實機考察）：
--   晚班 15:00~00:00 的下班卡落在隔天凌晨——「從歸屬日 HH:MM 之後的打卡歸前一天」
--   的切點讓跨日班的兩張卡歸到同一個出勤日。預設 04:00（清晨四點前的卡多半是
--   前一天晚班的收尾，不是今天的早到）。
--
-- ★ 扣薪級距等「錢」的規則本批**只存不算**：入帳與算薪是薪資批（第二批）的事，
--   出勤批先把事實記全（遲到幾分鐘是事實，扣多少錢是政策）。

-- === 部門樹 ===
CREATE TABLE departments (
  id serial PRIMARY KEY,
  name text NOT NULL,
  parent_id integer REFERENCES departments(id),   -- NULL＝頂層
  manager_employee_id integer REFERENCES employees(id),  -- 當層主管（簽核鏈的「第 N 關」取這裡）
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- === 員工檔擴充（0022 的 B3 之後、HR 需要的另一半） ===
ALTER TABLE employees ADD COLUMN department_id integer REFERENCES departments(id);
-- 直屬主管可以與部門主管不同（實機考察：員工檔上是獨立欄位）
ALTER TABLE employees ADD COLUMN manager_employee_id integer REFERENCES employees(id);
-- 全職／部分工時。text 不用 enum（同 contracts.kind 的理由）
ALTER TABLE employees ADD COLUMN employment_type text NOT NULL DEFAULT 'fulltime';
-- 免打卡（老闆與部分主管）：不產生出勤異常、打卡頁仍可自願打
ALTER TABLE employees ADD COLUMN punch_exempt boolean NOT NULL DEFAULT false;

-- === 班別 ===
CREATE TABLE shifts (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,          -- D001/N001 慣例，使用者自訂
  name text NOT NULL,
  color text NOT NULL DEFAULT '#0071e3',
  start_time time NOT NULL,
  end_time time NOT NULL,             -- 小於 start_time＝跨日班
  -- 休息時間多段：[{"start":"12:00","end":"13:00"}]。獨立表太重——休息段沒有自己的生命週期
  breaks jsonb NOT NULL DEFAULT '[]',
  -- 打卡歸屬日切點：這個時刻（含）之前的打卡歸前一天。預設 04:00
  day_cutoff time NOT NULL DEFAULT '04:00',
  active boolean NOT NULL DEFAULT true,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- === 排班：某員工某天上某班 ===
-- 固定班＝排班的特例（每週重複），先做通例；「一鍵展開整週/整月」由服務層產列，
-- 落地後每一天都是一列——改某天的班不會影響其他天（與月費排程展開同一個做法）
CREATE TABLE schedules (
  id serial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id),
  work_date date NOT NULL,
  shift_id integer NOT NULL REFERENCES shifts(id),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date)     -- 一天一班；換班＝改列（排班是計畫不是單據，可改）
);

-- === 打卡紀錄（append-only，見紀律一） ===
CREATE TABLE punches (
  id serial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id),
  punched_at timestamptz NOT NULL DEFAULT now(),
  direction text NOT NULL,            -- 'in' | 'out'（服務層驗，text 留擴充如外出/簽到）
  -- 出勤日：依班別 day_cutoff 換算落地（不即時推導——班別事後改了，歷史出勤日不能跟著漂）
  work_date date NOT NULL,
  source_ip text NOT NULL DEFAULT '',
  -- 'web'；未來 'correction'（補卡核准後由系統寫入）、'import'（外部系統平行期匯入）
  method text NOT NULL DEFAULT 'web',
  memo text NOT NULL DEFAULT ''
);

CREATE INDEX punches_employee_date_idx ON punches (employee_id, work_date);

-- === 出勤設定（單列，同 agent_settings 模式）===
CREATE TABLE attendance_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- IP 白名單：CIDR 或完整 IP，逗號分隔；空字串＝不限制（遠端打卡）。
  -- 打卡時記下 source_ip 無論如何都做——限制是政策，紀錄是事實
  ip_allowlist text NOT NULL DEFAULT '',
  -- 彈性上下班（分鐘）：可早到/晚到的緩衝；0＝不彈性。早到可早走、晚到需晚下（實機考察的語意）
  flex_minutes integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES users(id)
);

INSERT INTO attendance_settings (id) VALUES (1);
