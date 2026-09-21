import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  idParamSchema,
  patientIdParamSchema,
  createInsurerSchema,
  updateInsurerSchema,
  getInsurersQuerySchema,
  createTPASchema,
  updateTPASchema,
  getTPAsQuerySchema,
  createPolicySchema,
  updatePolicySchema,
  getPoliciesQuerySchema,
  verifyPolicySchema,
  createClaimSchema,
  updateClaimSchema,
  getClaimsQuerySchema,
  approveClaimSchema,
  rejectClaimSchema,
  partialApproveClaimSchema,
  settleClaimSchema,
  resubmitClaimSchema,
  cancelClaimSchema,
  createPreAuthSchema,
  updatePreAuthSchema,
  getPreAuthsQuerySchema,
  approvePreAuthSchema,
  rejectPreAuthSchema,
  holdPreAuthSchema,
  calcResponsibilitySchema,
  splitBillSchema,
  reportsQuerySchema,
  createTpaLogSchema,
  getTpaLogsQuerySchema,
} from './insurance.validation';
import * as controller from './insurance.controller';
import * as workflowController from './insurance.workflow.controller';
import {
  addCasePolicySchema,
  addClaimDocumentSchema,
  bankMatchQuerySchema,
  bulkSettlementSchema,
  caseIdParamSchema,
  claimIdParamSchema,
  contractQuerySchema,
  createAdjustmentSchema,
  createCorporatePayerSchema,
  createEnhancementSchema,
  createGovernmentSchemeSchema,
  createInsuranceCaseSchema,
  createPayerContractSchema,
  decideWriteOffSchema,
  emergencyIntimationSchema,
  insuranceCaseQuerySchema,
  payerListQuerySchema,
  physicalReleaseSchema,
  queueExchangeSchema,
  raiseClaimQuerySchema,
  recordEligibilitySchema,
  recordSettlementSchema,
  requestFinalAuthorizationSchema,
  requestWriteOffSchema,
  resolveClaimQuerySchema,
  respondClaimQuerySchema,
  updateInsuranceCaseStatusSchema,
  updatePayerContractSchema,
  verifyClaimDocumentSchema,
  workflowReportQuerySchema,
} from './insurance.workflow.validation';

export const insuranceRoutes = Router();

// ============================================================
// Dashboard
// ============================================================
insuranceRoutes.get('/dashboard', authenticate, requirePermission('insurance', 'read'), controller.getDashboard);
insuranceRoutes.get('/sla-queue', authenticate, requirePermission('insurance', 'read'), workflowController.getSlaQueue);
insuranceRoutes.get('/workflow-analytics', authenticate, requirePermission('insurance', 'read'), validate(workflowReportQuerySchema), workflowController.getWorkflowAnalytics);

// Distinct payer roles. A TPA administers a claim; it is not implicitly the
// party financially responsible for every case.
insuranceRoutes.post('/corporate-payers', authenticate, requirePermission('insurance', 'create'), validate(createCorporatePayerSchema), workflowController.createCorporatePayer);
insuranceRoutes.get('/corporate-payers', authenticate, requirePermission('insurance', 'read'), validate(payerListQuerySchema), workflowController.listCorporatePayers);
insuranceRoutes.post('/government-schemes', authenticate, requirePermission('insurance', 'create'), validate(createGovernmentSchemeSchema), workflowController.createGovernmentScheme);
insuranceRoutes.get('/government-schemes', authenticate, requirePermission('insurance', 'read'), validate(payerListQuerySchema), workflowController.listGovernmentSchemes);

// Payer contracts, negotiated tariffs, packages, checklists and non-payables.
insuranceRoutes.post('/contracts', authenticate, requirePermission('insurance', 'create'), validate(createPayerContractSchema), workflowController.createContract);
insuranceRoutes.get('/contracts', authenticate, requirePermission('insurance', 'read'), validate(contractQuerySchema), workflowController.listContracts);
insuranceRoutes.get('/contracts/:id', authenticate, requirePermission('insurance', 'read'), validate(caseIdParamSchema), workflowController.getContract);
insuranceRoutes.put('/contracts/:id', authenticate, requirePermission('insurance', 'update'), validate(updatePayerContractSchema), workflowController.updateContract);

// Longitudinal Insurance / Payer Case (cashless, reimbursement or credit).
insuranceRoutes.post('/cases', authenticate, requirePermission('insurance', 'create'), validate(createInsuranceCaseSchema), workflowController.createInsuranceCase);
insuranceRoutes.get('/cases', authenticate, requirePermission('insurance', 'read'), validate(insuranceCaseQuerySchema), workflowController.listInsuranceCases);
insuranceRoutes.get('/cases/:id', authenticate, requirePermission('insurance', 'read'), validate(caseIdParamSchema), workflowController.getInsuranceCase);
insuranceRoutes.get('/cases/:id/patient-status', authenticate, requirePermission('insurance', 'read'), validate(caseIdParamSchema), workflowController.getPatientCaseStatus);
insuranceRoutes.patch('/cases/:id/status', authenticate, requirePermission('insurance', 'update'), validate(updateInsuranceCaseStatusSchema), workflowController.updateInsuranceCaseStatus);
insuranceRoutes.post('/cases/:id/policies', authenticate, requirePermission('insurance', 'update'), validate(addCasePolicySchema), workflowController.addCasePolicy);
insuranceRoutes.post('/cases/:id/eligibility', authenticate, requirePermission('insurance', 'update'), validate(recordEligibilitySchema), workflowController.recordEligibility);
insuranceRoutes.patch('/cases/:id/emergency-intimation', authenticate, requirePermission('insurance', 'update'), validate(emergencyIntimationSchema), workflowController.recordEmergencyIntimation);
insuranceRoutes.patch('/cases/:id/physical-release', authenticate, requirePermission('insurance', 'update'), validate(physicalReleaseSchema), workflowController.recordPhysicalRelease);
insuranceRoutes.post('/cases/:id/final-authorization', authenticate, requirePermission('insurance', 'create'), validate(requestFinalAuthorizationSchema), workflowController.requestFinalAuthorization);

// Integration outbox (including NHCX/FHIR R4 envelopes).
insuranceRoutes.post('/exchanges', authenticate, requirePermission('insurance', 'create'), validate(queueExchangeSchema), workflowController.queueExchange);

// ============================================================
// Insurers
// ============================================================
insuranceRoutes.post('/insurers', authenticate, requirePermission('insurance', 'create'), validate(createInsurerSchema), controller.createInsurer);
insuranceRoutes.get('/insurers', authenticate, requirePermission('insurance', 'read'), validate(getInsurersQuerySchema), controller.getInsurers);
insuranceRoutes.get('/insurers/:id', authenticate, requirePermission('insurance', 'read'), validate(idParamSchema), controller.getInsurerById);
insuranceRoutes.put('/insurers/:id', authenticate, requirePermission('insurance', 'update'), validate(updateInsurerSchema), controller.updateInsurer);
insuranceRoutes.delete('/insurers/:id', authenticate, requirePermission('insurance', 'delete'), validate(idParamSchema), controller.deleteInsurer);

// ============================================================
// TPA Providers
// ============================================================
insuranceRoutes.post('/tpa', authenticate, requirePermission('insurance', 'create'), validate(createTPASchema), controller.createTPA);
insuranceRoutes.get('/tpa', authenticate, requirePermission('insurance', 'read'), validate(getTPAsQuerySchema), controller.getTPAs);
insuranceRoutes.get('/tpa/:id', authenticate, requirePermission('insurance', 'read'), validate(idParamSchema), controller.getTPAById);
insuranceRoutes.put('/tpa/:id', authenticate, requirePermission('insurance', 'update'), validate(updateTPASchema), controller.updateTPA);
insuranceRoutes.delete('/tpa/:id', authenticate, requirePermission('insurance', 'delete'), validate(idParamSchema), controller.deleteTPA);

// ============================================================
// TPA Communication Logs
//
// A distinct path from `/tpa/:id` — that route only matches `/tpa/<value>`,
// so `/tpa-logs` cannot be swallowed by it.
// ============================================================
insuranceRoutes.post('/tpa-logs', authenticate, requirePermission('insurance', 'create'), validate(createTpaLogSchema), controller.createTpaLog);
insuranceRoutes.get('/tpa-logs', authenticate, requirePermission('insurance', 'read'), validate(getTpaLogsQuerySchema), controller.getTpaLogs);

// ============================================================
// Policies
// ============================================================
insuranceRoutes.post('/policies', authenticate, requirePermission('insurance', 'create'), validate(createPolicySchema), controller.createPolicy);
insuranceRoutes.get('/policies', authenticate, requirePermission('insurance', 'read'), validate(getPoliciesQuerySchema), controller.getPolicies);
insuranceRoutes.get('/policies/by-patient/:patientId', authenticate, requirePermission('insurance', 'read'), validate(patientIdParamSchema), controller.getPoliciesByPatient);
insuranceRoutes.get('/policies/:id', authenticate, requirePermission('insurance', 'read'), validate(idParamSchema), controller.getPolicyById);
insuranceRoutes.put('/policies/:id', authenticate, requirePermission('insurance', 'update'), validate(updatePolicySchema), controller.updatePolicy);
insuranceRoutes.patch('/policies/:id/verify', authenticate, requirePermission('insurance', 'approve'), validate(verifyPolicySchema), controller.verifyPolicy);

// ============================================================
// Claims
// ============================================================
insuranceRoutes.post('/claims', authenticate, requirePermission('insurance', 'create'), validate(createClaimSchema), controller.createClaim);
insuranceRoutes.get('/claims', authenticate, requirePermission('insurance', 'read'), validate(getClaimsQuerySchema), controller.getClaims);
insuranceRoutes.get('/claims/expiring', authenticate, requirePermission('insurance', 'read'), controller.getExpiringClaims);
insuranceRoutes.post('/claims/settlements/bulk', authenticate, requirePermission('insurance', 'approve'), validate(bulkSettlementSchema), workflowController.recordBulkSettlements);
insuranceRoutes.get('/claims/settlements/bank-match', authenticate, requirePermission('insurance', 'read'), validate(bankMatchQuerySchema), workflowController.findBankMatches);
insuranceRoutes.get('/claims/:id', authenticate, requirePermission('insurance', 'read'), validate(idParamSchema), controller.getClaimById);
insuranceRoutes.get('/claims/:id/export', authenticate, requirePermission('insurance', 'export'), validate(idParamSchema), controller.exportClaim);
insuranceRoutes.get('/claims/:id/dossier', authenticate, requirePermission('insurance', 'export'), validate(claimIdParamSchema), workflowController.getClaimDossier);
insuranceRoutes.get('/claims/:id/checklist', authenticate, requirePermission('insurance', 'read'), validate(claimIdParamSchema), workflowController.getClaimChecklist);
insuranceRoutes.post('/claims/:id/checklist/sync', authenticate, requirePermission('insurance', 'update'), validate(claimIdParamSchema), workflowController.syncClaimChecklist);
insuranceRoutes.post('/claims/:id/documents', authenticate, requirePermission('insurance', 'create'), validate(addClaimDocumentSchema), workflowController.addClaimDocument);
insuranceRoutes.post('/claims/:id/queries', authenticate, requirePermission('insurance', 'update'), validate(raiseClaimQuerySchema), workflowController.raiseClaimQuery);
insuranceRoutes.post('/claims/:id/settlements', authenticate, requirePermission('insurance', 'approve'), validate(recordSettlementSchema), workflowController.recordSettlement);
insuranceRoutes.post('/claims/:id/write-offs', authenticate, requirePermission('insurance', 'update'), validate(requestWriteOffSchema), workflowController.requestWriteOff);
insuranceRoutes.post('/claims/:id/adjustments', authenticate, requirePermission('insurance', 'approve'), validate(createAdjustmentSchema), workflowController.createAdjustment);
insuranceRoutes.put('/claims/:id', authenticate, requirePermission('insurance', 'update'), validate(updateClaimSchema), controller.updateClaim);
insuranceRoutes.patch('/claims/:id/submit', authenticate, requirePermission('insurance', 'update'), validate(idParamSchema), controller.submitClaim);
insuranceRoutes.patch('/claims/:id/approve', authenticate, requirePermission('insurance', 'approve'), validate(approveClaimSchema), controller.approveClaim);
insuranceRoutes.patch('/claims/:id/partial-approve', authenticate, requirePermission('insurance', 'approve'), validate(partialApproveClaimSchema), controller.partialApproveClaim);
insuranceRoutes.patch('/claims/:id/reject', authenticate, requirePermission('insurance', 'approve'), validate(rejectClaimSchema), controller.rejectClaim);
insuranceRoutes.patch('/claims/:id/settle', authenticate, requirePermission('insurance', 'approve'), validate(settleClaimSchema), controller.settleClaim);
insuranceRoutes.post('/claims/:id/resubmit', authenticate, requirePermission('insurance', 'create'), validate(resubmitClaimSchema), controller.resubmitClaim);
insuranceRoutes.patch('/claims/:id/cancel', authenticate, requirePermission('insurance', 'update'), validate(cancelClaimSchema), controller.cancelClaim);
insuranceRoutes.patch('/claim-documents/:documentId/verify', authenticate, requirePermission('insurance', 'approve'), validate(verifyClaimDocumentSchema), workflowController.verifyClaimDocument);
insuranceRoutes.patch('/claim-queries/:queryId/respond', authenticate, requirePermission('insurance', 'update'), validate(respondClaimQuerySchema), workflowController.respondClaimQuery);
insuranceRoutes.patch('/claim-queries/:queryId/resolve', authenticate, requirePermission('insurance', 'approve'), validate(resolveClaimQuerySchema), workflowController.resolveClaimQuery);
insuranceRoutes.patch('/claim-write-offs/:writeOffId/decision', authenticate, requirePermission('insurance', 'approve'), validate(decideWriteOffSchema), workflowController.decideWriteOff);

// ============================================================
// Pre-Authorization
// ============================================================
insuranceRoutes.post('/pre-auth', authenticate, requirePermission('insurance', 'create'), validate(createPreAuthSchema), controller.createPreAuth);
insuranceRoutes.get('/pre-auth', authenticate, requirePermission('insurance', 'read'), validate(getPreAuthsQuerySchema), controller.getPreAuths);
insuranceRoutes.post('/pre-auth/:id/enhancements', authenticate, requirePermission('insurance', 'create'), validate(createEnhancementSchema), workflowController.createEnhancement);
insuranceRoutes.get('/pre-auth/:id', authenticate, requirePermission('insurance', 'read'), validate(idParamSchema), controller.getPreAuthById);
insuranceRoutes.put('/pre-auth/:id', authenticate, requirePermission('insurance', 'update'), validate(updatePreAuthSchema), controller.updatePreAuth);
insuranceRoutes.patch('/pre-auth/:id/approve', authenticate, requirePermission('insurance', 'approve'), validate(approvePreAuthSchema), controller.approvePreAuth);
insuranceRoutes.patch('/pre-auth/:id/reject', authenticate, requirePermission('insurance', 'approve'), validate(rejectPreAuthSchema), controller.rejectPreAuth);
insuranceRoutes.patch('/pre-auth/:id/hold', authenticate, requirePermission('insurance', 'approve'), validate(holdPreAuthSchema), controller.holdPreAuth);
insuranceRoutes.patch('/pre-auth/:id/release-hold', authenticate, requirePermission('insurance', 'approve'), validate(idParamSchema), controller.releasePreAuthHold);
insuranceRoutes.patch('/pre-auth/:id/cancel', authenticate, requirePermission('insurance', 'update'), validate(idParamSchema), controller.cancelPreAuth);

// ============================================================
// Calc + Bill Split
// ============================================================
insuranceRoutes.get('/calc-responsibility', authenticate, requirePermission('insurance', 'read'), validate(calcResponsibilitySchema), controller.calcResponsibility);
insuranceRoutes.patch('/bills/:billId/split', authenticate, requirePermission('insurance', 'update'), validate(splitBillSchema), controller.splitBill);

// ============================================================
// Reports
// ============================================================
insuranceRoutes.get('/reports/claims-summary', authenticate, requirePermission('insurance', 'read'), validate(reportsQuerySchema), controller.getClaimsSummaryReport);
insuranceRoutes.get('/reports/approval-rate', authenticate, requirePermission('insurance', 'read'), validate(reportsQuerySchema), controller.getApprovalRateReport);
insuranceRoutes.get('/reports/aging', authenticate, requirePermission('insurance', 'read'), validate(reportsQuerySchema), controller.getAgingReport);
insuranceRoutes.get('/reports/outstanding', authenticate, requirePermission('insurance', 'read'), validate(reportsQuerySchema), controller.getOutstandingReport);
