-- Bedside staff choose what should happen to a patient-specific NDPS remainder,
-- but the actual destruction remains a separate authorised, witnessed action.

ALTER TABLE "ndps_patient_doses"
  ADD COLUMN IF NOT EXISTS "residual_handling" VARCHAR(30);

ALTER TABLE "ndps_transactions"
  ADD COLUMN IF NOT EXISTS "residual_handling" VARCHAR(30);

-- Existing open residuals were recorded as sealed quarantine. Existing final
-- destruction rows necessarily travelled through a destruction instruction.
UPDATE "ndps_patient_doses"
SET "residual_handling" = CASE
  WHEN "status" = 'destroyed' THEN 'pending_destruction'
  ELSE 'sealed_quarantine'
END
WHERE "residual_quantity" > 0
  AND "residual_handling" IS NULL;

UPDATE "ndps_transactions" AS txn
SET "residual_handling" = dose."residual_handling"
FROM "ndps_patient_doses" AS dose
WHERE txn."patient_dose_id" = dose."id"
  AND txn."residual_handling" IS NULL;

ALTER TABLE "ndps_patient_doses"
  DROP CONSTRAINT IF EXISTS "ndps_patient_doses_residual_handling_check";

ALTER TABLE "ndps_patient_doses"
  ADD CONSTRAINT "ndps_patient_doses_residual_handling_check"
  CHECK (
    ("residual_quantity" = 0 AND "residual_handling" IS NULL) OR
    ("residual_quantity" > 0 AND "residual_handling" IN
      ('pending_destruction', 'sealed_quarantine'))
  );
