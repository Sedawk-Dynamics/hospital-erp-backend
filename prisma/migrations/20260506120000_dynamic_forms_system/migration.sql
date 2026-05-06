-- CreateEnum
CREATE TYPE "FormCategory" AS ENUM ('assessment', 'screening', 'intake', 'vitals', 'daily_note', 'procedure', 'discharge', 'other');

-- CreateTable
CREATE TABLE "form_templates" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "category" "FormCategory" NOT NULL DEFAULT 'other',
    "schema" JSONB NOT NULL,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "form_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hospital_forms" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "category" "FormCategory" NOT NULL DEFAULT 'other',
    "schema" JSONB NOT NULL,
    "is_published" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "template_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "archived_at" TIMESTAMP(3),
    "archive_reason" VARCHAR(255),
    "archived_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hospital_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hospital_form_submissions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "form_id" TEXT NOT NULL,
    "form_version" INTEGER NOT NULL,
    "form_snapshot" JSONB NOT NULL,
    "patient_id" TEXT NOT NULL,
    "visit_id" TEXT,
    "admission_id" TEXT,
    "appointment_id" TEXT,
    "submitted_by_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hospital_form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "form_templates_category_is_published_idx" ON "form_templates"("category", "is_published");

-- CreateIndex
CREATE INDEX "hospital_forms_tenant_id_archived_at_idx" ON "hospital_forms"("tenant_id", "archived_at");

-- CreateIndex
CREATE INDEX "hospital_forms_tenant_id_category_idx" ON "hospital_forms"("tenant_id", "category");

-- CreateIndex
CREATE INDEX "hospital_form_submissions_patient_id_created_at_idx" ON "hospital_form_submissions"("patient_id", "created_at");

-- CreateIndex
CREATE INDEX "hospital_form_submissions_form_id_created_at_idx" ON "hospital_form_submissions"("form_id", "created_at");

-- CreateIndex
CREATE INDEX "hospital_form_submissions_tenant_id_patient_id_idx" ON "hospital_form_submissions"("tenant_id", "patient_id");

-- AddForeignKey
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_forms" ADD CONSTRAINT "hospital_forms_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_forms" ADD CONSTRAINT "hospital_forms_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "form_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_forms" ADD CONSTRAINT "hospital_forms_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_forms" ADD CONSTRAINT "hospital_forms_archived_by_id_fkey" FOREIGN KEY ("archived_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_form_submissions" ADD CONSTRAINT "hospital_form_submissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_form_submissions" ADD CONSTRAINT "hospital_form_submissions_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "hospital_forms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_form_submissions" ADD CONSTRAINT "hospital_form_submissions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_form_submissions" ADD CONSTRAINT "hospital_form_submissions_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_form_submissions" ADD CONSTRAINT "hospital_form_submissions_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_form_submissions" ADD CONSTRAINT "hospital_form_submissions_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_form_submissions" ADD CONSTRAINT "hospital_form_submissions_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
