-- G2 purchase-side discount structure: capture MRP, purchase discount %, GST %
-- and free quantity distinctly on each received drug batch so the GRN/inward
-- form can show invoice price, discount, net purchase price and landing cost
-- as separate fields. purchase_price stays the per-unit purchase RATE.
ALTER TABLE "drug_batches"
  ADD COLUMN IF NOT EXISTS "mrp" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "purchase_discount_percent" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "gst_percent" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "free_quantity" INTEGER NOT NULL DEFAULT 0;
