-- Keep a voided sale's dispensing record instead of deleting it.
--
-- Voiding a counter sale deleted its DispensingRecords, and those rows are what
-- the controlled-drug register reads for outward movement. So voiding a
-- Schedule X or narcotic sale erased it from the statutory register — and not
-- only from today's: the row vanished from every window, including ones an
-- inspector had already been shown. A register that changes retrospectively is
-- the one thing it must never do.
--
-- The row is kept and marked. Everything that counts what was dispensed
-- excludes a cancelled row; the register shows it, with a reversal row putting
-- the stock back.
--
-- Idempotent: applied by `prisma db push` on deploy and may be re-run.
ALTER TABLE "dispensing_records"
  ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancelled_by" TEXT;

-- Every consumer filters on this, so it earns an index.
CREATE INDEX IF NOT EXISTS "dispensing_records_cancelled_at_idx"
  ON "dispensing_records" ("cancelled_at");
