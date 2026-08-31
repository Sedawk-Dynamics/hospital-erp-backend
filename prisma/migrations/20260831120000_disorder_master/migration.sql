-- The list of disorders a patient or clinician picks from when recording
-- "existing disorders".
--
-- That field was free text on both the portal and the clinician panel, so the
-- same condition arrived as "sugar", "diabetes" and "DM" and nothing
-- downstream could count or match them.
--
-- Deliberately NOT the ICD table. `icd_codes` is the WHO classification, all
-- 12,325 rows of it, and 5,135 of those are injuries, external causes,
-- pregnancy states and "factors influencing health status" — none of which is
-- a disorder someone lives with. This is the shorter list a super admin owns:
-- seeded from the disease chapters (A-N, Q) and then theirs to add to or prune,
-- without touching the classification underneath.
--
-- `tenant_id` NULL is the platform list every hospital sees, matching
-- `icd_codes`. `icd_code` is kept where the disorder came from one, so a picked
-- disorder is still coded; a hand-added one may have none.
--
-- IF NOT EXISTS throughout: the table is created by `prisma db push` on deploy,
-- so this file is the written record and must be safe to replay.

CREATE TABLE IF NOT EXISTS "disorders" (
    "id"            TEXT NOT NULL,
    "tenant_id"     TEXT,
    "name"          VARCHAR(500) NOT NULL,
    "icd_code"      VARCHAR(20),
    "category"      VARCHAR(255),
    "search_tokens" TEXT,
    "keywords"      TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_custom"     BOOLEAN NOT NULL DEFAULT false,
    "is_active"     BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disorders_pkey" PRIMARY KEY ("id")
);

-- One row per name per list. A hospital may hold its own disorder with the same
-- name as a platform one; within a list a name appears once.
CREATE UNIQUE INDEX IF NOT EXISTS "disorders_tenant_id_name_key"
    ON "disorders" ("tenant_id", "name");

CREATE INDEX IF NOT EXISTS "disorders_icd_code_idx" ON "disorders" ("icd_code");

DO $$
BEGIN
    ALTER TABLE "disorders"
        ADD CONSTRAINT "disorders_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
