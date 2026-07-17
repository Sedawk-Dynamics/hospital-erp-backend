-- Recall is batch-level only: a recall names a specific batch, never a whole
-- medicine. The old drug-wide recall (recallDrug) already cascaded is_recalled
-- onto every batch of the drug, so dropping this flag loses nothing — those
-- recalls survive on drug_batches.is_recalled, which every stock, FEFO and
-- dispensing path already enforces.
ALTER TABLE "drug_formulary" DROP COLUMN IF EXISTS "is_recalled";
