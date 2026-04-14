import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as labService from './lab.service';

// ============================================================
// Lab Departments
// ============================================================

export async function createLabDepartment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const department = await labService.createLabDepartment(tenantId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Lab department created successfully',
      data: department,
    });
  } catch (err) {
    next(err);
  }
}

export async function getLabDepartments(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { departments, total, page, limit } = await labService.getLabDepartments(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, departments, total, page, limit, 'Lab departments retrieved');
  } catch (err) {
    next(err);
  }
}

export async function updateLabDepartment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const department = await labService.updateLabDepartment(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Lab department updated successfully',
      data: department,
    });
  } catch (err) {
    next(err);
  }
}

export async function deleteLabDepartment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const department = await labService.deleteLabDepartment(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Lab department deleted successfully',
      data: department,
    });
  } catch (err) {
    next(err);
  }
}

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
    const test = await labService.createTest(tenantId, req.body);
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
    const test = await labService.updateTest(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Lab test updated successfully',
      data: test,
    });
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
    const order = await labService.cancelLabOrder(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Lab order cancelled successfully',
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
    const sample = await labService.updateSampleStatus(tenantId, req.params.id as string, req.body);
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
    const sample = await labService.rejectSample(tenantId, req.params.id as string, req.body);
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
    const result = await labService.verifyResult(tenantId, req.params.id as string, userId);
    sendResponse({
      res,
      message: 'Result verified successfully',
      data: result,
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
    const report = await labService.generateLabReport(
      tenantId,
      req.params.orderId as string,
      userId,
      reportContent,
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
