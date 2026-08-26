-- 訂單/採購單短交結案 ＋ 課稅別走訂單流程（gap-analysis-2608 B4 尚缺、B12 尚缺的匯流）。
--
-- 一、課稅別進報價單與訂單（quotes / orders）：
--   0028 讓銷貨單能表達零稅率，但外銷客戶若走正規流程（報價 → 訂單 → 出貨），
--   shipOrder 開出的銷貨單沒有課稅別入口，一律應稅——外銷業務被迫繞過訂單流程直開銷貨單，
--   出貨進度與成交率統計就斷了。欄位形狀與 sales 完全一致（0028）：
--   tax_type 存附件五／MIG 課稅別代號（'1' 應稅／'2' 零稅率／'3' 免稅佔位、服務層拒收），
--   zero_tax_via_customs＝經海關出口與否（401 申報書代號 15／7 兩欄的分野），
--   zero_tax_cert_no＝證明文件號碼（報價階段幾乎必空，出口報單在報關後才有；出貨開銷貨單時
--   若仍空白，createSale 會出聲提醒，補登入口在銷貨單那一層）。
--   採購單刻意不加課稅別：進項的申報屬性是「憑證格式＋扣抵代號」（purchases 已有），
--   與銷項的課稅別是兩套語言，硬搬只會誤導。
--
-- 二、短交結案（orders / purchase_orders）：
--   status enum 已有 'closed'（全數出清自動結案），但 partial 的單永遠到不了——
--   客戶砍單、廠商斷貨時，唯一出路是「假出貨／假收貨」憑空生稅務憑證。
--   結案（close）與取消（cancel）語意不同：取消＝這張單從沒發生（僅限完全未出/收貨）；
--   結案＝到此為止——已發生的出貨/收貨與其憑證全部留著，只是剩餘量不再期待。
--   三欄都 NULL＝全數出清的自動結案；短交結案必填理由（closed_at/closed_by/close_reason）。
--   不動 enum、不加新狀態：對所有既有彙總（openBacklog 只認 open/partial）而言，
--   「短交結案」與「出清結案」本來就該同樣退場。
--
-- 既有資料：全部視為應稅（'1'）——0032 之前訂單流程根本表達不了零稅率，這是事實而非假設。

ALTER TABLE quotes ADD COLUMN tax_type char(1) NOT NULL DEFAULT '1'
  CHECK (tax_type IN ('1', '2', '3'));
ALTER TABLE quotes ADD COLUMN zero_tax_via_customs boolean;
ALTER TABLE quotes ADD COLUMN zero_tax_cert_no text;
ALTER TABLE quotes ADD CONSTRAINT ck_quotes_zero_tax_shape
  CHECK ((tax_type = '2' AND zero_tax_via_customs IS NOT NULL)
      OR (tax_type <> '2' AND zero_tax_via_customs IS NULL AND zero_tax_cert_no IS NULL));

ALTER TABLE orders ADD COLUMN tax_type char(1) NOT NULL DEFAULT '1'
  CHECK (tax_type IN ('1', '2', '3'));
ALTER TABLE orders ADD COLUMN zero_tax_via_customs boolean;
ALTER TABLE orders ADD COLUMN zero_tax_cert_no text;
ALTER TABLE orders ADD CONSTRAINT ck_orders_zero_tax_shape
  CHECK ((tax_type = '2' AND zero_tax_via_customs IS NOT NULL)
      OR (tax_type <> '2' AND zero_tax_via_customs IS NULL AND zero_tax_cert_no IS NULL));

ALTER TABLE orders ADD COLUMN closed_at timestamptz;
ALTER TABLE orders ADD COLUMN closed_by integer REFERENCES users(id);
ALTER TABLE orders ADD COLUMN close_reason text;

ALTER TABLE purchase_orders ADD COLUMN closed_at timestamptz;
ALTER TABLE purchase_orders ADD COLUMN closed_by integer REFERENCES users(id);
ALTER TABLE purchase_orders ADD COLUMN close_reason text;
