-- GTIN uniqueness: a GTIN identifies one product, so it must map to at most one
-- medicine. DrugMaster is platform-wide (global unique); DrugFormulary is
-- per-tenant. Empty strings are first collapsed to NULL so a blank field never
-- collides under the unique index (NULLs are treated as distinct in Postgres).

-- Normalise legacy blanks to NULL.
UPDATE "drug_master"    SET "gtin" = NULL           WHERE "gtin" = '';
UPDATE "drug_master"    SET "case_pack_gtin" = NULL WHERE "case_pack_gtin" = '';
UPDATE "drug_formulary" SET "gtin" = NULL           WHERE "gtin" = '';
UPDATE "drug_formulary" SET "case_pack_gtin" = NULL WHERE "case_pack_gtin" = '';

-- Platform-global uniqueness on the catalog.
CREATE UNIQUE INDEX "drug_master_gtin_key" ON "drug_master"("gtin");
CREATE UNIQUE INDEX "drug_master_case_pack_gtin_key" ON "drug_master"("case_pack_gtin");

-- Per-tenant uniqueness on each hospital's formulary.
CREATE UNIQUE INDEX "drug_formulary_tenant_id_gtin_key" ON "drug_formulary"("tenant_id", "gtin");
CREATE UNIQUE INDEX "drug_formulary_tenant_id_case_pack_gtin_key" ON "drug_formulary"("tenant_id", "case_pack_gtin");
