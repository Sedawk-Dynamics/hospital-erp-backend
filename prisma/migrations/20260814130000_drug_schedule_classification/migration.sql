-- Classification columns written by the drug schedule classifier.
-- Purely additive: every column is nullable or defaulted, and nothing reads them
-- yet, so applying this changes no behaviour.
--
-- NOTE ON drug_master.schedule: that legacy column is deliberately NOT used.
-- checkSaleCompliance() already reads it and is already wired into
-- createPharmacySale, so populating it would silently switch counter enforcement
-- on. The classifier writes schedule_resolved instead; the compliance gate is
-- repointed at it later, behind a per-hospital enforcement setting.

ALTER TABLE "drug_master"
    ADD COLUMN IF NOT EXISTS "schedule_resolved"  VARCHAR(10),
    ADD COLUMN IF NOT EXISTS "schedule_reason"    TEXT,
    ADD COLUMN IF NOT EXISTS "controlled_class"   VARCHAR(20),
    ADD COLUMN IF NOT EXISTS "vault_controlled"   BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "requires_qr_scan"   BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "salts_json"         JSONB,
    ADD COLUMN IF NOT EXISTS "classified_at"      TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "classifier_version" INTEGER;

ALTER TABLE "drug_formulary"
    ADD COLUMN IF NOT EXISTS "schedule"                  VARCHAR(10),
    ADD COLUMN IF NOT EXISTS "schedule_source"           VARCHAR(20),
    ADD COLUMN IF NOT EXISTS "schedule_reason"           TEXT,
    ADD COLUMN IF NOT EXISTS "schedule_overridden_by_id" TEXT,
    ADD COLUMN IF NOT EXISTS "schedule_overridden_at"    TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "controlled_class"          VARCHAR(20),
    ADD COLUMN IF NOT EXISTS "vault_controlled"          BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "requires_qr_scan"          BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "salts_json"                JSONB,
    ADD COLUMN IF NOT EXISTS "classified_at"             TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "classifier_version"        INTEGER;

-- Drives the "show me every controlled drug" reports and the catalog filter.
CREATE INDEX IF NOT EXISTS "drug_formulary_tenant_schedule_idx"
    ON "drug_formulary" ("tenant_id", "schedule");
CREATE INDEX IF NOT EXISTS "drug_formulary_tenant_controlled_class_idx"
    ON "drug_formulary" ("tenant_id", "controlled_class");
CREATE INDEX IF NOT EXISTS "drug_master_schedule_resolved_idx"
    ON "drug_master" ("schedule_resolved");
