-- Doctor → Front-desk handoff for moving an OP patient into IP. The doctor
-- raises the request from the consultation workspace; front desk reviews the
-- queue and either accepts (which optionally creates a Reservation/Admission
-- and links it back) or rejects with a reason. Doctors can cancel their own
-- pending requests.

-- CreateEnum
CREATE TYPE "AdmissionRequestStatus" AS ENUM ('pending', 'accepted', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "AdmissionRequestUrgency" AS ENUM ('routine', 'urgent', 'emergency');

-- CreateTable
CREATE TABLE "admission_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "visit_id" TEXT,
    "doctor_id" TEXT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "provisional_diagnosis" VARCHAR(1000),
    "urgency" "AdmissionRequestUrgency" NOT NULL DEFAULT 'routine',
    "preferred_ward_type" VARCHAR(100),
    "expected_admission_date" DATE,
    "notes" TEXT,
    "status" "AdmissionRequestStatus" NOT NULL DEFAULT 'pending',
    "reservation_id" TEXT,
    "admission_id" TEXT,
    "rejection_reason" TEXT,
    "requested_by_id" TEXT,
    "processed_by_id" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admission_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admission_requests_tenant_id_status_created_at_idx" ON "admission_requests"("tenant_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "admission_requests" ADD CONSTRAINT "admission_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admission_requests" ADD CONSTRAINT "admission_requests_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admission_requests" ADD CONSTRAINT "admission_requests_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admission_requests" ADD CONSTRAINT "admission_requests_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admission_requests" ADD CONSTRAINT "admission_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admission_requests" ADD CONSTRAINT "admission_requests_processed_by_id_fkey" FOREIGN KEY ("processed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
