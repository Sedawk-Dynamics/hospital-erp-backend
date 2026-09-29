-- SNOMED CT diagnosis search and its ICD-10 cross-map.
-- Additive and safe for databases previously provisioned with `prisma db push`.

CREATE TABLE IF NOT EXISTS "snomed_descriptions" (
  "id" TEXT NOT NULL,
  "description_id" VARCHAR(32) NOT NULL,
  "concept_id" VARCHAR(32) NOT NULL,
  "term" VARCHAR(500) NOT NULL,
  "type_id" VARCHAR(32),
  "language_code" VARCHAR(10),
  "case_significance_id" VARCHAR(32),
  "module_id" VARCHAR(32),
  "effective_time" VARCHAR(20),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "search_tokens" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "snomed_descriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "snomed_descriptions_description_id_key"
  ON "snomed_descriptions"("description_id");
CREATE INDEX IF NOT EXISTS "snomed_descriptions_concept_id_idx"
  ON "snomed_descriptions"("concept_id");
CREATE INDEX IF NOT EXISTS "snomed_descriptions_active_idx"
  ON "snomed_descriptions"("active");

CREATE TABLE IF NOT EXISTS "snomed_icd_maps" (
  "id" TEXT NOT NULL,
  "refset_member_id" VARCHAR(64),
  "refset_id" VARCHAR(32),
  "referenced_component_id" VARCHAR(32) NOT NULL,
  "map_group" INTEGER NOT NULL DEFAULT 1,
  "map_priority" INTEGER NOT NULL DEFAULT 1,
  "map_rule" TEXT,
  "map_advice" TEXT,
  "map_target" VARCHAR(20),
  "correlation_id" VARCHAR(32),
  "map_category_id" VARCHAR(32),
  "module_id" VARCHAR(32),
  "effective_time" VARCHAR(20),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "snomed_icd_maps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "snomed_icd_maps_refset_member_id_key"
  ON "snomed_icd_maps"("refset_member_id");
CREATE INDEX IF NOT EXISTS "snomed_icd_maps_referenced_component_id_idx"
  ON "snomed_icd_maps"("referenced_component_id");
CREATE INDEX IF NOT EXISTS "snomed_icd_maps_map_target_idx"
  ON "snomed_icd_maps"("map_target");
CREATE INDEX IF NOT EXISTS "snomed_icd_maps_active_idx"
  ON "snomed_icd_maps"("active");

ALTER TABLE "diagnoses" ADD COLUMN IF NOT EXISTS "snomed_code" VARCHAR(32);
