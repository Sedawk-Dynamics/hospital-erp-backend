-- ---------------------------------------------------------------------------
-- Retail products: things a pharmacy sells that are not medicines.
--
-- Skin care, baby care, nutrition, devices. They are stocked and sold exactly
-- like a medicine (a formulary row with batches, billed at the counter), so
-- they get a category of their own rather than a table of their own, plus the
-- shelf they sit on.
--
-- All additive. Deployments provision with `prisma db push`; this file records
-- the same change for anyone upgrading from the migration history.
-- ---------------------------------------------------------------------------

ALTER TYPE "InventoryCategory" ADD VALUE IF NOT EXISTS 'product';

ALTER TABLE "drug_formulary" ADD COLUMN IF NOT EXISTS "product_category" VARCHAR(120);
