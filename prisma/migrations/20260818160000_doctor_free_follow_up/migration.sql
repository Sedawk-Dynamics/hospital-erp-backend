-- A doctor's free follow-up window, in days.
--
-- Every consultation went through the same fee, so a patient asked back in a
-- week to have a wound looked at paid a second full consultation for a visit
-- the doctor had scheduled themselves. There was no way to run a consultation
-- that carries no new charge.
--
-- Per DOCTOR rather than per hospital: the window that makes sense for a
-- surgeon reviewing a post-op wound is not the one for a physician following up
-- a chronic case, and the fee it waives is the doctor's own.
--
-- NULL or 0 means no free follow-up, which is the behaviour every existing
-- doctor keeps.
--
-- Idempotent: applied by `prisma db push` on deploy and may be re-run.
ALTER TABLE "doctor_profiles"
  ADD COLUMN IF NOT EXISTS "free_follow_up_days" INTEGER;
