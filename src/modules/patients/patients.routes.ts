import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission, requireRoles } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createPatientSchema,
  updatePatientSchema,
  searchPatientsSchema,
  addEmergencyContactSchema,
  addDocumentSchema,
  patientIdParamSchema,
  createTemporaryPatientSchema,
  registerTemporaryPatientSchema,
  mergeTemporaryPatientSchema,
  recordPatientDeathSchema,
  clearPatientDeathSchema,
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

// Create a temporary (provisional) patient — literal path before '/:id'
patientRoutes.post(
  '/temporary',
  authenticate,
  requirePermission('patients', 'create'),
  validate(createTemporaryPatientSchema),
  controller.createTemporary,
);

// ── Death ──────────────────────────────────────────────────────────────────
// Literal subpaths, so they must precede '/:id'.
//
// Certifying a death is a medical act, so this is role-gated rather than
// permission-gated: a receptionist holding patients:update has no business
// recording one. `super_admin` is included because it bypasses permission
// checks everywhere else and would otherwise be the one role that cannot.
patientRoutes.post(
  '/:id/death',
  authenticate,
  requireRoles('doctor', 'admin', 'super_admin'),
  validate(recordPatientDeathSchema),
  controller.recordDeath,
);

// Withdrawing one is narrower still. Mis-identification is exactly what the
// unidentified-patient flow is prone to, so there has to be a way back — but
// it rewrites a legal fact, so it is not the certifying doctor's to undo alone.
patientRoutes.delete(
  '/:id/death',
  authenticate,
  requireRoles('admin', 'super_admin'),
  validate(clearPatientDeathSchema),
  controller.clearDeath,
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

// List patient profiles linked to a user (front-desk family-profile flow)
patientRoutes.get(
  '/by-user/:userId',
  authenticate,
  requirePermission('patients', 'read'),
  controller.findByUser,
);

// GLOBAL cross-hospital lookup by phone/ABHA (registered before literal subpaths
// so it isn't shadowed by /:id). Patients are one person across the whole ERP —
// this finds them so the desk pre-fills instead of re-registering.
patientRoutes.get(
  '/global-lookup',
  authenticate,
  requirePermission('patients', 'read'),
  controller.globalLookup,
);

// GLOBAL patient search for the pickers — finds a person at ANY hospital so the
// appointment/admit desk can select them (and provision a local MRN on pick).
patientRoutes.get(
  '/global-search',
  authenticate,
  requirePermission('patients', 'read'),
  controller.globalSearch,
);

// Provision a local record (new MRN) for a cross-hospital patient the desk picked.
patientRoutes.post(
  '/provision-local',
  authenticate,
  requirePermission('patients', 'create'),
  controller.provisionLocal,
);

// PLATFORM directory — every patient at every hospital. super_admin only: they
// run the platform rather than a hospital, so there is no tenant to scope to.
// Literal subpaths must precede '/:id' or they get swallowed by it.
patientRoutes.get(
  '/platform-directory',
  authenticate,
  requireRoles('super_admin'),
  controller.platformDirectory,
);

patientRoutes.get(
  '/platform-hospitals',
  authenticate,
  requireRoles('super_admin'),
  controller.platformHospitals,
);

// Get patient by ID
patientRoutes.get(
  '/:id',
  authenticate,
  requirePermission('patients', 'read'),
  validate(patientIdParamSchema),
  controller.findById,
);

// The centralized patient file — everything the hospital holds on one patient.
// A hospital user only ever resolves a patient registered at THEIR hospital
// (the service scopes by tenant unless the caller is super_admin), so a person
// who has never been here is simply not found.
patientRoutes.get(
  '/:id/file',
  authenticate,
  requirePermission('patients', 'read'),
  validate(patientIdParamSchema),
  controller.patientFile,
);

// Update patient
patientRoutes.put(
  '/:id',
  authenticate,
  requirePermission('patients', 'update'),
  validate(updatePatientSchema),
  controller.update,
);

// Register a temporary patient in place — permanent MRN + real details, same row
patientRoutes.post(
  '/:id/register-in-place',
  authenticate,
  requirePermission('patients', 'update'),
  validate(registerTemporaryPatientSchema),
  controller.registerTemporary,
);

// Merge a temporary patient into an existing registered patient (repoint + retire)
patientRoutes.post(
  '/:id/merge',
  authenticate,
  requirePermission('patients', 'update'),
  validate(mergeTemporaryPatientSchema),
  controller.mergeTemporary,
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

// List documents — everything on file for this PERSON, including what the
// patient uploaded from the portal under "My Documents". There was no read
// side, so those uploads were invisible to the clinician they were meant for.
patientRoutes.get(
  '/:id/documents',
  authenticate,
  requirePermission('patients', 'read'),
  validate(patientIdParamSchema),
  controller.getDocuments,
);

// Get visit history
patientRoutes.get(
  '/:id/visits',
  authenticate,
  validate(patientIdParamSchema),
  controller.getVisitHistory,
);

// Unified cross-hospital history (aggregates every hospital this person visited)
patientRoutes.get(
  '/:id/global-history',
  authenticate,
  requirePermission('patients', 'read'),
  validate(patientIdParamSchema),
  controller.globalHistory,
);
