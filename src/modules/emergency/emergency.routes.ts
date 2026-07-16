import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createEmergencyPatientSchema,
  registerEmergencyPatientSchema,
  mergeEmergencyPatientSchema,
} from './emergency.validation';
import * as controller from './emergency.controller';

export const emergencyRoutes = Router();

// Mint a temporary emergency patient and route it as OP or IP.
emergencyRoutes.post(
  '/patients',
  authenticate,
  requirePermission('patients', 'create'),
  validate(createEmergencyPatientSchema),
  controller.createEmergencyPatient,
);

// List active temp emergency patients + their held charges and OP/IP context.
emergencyRoutes.get(
  '/patients',
  authenticate,
  requirePermission('patients', 'read'),
  controller.listEmergencyPatients,
);

// Register a temp emergency patient in place as a permanent patient.
emergencyRoutes.post(
  '/patients/:id/register',
  authenticate,
  requirePermission('patients', 'update'),
  validate(registerEmergencyPatientSchema),
  controller.registerEmergencyPatient,
);

// Connect a temp emergency patient to an already-registered patient.
emergencyRoutes.post(
  '/patients/:id/merge',
  authenticate,
  requirePermission('patients', 'update'),
  validate(mergeEmergencyPatientSchema),
  controller.mergeEmergencyPatient,
);
