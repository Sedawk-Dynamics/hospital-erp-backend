-- Let an OT request name the surgery it is, for tax.
--
-- Section 4.6 turns on one distinction: "Therapeutic — done to treat illness,
-- injury or a congenital defect — Exempt. Cosmetic — done to improve
-- appearance, not medically necessary — 18%. The same theatre, the same
-- surgeon and the same consumables can be exempt or taxable depending on why
-- the procedure was done." Acceptance scenario 14 tests exactly that.
--
-- `service_tariffs` has carried `is_cosmetic` all along and `OtRequest` had no
-- way to point at a tariff — only a free-text `procedure_name` and a
-- `billing_amount`. So `billOtRequest` built its charge with no SAC and no
-- cosmetic flag, `supplyKindForCategory('surgery')` resolved to 'procedure',
-- which is a healthcare kind, and EVERY OT charge came out exempt. The flag was
-- unreachable from the one place it exists to be read.
--
-- `service_tariff_id` rather than a bare boolean, because the tariff already
-- carries the SAC, the treatment, the rate and the auditor's approval. A second
-- copy of "is this cosmetic" on the request would be a second thing to keep in
-- step with the first.
--
-- Nullable. Every request already in the database keeps resolving exactly as it
-- does today — through the category, to exempt — until somebody picks a tariff.

ALTER TABLE "ot_requests"
  ADD COLUMN IF NOT EXISTS "service_tariff_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ot_requests_service_tariff_id_fkey'
  ) THEN
    ALTER TABLE "ot_requests"
      ADD CONSTRAINT "ot_requests_service_tariff_id_fkey"
      FOREIGN KEY ("service_tariff_id") REFERENCES "service_tariffs"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ot_requests_service_tariff_id_idx"
  ON "ot_requests" ("service_tariff_id");
