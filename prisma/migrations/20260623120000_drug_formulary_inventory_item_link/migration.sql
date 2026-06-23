-- Additive unification: optionally map a pharmacy drug (drug_formulary) to the
-- generic inventory item (inventory_items) that represents the same product, so
-- the combined Inventory page can treat both stock systems as one and de-duplicate
-- SKU counts. Nullable + ON DELETE SET NULL — non-destructive, default unmapped.
ALTER TABLE "drug_formulary" ADD COLUMN "inventory_item_id" TEXT;

ALTER TABLE "drug_formulary"
  ADD CONSTRAINT "drug_formulary_inventory_item_id_fkey"
  FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "drug_formulary_inventory_item_id_idx" ON "drug_formulary"("inventory_item_id");
