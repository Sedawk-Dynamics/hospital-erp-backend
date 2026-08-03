-- OT reschedule ↔ doctor-confirmation loop.
--
-- The doctor books a *preferred* slot; the OT admin schedules the real one.
-- When the admin's slot differs from what the doctor asked for, the booking is
-- only a proposal until the doctor accepts it. That sub-state rides alongside
-- `status` in these columns rather than in the OtRequestStatus enum, so every
-- existing status transition is untouched and no enum migration is needed.
--
--   schedule_state : NULL | 'awaiting_doctor' | 'confirmed'
--   doctor_response: NULL | 'accepted' | 'rejected'
--
-- IF NOT EXISTS throughout: these columns were first created with
-- `prisma db push` on the running dev database, and src/shared/ot-schedule.ts
-- carries the same DDL as a self-healing guard, so this must be replayable.
ALTER TABLE "ot_requests"
  ADD COLUMN IF NOT EXISTS "schedule_state" VARCHAR(24),
  ADD COLUMN IF NOT EXISTS "reschedule_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "rescheduled_by" TEXT,
  ADD COLUMN IF NOT EXISTS "rescheduled_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "previous_scheduled_date" DATE,
  ADD COLUMN IF NOT EXISTS "previous_scheduled_time" VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "doctor_response" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "doctor_response_note" TEXT,
  ADD COLUMN IF NOT EXISTS "doctor_responded_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reschedule_count" INTEGER NOT NULL DEFAULT 0;
