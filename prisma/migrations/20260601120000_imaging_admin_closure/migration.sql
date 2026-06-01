-- Imaging admin closure (2026-06-01).
-- Adds a way for the radiology_admin to close out imaging requests that will
-- never produce a report file: patient no-show, patient refused, scan done at
-- another facility, no longer required, equipment down, duplicate order, etc.
-- Without this, such requests are stuck forever in the pending/scheduled
-- queues (the upload→complete path requires an attached file) or get lumped
-- into a reason-less generic cancel.

-- New terminal status for patients who never turned up for the scan. Kept
-- distinct from `cancelled` because no-show rate is a standard radiology KPI.
ALTER TYPE "ImagingRequestStatus" ADD VALUE IF NOT EXISTS 'no_show';

-- Reason taxonomy for an admin closure.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ImagingClosureReason') THEN
    CREATE TYPE "ImagingClosureReason" AS ENUM (
      'patient_no_show',
      'patient_refused',
      'patient_cancelled',
      'done_externally',
      'not_required',
      'equipment_unavailable',
      'duplicate_order',
      'other'
    );
  END IF;
END$$;

-- AlterTable — capture the closure metadata alongside the status flip.
ALTER TABLE "imaging_requests"
  ADD COLUMN IF NOT EXISTS "closure_reason" "ImagingClosureReason",
  ADD COLUMN IF NOT EXISTS "closure_note"   TEXT,
  ADD COLUMN IF NOT EXISTS "closed_by"      TEXT,
  ADD COLUMN IF NOT EXISTS "closed_at"      TIMESTAMP(3);

-- FK to the user (admin/radiology_admin) who closed the request.
ALTER TABLE "imaging_requests"
  ADD CONSTRAINT "imaging_requests_closed_by_fkey"
  FOREIGN KEY ("closed_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
