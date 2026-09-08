-- When a bill was cancelled, as its own fact.
--
-- Report C-9 (Cancelled and Amended Invoices) filtered on `bill_date` — the
-- date the invoice was RAISED — while reporting `updated_at` as the
-- cancellation date. Those are different months more often than not:
--
--   raised 2026-07, cancelled 2026-07   3 bills
--   raised 2026-07, cancelled 2026-09   3 bills   <- invisible in either month
--   raised 2026-08, cancelled 2026-08   8 bills
--   raised 2026-09, cancelled 2026-09  14 bills
--
-- So the three July invoices cancelled in September appeared in July's report,
-- where the cancellation had not happened yet, and were missing from
-- September's, which is the month the reversal actually belongs to. An auditor
-- asking "what did you cancel in September" got the wrong answer both ways.
--
-- `updated_at` could not stand in for it: any later touch of the row moves it.
--
-- Backfilled from `updated_at` for the rows already cancelled — the best
-- evidence available for a cancellation that happened before this column
-- existed, and better than leaving them out of every period.

ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMP(3);

UPDATE "bills"
   SET "cancelled_at" = "updated_at"
 WHERE "cancelled_at" IS NULL
   AND "status" = 'cancelled';

CREATE INDEX IF NOT EXISTS "bills_tenant_cancelled_at_idx"
  ON "bills" ("tenant_id", "cancelled_at");
