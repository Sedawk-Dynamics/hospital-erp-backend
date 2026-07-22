-- Past medical + surgical narrative, surfaced by the doctor's
-- Medical & Surgical History tab.
ALTER TABLE "patient_personal_history"
  ADD COLUMN IF NOT EXISTS "past_medical_history" TEXT,
  ADD COLUMN IF NOT EXISTS "past_surgical_history" TEXT;
