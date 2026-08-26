-- 預收／預付（gap-analysis-2608 的 B9，第二批）：溢收不再是負數應收。
--
-- 為什麼做這一批：實測客戶只欠 36,540 卻收 500,000，系統照樣 201——應收帳款直接變
-- -463,460（負的資產），資產負債表會被記帳士退件；供應商側同理（付 300,000 只欠 21,000
-- → 負的應付負債）。收訂金、客戶預付月結款、付供應商訂金都是食品貿易的常態，
-- 溢收溢付需要自己的科目：收款超過「該對象當下未沖餘額合計」的部分掛 2231 預收款項
-- （負債）、付款溢付掛 1212 預付貨款（資產），應收／應付永遠不為負，
-- 資產負債表分列、不以淨額互抵。
--
-- ★ 為什麼不開新表記預收餘額：
--   「這張單還剩多少預收」＝ cash_docs.unapplied_amount −（該單 from_prepaid 沖銷合計），
--   完全可由既有結構推導。「用預收沖後續銷貨」本質上就是「這張收款單沖銷那張單據」——
--   與既有 cash_doc_allocations 同一形狀；另開一張餘額表等於把同一種事實拆成兩套
--   加總邏輯（allocatedByTarget 得寫兩遍），兩邊必然漂移。
--
-- ★ 溢收金額在建單當下落地（unapplied_amount）而不是每次重算：
--   傳票的 2231／1212 金額建單時已經入帳，事後的銷貨、退回不得回頭改變這個切分
--   （改了單據面就與傳票對不上）——它是單據事實，不是推導值。
--
-- ★ 事後沖用預收／預付（from_prepaid = true 的沖銷列）：
--   每批沖用產生自己的傳票（收款側借 2231 貸 1144；付款側借 2144 貸 1212），
--   journal_entry_id 指向它、alloc_date 是沖用日（受關帳鎖）。建立時的立沖列這三欄
--   維持 false／NULL——那部分金額已含在收付款單的原傳票裡，不另生傳票。
--   收付款單作廢時，沖用傳票一併反向沖轉（services/void.ts）；沖用列本身保留（軌跡），
--   彙總一律以收付款單的 voided_at 排除。
--
-- 既有資料：0027 之前建立的收付款單 unapplied_amount 一律 0（維持當時入帳的形狀）。
-- 舊單若已把應收沖成負數，正路是作廢重開（0025 的 B4 原則）——
-- migration 不代使用者改帳：重分類的日期與科目是會計判斷，不是資料修補。

ALTER TABLE cash_docs ADD COLUMN unapplied_amount integer NOT NULL DEFAULT 0
  CHECK (unapplied_amount >= 0);
-- 溢收部分不可能超過收付金額（服務層以未沖餘額合計計算），資料庫再守一層
ALTER TABLE cash_docs ADD CONSTRAINT cash_docs_unapplied_within_amount
  CHECK (unapplied_amount <= amount);

ALTER TABLE cash_doc_allocations ADD COLUMN from_prepaid boolean NOT NULL DEFAULT false;
ALTER TABLE cash_doc_allocations ADD COLUMN alloc_date date;
ALTER TABLE cash_doc_allocations ADD COLUMN journal_entry_id integer REFERENCES journal_entries(id);
-- 事後沖用必須帶沖用日與傳票；建立時立沖必須兩者皆空——兩種列不允許中間態
ALTER TABLE cash_doc_allocations ADD CONSTRAINT cash_doc_allocations_prepaid_shape
  CHECK ((from_prepaid AND alloc_date IS NOT NULL AND journal_entry_id IS NOT NULL)
      OR (NOT from_prepaid AND alloc_date IS NULL AND journal_entry_id IS NULL));
