-- Record the QR/barcode read off a Schedule H2 pack at the counter.
--
-- H2 is the Rule 96(6)-(7) anti-counterfeiting list. The obligation was being
-- classified and then ignored: the flag was stored, filtered and badged, but
-- nothing at the point of sale ever read it. This column is where the evidence
-- lands once the counter is asked for it.
--
-- Idempotent: applied by `prisma db push` on deploy and may be re-run.
ALTER TABLE "dispensing_records"
  ADD COLUMN IF NOT EXISTS "scanned_code" VARCHAR(120);
