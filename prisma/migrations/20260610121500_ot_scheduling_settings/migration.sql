-- Per-tenant OT scheduling preferences (default duration, buffer, daily cap,
-- operating-day window). One row per hospital, upserted from OT Settings.

CREATE TABLE "ot_scheduling_settings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "default_duration_minutes" INTEGER NOT NULL DEFAULT 60,
    "buffer_minutes" INTEGER NOT NULL DEFAULT 30,
    "max_surgeries_per_day" INTEGER NOT NULL DEFAULT 10,
    "day_start_time" VARCHAR(5),
    "day_end_time" VARCHAR(5),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ot_scheduling_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ot_scheduling_settings_tenant_id_key" ON "ot_scheduling_settings"("tenant_id");

ALTER TABLE "ot_scheduling_settings" ADD CONSTRAINT "ot_scheduling_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
