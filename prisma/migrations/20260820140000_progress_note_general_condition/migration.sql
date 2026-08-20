-- Test Report 3, C18: record a ward round as "prescription + clinical status"
-- rather than requiring prose.
--
-- Reuses the existing GeneralCondition enum rather than inventing a parallel
-- three-value one. Nursing already describes a patient with these words on
-- ClinicalObservation, and the enum carries `deteriorating` — the value the
-- report's own list omits, and the one a reader most needs to see.
ALTER TABLE "progress_notes"
  ADD COLUMN IF NOT EXISTS "general_condition" "GeneralCondition";

-- "Unchanged" has been on the IP round composer all along; it just had nowhere
-- structured to go. Additive, and no existing row can be using it.
ALTER TYPE "GeneralCondition" ADD VALUE IF NOT EXISTS 'unchanged';
