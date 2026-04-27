-- Partial unique index for NurseAssignment: at most one row with status='active'
-- per (admissionId, shiftDate, shiftType). Prisma cannot express partial uniques
-- declaratively (@@unique always creates a full unique index), so run this once
-- after the schema migration that adds the nurse_assignments table.
--
-- Apply with:
--   psql "$DATABASE_URL" -f prisma/sql/nurse_assignment_partial_unique.sql
-- or via the Prisma migrate workflow: copy the body of this file into the
-- generated migration's migration.sql, below the CREATE TABLE statement.

CREATE UNIQUE INDEX IF NOT EXISTS uq_nurse_assignment_active
  ON nurse_assignments (admission_id, shift_date, shift_type)
  WHERE status = 'active';
