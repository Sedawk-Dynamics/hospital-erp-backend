import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './discount-policy.controller';
import {
  updateConfigSchema,
  createRuleSchema,
  updateRuleSchema,
  ruleIdParamSchema,
  evaluateQuerySchema,
} from './discount-policy.validation';

// Margin-based system-wide discount — a SEPARATE module from stock entry and
// bill discounts. Gated on the pharmacy permission set (pharmacy_admin manages;
// any pharmacy user can read the effective policy for the POS).
export const discountPolicyRoutes = Router();

// --- Config (on/off + mode) ---
discountPolicyRoutes.get('/config', authenticate, requirePermission('pharmacy', 'read'), controller.getConfig);
discountPolicyRoutes.put('/config', authenticate, requirePermission('pharmacy', 'update'), validate(updateConfigSchema), controller.updateConfig);

// --- Margin bands (rules) ---
discountPolicyRoutes.get('/rules', authenticate, requirePermission('pharmacy', 'read'), controller.listRules);
discountPolicyRoutes.post('/rules', authenticate, requirePermission('pharmacy', 'update'), validate(createRuleSchema), controller.createRule);
discountPolicyRoutes.put('/rules/:id', authenticate, requirePermission('pharmacy', 'update'), validate(updateRuleSchema), controller.updateRule);
discountPolicyRoutes.delete('/rules/:id', authenticate, requirePermission('pharmacy', 'delete'), validate(ruleIdParamSchema), controller.deleteRule);

// --- POS-facing helpers ---
// Effective policy the billing counter applies locally to cap each line.
discountPolicyRoutes.get('/effective', authenticate, requirePermission('pharmacy', 'read'), controller.getEffective);
// Single-margin lookup (margin% query) — convenience for a one-off check.
discountPolicyRoutes.get('/evaluate', authenticate, requirePermission('pharmacy', 'read'), validate(evaluateQuerySchema), controller.evaluate);
