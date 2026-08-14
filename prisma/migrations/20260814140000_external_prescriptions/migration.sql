-- Outside (paper) prescriptions presented at the pharmacy counter.
--
-- Purely additive: one new table plus one nullable column on dispensing_records.
-- Nothing reads either yet, so applying this changes no behaviour.
--
-- Why a separate table rather than nullable fields on `prescriptions`: a
-- Prescription is a clinical record this hospital authored and owns, while this
-- is evidence a walk-in presented. Merging them would put unverified outside
-- data into the clinical record.

CREATE TABLE IF NOT EXISTS "external_prescriptions" (
    "id"                        TEXT NOT NULL,
    "tenant_id"                 TEXT NOT NULL,
    "patient_id"                TEXT,
    "patient_name_raw"          VARCHAR(255),
    "patient_age"               INTEGER,
    "patient_sex"               VARCHAR(20),
    -- The Schedule H1 register must record the patient's address, which we hold
    -- nowhere else for a walk-in.
    "patient_address"           TEXT,
    "prescriber_name"           VARCHAR(255) NOT NULL,
    "prescriber_reg_no"         VARCHAR(60),
    "prescriber_qualification"  VARCHAR(120),
    "hospital_name"             VARCHAR(255),
    "prescribed_date"           DATE,
    "image_url"                 TEXT,
    "ocr_json"                  JSONB,
    "notes"                     TEXT,
    "captured_by_id"            TEXT NOT NULL,
    -- Statutory retention: +2 years Schedule X, +3 years H1.
    "retain_until"              DATE,
    "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_prescriptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "external_prescriptions_tenant_id_created_at_idx"
    ON "external_prescriptions" ("tenant_id", "created_at");
CREATE INDEX IF NOT EXISTS "external_prescriptions_tenant_id_prescriber_reg_no_idx"
    ON "external_prescriptions" ("tenant_id", "prescriber_reg_no");

DO $$ BEGIN
    ALTER TABLE "external_prescriptions"
        ADD CONSTRAINT "external_prescriptions_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "external_prescriptions"
        ADD CONSTRAINT "external_prescriptions_patient_id_fkey"
        FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A dispensed line is backed by EITHER an in-system prescription or an external
-- one. Nullable, so every existing row stays valid untouched.
ALTER TABLE "dispensing_records"
    ADD COLUMN IF NOT EXISTS "external_prescription_id" TEXT;

CREATE INDEX IF NOT EXISTS "dispensing_records_external_prescription_id_idx"
    ON "dispensing_records" ("external_prescription_id");

DO $$ BEGIN
    ALTER TABLE "dispensing_records"
        ADD CONSTRAINT "dispensing_records_external_prescription_id_fkey"
        FOREIGN KEY ("external_prescription_id") REFERENCES "external_prescriptions"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
