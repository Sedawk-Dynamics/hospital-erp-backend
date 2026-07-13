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
} from './insurance.validation';
import * as controller from './insurance.controller';

export const insuranceRoutes = Router();

// ============================================================
// Dashboard
// ============================================================
insuranceRoutes.get('/dashboard', authenticate, requirePermission('insurance', 'read'), controller.getDashboard);

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
insuranceRoutes.get('/claims/:id', authenticate, requirePermission('insurance', 'read'), validate(idParamSchema), controller.getClaimById);
insuranceRoutes.get('/claims/:id/export', authenticate, requirePermission('insurance', 'export'), validate(idParamSchema), controller.exportClaim);
insuranceRoutes.put('/claims/:id', authenticate, requirePermission('insurance', 'update'), validate(updateClaimSchema), controller.updateClaim);
insuranceRoutes.patch('/claims/:id/submit', authenticate, requirePermission('insurance', 'update'), validate(idParamSchema), controller.submitClaim);
insuranceRoutes.patch('/claims/:id/approve', authenticate, requirePermission('insurance', 'approve'), validate(approveClaimSchema), controller.approveClaim);
insuranceRoutes.patch('/claims/:id/partial-approve', authenticate, requirePermission('insurance', 'approve'), validate(partialApproveClaimSchema), controller.partialApproveClaim);
insuranceRoutes.patch('/claims/:id/reject', authenticate, requirePermission('insurance', 'approve'), validate(rejectClaimSchema), controller.rejectClaim);
insuranceRoutes.patch('/claims/:id/settle', authenticate, requirePermission('insurance', 'approve'), validate(settleClaimSchema), controller.settleClaim);
insuranceRoutes.post('/claims/:id/resubmit', authenticate, requirePermission('insurance', 'create'), validate(resubmitClaimSchema), controller.resubmitClaim);
insuranceRoutes.patch('/claims/:id/cancel', authenticate, requirePermission('insurance', 'update'), validate(cancelClaimSchema), controller.cancelClaim);

// ============================================================
// Pre-Authorization
// ============================================================
insuranceRoutes.post('/pre-auth', authenticate, requirePermission('insurance', 'create'), validate(createPreAuthSchema), controller.createPreAuth);
insuranceRoutes.get('/pre-auth', authenticate, requirePermission('insurance', 'read'), validate(getPreAuthsQuerySchema), controller.getPreAuths);
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
