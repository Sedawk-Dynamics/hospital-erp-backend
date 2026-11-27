-- DropIndex: global unique on the DICOM UIDs (caused cross-tenant collisions)
DROP INDEX "dicom_studies_study_instance_uid_key";
DROP INDEX "dicom_series_series_instance_uid_key";
DROP INDEX "dicom_instances_sop_instance_uid_key";

-- CreateIndex: make the UIDs unique per tenant instead
CREATE UNIQUE INDEX "dicom_studies_tenant_id_study_instance_uid_key" ON "dicom_studies"("tenant_id", "study_instance_uid");
CREATE UNIQUE INDEX "dicom_series_tenant_id_series_instance_uid_key" ON "dicom_series"("tenant_id", "series_instance_uid");
CREATE UNIQUE INDEX "dicom_instances_tenant_id_sop_instance_uid_key" ON "dicom_instances"("tenant_id", "sop_instance_uid");
