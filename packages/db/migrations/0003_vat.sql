-- Phase 3：營業稅申報——公司稅籍資料、進項發票（供應商開給我們的發票）登錄

ALTER TABLE company_profile ADD COLUMN tax_registration_no char(9);
ALTER TABLE company_profile ADD COLUMN city_code char(1);

-- 進項發票資訊掛在進貨單上：格式代號預設 25（進項電子發票）、扣抵代號預設 1（可扣抵之進貨及費用）
ALTER TABLE purchases ADD COLUMN inv_track char(2);
ALTER TABLE purchases ADD COLUMN inv_no char(8);
ALTER TABLE purchases ADD COLUMN inv_format char(2) NOT NULL DEFAULT '25';
ALTER TABLE purchases ADD COLUMN deduction_code char(1) NOT NULL DEFAULT '1';
