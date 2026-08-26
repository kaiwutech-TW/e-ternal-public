-- 外銷零稅率：課稅別接上整條鏈（gap-analysis-2608 的 B12）。
--
-- 為什麼做這一批：「這一單是零稅率」這件事在系統裡原本無處可表達——
--   sales 沒有課稅別欄位、createSale 一律照解析到的營業稅率計稅、
--   發票 XML 硬寫 <TaxType>1</TaxType>、401 的零稅率四欄（申報書代號 7/15/19/23）恆為 0。
--   實測後果：對外國客戶的 40,000 元外銷被課 2,000 元銷項稅進了傳票、應稅銷售額被灌水，
--   而畫面上零徵兆。demo-data 甚至只能用手工傳票繞路（seed 註解自承「系統目前做不到」）。
--
-- 欄位設計：
--   tax_type 用附件五／MIG 的課稅別代號（'1' 應稅／'2' 零稅率／'3' 免稅），單頭層級——
--   與 purchases.deduction_code、inv_format 同一個體例（存官方代號，畫面翻譯成中文），
--   媒體檔與發票 XML 不再需要對照表。'3'（免稅）在 schema 先佔位：服務層目前拒收
--   （兼營免稅要用 403 申報，本系統未支援 403——收了單就是引導使用者錯報），
--   等 403 做出來才開放，schema 不必再動。
--
--   零稅率的證明文件兩欄（401 申報書把零稅率銷售額分成兩欄，依據不同的證明文件）：
--   zero_tax_via_customs＝經海關出口與否（true→申報書代號 15「經海關」；false→代號 7「非經海關」）。
--   zero_tax_cert_no＝證明文件號碼（經海關＝出口報單號碼；非經海關＝取得外匯證明文件號碼等）。
--   ★ 系統不驗證文件真偽與格式（各類證明文件格式不一，驗錯會把合法單據擋在門外）——
--   只提供欄位，缺號碼時在建單回應與 401 產出出聲提醒。號碼通常在報關／收匯後才拿得到，
--   所以可事後補登（PATCH /sales/:id/zero-tax-cert），與退回折讓證明單同一個模式。
--
--   invoices.tax_type 是開立當下的快照（與 vat_rate_bp 同一個理由）：401 媒體檔依發票
--   產明細，課稅別必須是「開立當時那張單的」，不能事後跟著 sales 改。
--
--   company_profile.vat_mixed_business＝兼營免稅／特種稅額標記。本系統只支援 401
--   （專營應稅），兼營的公司要用 403 申報——這個旗標讓 generate401 能「擋下並說明」，
--   而不是靜默產出一份看起來完全正常、實則報錯類別的檔案。
--
-- 既有資料：全部視為應稅（'1'）——0028 之前根本開不出零稅率單據，這是事實而非假設。

ALTER TABLE sales ADD COLUMN tax_type char(1) NOT NULL DEFAULT '1'
  CHECK (tax_type IN ('1', '2', '3'));
ALTER TABLE sales ADD COLUMN zero_tax_via_customs boolean;
ALTER TABLE sales ADD COLUMN zero_tax_cert_no text;
-- 形狀約束：零稅率必須指明經海關與否（兩欄落在申報書不同代號，沒有預設可言）；
-- 非零稅率不得帶零稅率欄位（帶了等於兩個欄位各說各話，401 取數無從判斷）
ALTER TABLE sales ADD CONSTRAINT ck_sales_zero_tax_shape
  CHECK ((tax_type = '2' AND zero_tax_via_customs IS NOT NULL)
      OR (tax_type <> '2' AND zero_tax_via_customs IS NULL AND zero_tax_cert_no IS NULL));

ALTER TABLE invoices ADD COLUMN tax_type char(1) NOT NULL DEFAULT '1'
  CHECK (tax_type IN ('1', '2', '3'));

ALTER TABLE company_profile ADD COLUMN vat_mixed_business boolean NOT NULL DEFAULT false;
