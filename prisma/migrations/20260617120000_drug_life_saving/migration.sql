-- IP credit-clearance: vital/life-saving drugs bypass the cash-patient deposit gate.
ALTER TABLE "drug_formulary"
  ADD COLUMN IF NOT EXISTS "is_life_saving" BOOLEAN NOT NULL DEFAULT false;
