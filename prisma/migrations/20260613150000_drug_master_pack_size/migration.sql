-- Numeric pack size on the platform drug catalog (base units per pack/strip).
-- Copied into DrugFormulary.packSize on import so a strip sells as loose units.
-- Null = indivisible container (bottle/vial/tube). Backfilled by db:seed:pack-sizes.
ALTER TABLE "drug_master"
  ADD COLUMN IF NOT EXISTS "pack_size" INTEGER;
