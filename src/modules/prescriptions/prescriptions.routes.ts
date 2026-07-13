import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './prescriptions.controller';
import {
  createPrescriptionSchema,
  getPrescriptionsQuerySchema,
  prescriptionIdParamSchema,
  updatePrescriptionSchema,
  cancelPrescriptionSchema,
  addPrescriptionItemSchema,
  updatePrescriptionItemSchema,
  removePrescriptionItemSchema,
  recordAdministrationSchema,
  getAdministrationRecordsQuerySchema,
  getAdministrationScheduleQuerySchema,
  allergyCheckQuerySchema,
  formularySearchQuerySchema,
  checkInteractionsSchema,
} from './prescriptions.validation';

export const prescriptionRoutes = Router();

// --- Allergy Check & Formulary Search (must be before /:id) ---
prescriptionRoutes.get('/allergy-check', authenticate, requirePermission('prescriptions', 'read'), validate(allergyCheckQuerySchema), controller.checkAllergy);
prescriptionRoutes.get('/formulary-search', authenticate, requirePermission('prescriptions', 'read'), validate(formularySearchQuerySchema), controller.searchFormulary);
prescriptionRoutes.post('/check-interactions', authenticate, requirePermission('prescriptions', 'read'), validate(checkInteractionsSchema), controller.checkInteractions);

// --- Drug History (auto-aggregated past + current meds per patient) ---
prescriptionRoutes.get('/drug-history/:patientId', authenticate, requirePermission('prescriptions', 'read'), controller.getDrugHistory);

// --- Prescriptions ---
prescriptionRoutes.post('/', authenticate, requirePermission('prescriptions', 'create'), validate(createPrescriptionSchema), controller.createPrescription);
prescriptionRoutes.get('/', authenticate, requirePermission('prescriptions', 'read'), validate(getPrescriptionsQuerySchema), controller.getPrescriptions);
prescriptionRoutes.get('/:id', authenticate, requirePermission('prescriptions', 'read'), validate(prescriptionIdParamSchema), controller.getPrescriptionById);
prescriptionRoutes.get('/:id/pdf', authenticate, requirePermission('prescriptions', 'read'), validate(prescriptionIdParamSchema), controller.downloadPrescriptionPdf);
prescriptionRoutes.put('/:id', authenticate, requirePermission('prescriptions', 'update'), validate(updatePrescriptionSchema), controller.updatePrescription);
prescriptionRoutes.patch('/:id', authenticate, requirePermission('prescriptions', 'update'), validate(updatePrescriptionSchema), controller.updatePrescription);
prescriptionRoutes.patch('/:id/cancel', authenticate, requirePermission('prescriptions', 'update'), validate(cancelPrescriptionSchema), controller.cancelPrescription);

// --- Prescription Items ---
prescriptionRoutes.post('/:id/items', authenticate, requirePermission('prescriptions', 'create'), validate(addPrescriptionItemSchema), controller.addPrescriptionItem);
prescriptionRoutes.put('/:id/items/:itemId', authenticate, requirePermission('prescriptions', 'update'), validate(updatePrescriptionItemSchema), controller.updatePrescriptionItem);
prescriptionRoutes.delete('/:id/items/:itemId', authenticate, requirePermission('prescriptions', 'delete'), validate(removePrescriptionItemSchema), controller.removePrescriptionItem);

// --- Medication Administration ---
prescriptionRoutes.post('/administration', authenticate, requirePermission('prescriptions', 'update'), validate(recordAdministrationSchema), controller.recordAdministration);
prescriptionRoutes.get('/administration', authenticate, requirePermission('prescriptions', 'read'), validate(getAdministrationRecordsQuerySchema), controller.getAdministrationRecords);
prescriptionRoutes.get('/administration/schedule', authenticate, requirePermission('prescriptions', 'read'), validate(getAdministrationScheduleQuerySchema), controller.getAdministrationSchedule);
