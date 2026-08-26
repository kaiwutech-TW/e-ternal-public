-- 合約深化：類型、分期請款計畫、續約成鏈（顧問／軟體開發業的營收形狀）
--
-- 為什麼做這一批：合約原本只是「一張掃描檔＋起迄日＋一個金額」的登記簿。
-- 對買賣業夠用（營收在銷貨單上），對顧問／軟體開發業不夠——他們的營收**長在合約上**：
-- 專案合約分期請款（簽約金／期中款／驗收尾款）、顧問月費約每月請一次、維護約年年續。
-- 「這期該向誰請多少錢」目前在系統裡無處可問，只能靠人記，而忘了請款＝白做工。
--
-- ★ 設計紀律一：**請款計畫是計畫，單據是單據**。
--   installment 是內部的排程，不是對外的憑證——所以未請款的計畫列可以改、可以刪
--   （這不違反 append-only：append-only 守的是「發生過的交易」，計畫還沒發生）。
--   一旦開了銷貨單（sale_id 非 NULL），該列就鎖住：要改先作廢那張銷貨單，
--   作廢後計畫列自動回到「未請款」可重開。單一事實來源是銷貨單，計畫列只是指標。
--
-- ★ 設計紀律二：**續約＝開新合約成鏈，不是改舊合約的日期**。
--   把 end_date 往後改等於竄改歷史（去年的合約條件是什麼再也查不到）。
--   續約動作建立一份新合約、以 renewed_from_id 指回前身、前身標 ended——
--   與「更正＝作廢＋重開」（0025）是同一個紀律的正面版本。
--
-- ★ 設計紀律三：**金額欄一律未稅**（與報價單/銷貨單的 lines 同口徑）。
--   開單時走 createSale 的既有稅額計算（含課稅別）。合約總額與分期合計不一致時
--   只提示不硬擋——差額可能是議價或未列入排程的保留款，那是商業判斷。
--
-- kind 用 text 不用 pgEnum（與 tax_parameters.kind 同理由）：
-- 'project' 專案（一次或分期）／'retainer' 顧問月費／'maintenance' 維護（年約）／'other'。
-- 使用者遇到我們沒想過的型態時不必等發版。

ALTER TABLE contracts ADD COLUMN kind text NOT NULL DEFAULT 'other';
-- 續約提醒提前天數；NULL＝用系統預設（45 天，原本寫死在前端，現在逐約可調）
ALTER TABLE contracts ADD COLUMN renew_notice_days integer;
-- 續約鏈：這份合約是從哪一份續來的
ALTER TABLE contracts ADD COLUMN renewed_from_id integer REFERENCES contracts(id);

CREATE TABLE contract_installments (
  id serial PRIMARY KEY,
  contract_id integer NOT NULL REFERENCES contracts(id),
  seq integer NOT NULL,                -- 期次（第 1 期、第 2 期…），同一合約內唯一
  due_date date NOT NULL,              -- 預計請款日
  amount integer NOT NULL CHECK (amount > 0),   -- 未稅金額（整數元）
  description text NOT NULL DEFAULT '',         -- 這一期是什麼：簽約金 30%、驗收尾款…
  sale_id integer REFERENCES sales(id),         -- NULL＝未請款；指向的銷貨單被作廢＝視同未請款
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX contract_installments_contract_seq_idx
  ON contract_installments (contract_id, seq);
CREATE INDEX contract_installments_due_idx ON contract_installments (due_date);
