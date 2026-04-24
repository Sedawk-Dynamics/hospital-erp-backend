import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './progress-notes.controller';
import {
  createProgressNoteSchema,
  listProgressNotesSchema,
  progressNoteIdParamSchema,
  updateProgressNoteSchema,
  signProgressNoteSchema,
  listAmendmentsSchema,
  createNursingNoteSchema,
  listNursingNotesSchema,
  nursingNoteIdParamSchema,
  updateNursingNoteSchema,
  createProgressNoteTemplateSchema,
  updateProgressNoteTemplateSchema,
  templateIdParamSchema,
  unlockProgressNoteSchema,
  listUnlockedProgressNotesSchema,
  createWoundCareSchema,
  listWoundCareSchema,
  createIvLineSchema,
  listIvLinesSchema,
  removeIvLineSchema,
  createIntakeOutputSchema,
  listIntakeOutputSchema,
  listPhysicalObservationsSchema,
  createPhysicalObservationSchema,
  updatePhysicalObservationSchema,
  physicalObservationIdParamSchema,
  smartSuggestionsSchema,
} from './progress-notes.validation';

export const progressNotesRoutes = Router();

// --- Wound Care (must be before /:id to avoid conflict) ---
progressNotesRoutes.post('/wound-care', authenticate, requirePermission('nursing_notes', 'create'), validate(createWoundCareSchema), controller.createWoundCare);
progressNotesRoutes.get('/wound-care', authenticate, requirePermission('nursing_notes', 'read'), validate(listWoundCareSchema), controller.getWoundCare);

// --- IV Lines (must be before /:id to avoid conflict) ---
progressNotesRoutes.post('/iv-lines', authenticate, requirePermission('nursing_notes', 'create'), validate(createIvLineSchema), controller.createIvLine);
progressNotesRoutes.get('/iv-lines', authenticate, requirePermission('nursing_notes', 'read'), validate(listIvLinesSchema), controller.getIvLines);
progressNotesRoutes.patch('/iv-lines/:id/remove', authenticate, requirePermission('nursing_notes', 'update'), validate(removeIvLineSchema), controller.removeIvLine);

// --- Intake / Output (must be before /:id to avoid conflict) ---
progressNotesRoutes.post('/intake-output', authenticate, requirePermission('nursing_notes', 'create'), validate(createIntakeOutputSchema), controller.createIntakeOutput);
progressNotesRoutes.get('/intake-output', authenticate, requirePermission('nursing_notes', 'read'), validate(listIntakeOutputSchema), controller.getIntakeOutput);

// --- Nursing Notes (must be before /:id to avoid conflict) ---
progressNotesRoutes.post('/nursing', authenticate, requirePermission('nursing_notes', 'create'), validate(createNursingNoteSchema), controller.createNursingNote);
progressNotesRoutes.get('/nursing', authenticate, requirePermission('nursing_notes', 'read'), validate(listNursingNotesSchema), controller.getNursingNotes);
progressNotesRoutes.get('/nursing/:id', authenticate, requirePermission('nursing_notes', 'read'), validate(nursingNoteIdParamSchema), controller.getNursingNoteById);
progressNotesRoutes.put('/nursing/:id', authenticate, requirePermission('nursing_notes', 'update'), validate(updateNursingNoteSchema), controller.updateNursingNote);
progressNotesRoutes.delete('/nursing/:id', authenticate, requirePermission('nursing_notes', 'delete'), validate(nursingNoteIdParamSchema), controller.deleteNursingNote);

// --- Progress Note Templates (must be before /:id to avoid conflict) ---
progressNotesRoutes.get('/templates', authenticate, requirePermission('progress_notes', 'read'), controller.listProgressNoteTemplates);
progressNotesRoutes.post('/templates', authenticate, requirePermission('progress_notes', 'create'), validate(createProgressNoteTemplateSchema), controller.createProgressNoteTemplate);
progressNotesRoutes.put('/templates/:id', authenticate, requirePermission('progress_notes', 'update'), validate(updateProgressNoteTemplateSchema), controller.updateProgressNoteTemplate);
progressNotesRoutes.delete('/templates/:id', authenticate, requirePermission('progress_notes', 'delete'), validate(templateIdParamSchema), controller.deleteProgressNoteTemplate);

// --- Unlocked Notes (must be before /:id to avoid conflict) ---
progressNotesRoutes.get('/unlocked', authenticate, requirePermission('progress_notes', 'read'), validate(listUnlockedProgressNotesSchema), controller.listUnlockedProgressNotes);

// --- AI Smart Suggestions (must be before /:id to avoid conflict) ---
progressNotesRoutes.post('/ai/suggest', authenticate, requirePermission('progress_notes', 'read'), validate(smartSuggestionsSchema), controller.smartSuggestions);

// --- Physical Observation Catalog (must be before /:id to avoid conflict) ---
progressNotesRoutes.get('/physical-observations', authenticate, requirePermission('progress_notes', 'read'), validate(listPhysicalObservationsSchema), controller.listPhysicalObservations);
progressNotesRoutes.post('/physical-observations', authenticate, requirePermission('progress_notes', 'create'), validate(createPhysicalObservationSchema), controller.createPhysicalObservation);
progressNotesRoutes.put('/physical-observations/:id', authenticate, requirePermission('progress_notes', 'update'), validate(updatePhysicalObservationSchema), controller.updatePhysicalObservation);
progressNotesRoutes.delete('/physical-observations/:id', authenticate, requirePermission('progress_notes', 'delete'), validate(physicalObservationIdParamSchema), controller.deletePhysicalObservation);

// --- Progress Notes ---
progressNotesRoutes.post('/', authenticate, requirePermission('progress_notes', 'create'), validate(createProgressNoteSchema), controller.createProgressNote);
progressNotesRoutes.get('/', authenticate, requirePermission('progress_notes', 'read'), validate(listProgressNotesSchema), controller.getProgressNotes);
progressNotesRoutes.get('/:id', authenticate, requirePermission('progress_notes', 'read'), validate(progressNoteIdParamSchema), controller.getProgressNoteById);
progressNotesRoutes.put('/:id', authenticate, requirePermission('progress_notes', 'update'), validate(updateProgressNoteSchema), controller.updateProgressNote);
progressNotesRoutes.delete('/:id', authenticate, requirePermission('progress_notes', 'delete'), validate(progressNoteIdParamSchema), controller.deleteProgressNote);
progressNotesRoutes.patch('/:id/sign', authenticate, requirePermission('progress_notes', 'approve'), validate(signProgressNoteSchema), controller.signProgressNote);
progressNotesRoutes.post('/:id/unlock', authenticate, requirePermission('progress_notes', 'update'), validate(unlockProgressNoteSchema), controller.unlockProgressNote);
progressNotesRoutes.post('/:id/relock', authenticate, requirePermission('progress_notes', 'update'), validate(progressNoteIdParamSchema), controller.relockProgressNote);
progressNotesRoutes.get('/:id/amendments', authenticate, requirePermission('progress_notes', 'read'), validate(listAmendmentsSchema), controller.listProgressNoteAmendments);
