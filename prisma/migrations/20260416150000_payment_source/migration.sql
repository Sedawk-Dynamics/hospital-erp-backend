-- Track whether a payment was collected online (Razorpay) or at the front desk.
-- Nullable on the column so historical rows that don't fit either bucket stay null.

CREATE TYPE "PaymentSource" AS ENUM ('online', 'frontdesk');

ALTER TABLE "payments"
  ADD COLUMN "payment_source" "PaymentSource";

-- Backfill: any payment that has a payment_transfers row is a Razorpay (online) payment.
UPDATE "payments" p
SET "payment_source" = 'online'
WHERE EXISTS (
  SELECT 1 FROM "payment_transfers" pt WHERE pt."payment_id" = p."id"
);

-- All other completed payments are direct front-desk collections.
UPDATE "payments"
SET "payment_source" = 'frontdesk'
WHERE "payment_source" IS NULL
  AND "status" = 'completed';
