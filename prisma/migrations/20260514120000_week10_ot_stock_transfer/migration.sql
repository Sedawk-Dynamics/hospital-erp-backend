-- Week 10: extend OT requests + add stock transfers
-- Adds the OT fields the frontend already expects (surgeon/anaesthetist/billing/diagnoses)
-- and introduces a StockTransfer model to track item movement between departments.

-- ============================================================
-- OT requests: new columns
-- ============================================================

ALTER TABLE "ot_requests"
  ADD COLUMN IF NOT EXISTS "surgeon_id" TEXT,
  ADD COLUMN IF NOT EXISTS "anaesthetist_id" TEXT,
  ADD COLUMN IF NOT EXISTS "surgery_type" VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "speciality" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "scheduled_start_time" VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "scheduled_end_time" VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "actual_start_time" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "actual_end_time" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "pre_op_diagnosis" TEXT,
  ADD COLUMN IF NOT EXISTS "post_op_diagnosis" TEXT,
  ADD COLUMN IF NOT EXISTS "notes" TEXT,
  ADD COLUMN IF NOT EXISTS "billing_amount" DECIMAL(12, 2),
  ADD COLUMN IF NOT EXISTS "billing_status" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "cancellation_reason" TEXT;

ALTER TABLE "ot_requests"
  ADD CONSTRAINT "ot_requests_surgeon_id_fkey"
  FOREIGN KEY ("surgeon_id") REFERENCES "doctor_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ot_requests"
  ADD CONSTRAINT "ot_requests_anaesthetist_id_fkey"
  FOREIGN KEY ("anaesthetist_id") REFERENCES "doctor_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ot_requests_surgeon_id_idx" ON "ot_requests"("surgeon_id");
CREATE INDEX IF NOT EXISTS "ot_requests_anaesthetist_id_idx" ON "ot_requests"("anaesthetist_id");
CREATE INDEX IF NOT EXISTS "ot_requests_scheduled_date_idx" ON "ot_requests"("scheduled_date");

-- ============================================================
-- Stock transfers
-- ============================================================

CREATE TYPE "StockTransferStatus" AS ENUM ('pending', 'approved', 'dispatched', 'received', 'rejected', 'cancelled');

CREATE TABLE "stock_transfers" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "transfer_number" VARCHAR(50) NOT NULL,
  "inventory_item_id" TEXT NOT NULL,
  "from_department_id" TEXT,
  "to_department_id" TEXT,
  "from_location" VARCHAR(100),
  "to_location" VARCHAR(100),
  "quantity_requested" INTEGER NOT NULL,
  "quantity_transferred" INTEGER NOT NULL DEFAULT 0,
  "batch_number" VARCHAR(100),
  "status" "StockTransferStatus" NOT NULL DEFAULT 'pending',
  "reason" TEXT,
  "notes" TEXT,
  "requested_by" TEXT NOT NULL,
  "approved_by" TEXT,
  "approved_at" TIMESTAMP(3),
  "dispatched_by" TEXT,
  "dispatched_at" TIMESTAMP(3),
  "received_by" TEXT,
  "received_at" TIMESTAMP(3),
  "rejection_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_transfers_transfer_number_key" ON "stock_transfers"("transfer_number");
CREATE INDEX "stock_transfers_tenant_id_status_idx" ON "stock_transfers"("tenant_id", "status");
CREATE INDEX "stock_transfers_tenant_id_inventory_item_id_idx" ON "stock_transfers"("tenant_id", "inventory_item_id");

ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_inventory_item_id_fkey"
  FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_from_department_id_fkey"
  FOREIGN KEY ("from_department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_to_department_id_fkey"
  FOREIGN KEY ("to_department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_requested_by_fkey"
  FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_approved_by_fkey"
  FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_dispatched_by_fkey"
  FOREIGN KEY ("dispatched_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_received_by_fkey"
  FOREIGN KEY ("received_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
