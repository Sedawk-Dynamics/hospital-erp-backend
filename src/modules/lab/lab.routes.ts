import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createLabDepartmentSchema,
  getLabDepartmentsSchema,
  updateLabDepartmentSchema,
  labDepartmentIdParamSchema,
  createTestSchema,
  getTestsSchema,
  testIdParamSchema,
  updateTestSchema,
  createLabOrderSchema,
  getLabOrdersSchema,
  labOrderIdParamSchema,
  updateLabOrderSchema,
  cancelLabOrderSchema,
  acceptLabOrderSchema,
  collectSampleSchema,
  getSamplesSchema,
  updateSampleStatusSchema,
  rejectSampleSchema,
  enterResultsSchema,
  getResultsSchema,
  verifyResultSchema,
  generateLabReportSchema,
  getLabReportsSchema,
  labReportIdParamSchema,
  signLabReportSchema,
  publishLabReportSchema,
  correctLabReportSchema,
} from './lab.validation';
import * as controller from './lab.controller';
import * as attachmentService from './lab-attachments.service';
import { uploadSingle } from '../../services/upload.service';
import type { AuthenticatedRequest } from '../../shared/types';
import type { Response, NextFunction } from 'express';
import { sendResponse } from '../../shared/apiResponse';

export const labRoutes = Router();

// --- Lab Departments ---
labRoutes.post('/departments', authenticate, requirePermission('lab_orders', 'create'), validate(createLabDepartmentSchema), controller.createLabDepartment);
labRoutes.get('/departments', authenticate, requirePermission('lab_orders', 'read'), validate(getLabDepartmentsSchema), controller.getLabDepartments);
labRoutes.put('/departments/:id', authenticate, requirePermission('lab_orders', 'update'), validate(updateLabDepartmentSchema), controller.updateLabDepartment);
labRoutes.delete('/departments/:id', authenticate, requirePermission('lab_orders', 'delete'), validate(labDepartmentIdParamSchema), controller.deleteLabDepartment);

// --- Test Catalog ---
labRoutes.post('/tests', authenticate, requirePermission('lab_orders', 'create'), validate(createTestSchema), controller.createTest);
labRoutes.get('/tests', authenticate, requirePermission('lab_orders', 'read'), validate(getTestsSchema), controller.getTests);
labRoutes.get('/test-catalog', authenticate, requirePermission('lab_orders', 'read'), validate(getTestsSchema), controller.getTests);
labRoutes.get('/tests/:id', authenticate, requirePermission('lab_orders', 'read'), validate(testIdParamSchema), controller.getTestById);
labRoutes.put('/tests/:id', authenticate, requirePermission('lab_orders', 'update'), validate(updateTestSchema), controller.updateTest);
labRoutes.delete('/tests/:id', authenticate, requirePermission('lab_orders', 'delete'), validate(testIdParamSchema), controller.deleteTest);

// --- Lab Orders ---
labRoutes.post('/orders', authenticate, requirePermission('lab_orders', 'create'), validate(createLabOrderSchema), controller.createLabOrder);
labRoutes.get('/orders', authenticate, requirePermission('lab_orders', 'read'), validate(getLabOrdersSchema), controller.getLabOrders);
labRoutes.get('/orders/:id', authenticate, requirePermission('lab_orders', 'read'), validate(labOrderIdParamSchema), controller.getLabOrderById);
labRoutes.put('/orders/:id', authenticate, requirePermission('lab_orders', 'update'), validate(updateLabOrderSchema), controller.updateLabOrder);
labRoutes.patch('/orders/:id/cancel', authenticate, requirePermission('lab_orders', 'update'), validate(cancelLabOrderSchema), controller.cancelLabOrder);
labRoutes.patch('/orders/:id/accept', authenticate, requirePermission('lab_orders', 'update'), validate(acceptLabOrderSchema), controller.acceptLabOrder);

// --- Samples ---
labRoutes.post('/samples', authenticate, requirePermission('lab_orders', 'update'), validate(collectSampleSchema), controller.collectSample);
labRoutes.get('/samples', authenticate, requirePermission('lab_orders', 'read'), validate(getSamplesSchema), controller.getSamples);
labRoutes.patch('/samples/:id/status', authenticate, requirePermission('lab_orders', 'update'), validate(updateSampleStatusSchema), controller.updateSampleStatus);
labRoutes.patch('/samples/:id/reject', authenticate, requirePermission('lab_orders', 'update'), validate(rejectSampleSchema), controller.rejectSample);

// --- Results ---
labRoutes.post('/results', authenticate, requirePermission('lab_reports', 'create'), validate(enterResultsSchema), controller.enterResults);
labRoutes.get('/results', authenticate, requirePermission('lab_reports', 'read'), validate(getResultsSchema), controller.getResults);
labRoutes.patch('/results/:id/verify', authenticate, requirePermission('lab_reports', 'approve'), validate(verifyResultSchema), controller.verifyResults);

// --- Reports ---
labRoutes.post('/reports/:orderId/generate', authenticate, requirePermission('lab_reports', 'create'), validate(generateLabReportSchema), controller.generateLabReport);
labRoutes.get('/reports/analytics', authenticate, requirePermission('lab_reports', 'read'), controller.getLabReportAnalytics);
labRoutes.get('/reports', authenticate, requirePermission('lab_reports', 'read'), validate(getLabReportsSchema), controller.getLabReports);
labRoutes.get('/reports/:id', authenticate, requirePermission('lab_reports', 'read'), validate(labReportIdParamSchema), controller.getLabReportById);
labRoutes.patch('/reports/:id/sign', authenticate, requirePermission('lab_reports', 'approve'), validate(signLabReportSchema), controller.signLabReport);
labRoutes.patch('/reports/:id/publish', authenticate, requirePermission('lab_reports', 'approve'), validate(publishLabReportSchema), controller.publishLabReport);
labRoutes.patch('/reports/:id/correct', authenticate, requirePermission('lab_reports', 'update'), validate(correctLabReportSchema), controller.correctLabReport);

// --- Investigation History (aggregated per patient) ---
labRoutes.get('/investigation-history/:patientId', authenticate, requirePermission('lab_reports', 'read'), controller.getInvestigationHistory);

// --- Dashboard (real-time worklist counts + recent activity for lab home) ---
labRoutes.get('/dashboard', authenticate, requirePermission('lab_orders', 'read'), controller.getLabDashboard);

// --- Extended analytics (per-test TAT, breach counts, daily trend) ---
labRoutes.get('/reports/analytics-extended', authenticate, requirePermission('lab_reports', 'read'), controller.getLabAnalyticsExtended);

// --- Attachments (PDF reports, microscopy images, scans, raw data) ---
// Files land on disk under /uploads via multer; metadata row points at the
// public URL so doctors / nurses / patients all hit the same static path.
labRoutes.post(
  '/orders/:orderId/attachments',
  authenticate,
  requirePermission('lab_reports', 'create'),
  (req: AuthenticatedRequest, res: Response, next: NextFunction) => uploadSingle('file')(req as any, res, next as any),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) throw new Error('No file uploaded');
      const tenantId = req.user!.tenantId;
      const userId = req.user!.userId;
      const orderId = req.params.orderId as string;
      const { labReportId, labOrderItemId, category, description } = (req.body ?? {}) as Record<string, string>;
      const data = await attachmentService.createLabAttachment(tenantId, userId, orderId, file, {
        labReportId: labReportId || undefined,
        labOrderItemId: labOrderItemId || undefined,
        category: category as any,
        description: description || undefined,
      });
      sendResponse({ res, statusCode: 201, message: 'Attachment uploaded', data });
    } catch (err) { next(err); }
  },
);

labRoutes.get(
  '/orders/:orderId/attachments',
  authenticate,
  requirePermission('lab_reports', 'read'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await attachmentService.listLabAttachmentsForOrder(req.user!.tenantId, req.params.orderId as string);
      sendResponse({ res, message: 'Attachments', data });
    } catch (err) { next(err); }
  },
);

labRoutes.get(
  '/reports/:reportId/attachments',
  authenticate,
  requirePermission('lab_reports', 'read'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await attachmentService.listLabAttachmentsForReport(req.user!.tenantId, req.params.reportId as string);
      sendResponse({ res, message: 'Attachments', data });
    } catch (err) { next(err); }
  },
);

labRoutes.delete(
  '/attachments/:id',
  authenticate,
  requirePermission('lab_reports', 'update'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await attachmentService.deleteLabAttachment(req.user!.tenantId, req.params.id as string);
      sendResponse({ res, message: 'Attachment deleted', data });
    } catch (err) { next(err); }
  },
);
