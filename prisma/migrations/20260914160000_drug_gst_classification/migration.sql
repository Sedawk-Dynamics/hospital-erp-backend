-- Product-level GST treatment for exceptions that cannot be represented by an
-- HSN rate alone (notably medicines named by Notification 10/2025-CT(R)).
-- Null deliberately means "use the HSN master" so ordinary catalogue rows
-- continue to follow later statutory rate changes without being rewritten.

ALTER TABLE "drug_master"
  ADD COLUMN IF NOT EXISTS "gst_treatment" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "gst_treatment_source" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "gst_classifier_version" INTEGER;

ALTER TABLE "drug_formulary"
  ADD COLUMN IF NOT EXISTS "gst_treatment" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "gst_treatment_source" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "gst_classifier_version" INTEGER;

ALTER TABLE "drug_master"
  DROP CONSTRAINT IF EXISTS "drug_master_gst_treatment_check";
ALTER TABLE "drug_master"
  ADD CONSTRAINT "drug_master_gst_treatment_check"
  CHECK ("gst_treatment" IS NULL OR "gst_treatment" IN
    ('taxable', 'exempt', 'nil_rated', 'non_gst', 'zero_rated'));

ALTER TABLE "drug_formulary"
  DROP CONSTRAINT IF EXISTS "drug_formulary_gst_treatment_check";
ALTER TABLE "drug_formulary"
  ADD CONSTRAINT "drug_formulary_gst_treatment_check"
  CHECK ("gst_treatment" IS NULL OR "gst_treatment" IN
    ('taxable', 'exempt', 'nil_rated', 'non_gst', 'zero_rated'));
