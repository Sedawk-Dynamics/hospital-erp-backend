-- Remove the entire form system: SystemForm, HospitalFormConfig, FormSubmission,
-- and the legacy FormTemplate / FormInstance / FormAssignment models, plus their enums.

-- Drop in dependency order so FK constraints don't block.
DROP TABLE IF EXISTS "form_submissions" CASCADE;
DROP TABLE IF EXISTS "form_assignments" CASCADE;
DROP TABLE IF EXISTS "form_instances" CASCADE;
DROP TABLE IF EXISTS "form_templates" CASCADE;
DROP TABLE IF EXISTS "hospital_form_configs" CASCADE;
DROP TABLE IF EXISTS "system_forms" CASCADE;

DROP TYPE IF EXISTS "FormSubmissionStatus";
DROP TYPE IF EXISTS "FormTemplateStatus";
DROP TYPE IF EXISTS "FormTrigger";
DROP TYPE IF EXISTS "FormCategory";
