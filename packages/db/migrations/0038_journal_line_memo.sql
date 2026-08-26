-- 分錄行摘要：每一行自己的說明（使用者實測回報：手工傳票只有單頭摘要，
-- 一張調整傳票裡五行各自在調什麼，看明細分類帳時對不出來）。
--
-- 單頭 memo 仍然是「這張傳票為什麼存在」；行 memo 是「這一行在動什麼」。
-- 自動拋轉的傳票不填行 memo（單頭已足以說明，行的語意由來源單據承載）；
-- 手工傳票才需要——它沒有來源單據可回查。
-- 明細分類帳顯示時以行 memo 優先、空字串回退單頭 memo（coalesce(nullif(...)））。

ALTER TABLE journal_lines ADD COLUMN memo text NOT NULL DEFAULT '';
