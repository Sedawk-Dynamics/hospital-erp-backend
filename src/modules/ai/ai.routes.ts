import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles, requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './ai.controller';
import {
  updateAiConfigSchema,
  patientChatSchema,
  bloodReportAnalysisSchema,
} from './ai.validation';

export const aiRoutes = Router();

// --- Feature status (any authenticated user) ---
// Lets the frontend decide whether to show AI panels/buttons. Booleans only.
aiRoutes.get('/status', authenticate, controller.getStatus);

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

// --- Super-admin: LLM provider configuration ---
aiRoutes.get('/config', authenticate, requireRoles('super_admin'), controller.getConfig);
aiRoutes.put(
  '/config',
  authenticate,
  requireRoles('super_admin'),
  validate(updateAiConfigSchema),
  controller.updateConfig,
);
