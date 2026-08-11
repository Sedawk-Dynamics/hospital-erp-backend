-- End-of-day cash reconciliation for one cashier's drawer.
--
-- Payments at this counter are marked by hand, so the drawer is the only place
-- the system meets physical reality. Only CASH is reconciled here: card, UPI and
-- bank transfers settle to the bank and never sit in a till.
--
-- Written by hand with IF NOT EXISTS throughout so it is safe to run against a
-- database that `prisma db push` has already brought into sync.

CREATE TABLE IF NOT EXISTS "cash_drawer_closures" (
    "id"             TEXT NOT NULL,
    "tenant_id"      TEXT NOT NULL,
    -- The IST calendar day being closed, not a timestamp.
    "business_date"  DATE NOT NULL,
    -- Whose drawer. Payments carry processed_by, so the expected figure is
    -- derived per cashier rather than guessed for the counter as a whole.
    "cashier_id"     TEXT NOT NULL,
    "opening_float"  DECIMAL(12,2) NOT NULL DEFAULT 0,
    -- System figure: opening float + cash collected - cash refunded.
    "expected_cash"  DECIMAL(12,2) NOT NULL DEFAULT 0,
    "counted_cash"   DECIMAL(12,2) NOT NULL DEFAULT 0,
    -- counted - expected. Negative is short, positive is over.
    "variance"       DECIMAL(12,2) NOT NULL DEFAULT 0,
    -- Note count per denomination, e.g. {"500": 12, "200": 3}.
    "denominations"  JSONB,
    "notes"          TEXT,
    "closed_by"      TEXT NOT NULL,
    "closed_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_drawer_closures_pkey" PRIMARY KEY ("id")
);

-- One closure per cashier per business day: closing twice would either
-- double-count the float or quietly overwrite the first variance.
CREATE UNIQUE INDEX IF NOT EXISTS "cash_drawer_closures_tenant_date_cashier_key"
    ON "cash_drawer_closures" ("tenant_id", "business_date", "cashier_id");

CREATE INDEX IF NOT EXISTS "cash_drawer_closures_tenant_date_idx"
    ON "cash_drawer_closures" ("tenant_id", "business_date");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'cash_drawer_closures_tenant_id_fkey'
    ) THEN
        ALTER TABLE "cash_drawer_closures"
            ADD CONSTRAINT "cash_drawer_closures_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'cash_drawer_closures_cashier_id_fkey'
    ) THEN
        ALTER TABLE "cash_drawer_closures"
            ADD CONSTRAINT "cash_drawer_closures_cashier_id_fkey"
            FOREIGN KEY ("cashier_id") REFERENCES "users"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'cash_drawer_closures_closed_by_fkey'
    ) THEN
        ALTER TABLE "cash_drawer_closures"
            ADD CONSTRAINT "cash_drawer_closures_closed_by_fkey"
            FOREIGN KEY ("closed_by") REFERENCES "users"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
