-- AlterTable
ALTER TABLE "drug_formulary" ADD COLUMN "is_narcotic" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ndps_locations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'sub_store',
    "ward_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ndps_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ndps_stock_balances" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "drug_formulary_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ndps_stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ndps_transactions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "drug_formulary_id" TEXT NOT NULL,
    "entry_type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "from_location_id" TEXT,
    "to_location_id" TEXT,
    "ndps_license_number" VARCHAR(120),
    "form_3c_number" VARCHAR(120),
    "transport_details" TEXT,
    "gross_weight" VARCHAR(60),
    "supplier_id" TEXT,
    "batch_number" VARCHAR(100),
    "expiry_date" DATE,
    "patient_id" TEXT,
    "doctor_reg_no" VARCHAR(60),
    "bed_number" VARCHAR(40),
    "diagnosis" TEXT,
    "reason_code" VARCHAR(40),
    "reference_number" VARCHAR(120),
    "attachment_url" TEXT,
    "co_sign_by_id" TEXT,
    "recorded_by_id" TEXT NOT NULL,
    "counterparty_id" TEXT,
    "notes" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ndps_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ndps_daily_balances" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "drug_formulary_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "opening_balance" INTEGER NOT NULL,
    "received" INTEGER NOT NULL DEFAULT 0,
    "dispensed" INTEGER NOT NULL DEFAULT 0,
    "disposed" INTEGER NOT NULL DEFAULT 0,
    "closing_balance" INTEGER NOT NULL,
    "physical_count" INTEGER,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_by_id" TEXT,
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ndps_daily_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ndps_locations_tenant_id_name_key" ON "ndps_locations"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ndps_stock_balances_tenant_id_drug_formulary_id_location_id_key" ON "ndps_stock_balances"("tenant_id", "drug_formulary_id", "location_id");

-- CreateIndex
CREATE INDEX "ndps_transactions_tenant_id_entry_type_occurred_at_idx" ON "ndps_transactions"("tenant_id", "entry_type", "occurred_at");

-- CreateIndex
CREATE INDEX "ndps_transactions_tenant_id_drug_formulary_id_occurred_at_idx" ON "ndps_transactions"("tenant_id", "drug_formulary_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "ndps_daily_balances_tenant_id_drug_formulary_id_date_key" ON "ndps_daily_balances"("tenant_id", "drug_formulary_id", "date");

-- AddForeignKey
ALTER TABLE "ndps_locations" ADD CONSTRAINT "ndps_locations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ndps_stock_balances" ADD CONSTRAINT "ndps_stock_balances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ndps_stock_balances" ADD CONSTRAINT "ndps_stock_balances_drug_formulary_id_fkey" FOREIGN KEY ("drug_formulary_id") REFERENCES "drug_formulary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ndps_stock_balances" ADD CONSTRAINT "ndps_stock_balances_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "ndps_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ndps_transactions" ADD CONSTRAINT "ndps_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ndps_transactions" ADD CONSTRAINT "ndps_transactions_drug_formulary_id_fkey" FOREIGN KEY ("drug_formulary_id") REFERENCES "drug_formulary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ndps_daily_balances" ADD CONSTRAINT "ndps_daily_balances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ndps_daily_balances" ADD CONSTRAINT "ndps_daily_balances_drug_formulary_id_fkey" FOREIGN KEY ("drug_formulary_id") REFERENCES "drug_formulary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
