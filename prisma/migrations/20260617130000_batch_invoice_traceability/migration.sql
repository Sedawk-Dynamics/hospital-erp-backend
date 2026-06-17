-- GRN invoice traceability on batches (design-doc manual GRN Steps 1/8/9).
ALTER TABLE "drug_batches"
  ADD COLUMN IF NOT EXISTS "invoice_number" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "invoice_date" DATE;
