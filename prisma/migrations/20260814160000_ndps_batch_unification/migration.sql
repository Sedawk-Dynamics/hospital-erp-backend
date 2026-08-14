-- Point every NDPS register entry at the real stock batch it moved.
--
-- Additive on its own: one nullable column. The behavioural change is in the
-- service (Form 3C inward now creates a DrugBatch) and in the accompanying data
-- migration (prisma/scripts/unify-ndps-batches.ts), which is run separately and
-- only after its --dry-run output has been reviewed.
--
-- No foreign key. NdpsTransaction is a statutory register: a row must survive
-- even if the batch it refers to is later merged or removed, because the
-- register is the record of what happened, not a view of current stock.

ALTER TABLE "ndps_transactions"
    ADD COLUMN IF NOT EXISTS "drug_batch_id" TEXT;

CREATE INDEX IF NOT EXISTS "ndps_transactions_drug_batch_id_idx"
    ON "ndps_transactions" ("drug_batch_id");
