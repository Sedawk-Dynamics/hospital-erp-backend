-- Allow a purchase-order line to reference a pharmacy drug instead of an inventory item.
ALTER TABLE "purchase_order_items" ALTER COLUMN "inventory_item_id" DROP NOT NULL;
ALTER TABLE "purchase_order_items" ADD COLUMN "drug_id" TEXT;
ALTER TABLE "purchase_order_items"
  ADD CONSTRAINT "purchase_order_items_drug_id_fkey"
  FOREIGN KEY ("drug_id") REFERENCES "drug_formulary"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
