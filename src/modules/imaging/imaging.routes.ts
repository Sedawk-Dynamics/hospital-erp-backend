import { Router } from 'express';
import type { Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './imaging.controller';
import * as dicomController from './dicom.controller';
import * as attachmentService from './imaging-attachments.service';
import { uploadImagingSingle } from '../../services/upload.service';
import type { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import {
  createImagingRequestSchema,
  getImagingRequestsQuerySchema,
  imagingRequestIdParamSchema,
  updateImagingRequestSchema,
  cancelImagingRequestSchema,
  closeImagingRequestSchema,
  reopenImagingRequestSchema,
  imagingCatalogQuerySchema,
  scheduleImagingSchema,
  verifyImagingPaymentSchema,
  acceptImagingRequestSchema,
  submitImagingResultSchema,
  reopenImagingResultSchema,
  uploadImagingResultSchema,
  getImagingResultsQuerySchema,
  imagingResultIdParamSchema,
  addImagingReportSchema,
  editImagingResultSchema,
  verifyImagingResultSchema,
} from './imaging.validation';
import {
  createStudySchema,
  addInstanceSchema,
  getStudiesQuerySchema,
  studyIdParamSchema,
  syncAttachmentParamSchema,
  worklistQuerySchema,
} from './dicom.validation';

export const imagingRoutes = Router();

// --- Imaging service catalog (admin-maintained tariffs, searched by doctors
// when ordering). Gated on imaging:read so doctors/radiology staff can read it. ---
imagingRoutes.get('/catalog', authenticate, requirePermission('imaging', 'read'), validate(imagingCatalogQuerySchema), controller.getImagingCatalog);

// --- Imaging Requests ---
imagingRoutes.post('/requests', authenticate, requirePermission('imaging', 'create'), validate(createImagingRequestSchema), controller.createImagingRequest);
imagingRoutes.get('/requests', authenticate, requirePermission('imaging', 'create'), validate(getImagingRequestsQuerySchema), controller.getImagingRequests);
imagingRoutes.get('/requests/:id', authenticate, requirePermission('imaging', 'create'), validate(imagingRequestIdParamSchema), controller.getImagingRequestById);
imagingRoutes.put('/requests/:id', authenticate, requirePermission('imaging', 'create'), validate(updateImagingRequestSchema), controller.updateImagingRequest);
imagingRoutes.patch('/requests/:id/cancel', authenticate, requirePermission('imaging', 'create'), validate(cancelImagingRequestSchema), controller.cancelImagingRequest);

// Admin closure (2026-06-01): close out a request that won't produce a report
// file (no-show, refused, done elsewhere, not required, …) or reopen one when
// the patient returns. Gated on imaging:update — radiology_admin/admin pass;
// it's surfaced on the admin queues in the UI.
imagingRoutes.patch('/requests/:id/close', authenticate, requirePermission('imaging', 'update'), validate(closeImagingRequestSchema), controller.closeImagingRequest);
imagingRoutes.patch('/requests/:id/reopen', authenticate, requirePermission('imaging', 'update'), validate(reopenImagingRequestSchema), controller.reopenImagingRequest);

imagingRoutes.patch('/requests/:id/schedule', authenticate, requirePermission('imaging', 'update'), validate(scheduleImagingSchema), controller.scheduleImaging);

// Payment-verify gate (2026-05-27 flow). Gated on `billing:update` so only
// radiology_admin / admin / billing-side roles pass — radiologists cannot
// self-clear payment because they don't have billing:update.
//
// Superseded by /accept below, which collects the money instead of just noting
// that somebody looked at the bill. Kept because it is still the right action
// for "the front desk took this at the main counter, release it" and because
// the old client calls it.
imagingRoutes.patch(
  '/requests/:id/verify-payment',
  authenticate,
  requirePermission('billing', 'update'),
  validate(verifyImagingPaymentSchema),
  controller.verifyImagingPayment,
);

// Accept — the radiology admin's single act: charge the study, collect at their
// own counter (or record why not), admit it, hand it to a radiologist. Gated on
// `billing:update` for the same reason verify-payment is: it takes money, and a
// radiologist must not be able to clear their own work through.
imagingRoutes.patch(
  '/requests/:id/accept',
  authenticate,
  requirePermission('billing', 'update'),
  validate(acceptImagingRequestSchema),
  controller.acceptImagingRequest,
);
// Read by the accept dialog before it offers to collect. Literal subpath, so it
// is registered alongside the other /requests/:id/<verb> routes.
imagingRoutes.get(
  '/requests/:id/billing-preview',
  authenticate,
  requirePermission('billing', 'update'),
  validate(imagingRequestIdParamSchema),
  controller.getImagingBillingPreview,
);

// --- Imaging Analytics (TAT, volume by modality, status mix, technician load) ---
imagingRoutes.get('/analytics', authenticate, requirePermission('imaging', 'read'), controller.getImagingAnalytics);

// --- Imaging Dashboard (worklist counts + recent activity for radiology admin landing) ---
imagingRoutes.get('/dashboard', authenticate, requirePermission('imaging', 'read'), controller.getImagingDashboard);

// --- Imaging Billing Summary (auto-linked BillItems aggregate for radiology admin) ---
imagingRoutes.get('/billing-summary', authenticate, requirePermission('imaging', 'read'), controller.getImagingBillingSummary);

// --- Imaging Results ---
imagingRoutes.post('/results', authenticate, requirePermission('imaging', 'create'), validate(uploadImagingResultSchema), controller.uploadImagingResult);
imagingRoutes.get('/results', authenticate, requirePermission('imaging', 'read'), validate(getImagingResultsQuerySchema), controller.getImagingResults);
imagingRoutes.get('/results/:id', authenticate, requirePermission('imaging', 'read'), validate(imagingResultIdParamSchema), controller.getImagingResultById);
imagingRoutes.post('/results/:id/report', authenticate, requirePermission('imaging', 'create'), validate(addImagingReportSchema), controller.addImagingReport);
imagingRoutes.patch('/results/:id', authenticate, requirePermission('imaging', 'update'), validate(editImagingResultSchema), controller.editImagingResult);
// Mark as Done — the radiologist submits their draft for admin approval. On
// `imaging:update` (which the radiologist has) and NOT `imaging:approve`, which
// is exactly the line between doing the work and signing it off.
imagingRoutes.patch('/results/:id/submit', authenticate, requirePermission('imaging', 'update'), validate(submitImagingResultSchema), controller.submitImagingResult);
imagingRoutes.patch('/results/:id/verify', authenticate, requirePermission('imaging', 'approve'), validate(verifyImagingResultSchema), controller.verifyImagingResult);
// Send a submitted report back for changes — the admin's "not yet", so a study
// needing another series can be reopened instead of published or abandoned.
imagingRoutes.patch('/results/:id/reopen', authenticate, requirePermission('imaging', 'approve'), validate(reopenImagingResultSchema), controller.reopenImagingResult);

// --- Attachments (PDF reports, modality images, DICOM, video loops) ---
// Mirrors the lab attachments pattern. Files land on disk under /uploads via
// multer; the metadata row is what doctors / nurses / patients read so they
// all see the same file via the public static handler.
imagingRoutes.post(
  '/requests/:requestId/attachments',
  authenticate,
  requirePermission('imaging', 'create'),
  (req: AuthenticatedRequest, res: Response, next: NextFunction) =>
    uploadImagingSingle('file')(req as any, res, next as any),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) throw new Error('No file uploaded');
      const tenantId = req.user!.tenantId;
      const userId = req.user!.userId;
      const requestId = req.params.requestId as string;
      const { imagingResultId, category, description } = (req.body ?? {}) as Record<string, string>;
      const data = await attachmentService.createImagingAttachment(tenantId, userId, requestId, file, {
        imagingResultId: imagingResultId || undefined,
        category: category as any,
        description: description || undefined,
      });
      sendResponse({ res, statusCode: 201, message: 'Attachment uploaded', data });
    } catch (err) {
      next(err);
    }
  },
);

imagingRoutes.get(
  '/requests/:requestId/attachments',
  authenticate,
  requirePermission('imaging', 'read'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await attachmentService.listImagingAttachmentsForRequest(
        req.user!.tenantId,
        req.params.requestId as string,
      );
      sendResponse({ res, message: 'Attachments', data });
    } catch (err) {
      next(err);
    }
  },
);

imagingRoutes.get(
  '/results/:resultId/attachments',
  authenticate,
  requirePermission('imaging', 'read'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await attachmentService.listImagingAttachmentsForResult(
        req.user!.tenantId,
        req.params.resultId as string,
      );
      sendResponse({ res, message: 'Attachments', data });
    } catch (err) {
      next(err);
    }
  },
);

imagingRoutes.patch(
  '/attachments/:id',
  authenticate,
  requirePermission('imaging', 'update'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { description, category } = (req.body ?? {}) as Record<string, string>;
      const data = await attachmentService.updateImagingAttachment(
        req.user!.tenantId,
        req.params.id as string,
        { description, category: category as any },
      );
      sendResponse({ res, message: 'Attachment updated', data });
    } catch (err) {
      next(err);
    }
  },
);

imagingRoutes.delete(
  '/attachments/:id',
  authenticate,
  requirePermission('imaging', 'update'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await attachmentService.deleteImagingAttachment(
        req.user!.tenantId,
        req.params.id as string,
      );
      sendResponse({ res, message: 'Attachment deleted', data });
    } catch (err) {
      next(err);
    }
  },
);

// --- PACS / DICOM ---
imagingRoutes.get('/dicom/config', authenticate, requirePermission('imaging', 'read'), dicomController.getPacsConfig);
imagingRoutes.get('/dicom/attachment/:attachmentId/viewer', authenticate, requirePermission('imaging', 'read'), validate(syncAttachmentParamSchema), dicomController.resolveAttachmentViewer);
imagingRoutes.post('/dicom/sync-attachment/:attachmentId', authenticate, requirePermission('imaging', 'create'), validate(syncAttachmentParamSchema), dicomController.syncAttachment);
imagingRoutes.get('/dicom/worklist', authenticate, requirePermission('imaging', 'read'), validate(worklistQuerySchema), dicomController.getWorklist);
imagingRoutes.get('/dicom/studies', authenticate, requirePermission('imaging', 'read'), validate(getStudiesQuerySchema), dicomController.getStudies);
imagingRoutes.get('/dicom/studies/:id', authenticate, requirePermission('imaging', 'read'), validate(studyIdParamSchema), dicomController.getStudyById);
imagingRoutes.get('/dicom/patient/:patientId/studies', authenticate, requirePermission('imaging', 'read'), dicomController.getStudiesByPatient);
imagingRoutes.post('/dicom/studies', authenticate, requirePermission('imaging', 'create'), validate(createStudySchema), dicomController.createStudy);
imagingRoutes.post('/dicom/studies/:id/instances', authenticate, requirePermission('imaging', 'create'), validate(addInstanceSchema), dicomController.addInstance);
