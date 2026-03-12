import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  idParamSchema,
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
  createPreAuthSchema,
  updatePreAuthSchema,
  getPreAuthsQuerySchema,
  approvePreAuthSchema,
  rejectPreAuthSchema,
} from './insurance.validation';
import * as controller from './insurance.controller';

export const insuranceRoutes = Router();

// --- Insurers ---
insuranceRoutes.post('/insurers', authenticate, requirePermission('insurance', 'create'), validate(createInsurerSchema), controller.createInsurer);
insuranceRoutes.get('/insurers', authenticate, requirePermission('insurance', 'read'), validate(getInsurersQuerySchema), controller.getInsurers);
insuranceRoutes.get('/insurers/:id', authenticate, requirePermission('insurance', 'read'), validate(idParamSchema), controller.getInsurerById);
insuranceRoutes.put('/insurers/:id', authenticate, requirePermission('insurance', 'update'), validate(updateInsurerSchema), controller.updateInsurer);
insuranceRoutes.delete('/insurers/:id', authenticate, requirePermission('insurance', 'delete'), validate(idParamSchema), controller.deleteInsurer);

// --- TPA ---
insuranceRoutes.post('/tpa', authenticate, requirePermission('insurance', 'create'), validate(createTPASchema), controller.createTPA);
insuranceRoutes.get('/tpa', authenticate, requirePermission('insurance', 'read'), validate(getTPAsQuerySchema), controller.getTPAs);
insuranceRoutes.get('/tpa/:id', authenticate, requirePermission('insurance', 'read'), validate(idParamSchema), controller.getTPAById);
insuranceRoutes.put('/tpa/:id', authenticate, requirePermission('insurance', 'update'), validate(updateTPASchema), controller.updateTPA);
insuranceRoutes.delete('/tpa/:id', authenticate, requirePermission('insurance', 'delete'), validate(idParamSchema), controller.deleteTPA);

// --- Policies ---
insuranceRoutes.post('/policies', authenticate, requirePermission('insurance', 'create'), validate(createPolicySchema), controller.createPolicy);
insuranceRoutes.get('/policies', authenticate, requirePermission('insurance', 'read'), validate(getPoliciesQuerySchema), controller.getPolicies);
insuranceRoutes.get('/policies/:id', authenticate, requirePermission('insurance', 'read'), validate(idParamSchema), controller.getPolicyById);
insuranceRoutes.put('/policies/:id', authenticate, requirePermission('insurance', 'update'), validate(updatePolicySchema), controller.updatePolicy);
insuranceRoutes.patch('/policies/:id/verify', authenticate, requirePermission('insurance', 'approve'), validate(verifyPolicySchema), controller.verifyPolicy);

// --- Claims ---
insuranceRoutes.post('/claims', authenticate, requirePermission('insurance', 'create'), validate(createClaimSchema), controller.createClaim);
insuranceRoutes.get('/claims', authenticate, requirePermission('insurance', 'read'), validate(getClaimsQuerySchema), controller.getClaims);
insuranceRoutes.get('/claims/:id', authenticate, requirePermission('insurance', 'read'), validate(idParamSchema), controller.getClaimById);
insuranceRoutes.put('/claims/:id', authenticate, requirePermission('insurance', 'update'), validate(updateClaimSchema), controller.updateClaim);
insuranceRoutes.patch('/claims/:id/submit', authenticate, requirePermission('insurance', 'update'), validate(idParamSchema), controller.submitClaim);
insuranceRoutes.patch('/claims/:id/approve', authenticate, requirePermission('insurance', 'approve'), validate(approveClaimSchema), controller.approveClaim);
insuranceRoutes.patch('/claims/:id/reject', authenticate, requirePermission('insurance', 'approve'), validate(rejectClaimSchema), controller.rejectClaim);

// --- Pre-Authorization ---
insuranceRoutes.post('/pre-auth', authenticate, requirePermission('insurance', 'create'), validate(createPreAuthSchema), controller.createPreAuth);
insuranceRoutes.get('/pre-auth', authenticate, requirePermission('insurance', 'read'), validate(getPreAuthsQuerySchema), controller.getPreAuths);
insuranceRoutes.get('/pre-auth/:id', authenticate, requirePermission('insurance', 'read'), validate(idParamSchema), controller.getPreAuthById);
insuranceRoutes.put('/pre-auth/:id', authenticate, requirePermission('insurance', 'update'), validate(updatePreAuthSchema), controller.updatePreAuth);
insuranceRoutes.patch('/pre-auth/:id/approve', authenticate, requirePermission('insurance', 'approve'), validate(approvePreAuthSchema), controller.approvePreAuth);
insuranceRoutes.patch('/pre-auth/:id/reject', authenticate, requirePermission('insurance', 'approve'), validate(rejectPreAuthSchema), controller.rejectPreAuth);
