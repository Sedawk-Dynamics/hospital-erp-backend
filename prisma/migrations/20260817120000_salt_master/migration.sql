-- Salt master: the structured replacement for classifying a drug by string.
--
-- Every statement is IF NOT EXISTS. This migration is applied by `prisma db push`
-- in the deploy start command and may be re-run against a database that already
-- has the tables, so it must be a no-op the second time.

-- ── The molecule ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "salts" (
  "id"                        TEXT NOT NULL,
  "name"                      VARCHAR(255) NOT NULL,
  "norm"                      VARCHAR(255) NOT NULL,
  -- NULL means undecided, NOT over-the-counter. That distinction is the whole
  -- point: an unmapped molecule has to be visible as work, not read as safe.
  "schedule_code"             VARCHAR(10),
  "controlled_class"          VARCHAR(20),
  "narcotic_class"            VARCHAR(40),
  "vault_controlled"          BOOLEAN NOT NULL DEFAULT false,
  "exempt_if_combination"     BOOLEAN NOT NULL DEFAULT false,
  "max_per_unit_mg"           DECIMAL(10,3),
  "max_concentration_percent" DECIMAL(6,3),
  "fallback_schedule"         VARCHAR(10),
  "topical_exempt"            BOOLEAN NOT NULL DEFAULT false,
  "source"                    VARCHAR(20),
  "schedule_note"             TEXT,
  "reviewed_by_id"            TEXT,
  "reviewed_at"               TIMESTAMP(3),
  "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "salts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "salts_name_key" ON "salts" ("name");
CREATE UNIQUE INDEX IF NOT EXISTS "salts_norm_key" ON "salts" ("norm");
CREATE INDEX IF NOT EXISTS "salts_schedule_code_idx" ON "salts" ("schedule_code");
CREATE INDEX IF NOT EXISTS "salts_controlled_class_idx" ON "salts" ("controlled_class");

-- ── Alternate spellings ─────────────────────────────────────────────────────
-- `norm` is unique across the whole table, not per salt, so one spelling can
-- never resolve to two molecules.
CREATE TABLE IF NOT EXISTS "salt_synonyms" (
  "id"         TEXT NOT NULL,
  "salt_id"    TEXT NOT NULL,
  "name"       VARCHAR(255) NOT NULL,
  "norm"       VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "salt_synonyms_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "salt_synonyms_norm_key" ON "salt_synonyms" ("norm");
CREATE INDEX IF NOT EXISTS "salt_synonyms_salt_id_idx" ON "salt_synonyms" ("salt_id");

-- ── Schedule H's 6 class entries ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "therapeutic_classes" (
  "id"            TEXT NOT NULL,
  "name"          VARCHAR(255) NOT NULL,
  "schedule_code" VARCHAR(10) NOT NULL,
  "pattern"       TEXT,
  "notes"         TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "therapeutic_classes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "therapeutic_classes_name_key" ON "therapeutic_classes" ("name");

CREATE TABLE IF NOT EXISTS "salt_therapeutic_classes" (
  "salt_id"      TEXT NOT NULL,
  "class_id"     TEXT NOT NULL,
  "is_confirmed" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "salt_therapeutic_classes_pkey" PRIMARY KEY ("salt_id", "class_id")
);

CREATE INDEX IF NOT EXISTS "salt_therapeutic_classes_class_id_idx"
  ON "salt_therapeutic_classes" ("class_id");

-- ── The composition, as data ────────────────────────────────────────────────
-- Strength is a number and a unit in separate columns. Held as text it was
-- destroyed by a lossy round-trip through the composition column, and "500mg"
-- against "500ml" could drift silently.
CREATE TABLE IF NOT EXISTS "drug_salts" (
  "id"               TEXT NOT NULL,
  "drug_master_id"   TEXT NOT NULL,
  "salt_id"          TEXT NOT NULL,
  "strength_value"   DECIMAL(12,4),
  "strength_unit"    VARCHAR(10),
  "per_volume_value" DECIMAL(12,4),
  "per_volume_unit"  VARCHAR(10),
  "position"         INTEGER NOT NULL DEFAULT 0,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "drug_salts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "drug_salts_drug_master_id_salt_id_key"
  ON "drug_salts" ("drug_master_id", "salt_id");
CREATE INDEX IF NOT EXISTS "drug_salts_salt_id_idx" ON "drug_salts" ("salt_id");

-- ── Foreign keys ────────────────────────────────────────────────────────────
-- Added separately and guarded, because ADD CONSTRAINT has no IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salt_synonyms_salt_id_fkey') THEN
    ALTER TABLE "salt_synonyms" ADD CONSTRAINT "salt_synonyms_salt_id_fkey"
      FOREIGN KEY ("salt_id") REFERENCES "salts" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salt_therapeutic_classes_salt_id_fkey') THEN
    ALTER TABLE "salt_therapeutic_classes" ADD CONSTRAINT "salt_therapeutic_classes_salt_id_fkey"
      FOREIGN KEY ("salt_id") REFERENCES "salts" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salt_therapeutic_classes_class_id_fkey') THEN
    ALTER TABLE "salt_therapeutic_classes" ADD CONSTRAINT "salt_therapeutic_classes_class_id_fkey"
      FOREIGN KEY ("class_id") REFERENCES "therapeutic_classes" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drug_salts_drug_master_id_fkey') THEN
    ALTER TABLE "drug_salts" ADD CONSTRAINT "drug_salts_drug_master_id_fkey"
      FOREIGN KEY ("drug_master_id") REFERENCES "drug_master" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drug_salts_salt_id_fkey') THEN
    ALTER TABLE "drug_salts" ADD CONSTRAINT "drug_salts_salt_id_fkey"
      FOREIGN KEY ("salt_id") REFERENCES "salts" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
