-- Controlled-drug witness co-sign on a dispensed line.
--
-- Purely additive: two nullable columns. Existing rows stay valid untouched,
-- and nothing requires a witness until a hospital sets
-- themeConfig.controlledDrugs.mode = 'inline'.

ALTER TABLE "dispensing_records"
    ADD COLUMN IF NOT EXISTS "witnessed_by_id" TEXT,
    ADD COLUMN IF NOT EXISTS "witnessed_at"    TIMESTAMP(3);

DO $$ BEGIN
    ALTER TABLE "dispensing_records"
        ADD CONSTRAINT "dispensing_records_witnessed_by_id_fkey"
        FOREIGN KEY ("witnessed_by_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
