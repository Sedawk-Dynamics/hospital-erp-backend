-- Pharmacy counter billing + loose/pack sale + GST + walk-in (nullable Rx).
-- Already applied to the dev DB via `prisma db push`; this file records the
-- change for fresh setups / `migrate deploy`, matching the repo convention.

-- DispensingRecord: allow walk-in / OTC sales (no prescription) ...
ALTER TABLE "dispensing_records" ALTER COLUMN "prescription_id" DROP NOT NULL;
ALTER TABLE "dispensing_records" ALTER COLUMN "prescription_item_id" DROP NOT NULL;

-- ... and capture the sale economics on each dispensed line.
ALTER TABLE "dispensing_records" ADD COLUMN "sale_unit" VARCHAR(10) DEFAULT 'pack';
ALTER TABLE "dispensing_records" ADD COLUMN "unit_price" DECIMAL(12,2);
ALTER TABLE "dispensing_records" ADD COLUMN "discount_percent" DECIMAL(5,2) DEFAULT 0;
ALTER TABLE "dispensing_records" ADD COLUMN "tax_percent" DECIMAL(5,2) DEFAULT 0;
ALTER TABLE "dispensing_records" ADD COLUMN "line_total" DECIMAL(12,2);
ALTER TABLE "dispensing_records" ADD COLUMN "bill_id" TEXT;

-- DrugFormulary: loose / sub-unit sale (pack size) + per-drug GST.
ALTER TABLE "drug_formulary" ADD COLUMN "pack_size" INTEGER;
ALTER TABLE "drug_formulary" ADD COLUMN "loose_unit_label" VARCHAR(40);
ALTER TABLE "drug_formulary" ADD COLUMN "tax_percent" DECIMAL(5,2);
