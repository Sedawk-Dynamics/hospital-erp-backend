-- Drug schedule reference (Drugs & Cosmetics Rules 1945 + NDPS Act).
-- Platform reference data, no tenant scoping. Purely additive: a new table only,
-- nothing existing is altered, so applying this changes no current behaviour.
-- Hand-written with IF NOT EXISTS so it is safe to re-apply on a database that
-- already received the change via `prisma db push`.

CREATE TABLE IF NOT EXISTS "drug_schedule_rules" (
    "id"                         TEXT NOT NULL,
    "schedule_code"              VARCHAR(10) NOT NULL,
    "match_type"                 VARCHAR(20) NOT NULL,
    "match_value"                VARCHAR(255) NOT NULL,
    "match_norm"                 VARCHAR(255) NOT NULL,
    "aliases"                    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "pattern"                    TEXT,
    "controlled_class"           VARCHAR(20),
    "is_narcotic"                BOOLEAN NOT NULL DEFAULT false,
    "narcotic_class"             VARCHAR(40),
    "vault_controlled"           BOOLEAN NOT NULL DEFAULT false,
    "exempt_if_combination"      BOOLEAN NOT NULL DEFAULT false,
    "max_per_unit_mg"            DECIMAL(10,3),
    "max_concentration_percent"  DECIMAL(6,3),
    "fallback_schedule"          VARCHAR(10),
    "topical_exempt"             BOOLEAN NOT NULL DEFAULT false,
    "notes"                      TEXT,
    "is_active"                  BOOLEAN NOT NULL DEFAULT true,
    "created_at"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drug_schedule_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "drug_schedule_rules_schedule_code_match_type_match_norm_key"
    ON "drug_schedule_rules" ("schedule_code", "match_type", "match_norm");

CREATE INDEX IF NOT EXISTS "drug_schedule_rules_match_norm_idx"
    ON "drug_schedule_rules" ("match_norm");

CREATE INDEX IF NOT EXISTS "drug_schedule_rules_match_type_is_active_idx"
    ON "drug_schedule_rules" ("match_type", "is_active");
