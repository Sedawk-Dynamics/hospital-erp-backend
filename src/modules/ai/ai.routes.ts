import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles, requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './ai.controller';
import {
  updateAiConfigSchema,
  aiConfigQuerySchema,
  aiConfigResetSchema,
  patientChatSchema,
  bloodReportAnalysisSchema,
  platformChatSchema,
} from './ai.validation';

export const aiRoutes = Router();

// --- Feature status (any authenticated user) ---
// Lets the frontend decide whether to show AI panels/buttons. Booleans only.
aiRoutes.get('/status', authenticate, controller.getStatus);

// --- Use Case 3 (Lvl 1): Platform-wide support chatbot (read-only) ---
// Any authenticated user; the service hard-scopes every data query to the
// caller's own tenant.
aiRoutes.post(
  '/support/chat',
  authenticate,
  validate(platformChatSchema),
  controller.platformChat,
);

// --- Use Case 2 (Lvl 1): Patient AI chatbot for the doctor (read-only) ---
aiRoutes.post(
  '/patient/chat',
  authenticate,
  requirePermission('patients', 'read'),
  validate(patientChatSchema),
  controller.patientChat,
);
aiRoutes.post(
  '/patient/blood-report',
  authenticate,
  requirePermission('lab_reports', 'read'),
  validate(bloodReportAnalysisSchema),
  controller.bloodReportAnalysis,
);

// --- Super-admin: LLM provider configuration (per hospital + platform default) ---
aiRoutes.get('/models', authenticate, requireRoles('super_admin'), controller.getModels);
aiRoutes.get('/configs', authenticate, requireRoles('super_admin'), controller.listConfigs);
aiRoutes.get(
  '/config',
  authenticate,
  requireRoles('super_admin'),
  validate(aiConfigQuerySchema),
  controller.getConfig,
);
aiRoutes.put(
  '/config',
  authenticate,
  requireRoles('super_admin'),
  validate(updateAiConfigSchema),
  controller.updateConfig,
);
aiRoutes.delete(
  '/config',
  authenticate,
  requireRoles('super_admin'),
  validate(aiConfigResetSchema),
  controller.resetConfig,
);
