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
  createNursingNoteSchema,
  listNursingNotesSchema,
  nursingNoteIdParamSchema,
  updateNursingNoteSchema,
} from './progress-notes.validation';

export const progressNotesRoutes = Router();

// --- Nursing Notes (must be before /:id to avoid conflict) ---
progressNotesRoutes.post('/nursing', authenticate, requirePermission('nursing_notes', 'create'), validate(createNursingNoteSchema), controller.createNursingNote);
progressNotesRoutes.get('/nursing', authenticate, requirePermission('nursing_notes', 'read'), validate(listNursingNotesSchema), controller.getNursingNotes);
progressNotesRoutes.get('/nursing/:id', authenticate, requirePermission('nursing_notes', 'read'), validate(nursingNoteIdParamSchema), controller.getNursingNoteById);
progressNotesRoutes.put('/nursing/:id', authenticate, requirePermission('nursing_notes', 'update'), validate(updateNursingNoteSchema), controller.updateNursingNote);
progressNotesRoutes.delete('/nursing/:id', authenticate, requirePermission('nursing_notes', 'delete'), validate(nursingNoteIdParamSchema), controller.deleteNursingNote);

// --- Progress Notes ---
progressNotesRoutes.post('/', authenticate, requirePermission('progress_notes', 'create'), validate(createProgressNoteSchema), controller.createProgressNote);
progressNotesRoutes.get('/', authenticate, requirePermission('progress_notes', 'read'), validate(listProgressNotesSchema), controller.getProgressNotes);
progressNotesRoutes.get('/:id', authenticate, requirePermission('progress_notes', 'read'), validate(progressNoteIdParamSchema), controller.getProgressNoteById);
progressNotesRoutes.put('/:id', authenticate, requirePermission('progress_notes', 'update'), validate(updateProgressNoteSchema), controller.updateProgressNote);
progressNotesRoutes.delete('/:id', authenticate, requirePermission('progress_notes', 'delete'), validate(progressNoteIdParamSchema), controller.deleteProgressNote);
progressNotesRoutes.patch('/:id/sign', authenticate, requirePermission('progress_notes', 'approve'), validate(signProgressNoteSchema), controller.signProgressNote);
