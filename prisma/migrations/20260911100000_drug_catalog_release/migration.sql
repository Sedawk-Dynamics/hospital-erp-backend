-- ---------------------------------------------------------------------------
-- The vendor drug catalogue (June 2026 release onward).
--
-- The platform catalogue used to be the free open dataset, matched between
-- snapshots on name + manufacturer + pack because it had no stable id. The
-- vendor catalogue has one — its Product ID — and far richer data: the pack as
-- data, the vendor's dosage form, whether the label says prescription only,
-- therapeutic class, the six safety verdicts, and long monographs.
--
-- The monographs are shared prose (one text per molecule with the brand name
-- pasted in), so they live once in drug_texts and drug_master points at them.
-- drug_catalog_releases records which release a database holds, which is what
-- lets a deploy import a new release exactly once.
--
-- All additive. Deployments provision with `prisma db push`; this file records
-- the same change for anyone upgrading from the migration history.
-- ---------------------------------------------------------------------------

ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "source_id" VARCHAR(40);
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "source_release" VARCHAR(20);
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "source_hash" VARCHAR(32);
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "package_type" VARCHAR(40);
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "pack_quantity" VARCHAR(40);
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "product_form" VARCHAR(60);
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "rx_required" BOOLEAN;
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "habit_forming" BOOLEAN;
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "therapeutic_class" VARCHAR(120);
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "chemical_class" VARCHAR(255);
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "action_class" VARCHAR(255);
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "product_category" VARCHAR(120);
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "category_path" VARCHAR(400);
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "storage" VARCHAR(120);
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "country_of_origin" VARCHAR(80);
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "safety_advice" JSONB;
ALTER TABLE "drug_master" ADD COLUMN IF NOT EXISTS "monograph" JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS "drug_master_source_id_key" ON "drug_master" ("source_id");

CREATE INDEX IF NOT EXISTS "drug_formulary_drug_master_id_idx" ON "drug_formulary" ("drug_master_id");

CREATE TABLE IF NOT EXISTS "drug_texts" (
  "id"         SERIAL       NOT NULL,
  "hash"       VARCHAR(32)  NOT NULL,
  "body"       TEXT         NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "drug_texts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "drug_texts_hash_key" ON "drug_texts" ("hash");

CREATE TABLE IF NOT EXISTS "drug_catalog_releases" (
  "id"             TEXT         NOT NULL,
  "release"        VARCHAR(20)  NOT NULL,
  "status"         VARCHAR(20)  NOT NULL,
  "sources"        TEXT[]       DEFAULT ARRAY[]::TEXT[],
  "products"       INTEGER      NOT NULL DEFAULT 0,
  "inserted"       INTEGER      NOT NULL DEFAULT 0,
  "updated"        INTEGER      NOT NULL DEFAULT 0,
  "discontinued"   INTEGER      NOT NULL DEFAULT 0,
  "texts"          INTEGER      NOT NULL DEFAULT 0,
  "legacy_removed" INTEGER      NOT NULL DEFAULT 0,
  "relinked"       INTEGER      NOT NULL DEFAULT 0,
  "unlinked"       INTEGER      NOT NULL DEFAULT 0,
  "report"         JSONB,
  "error"          TEXT,
  "started_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"    TIMESTAMP(3),
  CONSTRAINT "drug_catalog_releases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "drug_catalog_releases_release_key" ON "drug_catalog_releases" ("release");
