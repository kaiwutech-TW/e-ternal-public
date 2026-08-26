-- 稅法參數表：使用者自己查證、自己填、自己註明依據的稅法設定值，帶生效期間。
--
-- 為什麼要做這一批：在此之前，「稅率」在本系統有兩種存在形式，而兩種都不對——
--   ① 寫死在程式常數裡（packages/core/src/money.ts 的 VAT_RATE、
--      apps/api/src/services/expenses.ts 的 /1.05、invoices.ts 的 *1.05 與 taxRate: 0.05）：
--      改一次要改程式並重新部署，一般使用者做不到；而且它偽裝成「系統知道正確答案」。
--   ② 寫在扣繳類別上（0015 的 tax_rate_bp）：使用者填得動、也有來源欄，
--      但它**沒有生效期間**——費率變動時只能覆寫，覆寫掉的那一刻，去年的單據就再也解釋不出來了。
-- 本表補的正是 ② 缺的那一塊：**同一個參數在不同期間可以有不同的值，而且兩個值都留著**。
--
-- ★ 本批的設計紀律（使用者已拍板，違反者一律重做）：
--   **系統絕不斷言任何稅率、免稅額度、繳納期限或憑單格式代號。**
--   程式提供結構與算術，不提供答案。連舉例都不能用實際稅率——
--   例子裡的數字就是使用者最可能照抄的答案。本檔的範例一律用中性數字（3.5%、10 萬）。
--   唯一的例外是下方那一列 vat 種子，它是**既有行為的遷移**而不是查證結果，
--   source_note 已把這件事寫成使用者看得到的文字（見該段註解）。
--
-- ★ append-only 是這張表的核心紀律：法規變了是**新增一列並把舊列的 valid_to 補上**，
--   永不覆寫、永不刪除。理由不是資料潔癖，是**舊年度必須算得回來**：
--   核定通知或更正申報可能兩三年後才來，那時要重算的是「當年那個費率下的數字」。
--   如果參數列被覆寫，過去每一張單據的稅額都會變成無法解釋的孤兒——
--   帳上寫著 50，而系統現在算出來是 40，沒有任何地方查得到 50 是怎麼來的。
--   （同一個紀律見 .flightwake/DECISIONS.md 的 append-only 體例，
--    以及 schema_migrations 的「記錄哪些跑過」——都是「歷史必須留著」的同一件事。）
--   服務層據此只提供三種操作：新增一列、查詢、以及「接續」（把前一列的 valid_to
--   設為新列 valid_from 的前一天）。**接續是唯一允許改動舊列的情形，而且只動 valid_to。**
--
-- ★ 本檔不得出現任何 ALTER TYPE ... ADD VALUE 後立即使用新值的寫法：
--   migration runner 把整份 SQL 一次 exec 送出＝Postgres 隱式單一交易（0014／0015 已踩過）。
--   本檔沒有新增列舉型別，kind 刻意用 text 而不是 enum，理由見下。

-- === tax_parameters ===
--
-- kind：參數的種類。**用 text 而不是 pgEnum**，因為使用者必須能自訂：
--   本系統預期會用到的四種是 'vat'（營業稅率）、'income_tax'（營所稅級距）、
--   'undistributed_earnings'（未分配盈餘）、'input_tax_deductible'（報銷分類的進項稅可否扣抵），
--   但這四種是「我們想得到的」，不是窮舉。使用者查到一個我們沒想過的參數
--   （查定課徵稅率、某類支出的列報限額）時，應該當場就能記下來，而不是等我們改 enum 再發版。
--   enum 的代價是每加一種都要一次 migration＋部署；text 的代價只是「打錯字會多出一種 kind」，
--   而那件事在維護頁上一眼就看得見（依 kind 分組列出）。
--
-- scope_key：該 kind 需要細分時用。
--   'input_tax_deductible' 用費用科目代號（'6112'、'6137'…）當 scope_key，
--   'vat' 這種全公司只有一個值的就留 NULL。
--   為什麼不做成 FK：與 0015 的 expense_account_code 同一個先例——科目是應用層
--   seedAccounts() 灌的，migration 執行時可能一個科目都還沒有。
--
-- valid_from / valid_to：生效期間（含兩端）。**valid_to 為 NULL＝仍有效**。
--   為什麼用日期而不是年度：法規變動不保證落在年初，而單據日期本來就是日期。
--   解析規則（服務層與 packages/core/src/tax-parameters.ts 共用一份）：
--   找出 valid_from <= 單據日期 AND (valid_to IS NULL OR 單據日期 <= valid_to) 的那一列。
--
-- brackets / bool_value：**參數的值，兩種形狀二選一**（CHECK 強制恰好一種非 NULL）。
--   brackets 是級距型（jsonb 陣列），每個元素 { from, to, mode, rateBp }，
--     mode 三選一，都是**通用的算術形狀，不以任何特定稅制命名**：
--       exempt         該級距不課
--       rate_on_total  稅額 = 課稅基礎全額 × rateBp
--       rate_of_excess 稅額 = (課稅基礎 − from) × rateBp
--     rateBp 用 basis point（萬分之一）與 0015 同一個理由：整數運算避開浮點誤差，
--     而 bp 而不是百分點是為了容納帶小數的費率（例如 3.5% ＝ 350 bp）而不需要 numeric。
--     單一費率（例如營業稅率）就是「只有一個 rate_on_total 級距、涵蓋全區間」的特例，
--     不另立欄位——多一個欄位就多一組「哪個欄位才是準的」的歧義。
--   bool_value 是布林型（例如某個費用科目的進項稅可否扣抵）。
--   為什麼不允許兩者都填或都空：都空＝一列沒有值的參數（畫面上會顯示成一個空格，
--   使用者以為自己設定過了）；都填＝取數時無從決定要看哪一個，而那個歧義只會在
--   幾個月後某張單據算錯時才浮出來。CHECK 在寫入當下就擋掉。
--
-- source_note：使用者自己寫的依據（例如「依據 XXX 頁面，查詢日 2026-08-01」）。
--   程式完全不驗證內容——驗格式只會逼人寫假的。但填了值卻沒寫來源時，維護頁會提示（不阻擋）。
--
-- entered_by / entered_at：誰在什麼時候填的。這不是稽核潔癖：
--   兩年後有人問「這個數字哪來的」，source_note 回答「照哪裡填」，這兩欄回答「誰去查的」，
--   而那個人通常還在公司，問得到。
CREATE TABLE tax_parameters (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  scope_key text,
  label text NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  brackets jsonb,
  bool_value boolean,
  source_note text,
  entered_by integer REFERENCES users(id),
  entered_at timestamptz NOT NULL DEFAULT now(),
  -- 生效期間顛倒：把 valid_to 打成比 valid_from 早，這一列就永遠解析不到任何日期，
  -- 而畫面上它看起來跟正常的列一模一樣——使用者會以為自己已經設定好了，
  -- 然後每一張單據都靜靜地走回退路徑。在輸入當下擋掉，比事後查「為什麼都用預設值」好
  CONSTRAINT ck_tax_parameters_period CHECK (valid_to IS NULL OR valid_to >= valid_from),
  -- 恰好一種形狀（見上）。<> 對布林值就是 XOR
  CONSTRAINT ck_tax_parameters_shape CHECK ((brackets IS NOT NULL) <> (bool_value IS NOT NULL)),
  -- 空字串的 kind 會在維護頁分出一個沒有標題的組，而且永遠解析不到（服務層一律用具名 kind 查）
  CONSTRAINT ck_tax_parameters_kind CHECK (kind <> ''),
  CONSTRAINT ck_tax_parameters_label CHECK (label <> '')
);

-- 取數路徑：(kind, scope_key) 定位到一組列，再用日期挑出生效的那一列。
-- 生效期間重疊的檢查（服務層做，因為它要能說出「跟哪一列衝突」）也走這條索引。
CREATE INDEX idx_tax_parameters_kind ON tax_parameters (kind, scope_key);
CREATE INDEX idx_tax_parameters_valid_from ON tax_parameters (valid_from);

-- === 種子：一列 vat 參數 ===
--
-- ⚠️ 這是本檔唯一一個實際稅率，而它之所以被允許存在，是因為它**不是本專案的查證結果**，
--    而是「既有行為的遷移」：在這張表出現之前，全系統的營業稅額都是用這個值算的
--    （packages/core/src/money.ts 的 VAT_RATE），已入帳的每一張單據、每一張發票 XML、
--    每一份 401 媒體檔都建立在它之上。不遷移它，這批一上線就會有兩個後果：
--    ① 既有資料庫的每一張新單據都走回退路徑並不斷跳警告（雜訊會蓋掉真正的警告）；
--    ② 「首次啟動」與「升級上來」兩種資料庫的行為不一致，而那是最難察覺的差異。
--
--    誠實的來源標註與斷言的差別，在於它說的是「**這個值從哪裡來**」而不是「這個值是對的」。
--    所以 source_note 明白寫著它是遷移、不是查證，並要使用者自己補上依據——
--    維護頁也會把「有值但來源看起來還沒被使用者確認」的列標出來。
--
-- valid_from 刻意用一個非常早的日期：它必須涵蓋資料庫裡**已經存在的每一張單據**
--    （退回單會回頭用原單日期解析費率，而原單可能是好幾年前的），否則升級後
--    舊單據的退貨會突然走回退路徑。這個日期**不是**「該稅率自此適用」的主張，
--    只是「本列涵蓋本系統遷移前的所有既有資料」的技術下界——label 已把這件事寫進畫面。
--
-- 為什麼種子放在 migration 而不是 seedAccounts()：migration 每個資料庫只跑一次，
-- 天生就是「首次啟動灌一次」的語意。使用者接續了新的一列、改了標籤，
-- 都不會在下次重啟被蓋回去（與 0015 的扣繳類別種子同一個理由）。
INSERT INTO tax_parameters (kind, scope_key, label, valid_from, valid_to, brackets, source_note) VALUES (
  'vat',
  NULL,
  '營業稅率（系統遷移前的既有值）',
  '1900-01-01',
  NULL,
  '[{"from":0,"to":null,"mode":"rate_on_total","rateBp":500}]'::jsonb,
  '此列是既有行為的遷移（DECISIONS 2026-07-21 與官方範例 golden 測試），不是本專案的查證結果；請確認後補上你的依據來源。'
);

-- ── 費率快照：消除「讀取時再推導」 ────────────────────────────────────────
-- 對抗驗證實測抓到的 blocker：401 的 B2C 拆算與退回單的稅額原本是「讀取時依日期解析費率」，
-- 於是新增一列 vat 參數就會**追溯改掉已關帳（可能已申報）期間的申報數字**——
-- 實測 401 的銷項稅額從 50 變成 175，而發票 XML 仍寫著開立當時的費率、總帳 2288 仍是 50，
-- 三者互不相符且畫面上零徵兆。同一支 invoices.ts 的作廢流程對已關帳期間是明確丟 409 的，
-- 稅法參數走的是同一個後果，卻沒有同一道門。
--
-- 根治的辦法不是加更多門，是**不要在讀取時重算**：單據建立當下把解析到的費率存下來，
-- 之後任何需要回推的地方（B2C 拆算、退回單軋平）一律用單據自己那一格的快照。
-- 這樣參數怎麼改都不會回頭動到已落地的單據——與「單據存的是算好的金額」同一個原則。
ALTER TABLE sales ADD COLUMN vat_rate_bp integer;
ALTER TABLE purchases ADD COLUMN vat_rate_bp integer;
ALTER TABLE invoices ADD COLUMN vat_rate_bp integer;
ALTER TABLE quotes ADD COLUMN vat_rate_bp integer;
ALTER TABLE orders ADD COLUMN vat_rate_bp integer;
ALTER TABLE purchase_orders ADD COLUMN vat_rate_bp integer;
COMMENT ON COLUMN sales.vat_rate_bp IS '建單當下解析到的營業稅率（basis point）；NULL＝本欄位出現前建立的舊單，回推時退回參數解析';
