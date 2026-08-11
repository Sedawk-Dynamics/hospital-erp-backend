-- Discount approval gate.
--
-- A concession above a configured limit stops being effective the moment it is
-- typed and becomes a request that somebody with billing:approve has to decide
-- on. Only `approved` rows reduce what the patient owes.
--
-- Every existing row defaults to 'approved' so concessions granted before this
-- gate existed stay in effect, and a hospital that never switches the gate on
-- behaves exactly as it always did.
--
-- Hand-written with IF NOT EXISTS throughout so it is safe to run against a
-- database `prisma db push` has already brought into sync.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DiscountStatus') THEN
        CREATE TYPE "DiscountStatus" AS ENUM ('pending', 'approved', 'rejected');
    END IF;
END $$;

ALTER TABLE "discounts"
    ADD COLUMN IF NOT EXISTS "status" "DiscountStatus" NOT NULL DEFAULT 'approved',
    ADD COLUMN IF NOT EXISTS "requested_by" TEXT,
    ADD COLUMN IF NOT EXISTS "decided_at" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "rejection_reason" TEXT;

CREATE INDEX IF NOT EXISTS "discounts_tenant_id_status_idx"
    ON "discounts" ("tenant_id", "status");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'discounts_requested_by_fkey'
    ) THEN
        ALTER TABLE "discounts"
            ADD CONSTRAINT "discounts_requested_by_fkey"
            FOREIGN KEY ("requested_by") REFERENCES "users"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
