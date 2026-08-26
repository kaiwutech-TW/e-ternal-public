-- 單據的作廢／更正層（gap-analysis-2608 的 B4，第二批第 1 項）。
--
-- 為什麼做這一批：實測十種單據，建立後幾乎全部改不掉也廢不掉——收付款單打錯金額只能用
-- 手工傳票救總帳（但 partner-balances／帳齡只讀單據表，永遠不動）；扣繳單多打一個零，
-- 帳沖得平、年度彙總卻永久虛增，明年開給房東的憑單會把不存在的所得掛在他的身分證號下。
--
-- ★ 統一設計原則：**更正＝作廢＋重開，不是就地改。**
--   1. 已拋轉傳票的單據，作廢時產生「反向傳票」（原傳票借貸互換，sourceType 沿用原單據的
--      來源別、sourceId 指向原單，memo 註明「作廢沖轉 #原單號」）——總帳靠傳票對沖歸零，
--      兩張傳票都留在帳上；單據面的彙總（餘額／帳齡／401／年度彙總）則以 voided_at 排除。
--   2. 原單標 voided_at／voided_by／void_reason（理由必填），**永不刪除**：
--      作廢是 append-only 紀律的同一件事——留原單、留反向傳票、留理由，事後查得出誰廢了什麼。
--   3. 未拋轉傳票的單據（報價單）直接標作廢即可，沒有反向傳票。
--   4. 關帳鎖：反向傳票的日期落在已關帳期間一律 409，並指路「在開放期間以當日日期沖轉，
--      或先重開期間」。銷貨／進貨單更嚴：**原單日期**所屬期間已關就不可作廢（該期彙總與 401
--      可能已申報，作廢會回溯改掉），出路是退回／折讓單以當期認列——與發票作廢的既有規則一致。
--   5. 已開立（未作廢）發票的銷貨單不得作廢——先作廢發票；有退回單掛著的原單不得作廢
--      （雙重沖銷）。庫存面：銷貨作廢按原出庫成本回補、進貨作廢要在庫量足夠才沖得掉。
--
-- 涵蓋的單據（本批）：收付款單、手工傳票、扣繳支出單、銷貨單（獨立作廢入口）、進貨單、報價單。
-- 合約走「終止」（既有 status），不走作廢；訂單／採購單沿用既有 cancel（未出貨／未收貨才可取消）。
-- sales 不加 reversal_entry_id（0004 已有）；既有的「發票作廢連動沖銷」路徑改為同時落
-- voided_at／void_reason，0025 之前沖銷的舊單這三欄為 NULL（旗標仍是 reversal_entry_id）。

-- 收付款單：作廢＝反向傳票沖現金與應收/應付；立沖紀錄（cash_doc_allocations）保留原列不刪，
-- 但彙總與未沖餘額的計算一律排除已作廢收付款單的沖銷——原單據的未沖餘額隨作廢自動回復
ALTER TABLE cash_docs ADD COLUMN voided_at timestamptz;
ALTER TABLE cash_docs ADD COLUMN voided_by integer REFERENCES users(id);
ALTER TABLE cash_docs ADD COLUMN void_reason text;
ALTER TABLE cash_docs ADD COLUMN reversal_entry_id integer REFERENCES journal_entries(id);

-- 手工傳票：只有 source_type='manual' 的傳票能在這裡作廢——系統拋轉的傳票必須作廢其來源單據，
-- 否則單據還活著、傳票卻沒了，單據面與總帳從此各說各話。reversal_entry_id 指向反向傳票（自參照）
ALTER TABLE journal_entries ADD COLUMN voided_at timestamptz;
ALTER TABLE journal_entries ADD COLUMN voided_by integer REFERENCES users(id);
ALTER TABLE journal_entries ADD COLUMN void_reason text;
ALTER TABLE journal_entries ADD COLUMN reversal_entry_id integer REFERENCES journal_entries(id);

-- 扣繳支出單：B4 實測「最貴的一格」——年度彙總（憑單取數來源）從此以 voided_at 排除，
-- 打錯的單作廢重開後，受領人不會再被掛上不存在的所得
ALTER TABLE withholding_payments ADD COLUMN voided_at timestamptz;
ALTER TABLE withholding_payments ADD COLUMN voided_by integer REFERENCES users(id);
ALTER TABLE withholding_payments ADD COLUMN void_reason text;
ALTER TABLE withholding_payments ADD COLUMN reversal_entry_id integer REFERENCES journal_entries(id);

-- 進貨單：0004 只給了 sales 沖銷欄位，進貨側一直沒有對稱的機制。
-- 作廢條件：原單期間未關帳、無退出／折讓單、各商品在庫量足以沖回原入庫量
ALTER TABLE purchases ADD COLUMN voided_at timestamptz;
ALTER TABLE purchases ADD COLUMN voided_by integer REFERENCES users(id);
ALTER TABLE purchases ADD COLUMN void_reason text;
ALTER TABLE purchases ADD COLUMN reversal_entry_id integer REFERENCES journal_entries(id);

-- 銷貨單：沖銷旗標仍是既有的 reversal_entry_id（0004），這裡補「誰、何時、為什麼」的軌跡
ALTER TABLE sales ADD COLUMN voided_at timestamptz;
ALTER TABLE sales ADD COLUMN voided_by integer REFERENCES users(id);
ALTER TABLE sales ADD COLUMN void_reason text;

-- 報價單：未拋轉傳票，直接標作廢。與「失單」(lost) 是兩件事——失單是客戶沒成交（成交率的分母），
-- 作廢是單子本身建錯（不該進任何統計）。won（已轉訂單）不可作廢
ALTER TABLE quotes ADD COLUMN voided_at timestamptz;
ALTER TABLE quotes ADD COLUMN voided_by integer REFERENCES users(id);
ALTER TABLE quotes ADD COLUMN void_reason text;
