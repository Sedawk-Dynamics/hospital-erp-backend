-- G9: per-drug reorder level so low-stock formulary items surface for a draft PO.
ALTER TABLE "drug_formulary" ADD COLUMN IF NOT EXISTS "min_stock" INTEGER;
