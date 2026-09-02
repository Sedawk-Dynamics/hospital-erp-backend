-- Record what KIND of zero an HSN rate is, not just that it is zero.
--
-- `hsn_gst_rates` says a rate and nothing else, so ORS at 30049010 and a
-- medicine at 3004 differ only by the number 0 versus 5. That is enough to
-- charge a patient correctly and nowhere near enough to file a return.
--
-- GST reports nil-rated, exempt and non-GST turnover on THREE separate lines —
-- GSTR-1 table 8 splits them, and GSTR-3B splits 3.1(c) from 3.1(e). A system
-- that stores every one of them as "0%" cannot tell them apart afterwards, so
-- the figures have to be reassembled by hand at filing time, which is exactly
-- the manual step this work exists to remove.
--
-- The distinction is also not cosmetic for the hospital's money: exempt
-- turnover is the numerator of the Rule 42 input-credit reversal. Under-state
-- it and the hospital claims credit it is not entitled to; over-state it and it
-- gives up credit it could have kept.
--
-- Backfill rule, and its limits: a zero-rated row becomes 'nil_rated' and
-- anything else becomes 'taxable'. That is the safe reading rather than the
-- certain one — several zero-rated medicines are exempt by notification rather
-- than nil by tariff, and the two report to the same GSTR-3B line, so the
-- backfill cannot get the money wrong. A super admin can correct any row, and
-- the hospital's auditor is the one who should say which is which.
--
-- Nullable, defaulted by backfill, and every statement is guarded: safe to
-- replay, and `prisma db push` on deploy will have created the column already.

ALTER TABLE "hsn_gst_rates"
  ADD COLUMN IF NOT EXISTS "treatment" VARCHAR(20);

UPDATE "hsn_gst_rates"
   SET "treatment" = CASE WHEN "gst_rate" = 0 THEN 'nil_rated' ELSE 'taxable' END
 WHERE "treatment" IS NULL;
