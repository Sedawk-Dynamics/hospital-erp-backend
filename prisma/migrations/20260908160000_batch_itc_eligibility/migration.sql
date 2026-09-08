-- Whether the input credit on a purchase can actually be claimed.
--
-- Section 4.8 lists it as captured-or-not: "Whether the credit is eligible,
-- blocked or partly eligible — Not captured — Feeds the Rule 42 working." It
-- was not captured, and that single absence is why report B-2 could only ever
-- show gross credit. The Changes document (#10) asks for the ladder the
-- accountant actually needs:
--
--     Gross ITC -> Ineligible ITC -> Reversals -> Eligible ITC -> ITC claimed
--
-- Every rung but "Ineligible" was already derivable. This is the missing one.
--
-- Section 17(5) blocks credit outright on specific supplies, and a hospital's
-- commonest case is the one the room-rent notification creates: 5% on non-ICU
-- rent above Rs 5,000 comes explicitly WITHOUT input tax credit. So a purchase
-- consumed by that supply is blocked, and somebody has to be able to say so.
--
-- Defaults to 'eligible' with no reason: every batch already in the database
-- keeps behaving exactly as it does today, and the ladder simply reports zero
-- ineligible until a hospital starts marking them.

ALTER TABLE "drug_batches"
  ADD COLUMN IF NOT EXISTS "itc_eligibility" VARCHAR(12) NOT NULL DEFAULT 'eligible';

ALTER TABLE "drug_batches"
  ADD COLUMN IF NOT EXISTS "itc_blocked_reason" VARCHAR(255);

-- The head-wise split of what was actually paid on the supplier's invoice.
-- Derivable today from the rate and the taxable value, but only under the
-- assumption that the purchase was intra-state — which stops being true the
-- moment a hospital buys from another state. Stored so the register reports what
-- the invoice said rather than what we would have guessed.
ALTER TABLE "drug_batches" ADD COLUMN IF NOT EXISTS "input_cgst" DECIMAL(12,2);
ALTER TABLE "drug_batches" ADD COLUMN IF NOT EXISTS "input_sgst" DECIMAL(12,2);
ALTER TABLE "drug_batches" ADD COLUMN IF NOT EXISTS "input_igst" DECIMAL(12,2);

CREATE INDEX IF NOT EXISTS "drug_batches_itc_eligibility_idx"
  ON "drug_batches" ("tenant_id", "itc_eligibility");
