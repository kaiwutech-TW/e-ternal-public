-- 扣繳追蹤：交易對象的個人／法人區分、使用者自訂的扣繳類別、扣繳支出單
--
-- 為什麼要做這一批：付錢給個人（房東、接案設計師、記帳的個人工作者）時可能要代扣稅款，
-- 而在此之前系統裡「付款對象是自然人」這件事無處可存、2211/2212 兩個科目沒有任何流程會寫入，
-- 唯一記得出三腳分錄的地方是手工傳票——摘要是自由文字，要做年度憑單申報時
-- 無法依「所得人 × 所得類別 × 年度」彙總，等於扣了稅卻沒有機器可讀的申報取數來源。
--
-- ★ 本批的設計紀律（使用者已拍板）：**系統提供結構與算術，稅率／級距／門檻一律由使用者填寫**。
--   費率欄位允許 NULL＝尚未設定，種子資料只給「白話標籤 → 費用科目」的對應，費率一律留空。
--   理由：①這些每年會變，寫死是定時炸彈 ②本專案紀律是「法規原文為一級規格」
--   ③把無法查證的數字寫進程式，就是把猜測包裝成看起來很權威的東西。
--
-- ★ 本檔不得出現 'withholding' 這個 doc_source 字面值（不設 DEFAULT、不 INSERT 用到它）：
--   migration runner 把整份 SQL 一次 exec 送出＝Postgres 隱式單一交易，而 ALTER TYPE ADD VALUE
--   的新值不得在同一交易內被使用，一旦出現字面值會整檔回滾並丟 "unsafe use of new value"
--   （0014 已踩過並記錄）。把欄位宣告成 doc_source 型別不算「使用該值」，所以建表是安全的。

ALTER TYPE doc_source ADD VALUE IF NOT EXISTS 'withholding';

-- === A. partners：個人／法人區分 ===
--
-- is_individual：付款對象是自然人。它不只是顯示用的標籤——扣繳支出單只接受個人，
--   因為對法人付款不會有扣繳與年度憑單作業（該走進貨單或費用報銷）。
--
-- ⚠️ id_no 是個人資料（PII）：個人的身分證統一編號／居留證號，年度憑單申報時必須填。
--   1 英文＋9 數字，與 tax_id 的 char(8) 格式長度都不同，因此另立欄位而不是塞進 tax_id
--   （硬塞會撞統編檢查碼驗證的 422，或被 char(8) 截斷）。
--   本欄位的處理紀律：
--   1. **不得出現在任何飛行紀錄、規格文件、匯出範例或測試 fixture 的真實值中**——本 repo 可能公開。
--   2. **不建索引**：索引檔會把明文另外複製一份出去，而這欄從來不需要被查詢或排序。
--   3. **不進 list API 的預設回傳**：GET /partners 只回「有沒有填」（has_id_no），
--      真正要看明文得走單筆專用端點，且限財務／管理者（見 apps/api/src/services/auth.ts）。
--   之所以還是要存：不存的話，要填年度憑單時得回頭翻紙本合約，而系統存了名字卻不存身分證號
--   等於把「申報用的資料來源」做成半套。
ALTER TABLE partners ADD COLUMN is_individual boolean NOT NULL DEFAULT false;
ALTER TABLE partners ADD COLUMN id_no text;

-- 個人不得有統一編號：統編是營利事業的識別碼，個人填了它一定是資料錯置
-- （最常見的是把房東本人與他名下公司混為一筆）。反向不設限制——法人可以先不填統編。
ALTER TABLE partners ADD CONSTRAINT ck_partners_individual_no_tax_id
  CHECK (NOT (is_individual AND tax_id IS NOT NULL));

-- === B. withholding_categories：扣繳類別＝使用者自己填的費率設定 ===
--
-- tax_rate_bp / supplement_rate_bp 用 basis point（萬分之一，10% = 1000）：
--   整數運算避開浮點誤差（與全系統「金額一律整數元」同一個理由），
--   而 bp 而不是百分點是為了容納帶小數的費率（例如 3.5%）而不需要 numeric。
--   註解刻意不舉實際稅率當例子：例子裡的數字就是使用者最可能照抄的答案。
-- **允許 NULL＝使用者尚未設定**。NULL 與 0 必須分得開：0 是「我查過，這類不用扣」，
--   NULL 是「還沒查」——前者可以安心過帳，後者要在畫面上一直提醒。
--   所以這兩欄刻意不給 DEFAULT 0：預設 0 會讓「沒設定」偽裝成「不用扣」。
--
-- source_note：使用者自己寫的依據來源（例如「依據：財政部 XX 頁面，查詢日 2026-07-30」）。
--   程式完全不驗證內容——驗格式只會逼人寫假的。但費率有值而來源空白時 UI 會提示（不阻擋）。
--
-- expense_account_code 是 text 而不是 accounts(id) 的 FK：科目是由應用層的 seedAccounts()
--   灌入的（單一事實來源在 packages/core/src/chart.ts），migration 執行時可能還沒有任何科目，
--   加 FK 會讓這裡的種子資料無法插入。與 expense_items.account_code 同一個先例。
--   代號存不存在、有沒有被停用，在過帳當下才查（並給得出脫困指示）。
CREATE TABLE withholding_categories (
  id serial PRIMARY KEY,
  label text NOT NULL,
  expense_account_code text NOT NULL,
  tax_rate_bp integer,
  supplement_rate_bp integer,
  source_note text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 上限 10000 bp＝100%：扣繳額不可能超過給付額，打錯一個零（例：3.5% 打成 35%）
  -- 在設定當下就擋掉，比等到每張單的淨額變負數才發現好
  CONSTRAINT ck_withholding_categories_tax_rate
    CHECK (tax_rate_bp IS NULL OR (tax_rate_bp >= 0 AND tax_rate_bp <= 10000)),
  CONSTRAINT ck_withholding_categories_supplement_rate
    CHECK (supplement_rate_bp IS NULL OR (supplement_rate_bp >= 0 AND supplement_rate_bp <= 10000))
);

-- 種子類別：**只給白話標籤與費用科目對應，費率一律 NULL**。
-- 為什麼種子放在 migration 而不是 seedAccounts()：migration 每個資料庫只跑一次，
-- 天生就是「首次啟動灌一次」的語意——使用者改了標籤、停用了類別，都不會在下次重啟被蓋回去
-- （科目種子是 onConflictDoNothing + 每次啟動校正旗標，那套邏輯的前提是「代號由我們定義」，
--  而扣繳類別從第一天起就是使用者的資料）。
INSERT INTO withholding_categories (label, expense_account_code) VALUES
  ('付給個人房東的租金', '6121'),
  ('付給個人的專業服務費（記帳、法律、設計等）', '6124');

-- === C. withholding_payments：扣繳支出單 ===
--
-- 一張單同時記三件事：認列多少費用（gross）、代扣了多少（tax / supplement）、實際付出去多少（net）。
-- 費用報銷結構上做不到這件事（claim.total 一個金額貫穿核准與付款兩張傳票），
-- 硬用報銷記淨額的後果是「費用少列、扣繳稅款憑空消失」——這是本表存在的理由。
--
-- net_amount 落地而不是每次相減算出來：它是「這張單實際付出去的錢」，
-- 現金流與對帳都直接取它；CHECK 保證恆等式，所以落地不會與 gross/tax/supplement 漂移。
--
-- tax_withheld / supplement_withheld 由服務層以類別費率**試算成預設值**，但一律允許使用者覆寫：
-- 門檻、免扣額、身分別例外我們沒有模型，硬算會給出看似權威的錯數字（見服務層檔頭）。
--
-- partner 必須是 is_individual：這條在服務層檢查而非 DB CHECK——跨表的條件在 Postgres
-- 只能靠 trigger 實作，而 trigger 是另一份沒人記得的商業邏輯；服務層擋還能給出脫困指示。
CREATE TABLE withholding_payments (
  id serial PRIMARY KEY,
  partner_id integer NOT NULL REFERENCES partners(id),
  category_id integer NOT NULL REFERENCES withholding_categories(id),
  pay_date date NOT NULL,
  gross_amount integer NOT NULL,
  tax_withheld integer NOT NULL DEFAULT 0,
  supplement_withheld integer NOT NULL DEFAULT 0,
  cash_account_id integer NOT NULL REFERENCES accounts(id),
  net_amount integer NOT NULL,
  journal_entry_id integer REFERENCES journal_entries(id),
  memo text NOT NULL DEFAULT '',
  -- 建單當下這個類別的費率快照（NULL＝當時尚未設定）。
  -- 為什麼要存：費率沒設定時系統以 0 計，但那個 0 與「查過、確實不用扣的 0」在帳上長得一模一樣。
  -- 年度彙總是申報憑單的取數來源，使用者看到一欄 0 無從分辨自己是不是漏設了費率——
  -- 而建單當下的提示只出現一次，事後完全查不回來。存了快照，彙總就能把它標出來。
  tax_rate_bp_at_entry integer,
  supplement_rate_bp_at_entry integer,
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_withholding_payments_gross CHECK (gross_amount > 0),
  CONSTRAINT ck_withholding_payments_tax CHECK (tax_withheld >= 0),
  CONSTRAINT ck_withholding_payments_supplement CHECK (supplement_withheld >= 0),
  -- 淨額恆等式＋不得為負：扣繳額合計超過給付額是輸入錯誤，
  -- 放它過去會讓「貸 現金」變成負數而被 assertBalanced 擋在更下游、錯誤訊息也看不懂
  CONSTRAINT ck_withholding_payments_net
    CHECK (net_amount = gross_amount - tax_withheld - supplement_withheld AND net_amount >= 0)
);
-- 年度彙總（受領人 × 類別）與清單的取數路徑；刻意不索引 partners.id_no（PII，見上）
CREATE INDEX idx_withholding_payments_partner ON withholding_payments (partner_id);
CREATE INDEX idx_withholding_payments_date ON withholding_payments (pay_date);
CREATE INDEX idx_withholding_payments_category ON withholding_payments (category_id);
