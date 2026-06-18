-- G9 — draft Purchase Orders for drugs (2026-06-18).
-- Generated from the reorder list when a drug is at/below its minimum stock.
-- Separate from the inventory-consumable PurchaseOrder (whose items link to
-- InventoryItem); these items link to drug_formulary.

-- CreateEnum
CREATE TYPE "DrugPurchaseOrderStatus" AS ENUM ('draft', 'sent', 'received', 'cancelled');

-- CreateTable
CREATE TABLE "drug_purchase_orders" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "supplier_id" TEXT,
    "order_number" VARCHAR(50) NOT NULL,
    "status" "DrugPurchaseOrderStatus" NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drug_purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drug_purchase_order_items" (
    "id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "drug_id" TEXT NOT NULL,
    "quantity_ordered" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drug_purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drug_purchase_orders_order_number_key" ON "drug_purchase_orders"("order_number");

-- CreateIndex
CREATE INDEX "drug_purchase_orders_tenant_id_status_idx" ON "drug_purchase_orders"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "drug_purchase_orders" ADD CONSTRAINT "drug_purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_purchase_order_items" ADD CONSTRAINT "drug_purchase_order_items_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "drug_purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_purchase_order_items" ADD CONSTRAINT "drug_purchase_order_items_drug_id_fkey" FOREIGN KEY ("drug_id") REFERENCES "drug_formulary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
