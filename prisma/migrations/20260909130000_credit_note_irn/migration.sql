-- ---------------------------------------------------------------------------
-- A B2B credit or debit note is an e-invoice too.
--
-- Report D-1 is "every invoice sent to the portal", and under the e-invoicing
-- rules that includes the credit and debit notes raised against a registered
-- recipient — not only the original invoice. `credit_notes` had nowhere to hold
-- the portal's answer, so a register built on `bills` alone would have been
-- complete-looking and wrong: it would have shown a hospital's B2B invoices all
-- registered while the notes reversing them had never been sent.
--
-- Same shape as the columns on `bills`, for the same reasons.
-- ---------------------------------------------------------------------------

ALTER TABLE "credit_notes" ADD COLUMN IF NOT EXISTS "irn" VARCHAR(64);
ALTER TABLE "credit_notes" ADD COLUMN IF NOT EXISTS "irn_ack_no" VARCHAR(30);
ALTER TABLE "credit_notes" ADD COLUMN IF NOT EXISTS "irn_ack_date" TIMESTAMP(3);
ALTER TABLE "credit_notes" ADD COLUMN IF NOT EXISTS "irn_qr_payload" TEXT;
ALTER TABLE "credit_notes" ADD COLUMN IF NOT EXISTS "irn_status" VARCHAR(20);
ALTER TABLE "credit_notes" ADD COLUMN IF NOT EXISTS "irn_error" TEXT;
ALTER TABLE "credit_notes" ADD COLUMN IF NOT EXISTS "irn_attempted_at" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "credit_notes_irn_key" ON "credit_notes" ("irn");
CREATE INDEX IF NOT EXISTS "credit_notes_tenant_irn_status_idx"
  ON "credit_notes" ("tenant_id", "irn_status", "issue_date");
