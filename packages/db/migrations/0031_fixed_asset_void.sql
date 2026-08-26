-- 固定資產的作廢層＋處分修正欄（第三批 B14；欄位形狀照 0025）。
--
-- 為什麼補這張表：資產登錄打錯（成本少一個零、類別選錯）原本完全改不掉也廢不掉，
-- 唯一出路是假處分——那會在損益表留下一筆憑空的出售資產損失，且沒有端點可以沖回。
--
-- 統一原則同 0025（更正＝作廢＋重開；原單與軌跡永不刪除）：
-- * 資產登錄的作廢：登錄不拋轉取得傳票（0010 檔頭的刻意設計），所以與報價單同型——
--   直接標 voided_at／voided_by／void_reason，沒有 reversal_entry_id。
--   已提折舊的資產不可作廢（折舊傳票是帳上的真實軌跡，「登錄錯誤」在第一張折舊傳票
--   落地後就不成立了），409 指路處分（價款 0＝報廢）。
-- * 處分的作廢：處分有沖帳（沖成本、沖累折、認列損益、貸 2288 銷項稅額），
--   作廢＝反向傳票沖回、資產回到 active 繼續提折舊。處分時補提的折舊**留著**——
--   那是資產真實存在期間的折舊，被作廢的是「賣掉／報廢」這件事，不是資產的存在。
--   disposed_at／disposal_entry_id 保留當軌跡；再處分時覆寫（新舊處分的完整歷程都在傳票上）。
-- * PATCH /fixed-assets/:id 不需要新欄位（名稱／類別／成本／殘值／年限／啟用日 0010 都有），
--   規則在服務層：未提折舊可改基本資料，已提折舊後只可改名稱與備註。

-- 登錄作廢（照 0025 形狀；無 reversal_entry_id——登錄本來就沒拋轉過傳票）
ALTER TABLE fixed_assets ADD COLUMN voided_at timestamptz;
ALTER TABLE fixed_assets ADD COLUMN voided_by integer REFERENCES users(id);
ALTER TABLE fixed_assets ADD COLUMN void_reason text;

-- 處分明細（B14(b)）：價款拆「未稅＋銷項稅額」後，單據面要留得住這個拆法——
-- 只看傳票的話，2288 那一行是哪次處分的、實收含稅多少，幾個月後說不回來
ALTER TABLE fixed_assets ADD COLUMN disposal_proceeds integer; -- 實收總額（含稅）
ALTER TABLE fixed_assets ADD COLUMN disposal_tax integer;      -- 其中銷項稅額

-- 處分作廢（照 0025 形狀）
ALTER TABLE fixed_assets ADD COLUMN disposal_reversal_entry_id integer REFERENCES journal_entries(id);
ALTER TABLE fixed_assets ADD COLUMN disposal_voided_at timestamptz;
ALTER TABLE fixed_assets ADD COLUMN disposal_voided_by integer REFERENCES users(id);
ALTER TABLE fixed_assets ADD COLUMN disposal_void_reason text;
