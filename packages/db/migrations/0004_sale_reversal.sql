-- 作廢發票的後續處理：銷貨單沖銷（迴轉傳票）與作廢重開
-- 沖銷：sales.reversal_entry_id 指向迴轉傳票；已沖銷的銷貨單不得再開立發票
-- 重開：sale_id 的唯一性放寬為「同一銷貨單僅能有一張 issued 發票」，作廢後可另開新號

ALTER TABLE sales ADD COLUMN reversal_entry_id integer REFERENCES journal_entries(id);

ALTER TABLE invoices DROP CONSTRAINT invoices_sale_id_key;
CREATE UNIQUE INDEX uq_invoices_sale_issued ON invoices (sale_id) WHERE status = 'issued';
