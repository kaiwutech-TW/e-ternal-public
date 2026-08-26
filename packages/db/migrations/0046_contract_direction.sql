-- 合約方向（主導者 2026-08-13 拍板：一次到位、權限不下沉到列層級）
--
-- ★ direction 與 kind 正交：kind 是營收型態（專案/月費/維護），direction 是「錢往哪流」
--   （sale＝我賣給別人、我方請款；purchase＝別人賣給我、我方付款）。不混在同一欄。
--
-- ★ 兩側形狀刻意**不對稱**：銷貨側的分期是「我主動開請款單」（bill → createSale）；
--   進貨側的分期是「預計付款日＋金額」，單據來源是**對方寄來的發票**——動作是
--   「勾對既有進貨單」（match），不是生成。硬做成鏡像會失真（把對方的單據當成我方生成的）。
--
-- ★ 勾對只是指標：勾錯可解勾（unmatch），進貨單被作廢該期自動回到未勾對——
--   與 sale_id 同一條「不另存狀態欄位、以單據存活狀態推導」的紀律（0037 檔頭）。
--
-- ★ 一期只能對一張單：sale_id 與 purchase_id 互斥（CHECK）。方向在合約層，
--   期別層靠這條約束擋住「銷貨合約勾進貨單」這種資料矛盾。
ALTER TABLE contracts
  ADD COLUMN direction text NOT NULL DEFAULT 'sale';   -- 'sale' | 'purchase'；既有合約全是請款側

ALTER TABLE contract_installments
  ADD COLUMN purchase_id integer REFERENCES purchases(id),
  ADD CONSTRAINT contract_installments_one_doc CHECK (sale_id IS NULL OR purchase_id IS NULL);
