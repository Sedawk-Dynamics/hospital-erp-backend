-- AlterTable: extend DoctorLeave with approval workflow
ALTER TABLE "doctor_leaves"
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "approved_by" TEXT,
  ADD COLUMN "end_date" DATE,
  ADD COLUMN "leave_type" "LeaveType" NOT NULL DEFAULT 'casual',
  ADD COLUMN "status" "LeaveRequestStatus" NOT NULL DEFAULT 'pending';

-- AddForeignKey
ALTER TABLE "doctor_leaves"
  ADD CONSTRAINT "doctor_leaves_approved_by_fkey"
  FOREIGN KEY ("approved_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
