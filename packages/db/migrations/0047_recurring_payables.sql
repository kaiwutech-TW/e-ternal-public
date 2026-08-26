-- 週期性支出（每月/每季/每年固定要付出去的錢）：房租、雲端訂閱、記帳士費、
-- 勞健保與勞退、代扣稅款繳庫……在此之前這些錢在系統裡只有兩種存在方式：
-- 已經發生後被記進總帳，或根本不存在——沒有任何一處會在事前把它們列成一張清單。
--
-- ★ 為什麼不是 contracts（direction='purchase'）——這個問題一定會有人再問一次：
--   ① contract_id NOT NULL 逼你為勞保局建一份假合約，counterparty 填「勞保局」
--      是把「我跟誰簽了什麼」寫成謊，任何人（包括內建 agent）讀合約清單都會被誤導。
--   ② 假合約會被算進合約頁的到期橫幅與續約鏈，而待付款只列 active 合約，
--      所以它必須永遠 active 永遠不結束，續約提醒對它毫無意義卻照樣會唸。
--   ③ **最貴的一條**：0046 的付款側「已付」定義是勾對一張既有**進貨單**。
--      保費沒有進項發票、開不出進貨單；硬開一張假進貨單，它會直接進 401 的
--      進項扣抵取數（services/vat.ts）——為了做一格提醒而汙染申報數字，不能接受。
--   合約管的是「我跟誰約定了什麼」，這張表管的是「這個月有哪幾筆錢要付出去」。
--
-- ★ 零斷言紀律（DECISIONS 2026-08-01）在這張表上的具體形狀：
--   週期只能是「每 N 個月」的**純數字**，系統不提供任何以稅目或險種命名的範本
--   （選項名稱本身就是斷言：它同時告訴你誰該多久繳一次）。basis 依據欄必填，
--   由使用者寫下他自己查到的出處。系統只做日期算術，金額與起訖全部使用者給。
--
-- ★ 沒有 status／paid 欄位：「這期付了沒」一律由指向的單據推導（報銷單或傳票存在
--   且未作廢）——與 contract_installments 同一條紀律。存了狀態就會漂移成
--   「單作廢了但排程還寫著已付」。
--
-- ★ 不產生任何傳票、不進應付帳款、不進儀表板的應付數字：**這是計畫不是負債**。
--   真正的負債只在單據過帳當下存在（例：雇主保費是發薪定案時的 2203）。
--   兩邊都算一次，同一筆錢會被重複計。

CREATE TABLE recurring_payables (
  id serial PRIMARY KEY,
  name text NOT NULL,                             -- 純自填，系統不提供任何範本清單
  partner_id integer REFERENCES partners(id),     -- 可空：保費、稅款沒有交易對象
  -- 這筆錢平常記到哪個費用科目（選填，只是建報銷單時的預設值，不是強制）
  default_account_code text,
  -- 依據：使用者自己查到的出處（法規、合約條款、帳單）。服務層擋空字串——
  -- 與 tax_parameters.source、employee_salaries.source_note 同一個形狀
  basis text NOT NULL,
  interval_months integer NOT NULL CHECK (interval_months > 0),  -- 每 N 個月一期
  day_of_month integer NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  default_amount integer NOT NULL DEFAULT 0,      -- 每期預設金額（整數元），展開排程時帶入
  start_date date NOT NULL,
  end_date date,                                  -- NULL＝沒有結束日
  status text NOT NULL DEFAULT 'active',          -- active | ended
  memo text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES users(id)
);

CREATE TABLE recurring_payable_items (
  id serial PRIMARY KEY,
  payable_id integer NOT NULL REFERENCES recurring_payables(id),
  seq integer NOT NULL,
  due_date date NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  description text NOT NULL DEFAULT '',
  -- 結清指標二選一（互斥）：走報銷單（公司支付動線，進項稅可正確進 401），
  -- 或指定一張自己開的手工傳票（保費、稅款繳庫這類沒有憑證可報銷的）
  expense_claim_id integer REFERENCES expense_claims(id),
  journal_entry_id integer REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payable_id, seq),
  CONSTRAINT recurring_payable_items_one_doc
    CHECK (expense_claim_id IS NULL OR journal_entry_id IS NULL)
);

CREATE INDEX recurring_payable_items_due_idx ON recurring_payable_items (due_date);
