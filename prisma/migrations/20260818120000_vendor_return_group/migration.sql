-- Group the lines of one vendor return together.
--
-- A vendor return was one row = one batch = one quantity, with the supplier's
-- credit note number copied onto that same row. Sending five expired medicines
-- back therefore meant five separate returns, five stock movements and five
-- rows all claiming the same credit note — which is not what the distributor
-- issued. A credit note is one document against one return.
--
-- Both columns are nullable so every existing single-line return stays valid
-- and untouched; a return raised the old way simply has no group.
--
-- Idempotent: applied by `prisma db push` on deploy and may be re-run.
ALTER TABLE "drug_returns"
  ADD COLUMN IF NOT EXISTS "return_group_id" UUID;

ALTER TABLE "drug_returns"
  ADD COLUMN IF NOT EXISTS "return_number" VARCHAR(40);

-- The lines of one return are always read together.
CREATE INDEX IF NOT EXISTS "drug_returns_return_group_id_idx"
  ON "drug_returns" ("return_group_id");
