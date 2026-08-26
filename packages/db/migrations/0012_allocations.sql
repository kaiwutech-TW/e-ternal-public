-- 立沖帳（缺口第二層批次 C）：收付款單可逐張沖銷特定銷貨/進貨單
-- 未指定沖銷的收付款仍為對象層級（應收帳齡對這部分以 FIFO 補沖，見 services/orders.ts arAging）
-- target_type 沿用 doc_source enum：receipt→sale、payment→purchase

CREATE TABLE cash_doc_allocations (
  id serial PRIMARY KEY,
  cash_doc_id integer NOT NULL REFERENCES cash_docs(id),
  target_type doc_source NOT NULL,
  target_id integer NOT NULL,
  amount integer NOT NULL CHECK (amount > 0)
);

CREATE INDEX idx_allocations_target ON cash_doc_allocations (target_type, target_id);
