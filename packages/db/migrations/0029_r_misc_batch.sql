-- R 系列雜項（gap-analysis-2608 的 R5／R20／B5 載具捐贈欄位／B7 區間重疊）。
--
-- 為什麼做這一批：第二批收尾的五件小事，共通點是「資料早就流經系統、卻沒有落地或沒有防線」——
--   ① R5：同一張供應商發票可登錄在兩張進貨單上（兩次都 200），401 媒體檔出現兩筆
--      同賣方同號碼的記錄、進項稅重複列報＝少繳稅，被查到要補稅加罰。
--   ② R20：purchases 根本沒有供應商發票日期欄（送 invoiceDate 被 zod 靜默丟棄），
--      401 進項歸期只能用進貨單日期——發票開 6/30、貨 7/2 才到，買方報 07 期、
--      賣方報 05 期，雙方申報勾稽不符。報銷那條路（expense_items.invoice_date）早就做對了，
--      只有進貨單這條路缺欄位。
--   ③ 載具／捐贈碼：API 收得下 carrier/npoban、XML 也印得出來，但 invoices 表沒有欄位
--      （只存整包 xml）——事後查不到、篩不了，客服接到「我的發票怎麼沒歸戶」只能逐張翻 XML。
--   （④ 字軌區間重疊與 ⑤ GET /invoices 清單瘦身在應用層，本檔不動 schema。）
--
-- 欄位設計：
--   inv_date＝供應商發票上的開立日期（憑證日），與 doc_date（帳務／庫存日）並存——
--   「帳務日 ≠ 憑證日」的區分照抄報銷的前例。NULL＝本欄位出現前的舊單或尚未登錄，
--   401 歸期退回 doc_date 並在產檔回應出聲（不靜默混用兩種歸期）。
--
--   進項發票唯一性以（供應商, 字軌, 號碼）為鍵：同一期別的字軌＋號碼在全國唯一，
--   但跨期別號碼會重用，而本表沒有期別欄——供應商維度已足以擋住「同一張紙登兩次」
--   的實務錯誤。partial index 排除未登錄（inv_no IS NULL）與已作廢（voided_at）：
--   作廢單的進項不申報，同號重開一張正確的單是作廢機制的正常出路，不能被舊單卡死。
--
--   invoices 的載具／捐贈四欄是**開立當下的快照**（與 vat_rate_bp/tax_type 同一個理由）。
--   NULL＝0029 前的舊發票（當時的值只在 XML 裡）；新開立的一律落地：
--   donate_mark '0'/'1'、carrier_id 存 MIG 的 CarrierId1（本系統 Id1=Id2，存一份即可）。

-- === R5：供應商發票不得重複登錄 ===
-- 先驗再建（照 0022 uq_partners_tax_id 的體例）：升級中的舊庫可能已有重複，
-- CREATE UNIQUE INDEX 直接失敗只會吐英文約束名，使用者不知道該去修哪幾張單
DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg(inv_track || inv_no || '（進貨單 #' || ids || '）', '、') INTO dup
  FROM (
    SELECT p.partner_id, p.inv_track, p.inv_no, string_agg(p.id::text, '、#') AS ids
    FROM purchases p
    WHERE p.inv_no IS NOT NULL AND p.voided_at IS NULL
    GROUP BY p.partner_id, p.inv_track, p.inv_no HAVING count(*) > 1
  ) t;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION '無法升級：有供應商發票號碼重複登錄在多張進貨單上：%。重複列報進項稅是少繳稅——請先在「進貨」頁把登錯的那張單作廢（或改成正確的發票號碼），再重新啟動', dup;
  END IF;
END $$;
CREATE UNIQUE INDEX uq_purchases_supplier_invoice
  ON purchases (partner_id, inv_track, inv_no)
  WHERE inv_no IS NOT NULL AND voided_at IS NULL;

-- === R20：供應商發票日期（憑證日）===
ALTER TABLE purchases ADD COLUMN inv_date date;
COMMENT ON COLUMN purchases.inv_date IS '供應商發票開立日期（憑證日）：401 進項歸期優先用它；NULL＝舊單或未登錄，歸期退回 doc_date 並於產檔出聲';

-- === 載具／捐贈碼落地（B5 尾款）===
ALTER TABLE invoices ADD COLUMN carrier_type text;
ALTER TABLE invoices ADD COLUMN carrier_id text;
ALTER TABLE invoices ADD COLUMN donate_mark char(1) CHECK (donate_mark IN ('0', '1'));
ALTER TABLE invoices ADD COLUMN npoban text;
-- 形狀約束：捐贈發票必有捐贈碼、非捐贈不得帶捐贈碼（NPOBAN 的定義就是捐贈對象代碼）；
-- 載具兩欄同進退。NULL donate_mark＝0029 前的舊發票，不受此約束
ALTER TABLE invoices ADD CONSTRAINT ck_invoices_donate_shape
  CHECK (donate_mark IS NULL
      OR (donate_mark = '1' AND npoban IS NOT NULL)
      OR (donate_mark = '0' AND npoban IS NULL));
ALTER TABLE invoices ADD CONSTRAINT ck_invoices_carrier_shape
  CHECK ((carrier_type IS NULL) = (carrier_id IS NULL));
