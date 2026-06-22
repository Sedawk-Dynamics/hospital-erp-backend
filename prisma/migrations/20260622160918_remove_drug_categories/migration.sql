-- Remove Drug Categories entirely.
ALTER TABLE "drug_formulary" DROP CONSTRAINT IF EXISTS "drug_formulary_category_id_fkey";
ALTER TABLE "drug_formulary" DROP COLUMN IF EXISTS "category_id";
DROP TABLE IF EXISTS "drug_categories";
