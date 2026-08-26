-- 401 的「算錯稅三件套」（gap-analysis-2608 的 B10／B11，第一批第 4 項）。
--
-- 為什麼做這一批：實測發現三個會讓申報數字直接錯的洞——
--   ① 上期累積留抵（代號 108）永遠是 0：build401 支援 prevCarryForward 但沒有任何輸入通道，
--      有留抵的公司每一期都會溢繳，金額恰等於被丟掉的上期留抵（B11a）。
--   ② 申報人（第 99-103 欄）與委託記帳士（第 98／104 欄）連輸入通道都沒有，
--      而台灣中小企業絕大多數委託記帳士申報（B11c）。
--   ③ 進項的扣抵代號 3/4（不可扣抵）照樣被算進可扣抵合計＝少繳稅；
--      紙本三聯式（格式 21）落錯申報書欄位（B10）——這兩個是取數邏輯的修正，
--      欄位本身 0003 就有（purchases.inv_format／deduction_code），本檔不需要動 purchases。
--
-- === vat_returns：401 申報紀錄（一列＝一期存檔的申報結果）===
--
-- 為什麼要有這張表：留抵是**跨期的鏈**——本期的「上期累積留抵」＝上期的「期末累積留抵」。
-- 沒有任何地方存每期結果，鏈就斷在每一次產檔之後（單期算得出來，算完就丟）。
-- 產出 401 時自動讀上一期存檔列的 carry_forward；找不到（第一次申報）以 0 帶入並在回應出聲，
-- 也可用查詢參數人工覆寫（例如從舊系統帶進來的留抵）。
--
-- 設計：
-- * period 唯一：一期一列。更正申報＝先刪最新一列再重存——只允許刪「最新」一列，
--   因為中間抽掉一列會讓其後每一期存檔的留抵基礎失去來歷（服務層把關）。
-- * 只存申報書的關鍵金額（整數元），不存檔案本體：檔案隨時可由同一期資料重算，
--   存下來的是「當時申報的數字」——之後單據若被改動，兩者的差異正是要被看見的東西。
-- * 本表不拋轉傳票（2288 沖 1288 的期末沖轉是 R19 的獨立一批），所以不掛 journal_entry_id。
CREATE TABLE vat_returns (
  id serial PRIMARY KEY,
  period char(6) NOT NULL UNIQUE, -- 西元起始奇數月 YYYYMM（與產檔參數同一格式）
  roc_period char(5) NOT NULL, -- 民國年月 yyymm（申報書第 4 欄）
  output_sales integer NOT NULL, -- 銷項銷售額（已扣退回折讓減項）
  output_tax integer NOT NULL, -- 銷項稅額（代號 101）
  deductible_input_tax integer NOT NULL, -- 得扣抵進項稅額合計（代號 107）
  prev_carry_forward integer NOT NULL, -- 本期採用的上期累積留抵（代號 108）——存下來才解釋得了 payable
  payable integer NOT NULL, -- 本期應實繳（代號 111）
  carry_forward integer NOT NULL, -- 期末累積留抵（代號 115）＝下一期的 prev_carry_forward
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- === company_profile：申報人與委託記帳士 ===
--
-- 申報書第 98-104 欄的取數來源。filer_id_no 是 PII，紀律同 partners.id_no（0022）：
-- 設了 PII_KEY 就加密存放、不進 GET /company-profile 的一般回傳（只回 has 旗標）、
-- 明文限財務／管理者走單獨端點。長度上限放寬到密文長度（text 無此問題）。
ALTER TABLE company_profile ADD COLUMN filer_name text; -- 申報人姓名（第 100 欄 C(12)）
ALTER TABLE company_profile ADD COLUMN filer_id_no text; -- 申報人身分證統一編號（第 99 欄 X(10)；可能是密文）
ALTER TABLE company_profile ADD COLUMN filer_area_code text; -- 電話區碼（第 101 欄 X(4)）
ALTER TABLE company_profile ADD COLUMN filer_phone text; -- 電話（第 102 欄 X(11)）
ALTER TABLE company_profile ADD COLUMN filer_ext text; -- 分機（第 103 欄 X(5)）
-- 委託記帳士（代理申報人）登錄字號：有值＝委託申報（第 98 欄填 2、第 104 欄填此值），
-- 空＝自行申報（第 98 欄填 1）。用「有無字號」推導而不另設布林，兩欄不可能互相矛盾。
ALTER TABLE company_profile ADD COLUMN declaration_agent_no text;
