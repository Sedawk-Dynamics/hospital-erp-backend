-- Remove the contact person field from suppliers (vendors) entirely.
ALTER TABLE "suppliers" DROP COLUMN IF EXISTS "contact_person";
