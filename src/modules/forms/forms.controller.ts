import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as service from './forms.service';

function ctx(req: AuthenticatedRequest) {
  return {
    tenantId: req.user!.tenantId,
    userId: req.user!.userId,
    roles: req.user!.roles ?? [],
  };
}

// ── Templates (super-admin) ──────────────────────────────────

export async function listTemplates(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { items, total, page, limit } = await service.listTemplates(req.query as never);
    sendPaginatedResponse(res, items, total, page, limit, 'Form templates retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getTemplate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getTemplate(req.params.id as string);
    sendResponse({ res, message: 'Form template retrieved', data });
  } catch (err) {
    next(err);
  }
}

export async function createTemplate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { userId, roles } = ctx(req);
    const data = await service.createTemplate(userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Form template created', data });
  } catch (err) {
    next(err);
  }
}

export async function updateTemplate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { roles } = ctx(req);
    const data = await service.updateTemplate(roles, req.params.id as string, req.body);
    sendResponse({ res, message: 'Form template updated', data });
  } catch (err) {
    next(err);
  }
}

export async function deleteTemplate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { roles } = ctx(req);
    const data = await service.deleteTemplate(roles, req.params.id as string);
    sendResponse({ res, message: 'Form template deleted', data });
  } catch (err) {
    next(err);
  }
}

// ── Hospital forms ───────────────────────────────────────────

export async function listHospitalForms(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId } = ctx(req);
    const { items, total, page, limit } = await service.listHospitalForms(tenantId, req.query as never);
    sendPaginatedResponse(res, items, total, page, limit, 'Hospital forms retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getHospitalForm(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId } = ctx(req);
    const data = await service.getHospitalForm(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Form retrieved', data });
  } catch (err) {
    next(err);
  }
}

export async function createHospitalForm(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.createHospitalForm(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Form created', data });
  } catch (err) {
    next(err);
  }
}

export async function updateHospitalForm(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, roles } = ctx(req);
    const data = await service.updateHospitalForm(tenantId, roles, req.params.id as string, req.body);
    sendResponse({ res, message: 'Form updated', data });
  } catch (err) {
    next(err);
  }
}

export async function cloneTemplate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.cloneTemplateToHospital(
      tenantId,
      userId,
      roles,
      req.params.templateId as string,
      req.body,
    );
    sendResponse({ res, statusCode: 201, message: 'Template cloned', data });
  } catch (err) {
    next(err);
  }
}

export async function archiveHospitalForm(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.archiveHospitalForm(tenantId, userId, roles, req.params.id as string, req.body);
    sendResponse({ res, message: 'Form archived', data });
  } catch (err) {
    next(err);
  }
}

export async function restoreHospitalForm(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, roles } = ctx(req);
    const data = await service.restoreHospitalForm(tenantId, roles, req.params.id as string);
    sendResponse({ res, message: 'Form restored', data });
  } catch (err) {
    next(err);
  }
}

// ── Submissions ──────────────────────────────────────────────

export async function createSubmission(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId } = ctx(req);
    const data = await service.createSubmission(tenantId, userId, req.params.id as string, req.body);
    sendResponse({ res, statusCode: 201, message: 'Submission saved', data });
  } catch (err) {
    next(err);
  }
}

export async function listSubmissions(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId } = ctx(req);
    const { items, total, page, limit } = await service.listSubmissions(tenantId, req.query as never);
    sendPaginatedResponse(res, items, total, page, limit, 'Submissions retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getSubmission(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId } = ctx(req);
    const data = await service.getSubmission(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Submission retrieved', data });
  } catch (err) {
    next(err);
  }
}
