-- Remove NPPA / DPCO ceiling-price control from the pharmacy domain.
-- The official ceiling overlay (NppaCeilingPrice + DrugMaster scheduled flags)
-- and the dispense price-override audit field are dropped entirely.

-- DrugMaster: drop the platform-wide NPPA reference columns + index.
DROP INDEX IF EXISTS "drug_master_is_scheduled_idx";

ALTER TABLE "drug_master"
  DROP COLUMN IF EXISTS "is_scheduled",
  DROP COLUMN IF EXISTS "ceiling_price",
  DROP COLUMN IF EXISTS "ceiling_unit",
  DROP COLUMN IF EXISTS "nppa_notification",
  DROP COLUMN IF EXISTS "ceiling_effective_date";

-- DispensingRecord: drop the ceiling-override justification column.
ALTER TABLE "dispensing_records"
  DROP COLUMN IF EXISTS "price_override_reason";

-- Official ceiling-price reference table is no longer used.
DROP TABLE IF EXISTS "nppa_ceiling_prices";
