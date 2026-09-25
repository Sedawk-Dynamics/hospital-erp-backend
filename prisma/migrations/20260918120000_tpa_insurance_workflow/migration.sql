-- Full payer-case workflow: explicit payer roles, multi-policy coordination,
-- SLA-aware pre-authorisation, documents, queries, settlements and exchanges.

CREATE TYPE "InsuranceCaseType" AS ENUM ('insurance', 'corporate', 'government_scheme');
CREATE TYPE "InsuranceSettlementMode" AS ENUM ('cashless', 'reimbursement', 'credit');
CREATE TYPE "InsuranceCaseStatus" AS ENUM ('open', 'eligibility_pending', 'eligible', 'pre_auth_pending', 'authorized', 'admitted', 'treatment', 'discharge_authorization_pending', 'discharged', 'claim_submitted', 'query_pending', 'approved', 'settled', 'closed', 'cancelled');
CREATE TYPE "InsurancePriority" AS ENUM ('routine', 'urgent', 'critical', 'deceased');
CREATE TYPE "InsuranceClaimTier" AS ENUM ('primary', 'secondary', 'supplementary');
CREATE TYPE "PreAuthRequestType" AS ENUM ('initial', 'enhancement', 'final_discharge');
CREATE TYPE "ClaimQueryStatus" AS ENUM ('open', 'response_submitted', 'resolved', 'closed');
CREATE TYPE "ClaimDocumentStatus" AS ENUM ('pending', 'uploaded', 'verified', 'rejected');
CREATE TYPE "ClaimDocumentCategory" AS ENUM ('identity', 'eligibility', 'clinical', 'diagnostic', 'billing', 'authorization', 'settlement', 'correspondence', 'other');
CREATE TYPE "InsuranceSubmissionChannel" AS ENUM ('portal', 'email', 'nhcx', 'api', 'manual');
CREATE TYPE "ClaimWriteOffStatus" AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE "ClaimAdjustmentType" AS ENUM ('supplementary_payment', 'credit_note', 'debit_note');
CREATE TYPE "PayerType" AS ENUM ('insurer', 'tpa', 'corporate', 'government_scheme');
CREATE TYPE "InsuranceExchangeStatus" AS ENUM ('queued', 'submitted', 'acknowledged', 'failed');

ALTER TYPE "ClaimStatus" ADD VALUE IF NOT EXISTS 'query_raised';
ALTER TYPE "ClaimStatus" ADD VALUE IF NOT EXISTS 'response_submitted';

CREATE TABLE "corporate_payers" (
  "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "name" VARCHAR(255) NOT NULL,
  "code" VARCHAR(50), "contact_person" VARCHAR(100), "phone" VARCHAR(20),
  "email" VARCHAR(255), "address" TEXT, "gstin" VARCHAR(15), "state_code" VARCHAR(2),
  "credit_days" INTEGER NOT NULL DEFAULT 30, "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "corporate_payers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
);
CREATE UNIQUE INDEX "corporate_payers_tenant_id_name_key" ON "corporate_payers"("tenant_id", "name");

CREATE TABLE "government_scheme_payers" (
  "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "name" VARCHAR(255) NOT NULL,
  "scheme_code" VARCHAR(100), "contact_person" VARCHAR(100), "phone" VARCHAR(20),
  "email" VARCHAR(255), "portal_url" TEXT, "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "government_scheme_payers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
);
CREATE UNIQUE INDEX "government_scheme_payers_tenant_id_name_key" ON "government_scheme_payers"("tenant_id", "name");

CREATE TABLE "insurance_cases" (
  "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "case_number" VARCHAR(100) NOT NULL,
  "patient_id" TEXT NOT NULL, "admission_id" TEXT, "visit_id" TEXT,
  "case_type" "InsuranceCaseType" NOT NULL, "settlement_mode" "InsuranceSettlementMode" NOT NULL,
  "status" "InsuranceCaseStatus" NOT NULL DEFAULT 'open', "priority" "InsurancePriority" NOT NULL DEFAULT 'routine',
  "insurer_id" TEXT, "tpa_id" TEXT, "corporate_payer_id" TEXT, "government_scheme_payer_id" TEXT,
  "payment_responsible_type" "PayerType" NOT NULL, "payment_responsible_id" TEXT NOT NULL,
  "claim_administrator_type" "PayerType", "claim_administrator_id" TEXT,
  "member_id" VARCHAR(100), "employee_id" VARCHAR(100), "abha_number" VARCHAR(20),
  "eligibility_snapshot" JSONB, "emergency_intimation_due_at" TIMESTAMP(3),
  "emergency_intimated_at" TIMESTAMP(3), "deceased_protocol" BOOLEAN NOT NULL DEFAULT false,
  "physical_release_at" TIMESTAMP(3), "release_undertaking" TEXT, "notes" TEXT,
  "created_by" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "insurance_cases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
  CONSTRAINT "insurance_cases_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id"),
  CONSTRAINT "insurance_cases_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE SET NULL,
  CONSTRAINT "insurance_cases_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE SET NULL,
  CONSTRAINT "insurance_cases_insurer_id_fkey" FOREIGN KEY ("insurer_id") REFERENCES "insurers"("id") ON DELETE SET NULL,
  CONSTRAINT "insurance_cases_tpa_id_fkey" FOREIGN KEY ("tpa_id") REFERENCES "tpa_providers"("id") ON DELETE SET NULL,
  CONSTRAINT "insurance_cases_corporate_payer_id_fkey" FOREIGN KEY ("corporate_payer_id") REFERENCES "corporate_payers"("id") ON DELETE SET NULL,
  CONSTRAINT "insurance_cases_government_scheme_payer_id_fkey" FOREIGN KEY ("government_scheme_payer_id") REFERENCES "government_scheme_payers"("id") ON DELETE SET NULL,
  CONSTRAINT "insurance_cases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "insurance_cases_tenant_id_case_number_key" ON "insurance_cases"("tenant_id", "case_number");
CREATE INDEX "insurance_cases_tenant_id_patient_id_status_idx" ON "insurance_cases"("tenant_id", "patient_id", "status");
CREATE INDEX "insurance_cases_admission_id_idx" ON "insurance_cases"("admission_id");

CREATE TABLE "insurance_case_policies" (
  "id" TEXT PRIMARY KEY, "insurance_case_id" TEXT NOT NULL, "policy_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 1, "allocated_amount" DECIMAL(12,2),
  "original_documents_held" BOOLEAN NOT NULL DEFAULT false, "deduction_certificate_url" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "insurance_case_policies_insurance_case_id_fkey" FOREIGN KEY ("insurance_case_id") REFERENCES "insurance_cases"("id") ON DELETE CASCADE,
  CONSTRAINT "insurance_case_policies_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "insurance_policies"("id")
);
CREATE UNIQUE INDEX "insurance_case_policies_insurance_case_id_sequence_key" ON "insurance_case_policies"("insurance_case_id", "sequence");
CREATE UNIQUE INDEX "insurance_case_policies_insurance_case_id_policy_id_key" ON "insurance_case_policies"("insurance_case_id", "policy_id");

CREATE TABLE "payer_contracts" (
  "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "payer_type" "PayerType" NOT NULL,
  "payer_id" TEXT NOT NULL, "name" VARCHAR(255) NOT NULL, "contract_number" VARCHAR(100),
  "valid_from" DATE NOT NULL, "valid_to" DATE NOT NULL, "submission_window_days" INTEGER NOT NULL DEFAULT 15,
  "query_response_hours" INTEGER NOT NULL DEFAULT 24, "payment_due_days" INTEGER NOT NULL DEFAULT 30,
  "room_rent_cap" DECIMAL(12,2), "room_rent_cap_percent" DECIMAL(5,2), "terms" JSONB,
  "is_active" BOOLEAN NOT NULL DEFAULT true, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payer_contracts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
);
CREATE INDEX "payer_contracts_tenant_id_payer_type_payer_id_is_active_idx" ON "payer_contracts"("tenant_id", "payer_type", "payer_id", "is_active");

CREATE TABLE "payer_service_rates" (
  "id" TEXT PRIMARY KEY, "contract_id" TEXT NOT NULL, "service_tariff_id" TEXT,
  "service_code" VARCHAR(100) NOT NULL, "service_name" VARCHAR(255) NOT NULL,
  "agreed_rate" DECIMAL(12,2) NOT NULL, "effective_from" DATE NOT NULL, "effective_to" DATE,
  CONSTRAINT "payer_service_rates_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "payer_contracts"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "payer_service_rates_contract_id_service_code_effective_from_key" ON "payer_service_rates"("contract_id", "service_code", "effective_from");

CREATE TABLE "payer_package_rates" (
  "id" TEXT PRIMARY KEY, "contract_id" TEXT NOT NULL, "package_code" VARCHAR(100) NOT NULL,
  "package_name" VARCHAR(255) NOT NULL, "agreed_amount" DECIMAL(12,2) NOT NULL,
  "inclusions" JSONB, "exclusions" JSONB, "effective_from" DATE NOT NULL, "effective_to" DATE,
  CONSTRAINT "payer_package_rates_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "payer_contracts"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "payer_package_rates_contract_id_package_code_effective_from_key" ON "payer_package_rates"("contract_id", "package_code", "effective_from");

CREATE TABLE "payer_document_requirements" (
  "id" TEXT PRIMARY KEY, "contract_id" TEXT NOT NULL, "code" VARCHAR(100) NOT NULL,
  "name" VARCHAR(255) NOT NULL, "category" "ClaimDocumentCategory" NOT NULL,
  "is_required" BOOLEAN NOT NULL DEFAULT true, "applies_to" "InsuranceSettlementMode", "sort_order" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "payer_document_requirements_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "payer_contracts"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "payer_document_requirements_contract_id_code_key" ON "payer_document_requirements"("contract_id", "code");

CREATE TABLE "non_payable_item_rules" (
  "id" TEXT PRIMARY KEY, "contract_id" TEXT NOT NULL, "item_code" VARCHAR(100),
  "item_pattern" VARCHAR(255), "reason" TEXT NOT NULL, "patient_payable" BOOLEAN NOT NULL DEFAULT true,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "non_payable_item_rules_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "payer_contracts"("id") ON DELETE CASCADE
);
CREATE INDEX "non_payable_item_rules_contract_id_is_active_idx" ON "non_payable_item_rules"("contract_id", "is_active");

CREATE TABLE "policy_eligibility_checks" (
  "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "patient_id" TEXT NOT NULL,
  "policy_id" TEXT, "insurance_case_id" TEXT, "is_eligible" BOOLEAN NOT NULL,
  "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "coverage_available" DECIMAL(12,2),
  "co_pay_percent" DECIMAL(5,2), "deductible_amount" DECIMAL(12,2), "room_rent_limit" DECIMAL(12,2),
  "waiting_period_met" BOOLEAN, "exclusions" JSONB, "source" VARCHAR(100), "reference" VARCHAR(100),
  "raw_response" JSONB, "valid_until" TIMESTAMP(3),
  CONSTRAINT "policy_eligibility_checks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
  CONSTRAINT "policy_eligibility_checks_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id"),
  CONSTRAINT "policy_eligibility_checks_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "insurance_policies"("id") ON DELETE SET NULL,
  CONSTRAINT "policy_eligibility_checks_insurance_case_id_fkey" FOREIGN KEY ("insurance_case_id") REFERENCES "insurance_cases"("id") ON DELETE SET NULL
);
CREATE INDEX "policy_eligibility_checks_tenant_id_patient_id_checked_at_idx" ON "policy_eligibility_checks"("tenant_id", "patient_id", "checked_at");

ALTER TABLE "insurance_claims" DROP CONSTRAINT "insurance_claims_policy_id_fkey";
ALTER TABLE "insurance_claims" ALTER COLUMN "policy_id" DROP NOT NULL;
ALTER TABLE "insurance_claims"
  ADD COLUMN "insurance_case_id" TEXT, ADD COLUMN "pre_auth_id" TEXT,
  ADD COLUMN "tier" "InsuranceClaimTier" NOT NULL DEFAULT 'primary', ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "settlement_mode" "InsuranceSettlementMode" NOT NULL DEFAULT 'cashless',
  ADD COLUMN "submission_channel" "InsuranceSubmissionChannel", ADD COLUMN "payer_claim_reference" VARCHAR(100),
  ADD COLUMN "submission_reference" VARCHAR(100), ADD COLUMN "nhcx_transaction_id" VARCHAR(100),
  ADD COLUMN "final_authorization_requested_at" TIMESTAMP(3), ADD COLUMN "final_authorization_due_at" TIMESTAMP(3),
  ADD COLUMN "final_authorization_received_at" TIMESTAMP(3),
  ADD COLUMN "delay_liability_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "tds_receivable_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "disallowed_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "written_off_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "insurance_policies"("id") ON DELETE SET NULL;
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_insurance_case_id_fkey" FOREIGN KEY ("insurance_case_id") REFERENCES "insurance_cases"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "insurance_claims_insurance_case_id_sequence_key" ON "insurance_claims"("insurance_case_id", "sequence");
CREATE INDEX "insurance_claims_tenant_id_status_submission_date_idx" ON "insurance_claims"("tenant_id", "status", "submission_date");

ALTER TABLE "pre_authorization_requests" DROP CONSTRAINT "pre_authorization_requests_policy_id_fkey";
ALTER TABLE "pre_authorization_requests" ALTER COLUMN "policy_id" DROP NOT NULL;
ALTER TABLE "pre_authorization_requests"
  ADD COLUMN "insurance_case_id" TEXT, ADD COLUMN "request_number" VARCHAR(100),
  ADD COLUMN "request_type" "PreAuthRequestType" NOT NULL DEFAULT 'initial', ADD COLUMN "parent_request_id" TEXT,
  ADD COLUMN "admission_id" TEXT, ADD COLUMN "visit_id" TEXT, ADD COLUMN "doctor_id" TEXT,
  ADD COLUMN "diagnosis_code" VARCHAR(50), ADD COLUMN "procedure_code" VARCHAR(50),
  ADD COLUMN "payer_pre_auth_reference" VARCHAR(100), ADD COLUMN "submission_reference" VARCHAR(100),
  ADD COLUMN "nhcx_transaction_id" VARCHAR(100), ADD COLUMN "submission_channel" "InsuranceSubmissionChannel",
  ADD COLUMN "submitted_at" TIMESTAMP(3), ADD COLUMN "decision_due_at" TIMESTAMP(3),
  ADD COLUMN "alert_at" TIMESTAMP(3), ADD COLUMN "decided_at" TIMESTAMP(3), ADD COLUMN "escalated_at" TIMESTAMP(3);
UPDATE "pre_authorization_requests" SET "request_number" = 'PA-' || UPPER(SUBSTRING(REPLACE("id", '-', '') FROM 1 FOR 12));
ALTER TABLE "pre_authorization_requests" ALTER COLUMN "request_number" SET NOT NULL;
ALTER TABLE "pre_authorization_requests" ADD CONSTRAINT "pre_authorization_requests_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "insurance_policies"("id") ON DELETE SET NULL;
ALTER TABLE "pre_authorization_requests" ADD CONSTRAINT "pre_authorization_requests_insurance_case_id_fkey" FOREIGN KEY ("insurance_case_id") REFERENCES "insurance_cases"("id") ON DELETE SET NULL;
ALTER TABLE "pre_authorization_requests" ADD CONSTRAINT "pre_authorization_requests_parent_request_id_fkey" FOREIGN KEY ("parent_request_id") REFERENCES "pre_authorization_requests"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "pre_authorization_requests_tenant_id_request_number_key" ON "pre_authorization_requests"("tenant_id", "request_number");
CREATE INDEX "pre_authorization_requests_tenant_id_status_decision_due_at_idx" ON "pre_authorization_requests"("tenant_id", "status", "decision_due_at");

ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_pre_auth_id_fkey" FOREIGN KEY ("pre_auth_id") REFERENCES "pre_authorization_requests"("id") ON DELETE SET NULL;

CREATE TABLE "claim_documents" (
  "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "claim_id" TEXT NOT NULL,
  "code" VARCHAR(100), "name" VARCHAR(255) NOT NULL, "category" "ClaimDocumentCategory" NOT NULL,
  "file_url" TEXT NOT NULL, "mime_type" VARCHAR(100), "file_hash" VARCHAR(128), "version" INTEGER NOT NULL DEFAULT 1,
  "status" "ClaimDocumentStatus" NOT NULL DEFAULT 'uploaded', "rejection_reason" TEXT,
  "uploaded_by" TEXT, "verified_by" TEXT, "verified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "claim_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
  CONSTRAINT "claim_documents_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "insurance_claims"("id") ON DELETE CASCADE,
  CONSTRAINT "claim_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "claim_documents_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "claim_documents_claim_id_name_version_key" ON "claim_documents"("claim_id", "name", "version");
CREATE INDEX "claim_documents_claim_id_status_idx" ON "claim_documents"("claim_id", "status");

CREATE TABLE "claim_checklist_items" (
  "id" TEXT PRIMARY KEY, "claim_id" TEXT NOT NULL, "requirement_code" VARCHAR(100) NOT NULL,
  "label" VARCHAR(255) NOT NULL, "is_required" BOOLEAN NOT NULL DEFAULT true,
  "is_complete" BOOLEAN NOT NULL DEFAULT false, "document_id" TEXT, "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "claim_checklist_items_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "insurance_claims"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "claim_checklist_items_claim_id_requirement_code_key" ON "claim_checklist_items"("claim_id", "requirement_code");

CREATE TABLE "claim_queries" (
  "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "claim_id" TEXT NOT NULL,
  "query_reference" VARCHAR(100), "subject" VARCHAR(255) NOT NULL, "query_text" TEXT NOT NULL,
  "status" "ClaimQueryStatus" NOT NULL DEFAULT 'open', "raised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "response_due_at" TIMESTAMP(3), "responded_at" TIMESTAMP(3), "resolved_at" TIMESTAMP(3),
  "response_text" TEXT, "raised_by" TEXT, "responded_by" TEXT, "escalation_level" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "claim_queries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
  CONSTRAINT "claim_queries_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "insurance_claims"("id") ON DELETE CASCADE,
  CONSTRAINT "claim_queries_raised_by_fkey" FOREIGN KEY ("raised_by") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "claim_queries_responded_by_fkey" FOREIGN KEY ("responded_by") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX "claim_queries_tenant_id_status_response_due_at_idx" ON "claim_queries"("tenant_id", "status", "response_due_at");

CREATE TABLE "claim_settlements" (
  "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "claim_id" TEXT NOT NULL,
  "gross_approved_amount" DECIMAL(12,2) NOT NULL, "gross_paid_amount" DECIMAL(12,2) NOT NULL,
  "tds_amount" DECIMAL(12,2) NOT NULL DEFAULT 0, "tds_section" VARCHAR(50), "tds_rate" DECIMAL(7,4),
  "disallowed_amount" DECIMAL(12,2) NOT NULL DEFAULT 0, "disallowance_reason" TEXT,
  "net_paid_amount" DECIMAL(12,2) NOT NULL, "payment_reference" VARCHAR(100), "bank_reference" VARCHAR(100),
  "bank_statement_date" DATE, "tds_certificate_number" VARCHAR(100), "tds_certificate_date" DATE,
  "settlement_date" DATE NOT NULL, "notes" TEXT, "recorded_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "claim_settlements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
  CONSTRAINT "claim_settlements_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "insurance_claims"("id") ON DELETE CASCADE,
  CONSTRAINT "claim_settlements_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX "claim_settlements_claim_id_settlement_date_idx" ON "claim_settlements"("claim_id", "settlement_date");
CREATE INDEX "claim_settlements_tenant_id_bank_reference_idx" ON "claim_settlements"("tenant_id", "bank_reference");

CREATE TABLE "claim_write_offs" (
  "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "claim_id" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL, "reason" TEXT NOT NULL, "status" "ClaimWriteOffStatus" NOT NULL DEFAULT 'pending',
  "requested_by" TEXT, "decided_by" TEXT, "decided_at" TIMESTAMP(3), "decision_note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "claim_write_offs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
  CONSTRAINT "claim_write_offs_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "insurance_claims"("id") ON DELETE CASCADE,
  CONSTRAINT "claim_write_offs_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "claim_write_offs_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX "claim_write_offs_tenant_id_status_idx" ON "claim_write_offs"("tenant_id", "status");

CREATE TABLE "claim_adjustments" (
  "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "claim_id" TEXT NOT NULL,
  "adjustment_type" "ClaimAdjustmentType" NOT NULL, "amount" DECIMAL(12,2) NOT NULL,
  "reference" VARCHAR(100), "reason" TEXT NOT NULL, "effective_date" DATE NOT NULL,
  "recorded_by" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "claim_adjustments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
  CONSTRAINT "claim_adjustments_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "insurance_claims"("id") ON DELETE CASCADE,
  CONSTRAINT "claim_adjustments_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX "claim_adjustments_claim_id_effective_date_idx" ON "claim_adjustments"("claim_id", "effective_date");

CREATE TABLE "insurance_audit_events" (
  "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "insurance_case_id" TEXT,
  "claim_id" TEXT, "pre_auth_id" TEXT, "event_type" VARCHAR(100) NOT NULL,
  "from_status" VARCHAR(100), "to_status" VARCHAR(100), "details" JSONB,
  "actor_id" TEXT, "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "insurance_audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
  CONSTRAINT "insurance_audit_events_insurance_case_id_fkey" FOREIGN KEY ("insurance_case_id") REFERENCES "insurance_cases"("id") ON DELETE SET NULL,
  CONSTRAINT "insurance_audit_events_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "insurance_claims"("id") ON DELETE SET NULL,
  CONSTRAINT "insurance_audit_events_pre_auth_id_fkey" FOREIGN KEY ("pre_auth_id") REFERENCES "pre_authorization_requests"("id") ON DELETE SET NULL,
  CONSTRAINT "insurance_audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX "insurance_audit_events_tenant_id_insurance_case_id_occurred_idx" ON "insurance_audit_events"("tenant_id", "insurance_case_id", "occurred_at");
CREATE INDEX "insurance_audit_events_claim_id_occurred_at_idx" ON "insurance_audit_events"("claim_id", "occurred_at");

CREATE TABLE "insurance_exchanges" (
  "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "claim_id" TEXT, "pre_auth_id" TEXT,
  "channel" "InsuranceSubmissionChannel" NOT NULL, "message_type" VARCHAR(100) NOT NULL,
  "transaction_id" VARCHAR(100) NOT NULL, "status" "InsuranceExchangeStatus" NOT NULL DEFAULT 'queued',
  "request_payload" JSONB NOT NULL, "response_payload" JSONB, "error_message" TEXT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0, "next_attempt_at" TIMESTAMP(3),
  "submitted_at" TIMESTAMP(3), "acknowledged_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "insurance_exchanges_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
  CONSTRAINT "insurance_exchanges_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "insurance_claims"("id") ON DELETE SET NULL,
  CONSTRAINT "insurance_exchanges_pre_auth_id_fkey" FOREIGN KEY ("pre_auth_id") REFERENCES "pre_authorization_requests"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "insurance_exchanges_tenant_id_transaction_id_key" ON "insurance_exchanges"("tenant_id", "transaction_id");
CREATE INDEX "insurance_exchanges_tenant_id_status_next_attempt_at_idx" ON "insurance_exchanges"("tenant_id", "status", "next_attempt_at");
