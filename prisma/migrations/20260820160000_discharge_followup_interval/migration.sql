-- Test Report 3, C20: "Support month/interval-based follow-up entry
-- (e.g. 'after 3 months') without forcing selection of one specific calendar
-- date."
--
-- The discharge summary stored a DATE only, so the quick intervals added for
-- C19 resolved to a fixed day the instant they were picked. "About three
-- months" became e.g. 20 November, which reads to a patient as an appointment
-- on that day — and later as one they missed.
--
-- Both columns are nullable and neither replaces follow_up_date: a review that
-- genuinely falls on a given day should still say so.
ALTER TABLE "discharge_summaries"
  ADD COLUMN IF NOT EXISTS "follow_up_after_value" INTEGER,
  ADD COLUMN IF NOT EXISTS "follow_up_after_unit"  VARCHAR(10);
