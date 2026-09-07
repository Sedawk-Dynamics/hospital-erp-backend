-- Keep a frozen copy of what the hospital actually filed for a period.
--
-- The reports are LIVE. They read today's bills, so a bill raised, amended or
-- cancelled after a return went in changes what they say about a month that is
-- already closed. That is exactly right for the current month and exactly wrong
-- for a past one: an accountant asked "what did you file in September" needs
-- the figures AS FILED, not as they look today.
--
-- What is stored is the RETURN figures, not the register behind them — the rate
-- summary, the HSN summary, the GSTR-1 tables and the GSTR-3B boxes. Two
-- reasons. They are what was actually filed, which is the question. And they
-- are small: a busy month's register runs to thousands of lines and would put a
-- megabyte of JSON in a column to answer a question nobody asked.
--
-- Deliberately NOT included here: the period LOCK. The spec asks that once a
-- period is filed no bill in it can be edited, with corrections made through a
-- credit note in the current month. That is the right rule and it changes what
-- staff can do — a front desk that could fix yesterday's bill suddenly cannot —
-- so it needs the hospital to agree to it before it ships. The archive stands
-- on its own until then, and is in fact MORE necessary without the lock: with
-- the underlying lines still free to move, the snapshot is the only record of
-- what went in.

CREATE TABLE IF NOT EXISTS "gst_filed_periods" (
  "id"             TEXT NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "financial_year" VARCHAR(7) NOT NULL,
  "return_period"  VARCHAR(6) NOT NULL,
  "period_from"    DATE NOT NULL,
  "period_to"      DATE NOT NULL,
  "filed_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "filed_by"       TEXT,
  "note"           TEXT,
  "snapshot"       JSONB NOT NULL,

  CONSTRAINT "gst_filed_periods_pkey" PRIMARY KEY ("id")
);

-- One filing per hospital per return period. Re-filing a month replaces the
-- snapshot rather than growing a second one, because there is only ever one
-- answer to "what did you file for September".
CREATE UNIQUE INDEX IF NOT EXISTS "gst_filed_periods_tenant_id_return_period_key"
  ON "gst_filed_periods" ("tenant_id", "return_period");

CREATE INDEX IF NOT EXISTS "gst_filed_periods_tenant_id_filed_at_idx"
  ON "gst_filed_periods" ("tenant_id", "filed_at");

DO $$ BEGIN
  ALTER TABLE "gst_filed_periods"
    ADD CONSTRAINT "gst_filed_periods_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- SET NULL: the archive outlives the account that filed it, and a snapshot with
-- no name is still the figures that went in.
DO $$ BEGIN
  ALTER TABLE "gst_filed_periods"
    ADD CONSTRAINT "gst_filed_periods_filed_by_fkey"
    FOREIGN KEY ("filed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
