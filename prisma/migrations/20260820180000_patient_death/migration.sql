-- Test Report 3, D6: "Define explicit workflows for ... emergency death before
-- identification ... all preserving charges and clinical events recorded under
-- the temporary ID."
--
-- There was no death concept anywhere. The only way to close a stay was
-- `discharged`, which then told the family, the bill, the portal and every
-- report that the patient had gone home. A free-text reason on the discharge
-- override was the whole of it — nothing structured, nothing countable.
--
-- Recorded on the PATIENT, not the admission, because a death can happen with
-- no admission to close: brought in dead, or dying in casualty before anyone
-- is admitted. An admission status cannot express that.
--
-- `is_active` is deliberately untouched. It is a soft-delete flag; a deceased
-- patient's record must stay fully readable and billable.
ALTER TABLE "patients"
  ADD COLUMN IF NOT EXISTS "deceased_at"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deceased_recorded_by" TEXT,
  ADD COLUMN IF NOT EXISTS "deceased_note"        TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'patients_deceased_recorded_by_fkey'
  ) THEN
    ALTER TABLE "patients"
      ADD CONSTRAINT "patients_deceased_recorded_by_fkey"
      FOREIGN KEY ("deceased_recorded_by") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Finding a hospital's deaths for a period is a routine question (mortality
-- reporting, monthly returns) and would otherwise scan every patient.
CREATE INDEX IF NOT EXISTS "patients_tenant_deceased_at_idx"
  ON "patients"("tenant_id", "deceased_at");

-- A stay that ended in death should not read as a discharge.
ALTER TYPE "AdmissionStatus" ADD VALUE IF NOT EXISTS 'deceased';
