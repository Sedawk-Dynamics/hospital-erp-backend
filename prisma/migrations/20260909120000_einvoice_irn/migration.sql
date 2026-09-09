-- ---------------------------------------------------------------------------
-- E-invoice: what the government portal gave back, and what it refused.
--
-- Section 8 lists `irn`, `ack_no` and `qr_payload` among the columns `bills`
-- must gain; section 11.5's Group D reports read nothing else. Without them
-- there is nowhere to put the portal's answer, so D-1 and D-2 could not exist
-- and section 10's invoice layout could never print the IRN and signed QR it
-- calls for "once e-invoicing applies".
--
-- Every column is NULLABLE and nothing writes them yet. A hospital below the
-- threshold — or above it but not yet connected to a provider — is unaffected:
-- the registers say so in words rather than showing an empty table that reads
-- as "nothing failed".
--
-- The status is deliberately its OWN column rather than being inferred from
-- whether `irn` is null. "Never sent" and "sent and rejected" are different
-- facts and D-2 exists precisely to separate them; a null IRN cannot tell them
-- apart, and an invoice the portal rejected has a deadline attached to it.
-- ---------------------------------------------------------------------------

ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "irn" VARCHAR(64);
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "irn_ack_no" VARCHAR(30);
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "irn_ack_date" TIMESTAMP(3);
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "irn_qr_payload" TEXT;
-- 'pending' | 'registered' | 'failed' | 'cancelled'. Null = never sent.
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "irn_status" VARCHAR(20);
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "irn_error" TEXT;
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "irn_attempted_at" TIMESTAMP(3);
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "irn_cancelled_at" TIMESTAMP(3);

-- An IRN is the portal's own hash of the invoice. Two bills carrying the same
-- one means something was registered twice, which is the error the portal
-- itself refuses — so the database refuses it too.
CREATE UNIQUE INDEX IF NOT EXISTS "bills_irn_key" ON "bills" ("irn");

-- D-2 asks "which invoices were not accepted, and why" and is read by period.
CREATE INDEX IF NOT EXISTS "bills_tenant_irn_status_idx"
  ON "bills" ("tenant_id", "irn_status", "bill_date");

-- ---------------------------------------------------------------------------
-- D-3 — the e-way bill register.
--
-- Almost nothing a hospital does moves goods on a public road: a ward transfer
-- and a pharmacy issue both stay inside the building. The one movement that
-- does is stock going BACK to a supplier, which is why the number is recorded
-- against the vendor return rather than anywhere else.
--
-- Without these two columns D-3 would be a report that can never be completed
-- — it could list the movements that need a bill and never the bill.
-- ---------------------------------------------------------------------------

ALTER TABLE "drug_returns" ADD COLUMN IF NOT EXISTS "eway_bill_number" VARCHAR(20);
ALTER TABLE "drug_returns" ADD COLUMN IF NOT EXISTS "eway_bill_date" TIMESTAMP(3);
