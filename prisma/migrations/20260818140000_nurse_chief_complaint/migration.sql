-- What the NURSE was told at intake, kept apart from the doctor's own version.
--
-- `chief_complaint` is a single shared field, so a nurse writing what the
-- patient said and a doctor writing their own reading of it were the same box:
-- whoever saved last replaced the other, and nothing recorded who said what.
-- The two are different clinical statements — the patient's words at the door,
-- and the clinician's framing of the problem — and both are worth keeping.
--
-- Nullable, so every existing visit is untouched and a hospital that never uses
-- the nurse field simply has nulls.
--
-- Idempotent: applied by `prisma db push` on deploy and may be re-run.
ALTER TABLE "visits"
  ADD COLUMN IF NOT EXISTS "nurse_chief_complaint" TEXT;

ALTER TABLE "visits"
  ADD COLUMN IF NOT EXISTS "nurse_chief_complaint_by" UUID;

ALTER TABLE "visits"
  ADD COLUMN IF NOT EXISTS "nurse_chief_complaint_at" TIMESTAMP(3);
