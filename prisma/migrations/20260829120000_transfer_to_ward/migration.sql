-- Where a drug transfer lands.
--
-- Departments do not hold drug stock; wards do. A drug issued through the
-- transfer board was decremented from the pharmacy batch and credited nowhere,
-- so it left the pharmacy and was tracked nowhere at all. Naming the ward is
-- what lets `receive` put it on the ward's shelf.
--
-- Idempotent: applied by `prisma db push` on deploy and may be re-run.
ALTER TABLE "stock_transfers"
  ADD COLUMN IF NOT EXISTS "to_ward_id" TEXT;

CREATE INDEX IF NOT EXISTS "stock_transfers_to_ward_id_idx"
  ON "stock_transfers" ("to_ward_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_transfers_to_ward_id_fkey') THEN
    ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_ward_id_fkey"
      FOREIGN KEY ("to_ward_id") REFERENCES "wards" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
