-- GTIN uniqueness: a GTIN identifies one product, so it must map to at most one
-- medicine. DrugMaster is platform-wide / globally unique, DrugFormulary is
-- per-tenant. Empty strings are first collapsed to NULL so a blank field never
-- collides under the unique index (NULLs are treated as distinct in Postgres).
--
-- Self-healing: before creating the unique indexes we NULL out any pre-existing
-- duplicate GTINs, keeping the earliest-created row in each group. Without this,
-- a production database that already holds a duplicate would make CREATE UNIQUE
-- INDEX fail and block the whole deploy. Clearing the later duplicate is the
-- safe automatic resolution — the operator re-enters the correct code afterward,
-- and the first-assigned drug keeps the GTIN.

-- 1. Normalise legacy blanks to NULL.
UPDATE "drug_master"    SET "gtin" = NULL           WHERE "gtin" = '';
UPDATE "drug_master"    SET "case_pack_gtin" = NULL WHERE "case_pack_gtin" = '';
UPDATE "drug_formulary" SET "gtin" = NULL           WHERE "gtin" = '';
UPDATE "drug_formulary" SET "case_pack_gtin" = NULL WHERE "case_pack_gtin" = '';

-- 2. Break any pre-existing duplicates (keep the earliest row per group).

-- DrugMaster.gtin — global
UPDATE "drug_master" d SET "gtin" = NULL
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "gtin" ORDER BY "created_at", "id") AS rn
  FROM "drug_master" WHERE "gtin" IS NOT NULL
) x
WHERE d."id" = x."id" AND x.rn > 1;

-- DrugMaster.case_pack_gtin — global
UPDATE "drug_master" d SET "case_pack_gtin" = NULL
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "case_pack_gtin" ORDER BY "created_at", "id") AS rn
  FROM "drug_master" WHERE "case_pack_gtin" IS NOT NULL
) x
WHERE d."id" = x."id" AND x.rn > 1;

-- DrugFormulary.gtin — per tenant
UPDATE "drug_formulary" d SET "gtin" = NULL
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "tenant_id", "gtin" ORDER BY "created_at", "id") AS rn
  FROM "drug_formulary" WHERE "gtin" IS NOT NULL
) x
WHERE d."id" = x."id" AND x.rn > 1;

-- DrugFormulary.case_pack_gtin — per tenant
UPDATE "drug_formulary" d SET "case_pack_gtin" = NULL
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "tenant_id", "case_pack_gtin" ORDER BY "created_at", "id") AS rn
  FROM "drug_formulary" WHERE "case_pack_gtin" IS NOT NULL
) x
WHERE d."id" = x."id" AND x.rn > 1;

-- 3. Create the unique indexes (names match Prisma's @unique / @@unique convention).

-- Platform-global uniqueness on the catalog.
CREATE UNIQUE INDEX "drug_master_gtin_key" ON "drug_master"("gtin");
CREATE UNIQUE INDEX "drug_master_case_pack_gtin_key" ON "drug_master"("case_pack_gtin");

-- Per-tenant uniqueness on each hospital's formulary.
CREATE UNIQUE INDEX "drug_formulary_tenant_id_gtin_key" ON "drug_formulary"("tenant_id", "gtin");
CREATE UNIQUE INDEX "drug_formulary_tenant_id_case_pack_gtin_key" ON "drug_formulary"("tenant_id", "case_pack_gtin");
