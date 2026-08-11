-- Unified lab + radiology accept flow.
--
-- Both diagnostic modules now run the same shape: the department admin accepts
-- the order at their own counter (collecting payment for an OP patient, or
-- posting the charge to the IP ledger for an admitted one), assigns it to a
-- technician / radiologist, who works in a DRAFT state until they Mark as Done,
-- at which point it goes back to the admin for approval before the doctor sees
-- it.
--
-- Written by hand with IF NOT EXISTS throughout: this database's migration
-- history is not in sync with the folder, so `prisma migrate dev` would offer
-- to reset it. Applied with `db push --skip-generate` + this file for the
-- record.

-- ── lab_orders: the payment gate radiology already had ────────────────────
ALTER TABLE "lab_orders"
  ADD COLUMN IF NOT EXISTS "payment_verified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "payment_verified_by" UUID,
  ADD COLUMN IF NOT EXISTS "payment_verified_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "payment_deferred_reason" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lab_orders_payment_verified_by_fkey'
  ) THEN
    ALTER TABLE "lab_orders"
      ADD CONSTRAINT "lab_orders_payment_verified_by_fkey"
      FOREIGN KEY ("payment_verified_by") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "lab_orders_payment_verified_idx"
  ON "lab_orders" ("tenant_id", "payment_verified");

-- ── imaging_requests: the accept step lab already had ─────────────────────
ALTER TABLE "imaging_requests"
  ADD COLUMN IF NOT EXISTS "accepted_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "accepted_by" UUID,
  ADD COLUMN IF NOT EXISTS "payment_deferred_reason" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'imaging_requests_accepted_by_fkey'
  ) THEN
    ALTER TABLE "imaging_requests"
      ADD CONSTRAINT "imaging_requests_accepted_by_fkey"
      FOREIGN KEY ("accepted_by") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "imaging_requests_accepted_at_idx"
  ON "imaging_requests" ("tenant_id", "accepted_at");

-- ── Backfills ─────────────────────────────────────────────────────────────
-- An order the lab already admitted was, by definition, past the payment
-- question under the old flow. Without this every historical order would
-- surface in the new "Awaiting Payment" queue.
UPDATE "lab_orders"
   SET "payment_verified" = true,
       "payment_verified_at" = COALESCE("payment_verified_at", "accepted_at"),
       "payment_verified_by" = COALESCE("payment_verified_by", "accepted_by")
 WHERE "accepted_at" IS NOT NULL
   AND "payment_verified" = false;

-- Anything already finished predates the gate entirely.
UPDATE "lab_orders"
   SET "payment_verified" = true
 WHERE "status" = 'completed'
   AND "payment_verified" = false;

-- Radiology's old "Verify Payment" click WAS the accept, so replay it as one.
UPDATE "imaging_requests"
   SET "accepted_at" = COALESCE("accepted_at", "payment_verified_at"),
       "accepted_by" = COALESCE("accepted_by", "payment_verified_by")
 WHERE "payment_verified" = true
   AND "accepted_at" IS NULL;

-- The radiologist's Mark-as-Done step is being reinstated (it was removed on
-- 2026-06-01 and the admin approved straight off a draft). Existing draft
-- results whose study is already complete are exactly the set that had been
-- submitted under the old flow — promote them to `finalized` so they stay in
-- the admin's approval queue instead of falling back into the radiologist's
-- draft bucket.
UPDATE "imaging_results" r
   SET "status" = 'finalized'
  FROM "imaging_requests" q
 WHERE r."imaging_request_id" = q."id"
   AND r."status" = 'draft'
   AND q."status" = 'completed';
