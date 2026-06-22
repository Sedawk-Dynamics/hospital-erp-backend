-- CreateTable
CREATE TABLE "margin_discount_config" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" VARCHAR(20) NOT NULL DEFAULT 'cap',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "margin_discount_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "margin_discount_rules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "min_margin_percent" DECIMAL(6,2) NOT NULL,
    "max_margin_percent" DECIMAL(6,2),
    "max_discount_percent" DECIMAL(5,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "margin_discount_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "margin_discount_config_tenant_id_key" ON "margin_discount_config"("tenant_id");

-- CreateIndex
CREATE INDEX "margin_discount_rules_tenant_id_is_active_idx" ON "margin_discount_rules"("tenant_id", "is_active");
