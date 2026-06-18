-- §4.4 IP returns (2026-06-18). A pharmacy sale line can be marked
-- non-returnable on the bill at sale time (opened vial, cold-chain item, etc.)
-- so it can never be taken back as a patient return.
ALTER TABLE "dispensing_records" ADD COLUMN IF NOT EXISTS "non_returnable" BOOLEAN NOT NULL DEFAULT false;
