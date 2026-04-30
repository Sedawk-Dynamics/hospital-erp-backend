-- Partial unique index for NurseDoctorAssignment: at most one active row
-- per (nurse_id, doctor_id). Prisma cannot express partial uniques
-- declaratively, so run this once after the schema migration that adds the
-- nurse_doctor_assignments table.
--
-- Apply with:
--   psql "$DATABASE_URL" -f prisma/sql/nurse_doctor_assignment_partial_unique.sql

CREATE UNIQUE INDEX IF NOT EXISTS uq_nurse_doctor_assignment_active
  ON nurse_doctor_assignments (nurse_id, doctor_id)
  WHERE is_active = true;
