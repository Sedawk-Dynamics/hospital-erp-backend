import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createPatientSchema,
  updatePatientSchema,
  searchPatientsSchema,
  addEmergencyContactSchema,
  addDocumentSchema,
  patientIdParamSchema,
} from './patients.validation';
import * as controller from './patients.controller';

export const patientRoutes = Router();

// Create patient
patientRoutes.post(
  '/',
  authenticate,
  requirePermission('patients', 'create'),
  validate(createPatientSchema),
  controller.create,
);

// List patients (paginated)
patientRoutes.get(
  '/',
  authenticate,
  requirePermission('patients', 'read'),
  validate(searchPatientsSchema),
  controller.findAll,
);

// Search patients (quick search)
patientRoutes.get(
  '/search',
  authenticate,
  requirePermission('patients', 'read'),
  validate(searchPatientsSchema),
  controller.searchPatients,
);

// Get patient by ID
patientRoutes.get(
  '/:id',
  authenticate,
  requirePermission('patients', 'read'),
  validate(patientIdParamSchema),
  controller.findById,
);

// Update patient
patientRoutes.put(
  '/:id',
  authenticate,
  requirePermission('patients', 'update'),
  validate(updatePatientSchema),
  controller.update,
);

// Add emergency contact
patientRoutes.post(
  '/:id/emergency-contacts',
  authenticate,
  validate(addEmergencyContactSchema),
  controller.addEmergencyContact,
);

// Allergies & family history: canonical endpoints live in /medical-history module.
// Legacy /:id/allergies and /:id/family-history removed to avoid divergence.

// Add document
patientRoutes.post(
  '/:id/documents',
  authenticate,
  validate(addDocumentSchema),
  controller.addDocument,
);

// Get visit history
patientRoutes.get(
  '/:id/visits',
  authenticate,
  validate(patientIdParamSchema),
  controller.getVisitHistory,
);
