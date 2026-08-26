-- 處分發票登錄（第四批；gap-analysis B14(b) 尾款）：發票模組開放對固定資產處分開立。
--
-- 為什麼：401 的銷項取數來源是發票清單（services/vat.ts 逐張讀 invoices），
-- 處分認列的 2288 銷項稅額原本只有 taxNotes 出聲提醒「請開立統一發票」——
-- 提醒不會自己進申報書，人一忘就是漏報銷項（補稅加罰的方向）。
-- 現在處分可以（可選）在系統內開立發票：發票金額＝處分價款、稅額＝處分稅額
-- （皆取自處分當時落地的 disposal_proceeds／disposal_tax，不重算），401 銷項自然涵蓋；
-- 不開發票的處分維持現狀（taxNotes 出聲）。作廢連動與銷貨發票同一套規則
-- （先廢發票才能廢處分；廢發票時可勾選連動沖回處分）。
--
-- ★ 來源泛化選「加 asset_id 欄＋sale_id 改 nullable」而不是 source_type/source_id：
--   後者要 backfill 既有全部發票（source_type='sale'、source_id=sale_id），
--   且所有以 invoices.sale_id join 的查詢（vat.ts 退回減項、allowance-xml、returns）
--   都得跟著改寫。加一欄讓既有資料**零搬遷**、既有 join 零改動：
--   sale_id IS NOT NULL＝銷貨發票（形狀不變）、asset_id IS NOT NULL＝處分發票。
--   CHECK 保證恰好一個來源——兩個都空的發票沒有來歷，兩個都有的發票會被兩邊各算一次。
ALTER TABLE invoices ALTER COLUMN sale_id DROP NOT NULL;
ALTER TABLE invoices ADD COLUMN asset_id integer REFERENCES fixed_assets(id);
ALTER TABLE invoices ADD CONSTRAINT ck_invoices_single_source
  CHECK (num_nonnulls(sale_id, asset_id) = 1);
COMMENT ON COLUMN invoices.asset_id IS '處分發票的來源資產（fixed_assets.id）；NULL＝銷貨發票（sale_id 必有值，見 ck_invoices_single_source）';

-- 與 uq_invoices_sale_issued（0004）同一條規則：同一筆處分至多一張 issued 發票，
-- 作廢後可重開（多張 canceled ＋ 至多一張 issued）
CREATE UNIQUE INDEX uq_invoices_asset_issued ON invoices (asset_id) WHERE status = 'issued';

-- 處分當時解析到的營業稅率快照（bp）。發票可能晚於處分才開（處分時沒勾、或作廢重開），
-- 開票時「依處分日重新解析」會在參數事後被新增／接續時拿到另一個費率，
-- 而 disposal_tax 早已落地不會跟著變——同一個教訓已在 sales.vat_rate_bp 與
-- invoices.vat_rate_bp 上學過兩次（實測 50 → 175）。NULL＝0034 前的舊處分或未計稅處分，
-- 開票時退回依處分日解析並出聲。
ALTER TABLE fixed_assets ADD COLUMN disposal_vat_rate_bp integer;
COMMENT ON COLUMN fixed_assets.disposal_vat_rate_bp IS '處分當時解析到的營業稅率快照（bp）；NULL＝0034 前舊處分或未計稅，開票時依處分日解析並出聲';
