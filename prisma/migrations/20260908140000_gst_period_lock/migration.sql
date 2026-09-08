-- Lock a filed return period.
--
-- Section 6.10: "Once a return period is marked filed, the whole period is
-- locked. A late entry has to be posted in the current period, which is what
-- the law expects." Section 12 repeats it, and acceptance scenario 24 is
-- exactly this: editing a bill in a filed period must be refused and the user
-- told to raise a credit note in the current period instead.
--
-- Nothing enforced it. `gst_filed_periods` existed purely as an archive of the
-- figures as filed — the module's own comment said "What this deliberately does
-- NOT do is lock the period" — and no bill mutation anywhere consulted it. A
-- bill in September could be edited in November and the books would silently
-- stop matching the return.
--
-- Lock is a SEPARATE act from filing. Archiving the figures is a record; the
-- lock is a decision, and a hospital wants the snapshot the moment it files
-- while it may not want the doors shut until it has checked. So these are
-- nullable and default to unlocked: every period already archived stays exactly
-- as editable as it is today until somebody chooses otherwise.

ALTER TABLE "gst_filed_periods" ADD COLUMN IF NOT EXISTS "locked_at" TIMESTAMP(3);
ALTER TABLE "gst_filed_periods" ADD COLUMN IF NOT EXISTS "locked_by" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gst_filed_periods_locked_by_fkey'
  ) THEN
    ALTER TABLE "gst_filed_periods"
      ADD CONSTRAINT "gst_filed_periods_locked_by_fkey"
      FOREIGN KEY ("locked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- The lookup the guard makes on every bill mutation: "is the day this bill
-- falls on inside a locked period for this hospital".
CREATE INDEX IF NOT EXISTS "gst_filed_periods_tenant_locked_idx"
  ON "gst_filed_periods" ("tenant_id", "locked_at");
