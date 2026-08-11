import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission, requireRoles } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createTestSchema,
  getTestsSchema,
  testIdParamSchema,
  updateTestSchema,
  updateTestPriceSchema,
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
  completeLabOrderItemSchema,
  generateLabReportSchema,
  getLabReportsSchema,
  labReportIdParamSchema,
  signLabReportSchema,
  publishLabReportSchema,
  correctLabReportSchema,
  submitLabReportSchema,
  createLabTemplateSchema,
  updateLabTemplateSchema,
  labTemplateIdParamSchema,
  listLabTemplatesSchema,
  cloneOneLabTemplateSchema,
  cloneAllLabTemplatesSchema,
  createUnitGroupSchema,
  updateUnitGroupSchema,
  unitGroupIdParamSchema,
  createUnitSchema,
  updateUnitSchema,
  unitIdParamSchema,
} from './lab.validation';
import * as controller from './lab.controller';
import * as attachmentService from './lab-attachments.service';
import * as labService from './lab.service';
import { uploadSingle } from '../../services/upload.service';
import type { AuthenticatedRequest } from '../../shared/types';
import type { Response, NextFunction } from 'express';
import { sendResponse } from '../../shared/apiResponse';

export const labRoutes = Router();

// --- Public report verification (no auth) ---
// The branded report's QR code points here. Returns a minimal, PHI-free
// authenticity summary so any third party scanning the code can confirm the
// report is genuine.
labRoutes.get('/public/verify/:orderId', controller.getPublicLabReportSummary);

// --- Lab Unit Groups + Units (super-admin authors global; admin can add tenant-local) ---
// Reads are open to any authenticated user (parameter builder uses them).
// Writes are gated inside the service layer per role + scope (global vs tenant).
labRoutes.get('/unit-groups', authenticate, controller.listLabUnitGroups);
labRoutes.post('/unit-groups', authenticate, validate(createUnitGroupSchema), controller.createLabUnitGroup);
labRoutes.put('/unit-groups/:id', authenticate, validate(updateUnitGroupSchema), controller.updateLabUnitGroup);
labRoutes.delete('/unit-groups/:id', authenticate, validate(unitGroupIdParamSchema), controller.deleteLabUnitGroup);
labRoutes.post('/units', authenticate, validate(createUnitSchema), controller.createLabUnit);
labRoutes.put('/units/:id', authenticate, validate(updateUnitSchema), controller.updateLabUnit);
labRoutes.delete('/units/:id', authenticate, validate(unitIdParamSchema), controller.deleteLabUnit);

// --- Lab Test Templates (platform-wide, super-admin authored) ---
// Registered BEFORE the generic /tests/:id routes so /templates is not
// swallowed by Express matching `templates` against `:id`.
labRoutes.get('/templates', authenticate, validate(listLabTemplatesSchema), controller.listLabTemplates);
labRoutes.get('/templates/:id', authenticate, validate(labTemplateIdParamSchema), controller.getLabTemplate);
labRoutes.post('/templates', authenticate, requireRoles('super_admin'), validate(createLabTemplateSchema), controller.createLabTemplate);
labRoutes.put('/templates/:id', authenticate, requireRoles('super_admin'), validate(updateLabTemplateSchema), controller.updateLabTemplate);
labRoutes.delete('/templates/:id', authenticate, requireRoles('super_admin'), validate(labTemplateIdParamSchema), controller.deleteLabTemplate);
// Clone from platform template → tenant LabTestCatalog. Both single + bulk
// flows; the service guards roles (admin / super_admin only). `clone-all` is
// the "import everything at once" path the hospital admin onboarding screen
// uses on first setup.
labRoutes.post('/templates/clone-all', authenticate, validate(cloneAllLabTemplatesSchema), controller.cloneAllLabTemplates);
labRoutes.post('/templates/:templateId/clone', authenticate, validate(cloneOneLabTemplateSchema), controller.cloneOneLabTemplate);

// --- Test Catalog ---
labRoutes.post('/tests', authenticate, requirePermission('lab_orders', 'create'), validate(createTestSchema), controller.createTest);
labRoutes.get('/tests', authenticate, requirePermission('lab_orders', 'read'), validate(getTestsSchema), controller.getTests);
labRoutes.get('/test-catalog', authenticate, requirePermission('lab_orders', 'read'), validate(getTestsSchema), controller.getTests);
labRoutes.get('/tests/:id', authenticate, requirePermission('lab_orders', 'read'), validate(testIdParamSchema), controller.getTestById);
labRoutes.put('/tests/:id', authenticate, requirePermission('lab_orders', 'update'), validate(updateTestSchema), controller.updateTest);
// Narrow PATCH for lab_supervisor (and admin) — price + TAT only. Bypasses
// the admin-only schema-edit guard inside the full updateTest service.
labRoutes.patch('/tests/:id/price', authenticate, requirePermission('lab_orders', 'update'), validate(updateTestPriceSchema), controller.updateTestPrice);
labRoutes.delete('/tests/:id', authenticate, requirePermission('lab_orders', 'delete'), validate(testIdParamSchema), controller.deleteTest);

// --- Lab Orders ---
labRoutes.post('/orders', authenticate, requirePermission('lab_orders', 'create'), validate(createLabOrderSchema), controller.createLabOrder);
labRoutes.get('/orders', authenticate, requirePermission('lab_orders', 'read'), validate(getLabOrdersSchema), controller.getLabOrders);
labRoutes.get('/orders/:id', authenticate, requirePermission('lab_orders', 'read'), validate(labOrderIdParamSchema), controller.getLabOrderById);
labRoutes.put('/orders/:id', authenticate, requirePermission('lab_orders', 'update'), validate(updateLabOrderSchema), controller.updateLabOrder);
labRoutes.patch('/orders/:id/cancel', authenticate, requirePermission('lab_orders', 'update'), validate(cancelLabOrderSchema), controller.cancelLabOrder);
// Accepting an order admits it to the bench AND assigns a technician to it —
// that is triage and workload allocation, a supervisor's job. It sat on
// `lab_orders:update`, which technicians hold, so a technician could accept
// work and hand it to a colleague. `lab_orders:approve` is supervisor-only
// (lab_supervisor / admin / super_admin) and is already what result approval
// uses, so the two supervisor acts are gated the same way.
labRoutes.patch('/orders/:id/accept', authenticate, requirePermission('lab_orders', 'approve'), validate(acceptLabOrderSchema), controller.acceptLabOrder);
// Mark a single test on an order as done. The uploaded attachments serve as
// the report; when every item on the order is done, this endpoint auto-
// completes the order and publishes a LabReport for downstream readers.
labRoutes.patch(
  '/orders/:orderId/items/:itemId/complete',
  authenticate,
  requirePermission('lab_reports', 'create'),
  validate(completeLabOrderItemSchema),
  controller.completeLabOrderItem,
);

// --- Samples ---
// Sample collection + transit are WARD actions as much as lab ones: the nurse
// draws at the bedside and sends the sample down. They are gated by ROLE rather
// than `lab_orders:update`, because that permission also covers the test
// catalog, TEST PRICING, and order cancel/accept — a ward nurse must not get
// those just to label a blood tube. (Same precedent as /admissions/:id/type.)
const SAMPLE_HANDLER_ROLES = [
  'nurse', 'nurse_admin', 'lab_technician', 'lab_supervisor', 'admin', 'super_admin',
] as const;
labRoutes.post('/samples', authenticate, requireRoles(...SAMPLE_HANDLER_ROLES), validate(collectSampleSchema), controller.collectSample);
labRoutes.get('/samples', authenticate, requirePermission('lab_orders', 'read'), validate(getSamplesSchema), controller.getSamples);
labRoutes.patch('/samples/:id/status', authenticate, requireRoles(...SAMPLE_HANDLER_ROLES), validate(updateSampleStatusSchema), controller.updateSampleStatus);
// Rejecting a sample (haemolysed, insufficient volume, wrong tube) is a lab
// judgement, not a ward one — keep it on the lab permission.
labRoutes.patch('/samples/:id/reject', authenticate, requirePermission('lab_orders', 'update'), validate(rejectSampleSchema), controller.rejectSample);

// --- Results ---
labRoutes.post('/results', authenticate, requirePermission('lab_reports', 'create'), validate(enterResultsSchema), controller.enterResults);
labRoutes.get('/results', authenticate, requirePermission('lab_reports', 'read'), validate(getResultsSchema), controller.getResults);
labRoutes.patch('/results/:id/verify', authenticate, requirePermission('lab_reports', 'approve'), validate(verifyResultSchema), controller.verifyResults);

// --- Reports ---
labRoutes.post('/reports/:orderId/generate', authenticate, requirePermission('lab_reports', 'create'), validate(generateLabReportSchema), controller.generateLabReport);
labRoutes.get('/reports/analytics', authenticate, requirePermission('lab_reports', 'read'), controller.getLabReportAnalytics);
labRoutes.get('/reports', authenticate, requirePermission('lab_reports', 'read'), validate(getLabReportsSchema), controller.getLabReports);
// --- Extended analytics (per-test TAT, breach counts, daily trend) ---
// MUST precede `/reports/:id` — it was registered further down the file and
// `/:id` swallowed it, so the lab analytics dashboard only ever got back
// "Invalid report ID".
labRoutes.get('/reports/analytics-extended', authenticate, requirePermission('lab_reports', 'read'), controller.getLabAnalyticsExtended);
labRoutes.get('/reports/:id', authenticate, requirePermission('lab_reports', 'read'), validate(labReportIdParamSchema), controller.getLabReportById);
labRoutes.patch('/reports/:id/sign', authenticate, requirePermission('lab_reports', 'approve'), validate(signLabReportSchema), controller.signLabReport);
labRoutes.patch('/reports/:id/publish', authenticate, requirePermission('lab_reports', 'approve'), validate(publishLabReportSchema), controller.publishLabReport);
labRoutes.patch('/reports/:id/correct', authenticate, requirePermission('lab_reports', 'update'), validate(correctLabReportSchema), controller.correctLabReport);
// One-shot Submit (generate + sign + publish). Gated by `lab_reports.create`
// so technicians can publish a structured-mode report without supervisor
// sign-off — same trust model as the upload+mark-done auto-publish path.
labRoutes.post('/reports/:orderId/submit', authenticate, requirePermission('lab_reports', 'create'), validate(submitLabReportSchema), controller.submitLabReport);

// --- Investigation History (aggregated per patient) ---
labRoutes.get('/investigation-history/:patientId', authenticate, requirePermission('lab_reports', 'read'), controller.getInvestigationHistory);

// --- Dashboard (real-time worklist counts + recent activity for lab home) ---
labRoutes.get('/dashboard', authenticate, requirePermission('lab_orders', 'read'), controller.getLabDashboard);

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
      // Payment gate — OP orders must be paid before a result is uploaded (LP5).
      await labService.assertLabOrderPaymentCleared(tenantId, orderId);
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

// Re-run the reader on an already-uploaded report. The upload triggers this in
// the background, but the AI call can be unconfigured or rate-limited at that
// moment, so the lab needs a way to ask again — and a way to re-read a file the
// first pass got nothing out of. Literal subpath must precede /attachments/:id.
labRoutes.post(
  '/attachments/:id/extract',
  authenticate,
  requirePermission('lab_reports', 'update'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await labService.extractResultsFromAttachment(
        req.user!.tenantId,
        req.params.id as string,
        req.user!.userId,
      );
      sendResponse({ res, message: 'Report read', data });
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
