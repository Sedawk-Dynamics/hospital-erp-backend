-- G9 (3.4): repair the OT-kit migration drift.
--
-- Migration 20260629120000_remove_ot_surgical_kits DROPPED the OT-kit /
-- surgical-template tables, and the OT-kit module was later rebuilt via
-- `prisma db push` (so the tables exist in the live DB and in schema.prisma but
-- were never re-created in migration history). A fresh `prisma migrate deploy`
-- would therefore be missing them. This migration re-creates them.
--
-- IF NOT EXISTS / guarded constraints keep it a safe no-op on any DB that already
-- has the tables (the live db-push dev DB), while a fresh deploy creates them.

-- CreateTable
CREATE TABLE IF NOT EXISTS "surgical_templates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "procedure_name" VARCHAR(200),
    "doctor_id" TEXT,
    "kit_barcode" VARCHAR(64),
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "surgical_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "surgical_template_items" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "drug_formulary_id" TEXT NOT NULL,
    "default_quantity" INTEGER NOT NULL,
    "notes" TEXT,

    CONSTRAINT "surgical_template_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ot_kit_issues" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "issue_number" VARCHAR(40) NOT NULL,
    "ot_request_id" TEXT,
    "patient_id" TEXT NOT NULL,
    "visit_id" TEXT,
    "template_id" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'requested',
    "requested_by_id" TEXT,
    "issued_by_id" TEXT,
    "issued_at" TIMESTAMP(3),
    "reconciled_by_id" TEXT,
    "reconciled_at" TIMESTAMP(3),
    "bill_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ot_kit_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ot_kit_issue_items" (
    "id" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "drug_formulary_id" TEXT NOT NULL,
    "drug_batch_id" TEXT,
    "issued_qty" INTEGER NOT NULL DEFAULT 0,
    "returned_qty" INTEGER NOT NULL DEFAULT 0,
    "consumed_qty" INTEGER,
    "unit_price" DECIMAL(12,2),
    "tax_percent" DECIMAL(5,2) DEFAULT 0,
    "line_total" DECIMAL(12,2),

    CONSTRAINT "ot_kit_issue_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "surgical_templates_tenant_id_is_active_idx" ON "surgical_templates"("tenant_id", "is_active");
CREATE INDEX IF NOT EXISTS "surgical_template_items_template_id_idx" ON "surgical_template_items"("template_id");
CREATE INDEX IF NOT EXISTS "ot_kit_issues_tenant_id_status_idx" ON "ot_kit_issues"("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "ot_kit_issues_tenant_id_ot_request_id_idx" ON "ot_kit_issues"("tenant_id", "ot_request_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ot_kit_issues_tenant_id_issue_number_key" ON "ot_kit_issues"("tenant_id", "issue_number");
CREATE INDEX IF NOT EXISTS "ot_kit_issue_items_issue_id_idx" ON "ot_kit_issue_items"("issue_id");

-- AddForeignKey (guarded so a re-run on a DB that already has them is a no-op)
DO $$ BEGIN
  ALTER TABLE "surgical_template_items" ADD CONSTRAINT "surgical_template_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "surgical_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ot_kit_issue_items" ADD CONSTRAINT "ot_kit_issue_items_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "ot_kit_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
