-- Keep a log of every change to a tax master.
--
-- A rate that moves changes what a bill costs, and until now nothing recorded
-- that it moved. A hospital that suddenly starts charging 5% on something it
-- used to charge nothing for has no way to answer "when did that change, and
-- who changed it" — and that is the question an auditor asks first when two
-- bills for the same service carry different tax.
--
-- PLATFORM data, like the masters it tracks. There is no tenant column: a
-- change to HSN 3004 changes it for every hospital on the platform at once,
-- which is exactly what makes the impact worth reporting rather than shrugging
-- at. The report (C-8) reads this log alongside the bill lines carrying that
-- code, so "which items were affected" is answered with rows and not an
-- estimate.
--
-- `action` covers a deactivation as well as a rate move. Deactivating a code
-- changes what an item resolves to just as surely as re-rating it does — the
-- determination engine falls through to the next rule — and a log that only
-- watched the number would miss it entirely.
--
-- Written best-effort by the master writers: failing to log a change must never
-- stop the change itself, or a super admin fixing a wrong rate would be blocked
-- by the audit trail meant to explain the fix.

CREATE TABLE IF NOT EXISTS "gst_rate_changes" (
  "id"                 TEXT NOT NULL,
  "code_type"          VARCHAR(8) NOT NULL,
  "code"               VARCHAR(20) NOT NULL,
  "description"        VARCHAR(255),
  "previous_rate"      DECIMAL(5,2),
  "new_rate"           DECIMAL(5,2),
  "previous_treatment" VARCHAR(20),
  "new_treatment"      VARCHAR(20),
  "action"             VARCHAR(12) NOT NULL,
  "changed_by"         TEXT,
  "changed_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "gst_rate_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "gst_rate_changes_changed_at_idx"
  ON "gst_rate_changes" ("changed_at");

CREATE INDEX IF NOT EXISTS "gst_rate_changes_code_type_code_idx"
  ON "gst_rate_changes" ("code_type", "code");

-- SET NULL rather than RESTRICT: the log outlives the account that made the
-- change, and an entry with no name is still an entry with a date and a rate.
DO $$ BEGIN
  ALTER TABLE "gst_rate_changes"
    ADD CONSTRAINT "gst_rate_changes_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
