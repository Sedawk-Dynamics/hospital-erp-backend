import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './imaging.controller';
import * as dicomController from './dicom.controller';
import {
  createImagingRequestSchema,
  getImagingRequestsQuerySchema,
  imagingRequestIdParamSchema,
  updateImagingRequestSchema,
  cancelImagingRequestSchema,
  scheduleImagingSchema,
  uploadImagingResultSchema,
  getImagingResultsQuerySchema,
  imagingResultIdParamSchema,
  addImagingReportSchema,
  verifyImagingResultSchema,
} from './imaging.validation';
import {
  createStudySchema,
  addInstanceSchema,
  getStudiesQuerySchema,
  studyIdParamSchema,
  worklistQuerySchema,
} from './dicom.validation';

export const imagingRoutes = Router();

// --- Imaging Requests ---
imagingRoutes.post('/requests', authenticate, requirePermission('imaging', 'create'), validate(createImagingRequestSchema), controller.createImagingRequest);
imagingRoutes.get('/requests', authenticate, requirePermission('imaging', 'create'), validate(getImagingRequestsQuerySchema), controller.getImagingRequests);
imagingRoutes.get('/requests/:id', authenticate, requirePermission('imaging', 'create'), validate(imagingRequestIdParamSchema), controller.getImagingRequestById);
imagingRoutes.put('/requests/:id', authenticate, requirePermission('imaging', 'create'), validate(updateImagingRequestSchema), controller.updateImagingRequest);
imagingRoutes.patch('/requests/:id/cancel', authenticate, requirePermission('imaging', 'create'), validate(cancelImagingRequestSchema), controller.cancelImagingRequest);
imagingRoutes.patch('/requests/:id/schedule', authenticate, requirePermission('imaging', 'update'), validate(scheduleImagingSchema), controller.scheduleImaging);

// --- Imaging Analytics (TAT, volume by modality, status mix, technician load) ---
imagingRoutes.get('/analytics', authenticate, requirePermission('imaging', 'read'), controller.getImagingAnalytics);

// --- Imaging Results ---
imagingRoutes.post('/results', authenticate, requirePermission('imaging', 'create'), validate(uploadImagingResultSchema), controller.uploadImagingResult);
imagingRoutes.get('/results', authenticate, requirePermission('imaging', 'read'), validate(getImagingResultsQuerySchema), controller.getImagingResults);
imagingRoutes.get('/results/:id', authenticate, requirePermission('imaging', 'read'), validate(imagingResultIdParamSchema), controller.getImagingResultById);
imagingRoutes.post('/results/:id/report', authenticate, requirePermission('imaging', 'create'), validate(addImagingReportSchema), controller.addImagingReport);
imagingRoutes.patch('/results/:id/verify', authenticate, requirePermission('imaging', 'approve'), validate(verifyImagingResultSchema), controller.verifyImagingResult);

// --- PACS / DICOM ---
imagingRoutes.get('/dicom/worklist', authenticate, requirePermission('imaging', 'read'), validate(worklistQuerySchema), dicomController.getWorklist);
imagingRoutes.get('/dicom/studies', authenticate, requirePermission('imaging', 'read'), validate(getStudiesQuerySchema), dicomController.getStudies);
imagingRoutes.get('/dicom/studies/:id', authenticate, requirePermission('imaging', 'read'), validate(studyIdParamSchema), dicomController.getStudyById);
imagingRoutes.get('/dicom/patient/:patientId/studies', authenticate, requirePermission('imaging', 'read'), dicomController.getStudiesByPatient);
imagingRoutes.post('/dicom/studies', authenticate, requirePermission('imaging', 'create'), validate(createStudySchema), dicomController.createStudy);
imagingRoutes.post('/dicom/studies/:id/instances', authenticate, requirePermission('imaging', 'create'), validate(addInstanceSchema), dicomController.addInstance);
