-- Payment-verify gate for imaging requests.
-- Doctor's imaging order lands in the radiology_admin queue first. The admin
-- clicks "Verify Payment" once the patient has paid the imaging charge at
-- the cash counter; only then does the request reach the radiologist's
-- worklist. Keeps clinical staff out of payment workflows and gives admin
-- explicit control over what enters the imaging schedule.

-- AlterTable
ALTER TABLE "imaging_requests"
  ADD COLUMN "payment_verified"    BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN "payment_verified_by" TEXT,
  ADD COLUMN "payment_verified_at" TIMESTAMP(3);

-- FK to the user who verified payment (admin/radiology_admin/cashier).
ALTER TABLE "imaging_requests"
  ADD CONSTRAINT "imaging_requests_payment_verified_by_fkey"
  FOREIGN KEY ("payment_verified_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Index for the admin queue lookup (status='requested' AND payment_verified=false).
CREATE INDEX "imaging_requests_payment_verified_idx"
  ON "imaging_requests"("tenant_id", "payment_verified");

-- Role-permission tightening (2026-05-27): radiologist no longer has
-- imaging:approve — only radiology_admin/admin can publish reports now.
-- Existing tenants need this row removed so the new flow is enforced.
DELETE FROM "role_permissions"
WHERE "role_id" IN (
  SELECT r.id FROM "roles" r
  WHERE r.name = 'radiologist'
)
AND "permission_id" IN (
  SELECT p.id FROM "permissions" p
  WHERE p.module = 'imaging' AND p.action = 'approve'
);
