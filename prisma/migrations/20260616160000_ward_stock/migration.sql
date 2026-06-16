-- G13: ward stock sub-module. Each ward holds drug-batch stock transferred from
-- the central pharmacy; ward_stock_ledger is the digital ward medicine register.
CREATE TABLE IF NOT EXISTS "ward_stock" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "ward_id" TEXT NOT NULL,
  "drug_id" TEXT NOT NULL,
  "drug_batch_id" TEXT NOT NULL,
  "quantity_in_stock" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ward_stock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ward_stock_tenant_ward_batch_key" ON "ward_stock" ("tenant_id", "ward_id", "drug_batch_id");
CREATE INDEX IF NOT EXISTS "ward_stock_tenant_ward_idx" ON "ward_stock" ("tenant_id", "ward_id");

CREATE TABLE IF NOT EXISTS "ward_stock_ledger" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "ward_id" TEXT NOT NULL,
  "drug_id" TEXT NOT NULL,
  "drug_batch_id" TEXT NOT NULL,
  "movement_type" VARCHAR(20) NOT NULL,
  "quantity" INTEGER NOT NULL,
  "patient_id" TEXT,
  "admission_id" TEXT,
  "bill_id" TEXT,
  "performed_by" TEXT,
  "reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ward_stock_ledger_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ward_stock_ledger_tenant_ward_created_idx" ON "ward_stock_ledger" ("tenant_id", "ward_id", "created_at");
