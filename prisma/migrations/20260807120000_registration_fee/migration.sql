-- One-time registration fee, charged when a patient first attends THIS hospital.
--
-- Two additions, both idempotent so they are safe to re-apply:
--
-- 1. `registration` as its own bill-item category. It could have been filed
--    under `other`, but `other` is where unclassifiable charges go and a
--    hospital wants to see registration income as its own line in reports.
--
-- 2. `appointments.charge_registration_fee` — what the FRONT DESK decided when
--    booking. Nullable on purpose, and null does NOT mean "no": it means the
--    desk never said, so the rule decides at bill time (charge iff this is the
--    patient's first visit here and the fee has not already been taken). Only
--    an explicit false suppresses it.
ALTER TYPE "BillItemCategory" ADD VALUE IF NOT EXISTS 'registration';

ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "charge_registration_fee" BOOLEAN;
