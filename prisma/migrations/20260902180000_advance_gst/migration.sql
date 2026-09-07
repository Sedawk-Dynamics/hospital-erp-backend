-- Record the GST position of an advance at the moment it is taken.
--
-- Tax normally attaches to the invoice and not to the tender. Cash, card, UPI
-- and a split across three of them all carry identical tax, because the tax is
-- on the supply. An advance is the one real exception: for a service the time
-- of supply is the EARLIER of invoice or payment, so money taken before the
-- supply fixes the liability at receipt, and Rule 50 requires a receipt voucher
-- stating the rate and the tax charged.
--
-- Today an advance records none of that. createAdvancePayment writes a Payment
-- and a Receipt against the ADV- holding account and never touches the tax
-- engine, and the receipt handed to the patient positively prints a subtotal
-- and tax of zero — a statement the system has not established and, with no
-- supply recorded against the advance, could not establish.
--
-- For a hospital the answer is very often exempt: a deposit is against
-- treatment and treatment is exempt under Notification 12/2017. That is the
-- default this stores. But "usually exempt" has to be RECORDED rather than
-- assumed, for two reasons. It is the figure an advances report and GSTR-1
-- table 11 read. And it is not always true — an advance taken specifically
-- against a taxable supply, a deluxe room above the threshold or a cosmetic
-- procedure, does attract tax at receipt.
--
-- Deliberately NOT implementing the Rule 50 proviso that taxes an advance at
-- 18% where the rate is not determinable, and treats it as inter-State where
-- the nature of supply is not determinable. For a hospital both ARE
-- determinable — the supply is treatment and the patient is in front of you —
-- so applying the proviso here would invent 18% tax on an exempt deposit. The
-- proviso is for genuinely unknown supplies, which a hospital deposit is not.
--
-- source_advance_payment_id links an adjustment back to the advance receipt it
-- draws down. Today that linkage exists only as the free-text note "Adjusted
-- from advance", so GSTR-1 table 11B — adjustment of advances against invoices
-- — has no data source at all.
--
-- Every column is nullable. A payment settling an already-issued invoice leaves
-- all of them null, which is correct: its tax is on the invoice. Existing rows
-- are untouched and this is safe to replay.

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "gst_treatment"              VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "tax_rate_percent"           DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "taxable_value"              DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "tax_amount"                 DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "cgst_amount"                DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "sgst_amount"                DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "igst_amount"                DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "voucher_type"               VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "voucher_number"             VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "source_advance_payment_id"  TEXT;

-- A voucher number belongs to one voucher, like an invoice number to one
-- invoice. Lands on a brand-new all-NULL column, and Postgres treats NULLs as
-- distinct, so it cannot collide on existing rows.
CREATE UNIQUE INDEX IF NOT EXISTS "payments_voucher_number_key"
  ON "payments" ("voucher_number");

CREATE INDEX IF NOT EXISTS "payments_source_advance_payment_id_idx"
  ON "payments" ("source_advance_payment_id");

DO $$ BEGIN
  ALTER TABLE "payments"
    ADD CONSTRAINT "payments_source_advance_payment_id_fkey"
    FOREIGN KEY ("source_advance_payment_id") REFERENCES "payments"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
