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
} from './lab.validation';
import * as controller from './lab.controller';

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
labRoutes.get('/reports', authenticate, requirePermission('lab_reports', 'read'), validate(getLabReportsSchema), controller.getLabReports);
labRoutes.get('/reports/:id', authenticate, requirePermission('lab_reports', 'read'), validate(labReportIdParamSchema), controller.getLabReportById);

// --- Investigation History (aggregated per patient) ---
labRoutes.get('/investigation-history/:patientId', authenticate, requirePermission('lab_reports', 'read'), controller.getInvestigationHistory);
