import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as service from './nursing-forms.service';

// Tiny helpers — every route follows the same pattern: pull tenantId/
// userId/roles off the auth payload, hand off to the service.

function ctx(req: AuthenticatedRequest) {
  return {
    tenantId: req.user!.tenantId,
    userId: req.user!.userId,
    roles: req.user!.roles ?? [],
  };
}

// ── Admission Assessment ─────────────────────────────────

export async function createAdmissionAssessment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.createAdmissionAssessment(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Admission assessment recorded', data });
  } catch (err) {
    next(err);
  }
}

export async function listAdmissionAssessments(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId } = ctx(req);
    const { items, total, page, limit } = await service.listAdmissionAssessments(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, items, total, page, limit, 'Admission assessments retrieved');
  } catch (err) {
    next(err);
  }
}

// ── Pain Assessment ──────────────────────────────────────

export async function createPainAssessment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.createPainAssessment(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Pain assessment recorded', data });
  } catch (err) {
    next(err);
  }
}

export async function listPainAssessments(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId } = ctx(req);
    const { items, total, page, limit } = await service.listPainAssessments(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, items, total, page, limit, 'Pain assessments retrieved');
  } catch (err) {
    next(err);
  }
}

// ── Fall Risk ────────────────────────────────────────────

export async function createFallRisk(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.createFallRisk(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Fall risk assessment recorded', data });
  } catch (err) {
    next(err);
  }
}

export async function listFallRisks(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId } = ctx(req);
    const { items, total, page, limit } = await service.listFallRisks(tenantId, req.query as any);
    sendPaginatedResponse(res, items, total, page, limit, 'Fall risk assessments retrieved');
  } catch (err) {
    next(err);
  }
}

// ── Intake / Output ──────────────────────────────────────

export async function createIntakeOutput(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.createIntakeOutput(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Intake/output recorded', data });
  } catch (err) {
    next(err);
  }
}

export async function listIntakeOutput(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId } = ctx(req);
    const { items, total, page, limit } = await service.listIntakeOutput(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, items, total, page, limit, 'Intake/output records retrieved');
  } catch (err) {
    next(err);
  }
}

// ── Wound Care ───────────────────────────────────────────

export async function createWoundCare(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.createWoundCare(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Wound care recorded', data });
  } catch (err) {
    next(err);
  }
}

export async function listWoundCare(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId } = ctx(req);
    const { items, total, page, limit } = await service.listWoundCare(tenantId, req.query as any);
    sendPaginatedResponse(res, items, total, page, limit, 'Wound care records retrieved');
  } catch (err) {
    next(err);
  }
}

// ── Nursing Daily Note ───────────────────────────────────

export async function createNursingNote(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId, userId, roles } = ctx(req);
    const data = await service.createNursingNote(tenantId, userId, roles, req.body);
    sendResponse({ res, statusCode: 201, message: 'Nursing note recorded', data });
  } catch (err) {
    next(err);
  }
}

export async function listNursingNotes(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId } = ctx(req);
    const { items, total, page, limit } = await service.listNursingNotes(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, items, total, page, limit, 'Nursing notes retrieved');
  } catch (err) {
    next(err);
  }
}

// ── Aggregate summary (one call powers the doctor read-only panel) ──

export async function getPatientSummary(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId } = ctx(req);
    const data = await service.getPatientFormsSummary(tenantId, req.params.patientId as string);
    sendResponse({ res, message: 'Patient nursing-forms summary retrieved', data });
  } catch (err) {
    next(err);
  }
}
