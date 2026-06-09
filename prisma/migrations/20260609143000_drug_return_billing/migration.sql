-- Link patient drug returns to the originating sale + a refund, so a return is
-- bounded by what was dispensed and produces a real money refund on approval.
ALTER TABLE "drug_returns"
  ADD COLUMN "dispensing_record_id" TEXT,
  ADD COLUMN "bill_id" TEXT,
  ADD COLUMN "sale_unit" VARCHAR(10),
  ADD COLUMN "unit_price" DECIMAL(12, 2),
  ADD COLUMN "refund_amount" DECIMAL(12, 2),
  ADD COLUMN "refund_id" TEXT;

ALTER TABLE "drug_returns"
  ADD CONSTRAINT "drug_returns_refund_id_key" UNIQUE ("refund_id");

ALTER TABLE "drug_returns"
  ADD CONSTRAINT "drug_returns_dispensing_record_id_fkey"
    FOREIGN KEY ("dispensing_record_id") REFERENCES "dispensing_records"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "drug_returns_bill_id_fkey"
    FOREIGN KEY ("bill_id") REFERENCES "bills"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "drug_returns_refund_id_fkey"
    FOREIGN KEY ("refund_id") REFERENCES "refunds"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
