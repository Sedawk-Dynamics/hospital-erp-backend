-- CDSS persisted alerts: every triggered decision-support alert
-- (interaction / allergy / dosage / recall / critical value) is stored
-- with an acknowledge / override-with-reason review workflow.

CREATE TYPE "CdssAlertType" AS ENUM ('drug_interaction', 'allergy', 'dosage', 'recall', 'critical_value');

CREATE TYPE "CdssAlertStatus" AS ENUM ('active', 'acknowledged', 'overridden');

CREATE TABLE "cdss_alerts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT,
    "alert_type" "CdssAlertType" NOT NULL,
    "severity" VARCHAR(20) NOT NULL,
    "message" TEXT NOT NULL,
    "detail" TEXT,
    "drug_name" VARCHAR(255),
    "parameter_name" VARCHAR(255),
    "parameter_value" VARCHAR(100),
    "reference_type" VARCHAR(50),
    "reference_id" TEXT,
    "notified_user_id" TEXT,
    "status" "CdssAlertStatus" NOT NULL DEFAULT 'active',
    "acknowledged_by_id" TEXT,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledge_note" TEXT,
    "override_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cdss_alerts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cdss_alerts_tenant_id_status_created_at_idx" ON "cdss_alerts"("tenant_id", "status", "created_at");

CREATE INDEX "cdss_alerts_tenant_id_alert_type_created_at_idx" ON "cdss_alerts"("tenant_id", "alert_type", "created_at");

CREATE INDEX "cdss_alerts_tenant_id_patient_id_idx" ON "cdss_alerts"("tenant_id", "patient_id");

ALTER TABLE "cdss_alerts" ADD CONSTRAINT "cdss_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cdss_alerts" ADD CONSTRAINT "cdss_alerts_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cdss_alerts" ADD CONSTRAINT "cdss_alerts_acknowledged_by_id_fkey" FOREIGN KEY ("acknowledged_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
