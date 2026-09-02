-- The document a reversal is supposed to produce.
--
-- Eighteen places in this codebase move money back to a patient or a payer —
-- refunds, cancellations, counter returns, ward returns, post-supply discounts,
-- payment reversals, claim rejections — and exactly ONE of them reverses the
-- tax that moved with it. The ward return in indents.service does; nothing else
-- does.
--
-- The consequence is not academic. Output tax stays declared on a supply that
-- has been undone, so the hospital keeps owing the department money on a sale
-- it reversed. A voided pharmacy sale is the sharpest case: it DELETES its bill
-- lines outright while leaving the header's tax figure untouched, so the bill
-- claims tax on lines that no longer exist and can never be reconstructed.
--
-- A credit note is not a recalculation. It MIRRORS the lines it reverses —
-- their codes, their rates, their CGST/SGST split — scaled by how much came
-- back, and negated. Recomputing from today's masters would produce a credit
-- that does not equal its debit whenever a rate has moved in between, and that
-- residue would sit on the books with nothing to explain it. This is the shape
-- the ward return already uses, standardised.
--
-- credit_note_items.bill_item_id is what makes a PARTIAL credit traceable to
-- the exact line it came off. Today a partial refund is an arbitrary rupee
-- amount with no link to any line at all, which is why its tax cannot be
-- worked out.
--
-- within_time_limit records whether the note can still reduce tax liability. A
-- note raised after 30 November following the year end cannot: the money still
-- goes back to the patient, but the tax is no longer recoverable, and that is a
-- fact the accountant has to be able to see rather than discover.
--
-- Creates two new tables and touches no existing row: safe to replay.

CREATE TABLE IF NOT EXISTS "credit_notes" (
    "id"                          TEXT NOT NULL,
    "tenant_id"                   TEXT NOT NULL,
    "credit_note_number"          VARCHAR(50) NOT NULL,
    "bill_id"                     TEXT NOT NULL,
    "patient_id"                  TEXT,
    "issue_date"                  TIMESTAMP(3) NOT NULL,
    "financial_year"              VARCHAR(7),
    "reason"                      VARCHAR(40) NOT NULL,
    "reason_note"                 TEXT,
    "refund_id"                   TEXT,
    "drug_return_id"              TEXT,
    "taxable_value"               DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cgst_amount"                 DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst_amount"                 DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst_amount"                 DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cess_amount"                 DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_amount"                  DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_amount"                DECIMAL(12,2) NOT NULL DEFAULT 0,
    "supplier_gstin"              VARCHAR(15),
    "place_of_supply_state_code"  VARCHAR(2),
    "recipient_gstin"             VARCHAR(15),
    "within_time_limit"           BOOLEAN NOT NULL DEFAULT true,
    "issued_by"                   TEXT,
    "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "credit_note_items" (
    "id"             TEXT NOT NULL,
    "credit_note_id" TEXT NOT NULL,
    "bill_item_id"   TEXT,
    "description"    VARCHAR(500) NOT NULL,
    "hsn_sac_code"   VARCHAR(20),
    "gst_treatment"  VARCHAR(20),
    "quantity"       DECIMAL(12,2) NOT NULL DEFAULT 0,
    "unit_price"     DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxable_value"  DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_percent"    DECIMAL(5,2) NOT NULL DEFAULT 0,
    "tax_amount"     DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cgst_amount"    DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst_amount"    DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst_amount"    DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cess_amount"    DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_amount"   DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_items_pkey" PRIMARY KEY ("id")
);

-- A number belongs to one note, like an invoice number to one invoice.
CREATE UNIQUE INDEX IF NOT EXISTS "credit_notes_credit_note_number_key"
  ON "credit_notes" ("credit_note_number");
-- The registers read by period and by document.
CREATE INDEX IF NOT EXISTS "credit_notes_tenant_id_issue_date_idx"
  ON "credit_notes" ("tenant_id", "issue_date");
CREATE INDEX IF NOT EXISTS "credit_notes_bill_id_idx" ON "credit_notes" ("bill_id");
CREATE INDEX IF NOT EXISTS "credit_note_items_credit_note_id_idx"
  ON "credit_note_items" ("credit_note_id");

DO $$ BEGIN
  ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_bill_id_fkey"
    FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_issued_by_fkey"
    FOREIGN KEY ("issued_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_credit_note_id_fkey"
    FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_bill_item_id_fkey"
    FOREIGN KEY ("bill_item_id") REFERENCES "bill_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
