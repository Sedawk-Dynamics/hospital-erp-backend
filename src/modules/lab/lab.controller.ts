import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as labService from './lab.service';
import * as labTemplates from './lab-templates.service';
import * as labUnits from './lab-units.service';

// ============================================================
// Test Catalog
// ============================================================

export async function createTest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const roles = req.user!.roles ?? [];
    const test = await labService.createTest(tenantId, roles, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Lab test created successfully',
      data: test,
    });
  } catch (err) {
    next(err);
  }
}

export async function getTests(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { tests, total, page, limit } = await labService.getTests(tenantId, req.query as any);
    sendPaginatedResponse(res, tests, total, page, limit, 'Lab tests retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getTestById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const test = await labService.getTestById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Lab test retrieved successfully',
      data: test,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateTest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const roles = req.user!.roles ?? [];
    const test = await labService.updateTest(tenantId, roles, req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Lab test updated successfully',
      data: test,
    });
  } catch (err) {
    next(err);
  }
}

// Narrow PATCH used by lab_supervisor (and admin) to update price + TAT only
// without touching catalog schema.
export async function updateTestPrice(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const test = await labService.updateTestPrice(tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Lab test price updated', data: test });
  } catch (err) {
    next(err);
  }
}

export async function deleteTest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const test = await labService.deleteTest(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Lab test deleted successfully',
      data: test,
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Lab Orders
// ============================================================

export async function createLabOrder(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const order = await labService.createLabOrder(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Lab order created successfully',
      data: order,
    });
  } catch (err) {
    next(err);
  }
}

export async function getLabOrders(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { orders, total, page, limit } = await labService.getLabOrders(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, orders, total, page, limit, 'Lab orders retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getLabOrderById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const order = await labService.getLabOrderById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Lab order retrieved successfully',
      data: order,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateLabOrder(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const order = await labService.updateLabOrder(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Lab order updated successfully',
      data: order,
    });
  } catch (err) {
    next(err);
  }
}

export async function cancelLabOrder(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const order = await labService.cancelLabOrder(
      tenantId,
      req.params.id as string,
      (req.body?.reason as string | undefined) ?? undefined,
    );
    sendResponse({
      res,
      message: 'Lab order cancelled successfully',
      data: order,
    });
  } catch (err) {
    next(err);
  }
}

export async function acceptLabOrder(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const order = await labService.acceptLabOrder(
      tenantId,
      req.params.id as string,
      userId,
      req.body,
    );
    sendResponse({
      res,
      message: 'Lab order accepted successfully',
      data: order,
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Samples
// ============================================================

export async function collectSample(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const sample = await labService.collectSample(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Sample collected successfully',
      data: sample,
    });
  } catch (err) {
    next(err);
  }
}

export async function getSamples(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { samples, total, page, limit } = await labService.getSamples(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, samples, total, page, limit, 'Samples retrieved');
  } catch (err) {
    next(err);
  }
}

export async function updateSampleStatus(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const sample = await labService.updateSampleStatus(
      tenantId,
      req.params.id as string,
      userId,
      req.body,
    );
    sendResponse({
      res,
      message: 'Sample status updated successfully',
      data: sample,
    });
  } catch (err) {
    next(err);
  }
}

export async function rejectSample(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const sample = await labService.rejectSample(
      tenantId,
      req.params.id as string,
      userId,
      req.body,
    );
    sendResponse({
      res,
      message: 'Sample rejected successfully',
      data: sample,
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Results
// ============================================================

export async function enterResults(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const results = await labService.enterResults(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Results entered successfully',
      data: results,
    });
  } catch (err) {
    next(err);
  }
}

export async function getResults(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { results, total, page, limit } = await labService.getResults(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, results, total, page, limit, 'Results retrieved');
  } catch (err) {
    next(err);
  }
}

export async function verifyResults(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const result = await labService.verifyResult(
      tenantId,
      req.params.id as string,
      userId,
      req.body,
    );
    sendResponse({
      res,
      message: 'Result reviewed successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function completeLabOrderItem(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const item = await labService.completeLabOrderItem(
      tenantId,
      userId,
      req.params.orderId as string,
      req.params.itemId as string,
    );
    sendResponse({
      res,
      message: 'Test marked done',
      data: item,
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Reports
// ============================================================

export async function generateLabReport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const reportContent = req.body?.reportContent;
    const hospitalBranding = req.body?.hospitalBranding;
    const report = await labService.generateLabReport(
      tenantId,
      req.params.orderId as string,
      userId,
      reportContent,
      hospitalBranding,
    );
    sendResponse({
      res,
      statusCode: 201,
      message: 'Lab report generated successfully',
      data: report,
    });
  } catch (err) {
    next(err);
  }
}

export async function getLabReports(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { reports, total, page, limit } = await labService.getLabReports(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, reports, total, page, limit, 'Lab reports retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getLabReportById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const report = await labService.getLabReportById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Lab report retrieved successfully',
      data: report,
    });
  } catch (err) {
    next(err);
  }
}

export async function getInvestigationHistory(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const patientId = req.params.patientId as string;
    const data = await labService.getInvestigationHistory(tenantId, patientId);
    sendResponse({ res, message: 'Investigation history', data });
  } catch (err) {
    next(err);
  }
}

export async function signLabReport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const report = await labService.signLabReport(tenantId, req.params.id as string, userId);
    sendResponse({ res, message: 'Lab report signed', data: report });
  } catch (err) {
    next(err);
  }
}

export async function publishLabReport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const notify = (req.body?.notify ?? true) as boolean;
    const report = await labService.publishLabReport(
      tenantId,
      req.params.id as string,
      userId,
      notify,
    );
    sendResponse({ res, message: 'Lab report published', data: report });
  } catch (err) {
    next(err);
  }
}

export async function submitLabReport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const notify = (req.body?.notify ?? true) as boolean;
    const reportContent = req.body?.reportContent;
    const hospitalBranding = req.body?.hospitalBranding;
    const report = await labService.submitLabReport(
      tenantId,
      req.params.orderId as string,
      userId,
      notify,
      reportContent,
      hospitalBranding,
    );
    sendResponse({ res, message: 'Lab report submitted', data: report });
  } catch (err) {
    next(err);
  }
}

export async function correctLabReport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const report = await labService.correctLabReport(
      tenantId,
      req.params.id as string,
      userId,
      req.body,
    );
    sendResponse({ res, message: 'Lab report corrected', data: report });
  } catch (err) {
    next(err);
  }
}

export async function getLabReportAnalytics(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const fromDate = (req.query.fromDate as string) || undefined;
    const toDate = (req.query.toDate as string) || undefined;
    const data = await labService.getLabReportAnalytics(tenantId, { fromDate, toDate });
    sendResponse({ res, message: 'Lab analytics', data });
  } catch (err) {
    next(err);
  }
}

export async function getLabAnalyticsExtended(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const fromDate = (req.query.fromDate as string) || undefined;
    const toDate = (req.query.toDate as string) || undefined;
    const data = await labService.getLabAnalyticsExtended(tenantId, { fromDate, toDate });
    sendResponse({ res, message: 'Lab analytics extended', data });
  } catch (err) {
    next(err);
  }
}

export async function getLabDashboard(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await labService.getLabDashboard(tenantId);
    sendResponse({ res, message: 'Lab dashboard', data });
  } catch (err) {
    next(err);
  }
}

// Public — no auth. Backs the QR code on the printed branded report.
export async function getPublicLabReportSummary(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await labService.getPublicLabReportSummary(req.params.orderId as string);
    if (!data) {
      sendResponse({ res, statusCode: 404, message: 'Report not found' });
      return;
    }
    sendResponse({ res, message: 'Report verification', data });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Lab Test Templates (platform-wide; super-admin authors, hospital
// admin clones into LabTestCatalog).
// ============================================================

export async function listLabTemplates(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { items, total, page, limit } = await labTemplates.listLabTemplates(req.query as never);
    sendPaginatedResponse(res, items, total, page, limit, 'Lab test templates retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getLabTemplate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tpl = await labTemplates.getLabTemplate(req.params.id as string);
    sendResponse({ res, message: 'Lab test template retrieved', data: tpl });
  } catch (err) {
    next(err);
  }
}

export async function createLabTemplate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tpl = await labTemplates.createLabTemplate(
      req.user!.userId,
      req.user!.roles ?? [],
      req.body,
    );
    sendResponse({ res, statusCode: 201, message: 'Lab test template created', data: tpl });
  } catch (err) {
    next(err);
  }
}

export async function updateLabTemplate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tpl = await labTemplates.updateLabTemplate(
      req.user!.roles ?? [],
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Lab test template updated', data: tpl });
  } catch (err) {
    next(err);
  }
}

export async function deleteLabTemplate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const out = await labTemplates.deleteLabTemplate(
      req.user!.roles ?? [],
      req.params.id as string,
    );
    sendResponse({ res, message: 'Lab test template deleted', data: out });
  } catch (err) {
    next(err);
  }
}

export async function cloneOneLabTemplate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const out = await labTemplates.cloneOneLabTemplate(
      req.user!.tenantId,
      req.user!.roles ?? [],
      req.params.templateId as string,
      req.body,
    );
    sendResponse({ res, statusCode: 201, message: 'Template cloned', data: out });
  } catch (err) {
    next(err);
  }
}

export async function cloneAllLabTemplates(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const out = await labTemplates.cloneAllLabTemplates(
      req.user!.tenantId,
      req.user!.roles ?? [],
      req.body,
    );
    sendResponse({ res, message: 'Templates cloned', data: out });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Lab Unit Groups + Units
// ============================================================

export async function listLabUnitGroups(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const groups = await labUnits.listUnitGroups(req.user!.tenantId);
    sendResponse({ res, message: 'Unit groups retrieved', data: groups });
  } catch (err) {
    next(err);
  }
}

export async function createLabUnitGroup(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const group = await labUnits.createUnitGroup(
      req.user!.tenantId,
      req.user!.roles ?? [],
      req.body,
    );
    sendResponse({ res, statusCode: 201, message: 'Unit group created', data: group });
  } catch (err) {
    next(err);
  }
}

export async function updateLabUnitGroup(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const group = await labUnits.updateUnitGroup(
      req.user!.tenantId,
      req.user!.roles ?? [],
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Unit group updated', data: group });
  } catch (err) {
    next(err);
  }
}

export async function deleteLabUnitGroup(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const out = await labUnits.deleteUnitGroup(
      req.user!.tenantId,
      req.user!.roles ?? [],
      req.params.id as string,
    );
    sendResponse({ res, message: 'Unit group deleted', data: out });
  } catch (err) {
    next(err);
  }
}

export async function createLabUnit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const unit = await labUnits.createUnit(
      req.user!.tenantId,
      req.user!.roles ?? [],
      req.body,
    );
    sendResponse({ res, statusCode: 201, message: 'Unit created', data: unit });
  } catch (err) {
    next(err);
  }
}

export async function updateLabUnit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const unit = await labUnits.updateUnit(
      req.user!.tenantId,
      req.user!.roles ?? [],
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Unit updated', data: unit });
  } catch (err) {
    next(err);
  }
}

export async function deleteLabUnit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const out = await labUnits.deleteUnit(
      req.user!.tenantId,
      req.user!.roles ?? [],
      req.params.id as string,
    );
    sendResponse({ res, message: 'Unit deleted', data: out });
  } catch (err) {
    next(err);
  }
}
