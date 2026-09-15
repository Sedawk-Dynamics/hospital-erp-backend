-- Patient-specific narcotic residual workflow.
--
-- The existing ndps_transactions table remains the statutory ledger. This
-- additive table stores the content-level arithmetic for one opened container,
-- while new nullable transaction columns make Form 3E and residual-disposal
-- rows traceable back to eMAR without changing historical records.

ALTER TABLE "ndps_transactions"
  ADD COLUMN IF NOT EXISTS "patient_dose_id" TEXT,
  ADD COLUMN IF NOT EXISTS "emar_schedule_id" TEXT,
  ADD COLUMN IF NOT EXISTS "dispensing_record_id" TEXT,
  ADD COLUMN IF NOT EXISTS "labelled_quantity" DECIMAL(14, 4),
  ADD COLUMN IF NOT EXISTS "administered_quantity" DECIMAL(14, 4),
  ADD COLUMN IF NOT EXISTS "residual_quantity" DECIMAL(14, 4),
  ADD COLUMN IF NOT EXISTS "quantity_unit" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "residual_disposition" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "stock_source" VARCHAR(30);

CREATE TABLE IF NOT EXISTS "ndps_patient_doses" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "emar_schedule_id" TEXT NOT NULL,
  "prescription_item_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "admission_id" TEXT,
  "drug_formulary_id" TEXT NOT NULL,
  "drug_batch_id" TEXT NOT NULL,
  "dispensing_record_id" TEXT,
  "ndps_location_id" TEXT NOT NULL,
  "administration_transaction_id" TEXT NOT NULL,
  "disposal_transaction_id" TEXT,
  "labelled_quantity" DECIMAL(14, 4) NOT NULL,
  "administered_quantity" DECIMAL(14, 4) NOT NULL,
  "residual_quantity" DECIMAL(14, 4) NOT NULL,
  "quantity_unit" VARCHAR(20) NOT NULL,
  "container_quantity" INTEGER NOT NULL DEFAULT 1,
  "status" VARCHAR(30) NOT NULL,
  "disposition" VARCHAR(30) NOT NULL,
  "stock_source" VARCHAR(30) NOT NULL,
  "emergency_use" BOOLEAN NOT NULL DEFAULT false,
  "emergency_reason" TEXT,
  "administered_by_id" TEXT NOT NULL,
  "administered_at" TIMESTAMP(3) NOT NULL,
  "witnessed_by_id" TEXT,
  "witnessed_at" TIMESTAMP(3),
  "disposal_method" VARCHAR(160),
  "quarantine_location" VARCHAR(160),
  "quarantined_at" TIMESTAMP(3),
  "destroyed_at" TIMESTAMP(3),
  "bill_id" TEXT,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ndps_patient_doses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ndps_patient_doses_emar_schedule_id_fkey"
    FOREIGN KEY ("emar_schedule_id") REFERENCES "emar_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ndps_patient_doses_quantity_check"
    CHECK (
      "labelled_quantity" > 0 AND
      "administered_quantity" > 0 AND
      "residual_quantity" >= 0 AND
      "container_quantity" > 0 AND
      "labelled_quantity" = "administered_quantity" + "residual_quantity"
    ),
  CONSTRAINT "ndps_patient_doses_status_check"
    CHECK ("status" IN ('fully_administered', 'destroyed', 'quarantined')),
  CONSTRAINT "ndps_patient_doses_disposition_check"
    CHECK ("disposition" IN ('none', 'destroyed', 'quarantined')),
  CONSTRAINT "ndps_patient_doses_state_check"
    CHECK (
      ("residual_quantity" = 0 AND "status" = 'fully_administered' AND "disposition" = 'none') OR
      ("residual_quantity" > 0 AND "status" = 'destroyed' AND "disposition" = 'destroyed') OR
      ("residual_quantity" > 0 AND "status" = 'quarantined' AND "disposition" = 'quarantined')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "ndps_patient_doses_emar_schedule_id_key"
  ON "ndps_patient_doses"("emar_schedule_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ndps_patient_doses_administration_transaction_id_key"
  ON "ndps_patient_doses"("administration_transaction_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ndps_patient_doses_disposal_transaction_id_key"
  ON "ndps_patient_doses"("disposal_transaction_id");
CREATE INDEX IF NOT EXISTS "ndps_patient_doses_tenant_id_status_created_at_idx"
  ON "ndps_patient_doses"("tenant_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "ndps_patient_doses_tenant_id_patient_id_administered_at_idx"
  ON "ndps_patient_doses"("tenant_id", "patient_id", "administered_at");
CREATE INDEX IF NOT EXISTS "ndps_patient_doses_drug_batch_id_idx"
  ON "ndps_patient_doses"("drug_batch_id");
CREATE INDEX IF NOT EXISTS "ndps_patient_doses_ndps_location_id_idx"
  ON "ndps_patient_doses"("ndps_location_id");

CREATE INDEX IF NOT EXISTS "ndps_transactions_patient_dose_id_idx"
  ON "ndps_transactions"("patient_dose_id");
CREATE INDEX IF NOT EXISTS "ndps_transactions_emar_schedule_id_idx"
  ON "ndps_transactions"("emar_schedule_id");
