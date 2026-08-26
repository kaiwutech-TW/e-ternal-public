-- 內容尾款（gap 3.5 / R9，第四批）：交期欄位＋庫存異動明細帳的單據日期。
--
-- ① 交期欄位：quotes / orders 補 expected_date（預計交期）、purchase_orders 補
--    expected_date（預計到貨日）。三處同名同型（.flightwake/records/260727-* 兩份紀錄
--    都註明「兩邊一起加」）。NULL＝未約定——系統不替「沒談交期」的單捏造一個日期。
--    只是欄位與清單顯示（逾期標色），不做任何自動提醒排程。
--
-- ② inventory_movements 補 doc_date（單據日期）：明細帳（R9）需要按「業務發生日」
--    篩選期間，原本只有 created_at（寫入時刻）——補一張上個月的進貨單，異動的
--    created_at 是今天，期間篩選就會把它歸錯月。
--    回填規則（既有資料一次性）：
--    - purchase / sale / sale_return / purchase_return / adjustment：
--      以 source_id 回連來源單據，取其 doc_date。作廢回沖的異動與原異動同
--      source_type/source_id，一併回填為來源單據日期（反向傳票也是以原單日期入帳，
--      口徑一致；發票作廢連動沖銷的 cancelDate 可能不同日，但既有資料無從區分，
--      一律以來源單據日期為準）。
--    - opening（庫存開帳，source_id 固定 0）：開帳時的 docDate 從未落地，唯一可用的
--      日期是寫入時刻——以 (created_at AT TIME ZONE 'Asia/Taipei')::date 回填。
--      新寫入的開帳異動自此改記真正的開帳日（服務層帶入）。
--    - 兜底：任何仍回連不到的列（理論上不存在）同樣退回 created_at 的台北日期，
--      再設 NOT NULL——之後所有寫入點都必須帶 doc_date。

ALTER TABLE quotes ADD COLUMN expected_date date;
ALTER TABLE orders ADD COLUMN expected_date date;
ALTER TABLE purchase_orders ADD COLUMN expected_date date;

ALTER TABLE inventory_movements ADD COLUMN doc_date date;

UPDATE inventory_movements m SET doc_date = p.doc_date
  FROM purchases p WHERE m.source_type = 'purchase' AND m.source_id = p.id;
UPDATE inventory_movements m SET doc_date = s.doc_date
  FROM sales s WHERE m.source_type = 'sale' AND m.source_id = s.id;
UPDATE inventory_movements m SET doc_date = r.doc_date
  FROM sales_returns r WHERE m.source_type = 'sale_return' AND m.source_id = r.id;
UPDATE inventory_movements m SET doc_date = r.doc_date
  FROM purchase_returns r WHERE m.source_type = 'purchase_return' AND m.source_id = r.id;
UPDATE inventory_movements m SET doc_date = a.doc_date
  FROM inventory_adjustments a WHERE m.source_type = 'adjustment' AND m.source_id = a.id;
-- opening（source_id=0，無來源單據可回連）與任何殘餘列：退回寫入時刻的台北日期
UPDATE inventory_movements SET doc_date = (created_at AT TIME ZONE 'Asia/Taipei')::date
  WHERE doc_date IS NULL;

ALTER TABLE inventory_movements ALTER COLUMN doc_date SET NOT NULL;

-- 明細帳查詢固定形狀：單一商品＋日期範圍
CREATE INDEX idx_movements_product_doc_date ON inventory_movements (product_id, doc_date);
