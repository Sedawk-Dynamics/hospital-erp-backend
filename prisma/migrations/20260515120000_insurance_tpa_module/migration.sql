-- Insurance & TPA module: claim calc fields, resubmission lineage,
-- partial-settle / cancelled claim status, hold/cancelled pre-auth status,
-- pre-auth approved amount + hold reason.

-- ============================================================
-- Enum extensions
-- ============================================================

ALTER TYPE "ClaimStatus" ADD VALUE IF NOT EXISTS 'partially_settled';
ALTER TYPE "ClaimStatus" ADD VALUE IF NOT EXISTS 'cancelled';

ALTER TYPE "PreAuthStatus" ADD VALUE IF NOT EXISTS 'on_hold';
ALTER TYPE "PreAuthStatus" ADD VALUE IF NOT EXISTS 'cancelled';

-- ============================================================
-- Insurance claims: copay / deductible / covered / paid /
-- outstanding tracking, expiry alert date, resubmission lineage.
-- ============================================================

ALTER TABLE "insurance_claims"
  ADD COLUMN IF NOT EXISTS "copay_amount"        DECIMAL(12, 2),
  ADD COLUMN IF NOT EXISTS "deductible_amount"   DECIMAL(12, 2),
  ADD COLUMN IF NOT EXISTS "covered_amount"      DECIMAL(12, 2),
  ADD COLUMN IF NOT EXISTS "paid_amount"         DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "outstanding_amount"  DECIMAL(12, 2),
  ADD COLUMN IF NOT EXISTS "expiry_date"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "notes"               TEXT,
  ADD COLUMN IF NOT EXISTS "resubmission_count"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "previous_claim_id"   TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'insurance_claims_previous_claim_id_fkey'
  ) THEN
    ALTER TABLE "insurance_claims"
      ADD CONSTRAINT "insurance_claims_previous_claim_id_fkey"
      FOREIGN KEY ("previous_claim_id") REFERENCES "insurance_claims"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "insurance_claims_tenant_id_status_idx"
  ON "insurance_claims"("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "insurance_claims_expiry_date_idx"
  ON "insurance_claims"("expiry_date");
CREATE INDEX IF NOT EXISTS "insurance_claims_previous_claim_id_idx"
  ON "insurance_claims"("previous_claim_id");

-- ============================================================
-- Pre-authorization requests: approvedAmount + holdReason.
-- ============================================================

ALTER TABLE "pre_authorization_requests"
  ADD COLUMN IF NOT EXISTS "approved_amount"  DECIMAL(12, 2),
  ADD COLUMN IF NOT EXISTS "hold_reason"      TEXT;

CREATE INDEX IF NOT EXISTS "pre_authorization_requests_tenant_id_status_idx"
  ON "pre_authorization_requests"("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "pre_authorization_requests_valid_to_idx"
  ON "pre_authorization_requests"("valid_to");

-- ============================================================
-- Insurance policies: index validTo for expiry alerts.
-- ============================================================

CREATE INDEX IF NOT EXISTS "insurance_policies_valid_to_idx"
  ON "insurance_policies"("valid_to");
CREATE INDEX IF NOT EXISTS "insurance_policies_tenant_id_patient_id_idx"
  ON "insurance_policies"("tenant_id", "patient_id");
