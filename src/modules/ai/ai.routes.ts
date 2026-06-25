import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './ai.controller';
import { updateAiConfigSchema } from './ai.validation';

export const aiRoutes = Router();

// --- Feature status (any authenticated user) ---
// Lets the frontend decide whether to show AI panels/buttons. Booleans only.
aiRoutes.get('/status', authenticate, controller.getStatus);

// --- Super-admin: LLM provider configuration ---
aiRoutes.get('/config', authenticate, requireRoles('super_admin'), controller.getConfig);
aiRoutes.put(
  '/config',
  authenticate,
  requireRoles('super_admin'),
  validate(updateAiConfigSchema),
  controller.updateConfig,
);
