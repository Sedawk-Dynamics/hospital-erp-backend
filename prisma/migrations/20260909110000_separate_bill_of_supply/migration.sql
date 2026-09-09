-- The second document a GST-registered recipient is owed.
--
-- Section 6.7's document table, row 4: "Both [taxable and exempt lines], and
-- the patient IS GST-registered — Two documents: a Tax Invoice and a Bill of
-- Supply." Rule 46A allows the combined Invoice-cum-Bill of Supply only for an
-- UNREGISTERED recipient, which is why the normal hospital bill is one document
-- and a corporate or insurer's is not.
--
-- `resolveDocumentType` has returned `requiresSeparateBillOfSupply` since it
-- was written and nothing acted on it — `issueDocumentForBill` logged a warning
-- and issued one document anyway. So a mixed bill to a registered payer went
-- out as a Tax Invoice covering exempt lines it is not allowed to cover.
--
-- One bill, two numbers, rather than two bills. The bill is one commercial
-- event: the same patient, the same stay, one balance to settle. Splitting it
-- would double every payment, every credit note and every report row that keys
-- on a bill. The taxable lines are reported under the invoice number and the
-- exempt ones under this, which is what the two documents actually say.
--
-- Unique GLOBALLY, like `invoice_number` beside it, and drawn from the same
-- per-hospital `bill_of_supply` series — so the hospital-qualified prefix keeps
-- two hospitals from colliding here too.

ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "bill_of_supply_number" VARCHAR(50);

CREATE UNIQUE INDEX IF NOT EXISTS "bills_bill_of_supply_number_key"
  ON "bills" ("bill_of_supply_number");
