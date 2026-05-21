-- CreateTable
CREATE TABLE "lab_test_templates" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "code" VARCHAR(50),
    "department_name" VARCHAR(100) NOT NULL,
    "sample_type" VARCHAR(50),
    "specimen" VARCHAR(255),
    "instructions" TEXT,
    "description" TEXT,
    "default_price" DECIMAL(10,2),
    "turnaround_hours" INTEGER,
    "parameters" JSONB NOT NULL,
    "interpretation" TEXT,
    "is_published" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lab_test_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lab_test_templates_name_key" ON "lab_test_templates"("name");

-- AddForeignKey
ALTER TABLE "lab_test_templates" ADD CONSTRAINT "lab_test_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: extend lab_test_catalog with template link + structured fields
ALTER TABLE "lab_test_catalog"
    ADD COLUMN "template_id" TEXT,
    ADD COLUMN "specimen" VARCHAR(255),
    ADD COLUMN "instructions" TEXT,
    ADD COLUMN "parameters" JSONB,
    ADD COLUMN "interpretation" TEXT,
    ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex on the new template link
CREATE INDEX "lab_test_catalog_tenant_id_template_id_idx" ON "lab_test_catalog"("tenant_id", "template_id");

-- AddForeignKey
ALTER TABLE "lab_test_catalog" ADD CONSTRAINT "lab_test_catalog_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "lab_test_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
