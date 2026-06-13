-- Per-intake dose multiplier on prescription items.
-- Combined with frequency (M-A-N) + duration to derive the dispense quantity:
--   quantity = ceil(sum(M-A-N) * days * dose_quantity)
-- e.g. 1-1-1 for 3 days with dose 2 = 18. Defaults to 1 (single unit per intake).
ALTER TABLE "prescription_items"
  ADD COLUMN IF NOT EXISTS "dose_quantity" DECIMAL(6, 2) DEFAULT 1;
