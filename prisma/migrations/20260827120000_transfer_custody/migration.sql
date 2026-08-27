-- Controlled-drug custody on a stock transfer.
--
-- The transfer board had no controlled-drug handling at all, so merging the
-- NDPS challan screen into it would have let a vault narcotic move between
-- departments with one person and no trace. These columns carry the hand-over:
-- who took custody, and when.
--
-- Idempotent: applied by `prisma db push` on deploy and may be re-run.
ALTER TABLE "stock_transfers"
  ADD COLUMN IF NOT EXISTS "custodian_id" TEXT;

ALTER TABLE "stock_transfers"
  ADD COLUMN IF NOT EXISTS "custody_at" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_transfers_custodian_id_fkey') THEN
    ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_custodian_id_fkey"
      FOREIGN KEY ("custodian_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
