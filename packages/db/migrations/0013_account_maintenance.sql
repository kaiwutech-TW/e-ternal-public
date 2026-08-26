-- 會計科目維護：停用旗標＋系統科目保護
-- active：科目只能停用不能刪除——已入帳的分錄要永遠找得到科目名稱，刪除會讓歷史傳票變成孤兒。
--         停用僅代表「不再出現在新單據的下拉選單」，既有餘額與明細分類帳完全不受影響。
-- is_system：被拋轉邏輯硬引用的科目。單一事實來源是 packages/core/src/chart.ts 的 SYSTEM_ACCOUNT_CODES，
--         實際值由 seedAccounts()（apps/api/src/services/seed.ts）在每次啟動時校正，此處只建欄位。
--         這裡刻意不寫 UPDATE 清單：手寫一份 SQL 版清單等於在 SQL 與 TypeScript 兩處維護同一份事實，
--         之後往 EXPENSE_CATEGORIES 補一類就會靜默漂移（且 migration 只跑一次，補了也追不上）。

-- is_cash：這個科目算不算「現金」。現金流量表、儀表板現金水位、收付款/報銷/處分價款的下拉選單
--         全部以此欄位取科目，不再寫死 1101/1103——寫死的後果實測過：使用者自建 1104 銀行存款－玉山
--         收了 5000 元，試算表有這 5000，現金流量表卻整張傳票判定 cashDelta=0 而略過，
--         錢在資產負債表上、在現金流量表卻憑空消失（連種子科目 1102 零用金都中招）。
--         種子科目的值由 seedAccounts() 依 core 的 CASH_ACCOUNT_CODES 每次啟動校正（理由同 is_system），
--         使用者自建科目則由使用者自己在科目維護頁勾選，校正邏輯不會動它。

ALTER TABLE accounts ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE accounts ADD COLUMN is_system boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN is_cash boolean NOT NULL DEFAULT false;

CREATE INDEX idx_accounts_active ON accounts(active);
CREATE INDEX idx_accounts_is_cash ON accounts(is_cash);
