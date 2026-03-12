import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './imaging.controller';
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

export const imagingRoutes = Router();

// --- Imaging Requests ---
imagingRoutes.post('/requests', authenticate, requirePermission('imaging', 'create'), validate(createImagingRequestSchema), controller.createImagingRequest);
imagingRoutes.get('/requests', authenticate, requirePermission('imaging', 'create'), validate(getImagingRequestsQuerySchema), controller.getImagingRequests);
imagingRoutes.get('/requests/:id', authenticate, requirePermission('imaging', 'create'), validate(imagingRequestIdParamSchema), controller.getImagingRequestById);
imagingRoutes.put('/requests/:id', authenticate, requirePermission('imaging', 'create'), validate(updateImagingRequestSchema), controller.updateImagingRequest);
imagingRoutes.patch('/requests/:id/cancel', authenticate, requirePermission('imaging', 'create'), validate(cancelImagingRequestSchema), controller.cancelImagingRequest);
imagingRoutes.patch('/requests/:id/schedule', authenticate, requirePermission('imaging', 'update'), validate(scheduleImagingSchema), controller.scheduleImaging);

// --- Imaging Results ---
imagingRoutes.post('/results', authenticate, requirePermission('imaging', 'create'), validate(uploadImagingResultSchema), controller.uploadImagingResult);
imagingRoutes.get('/results', authenticate, requirePermission('imaging', 'read'), validate(getImagingResultsQuerySchema), controller.getImagingResults);
imagingRoutes.get('/results/:id', authenticate, requirePermission('imaging', 'read'), validate(imagingResultIdParamSchema), controller.getImagingResultById);
imagingRoutes.post('/results/:id/report', authenticate, requirePermission('imaging', 'create'), validate(addImagingReportSchema), controller.addImagingReport);
imagingRoutes.patch('/results/:id/verify', authenticate, requirePermission('imaging', 'approve'), validate(verifyImagingResultSchema), controller.verifyImagingResult);
