-- CreateTable: per-tenant inventory module configuration (singleton per tenant)
CREATE TABLE IF NOT EXISTS "inventory_settings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "default_low_stock_threshold" INTEGER NOT NULL DEFAULT 10,
    "expiry_alert_months" INTEGER NOT NULL DEFAULT 3,
    "low_stock_alert_enabled" BOOLEAN NOT NULL DEFAULT true,
    "expiry_alert_enabled" BOOLEAN NOT NULL DEFAULT true,
    "auto_flag_expired" BOOLEAN NOT NULL DEFAULT false,
    "prevent_expired_use" BOOLEAN NOT NULL DEFAULT true,
    "reorder_notify_enabled" BOOLEAN NOT NULL DEFAULT true,
    "alert_recipient_roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_alert_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_settings_tenant_id_key" ON "inventory_settings"("tenant_id");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'inventory_settings_tenant_id_fkey'
    ) THEN
        ALTER TABLE "inventory_settings"
            ADD CONSTRAINT "inventory_settings_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
