import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as svc from './medical-history.service';
import {
  upsertPersonalHistorySchema,
  familyHistorySchema,
  familyHistoryUpdateSchema,
  allergySchema,
  allergyUpdateSchema,
  currentMedicationSchema,
  currentMedicationUpdateSchema,
} from './medical-history.validation';

export const medicalHistoryRoutes = Router();
const router = medicalHistoryRoutes;

router.use(authenticate);

const p = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? '';

// ── Personal History (doctor + patient editable) ───────────────
router.get('/:patientId/personal', requirePermission('patients', 'read'), async (req: AuthenticatedRequest, res, next) => {
  try {
    await svc.verifyPatientTenant(req.user!.tenantId, p(req.params.patientId));
    const data = await svc.getPersonalHistory(p(req.params.patientId));
    sendResponse({ res, message: 'Personal history', data });
  } catch (err) { next(err); }
});

router.put('/:patientId/personal', requirePermission('patients', 'update'), validate(upsertPersonalHistorySchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    await svc.verifyPatientTenant(req.user!.tenantId, p(req.params.patientId));
    const data = await svc.upsertPersonalHistory(p(req.params.patientId), req.user!.userId, req.body);
    sendResponse({ res, message: 'Personal history saved', data });
  } catch (err) { next(err); }
});

// ── Medical & Surgical History (assembled read model) ─────────
// Past medical + surgical narrative, every diagnosis on file, and the
// doctors' own consultation notes/summaries — the tab used to show none of it.
router.get('/:patientId/medical-surgical', requirePermission('patients', 'read'), async (req: AuthenticatedRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    await svc.verifyPatientTenant(tenantId, p(req.params.patientId));
    const data = await svc.getMedicalSurgicalHistory(tenantId, p(req.params.patientId));
    sendResponse({ res, message: 'Medical & surgical history', data });
  } catch (err) { next(err); }
});

// ── Family History ─────────────────────────────────────────────
// The patient portal was the only place this could ever be entered, so for
// IP / emergency / day-care / temporary patients — who rarely have a portal
// login — the doctor's and nurse's Family tab was permanently empty. Clinical
// staff with `patients:update` can now record it at the bedside too; the
// portal endpoints are unchanged and write to the same rows.
router.get('/:patientId/family', requirePermission('patients', 'read'), async (req: AuthenticatedRequest, res, next) => {
  try {
    await svc.verifyPatientTenant(req.user!.tenantId, p(req.params.patientId));
    const data = await svc.listFamilyHistory(p(req.params.patientId));
    sendResponse({ res, message: 'Family history', data });
  } catch (err) { next(err); }
});

router.post('/:patientId/family', requirePermission('patients', 'update'), validate(familyHistorySchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    await svc.verifyPatientTenant(req.user!.tenantId, p(req.params.patientId));
    const data = await svc.createFamilyHistory(p(req.params.patientId), req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Family history added', data });
  } catch (err) { next(err); }
});

router.put('/:patientId/family/:id', requirePermission('patients', 'update'), validate(familyHistoryUpdateSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    await svc.verifyPatientTenant(req.user!.tenantId, p(req.params.patientId));
    const data = await svc.updateFamilyHistory(p(req.params.patientId), req.user!.userId, p(req.params.id), req.body);
    sendResponse({ res, message: 'Family history updated', data });
  } catch (err) { next(err); }
});

// Removing a mis-keyed entry is part of recording it — gated on `update`, not
// `delete`, since neither doctor nor nurse carries `patients:delete`.
router.delete('/:patientId/family/:id', requirePermission('patients', 'update'), async (req: AuthenticatedRequest, res, next) => {
  try {
    await svc.verifyPatientTenant(req.user!.tenantId, p(req.params.patientId));
    await svc.deleteFamilyHistory(p(req.params.patientId), p(req.params.id));
    sendResponse({ res, message: 'Family history removed' });
  } catch (err) { next(err); }
});

// ── Allergies (doctor + patient editable) ──────────────────────
router.get('/:patientId/allergies', requirePermission('patients', 'read'), async (req: AuthenticatedRequest, res, next) => {
  try {
    await svc.verifyPatientTenant(req.user!.tenantId, p(req.params.patientId));
    const data = await svc.listAllergies(p(req.params.patientId));
    sendResponse({ res, message: 'Allergies', data });
  } catch (err) { next(err); }
});

router.post('/:patientId/allergies', requirePermission('patients', 'update'), validate(allergySchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    await svc.verifyPatientTenant(req.user!.tenantId, p(req.params.patientId));
    const data = await svc.createAllergy(p(req.params.patientId), req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Allergy added', data });
  } catch (err) { next(err); }
});

router.put('/:patientId/allergies/:id', requirePermission('patients', 'update'), validate(allergyUpdateSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    await svc.verifyPatientTenant(req.user!.tenantId, p(req.params.patientId));
    const data = await svc.updateAllergy(p(req.params.patientId), p(req.params.id), req.body);
    sendResponse({ res, message: 'Allergy updated', data });
  } catch (err) { next(err); }
});

// Same rationale as family history above: doctors and nurses hold
// `patients:update` but not `patients:delete`, so the panel's remove button
// used to 403 for exactly the people who record allergies.
router.delete('/:patientId/allergies/:id', requirePermission('patients', 'update'), async (req: AuthenticatedRequest, res, next) => {
  try {
    await svc.verifyPatientTenant(req.user!.tenantId, p(req.params.patientId));
    await svc.deleteAllergy(p(req.params.patientId), p(req.params.id));
    sendResponse({ res, message: 'Allergy deleted' });
  } catch (err) { next(err); }
});

// ── Current Medications (doctor-editable, manual + derived combined) ─
router.get('/:patientId/current-medications', requirePermission('patients', 'read'), async (req: AuthenticatedRequest, res, next) => {
  try {
    await svc.verifyPatientTenant(req.user!.tenantId, p(req.params.patientId));
    const data = await svc.getAllCurrentMedications(p(req.params.patientId), req.user!.tenantId);
    sendResponse({ res, message: 'Current medications', data });
  } catch (err) { next(err); }
});

router.post('/:patientId/current-medications', requirePermission('patients', 'update'), validate(currentMedicationSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    await svc.verifyPatientTenant(req.user!.tenantId, p(req.params.patientId));
    const data = await svc.createCurrentMedication(p(req.params.patientId), req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Current medication added', data });
  } catch (err) { next(err); }
});

router.put('/:patientId/current-medications/:id', requirePermission('patients', 'update'), validate(currentMedicationUpdateSchema), async (req: AuthenticatedRequest, res, next) => {
  try {
    await svc.verifyPatientTenant(req.user!.tenantId, p(req.params.patientId));
    const data = await svc.updateCurrentMedication(p(req.params.patientId), p(req.params.id), req.body);
    sendResponse({ res, message: 'Current medication updated', data });
  } catch (err) { next(err); }
});

router.delete('/:patientId/current-medications/:id', requirePermission('patients', 'delete'), async (req: AuthenticatedRequest, res, next) => {
  try {
    await svc.verifyPatientTenant(req.user!.tenantId, p(req.params.patientId));
    await svc.deleteCurrentMedication(p(req.params.patientId), p(req.params.id));
    sendResponse({ res, message: 'Current medication removed' });
  } catch (err) { next(err); }
});
