-- G5: supplier credit-note fields on vendor returns (expired/damaged stock sent
-- back to the distributor). On approval a vendor return now reduces stock and
-- records the supplier's credit note number + credited value.
ALTER TABLE "drug_returns"
  ADD COLUMN IF NOT EXISTS "credit_note_number" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "credit_amount" DECIMAL(12,2);
