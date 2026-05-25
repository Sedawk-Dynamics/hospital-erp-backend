-- Drop the free-text `findings` column from `imaging_results`. The
-- radiology workflow is moving to attachment-only reporting: the
-- uploaded PDF / DICOM / image / video carries the finding instead of
-- a separate textarea. This migration is destructive — existing
-- findings text is deleted with the column.

-- AlterTable
ALTER TABLE "imaging_results" DROP COLUMN IF EXISTS "findings";
