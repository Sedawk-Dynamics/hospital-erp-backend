-- Add eMAR (Electronic Medication Administration Record) module:
-- per-tenant configurable time slot + frequency masters, dose-level
-- schedule rows generated from IP prescriptions, and an append-only audit log.
-- Status lifecycle: pending -> due -> overdue -> (given | given_late | missed | held | refused | cancelled).

-- Enums
CREATE TYPE "EmarFrequencyType" AS ENUM (
  'slot',
  'interval',
  'once',
  'prn'
);

CREATE TYPE "EmarDoseStatus" AS ENUM (
  'pending',
  'due',
  'overdue',
  'given',
  'given_late',
  'missed',
  'held',
  'refused',
  'cancelled'
);

CREATE TYPE "EmarAuditAction" AS ENUM (
  'generated',
  'given',
  'late',
  'missed',
  'held',
  'refused',
  'amended',
  'cancelled',
  'prn',
  'status'
);

-- Time Slot Master (per-tenant configurable)
CREATE TABLE "emar_time_slots" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "code" VARCHAR(40) NOT NULL,
  "label" VARCHAR(80) NOT NULL,
  "time" VARCHAR(5) NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emar_time_slots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "emar_time_slots_tenant_id_code_key"
  ON "emar_time_slots"("tenant_id", "code");

ALTER TABLE "emar_time_slots"
  ADD CONSTRAINT "emar_time_slots_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Frequency Master
CREATE TABLE "emar_frequencies" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "code" VARCHAR(40) NOT NULL,
  "label" VARCHAR(120) NOT NULL,
  "type" "EmarFrequencyType" NOT NULL,
  "slot_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "interval_hours" INTEGER,
  "min_prn_interval_minutes" INTEGER,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emar_frequencies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "emar_frequencies_tenant_id_code_key"
  ON "emar_frequencies"("tenant_id", "code");

ALTER TABLE "emar_frequencies"
  ADD CONSTRAINT "emar_frequencies_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Settings (grace period, default PRN min interval)
CREATE TABLE "emar_settings" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "grace_period_minutes" INTEGER NOT NULL DEFAULT 120,
  "default_prn_min_interval_minutes" INTEGER NOT NULL DEFAULT 240,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emar_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "emar_settings_tenant_id_key"
  ON "emar_settings"("tenant_id");

ALTER TABLE "emar_settings"
  ADD CONSTRAINT "emar_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Schedule (one row per dose)
CREATE TABLE "emar_schedules" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "prescription_id" TEXT NOT NULL,
  "prescription_item_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "admission_id" TEXT,
  "drug_name" VARCHAR(255) NOT NULL,
  "dosage" VARCHAR(100) NOT NULL,
  "route" "MedicationRoute" NOT NULL DEFAULT 'oral',
  "frequency_code" VARCHAR(40),
  "slot_code" VARCHAR(40),
  "scheduled_at" TIMESTAMP(3) NOT NULL,
  "status" "EmarDoseStatus" NOT NULL DEFAULT 'pending',
  "is_prn" BOOLEAN NOT NULL DEFAULT false,
  "actioned_at" TIMESTAMP(3),
  "actual_given_time" TIMESTAMP(3),
  "given_by_id" TEXT,
  "delay_minutes" INTEGER,
  "reason" TEXT,
  "notes" TEXT,
  "amended_at" TIMESTAMP(3),
  "amended_by_id" TEXT,
  "previous_status" "EmarDoseStatus",
  "cancelled_at" TIMESTAMP(3),
  "cancel_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emar_schedules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "emar_schedules_tenant_id_scheduled_at_idx"
  ON "emar_schedules"("tenant_id", "scheduled_at");

CREATE INDEX "emar_schedules_tenant_id_patient_id_scheduled_at_idx"
  ON "emar_schedules"("tenant_id", "patient_id", "scheduled_at");

CREATE INDEX "emar_schedules_tenant_id_admission_id_scheduled_at_idx"
  ON "emar_schedules"("tenant_id", "admission_id", "scheduled_at");

CREATE INDEX "emar_schedules_tenant_id_status_idx"
  ON "emar_schedules"("tenant_id", "status");

ALTER TABLE "emar_schedules"
  ADD CONSTRAINT "emar_schedules_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "emar_schedules"
  ADD CONSTRAINT "emar_schedules_prescription_id_fkey"
  FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "emar_schedules"
  ADD CONSTRAINT "emar_schedules_prescription_item_id_fkey"
  FOREIGN KEY ("prescription_item_id") REFERENCES "prescription_items"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "emar_schedules"
  ADD CONSTRAINT "emar_schedules_patient_id_fkey"
  FOREIGN KEY ("patient_id") REFERENCES "patients"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "emar_schedules"
  ADD CONSTRAINT "emar_schedules_admission_id_fkey"
  FOREIGN KEY ("admission_id") REFERENCES "admissions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "emar_schedules"
  ADD CONSTRAINT "emar_schedules_given_by_id_fkey"
  FOREIGN KEY ("given_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "emar_schedules"
  ADD CONSTRAINT "emar_schedules_amended_by_id_fkey"
  FOREIGN KEY ("amended_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Audit log (append-only)
CREATE TABLE "emar_audit_logs" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "schedule_id" TEXT NOT NULL,
  "action" "EmarAuditAction" NOT NULL,
  "from_status" "EmarDoseStatus",
  "to_status" "EmarDoseStatus" NOT NULL,
  "performed_by_id" TEXT,
  "performed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "server_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" TEXT,
  "notes" TEXT,
  "delay_minutes" INTEGER,
  "metadata" JSONB,
  CONSTRAINT "emar_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "emar_audit_logs_tenant_id_schedule_id_idx"
  ON "emar_audit_logs"("tenant_id", "schedule_id");

CREATE INDEX "emar_audit_logs_tenant_id_performed_at_idx"
  ON "emar_audit_logs"("tenant_id", "performed_at");

ALTER TABLE "emar_audit_logs"
  ADD CONSTRAINT "emar_audit_logs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "emar_audit_logs"
  ADD CONSTRAINT "emar_audit_logs_schedule_id_fkey"
  FOREIGN KEY ("schedule_id") REFERENCES "emar_schedules"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "emar_audit_logs"
  ADD CONSTRAINT "emar_audit_logs_performed_by_id_fkey"
  FOREIGN KEY ("performed_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
