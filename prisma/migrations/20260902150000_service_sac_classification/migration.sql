-- Give services a code, so their tax can be resolved instead of typed.
--
-- `service_tariffs` has carried `gst_rate_percent` since the billing module was
-- built, and `lab_test_catalog` has carried no tax field at all. Neither has
-- ever carried a SAC code, which is the thing that actually decides the rate,
-- prints on the invoice, and groups the GSTR-1 summary.
--
-- What that produced is in the live data. Sixteen tariff rows exist, all
-- radiology, because the only screen that can create one is the radiology
-- settings page — and the same X-Ray appears three times at 0%, 5% and 10%.
-- Elsewhere the rate is simply typed at the counter: registration fees recorded
-- at 10%, procedures at 2%, "other" at 2%. None of those are rates in law.
--
-- Three fields rather than one:
--
--   sac_code      what the invoice prints and what resolves the rate
--   gst_treatment exempt is not the same as taxable-at-zero, and healthcare is
--                 the former — the distinction drives the monthly input-credit
--                 reversal, so it cannot be inferred from a percentage
--   gst_approved  the hospital's auditor has signed this classification off.
--                 An approved row is never overridden by a master or a default,
--                 which is the entire point of asking an auditor
--   is_cosmetic   a non-therapeutic procedure is taxable however the rest of
--                 the surgery list is classified, and no code can tell the two
--                 apart on its own
--
-- gst_rate_percent stays exactly as it is. It becomes the hospital's own
-- override for the rare case where its auditor differs from the master, rather
-- than the only answer available.
--
-- BACKFILL: each tariff gets the SAC its category implies, and each lab test
-- gets the diagnostics code. This is a starting point, NOT a classification —
-- gst_approved stays false on every row precisely so that nothing here is
-- mistaken for the auditor's sign-off, and the exception report will list them
-- as unapproved until somebody looks. No rate is changed and no bill is
-- touched: these columns are read by nothing until the writers are wired.
--
-- Every column is nullable or defaulted and every statement is guarded: safe to
-- replay.

ALTER TABLE "service_tariffs"
  ADD COLUMN IF NOT EXISTS "sac_code"      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "gst_treatment" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "gst_approved"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "is_cosmetic"   BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "lab_test_catalog"
  ADD COLUMN IF NOT EXISTS "sac_code"      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "gst_treatment" VARCHAR(20);

-- The SAC each category implies. Healthcare is exempt; the ones that are not
-- healthcare are left for the hospital to classify rather than guessed at.
UPDATE "service_tariffs"
   SET "sac_code" = CASE "category"
                      WHEN 'consultation' THEN '999312'
                      WHEN 'surgery'      THEN '9993'
                      WHEN 'procedure'    THEN '9993'
                      WHEN 'lab'          THEN '999316'
                      WHEN 'radiology'    THEN '999316'
                      WHEN 'room'         THEN '996311'
                      ELSE NULL
                    END,
       "gst_treatment" = CASE "category"
                      WHEN 'consultation' THEN 'exempt'
                      WHEN 'surgery'      THEN 'exempt'
                      WHEN 'procedure'    THEN 'exempt'
                      WHEN 'lab'          THEN 'exempt'
                      WHEN 'radiology'    THEN 'exempt'
                      -- Room rent has its own rule; the treatment is decided
                      -- per day by the rate and the bed, not by this row.
                      WHEN 'room'         THEN NULL
                      ELSE NULL
                    END
 WHERE "sac_code" IS NULL;

UPDATE "lab_test_catalog"
   SET "sac_code" = '999316',
       "gst_treatment" = 'exempt'
 WHERE "sac_code" IS NULL;
