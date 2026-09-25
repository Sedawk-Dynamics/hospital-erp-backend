import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as svc from './emar.service';

// ── Time slots ──────────────────────────────────────────────

export async function listTimeSlots(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.listTimeSlots(req.user!.tenantId);
    sendResponse({ res, message: 'Time slots retrieved', data });
  } catch (err) { next(err); }
}

export async function createTimeSlot(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.createTimeSlot(req.user!.tenantId, req.body);
    sendResponse({ res, message: 'Time slot created', data, statusCode: 201 });
  } catch (err) { next(err); }
}

export async function updateTimeSlot(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.updateTimeSlot(req.user!.tenantId, String(req.params.id), req.body);
    sendResponse({ res, message: 'Time slot updated', data });
  } catch (err) { next(err); }
}

export async function deleteTimeSlot(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.deleteTimeSlot(req.user!.tenantId, String(req.params.id));
    sendResponse({ res, message: 'Time slot deleted', data });
  } catch (err) { next(err); }
}

// ── Frequencies ─────────────────────────────────────────────

export async function listFrequencies(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.listFrequencies(req.user!.tenantId);
    sendResponse({ res, message: 'Frequencies retrieved', data });
  } catch (err) { next(err); }
}

export async function createFrequency(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.createFrequency(req.user!.tenantId, req.body);
    sendResponse({ res, message: 'Frequency created', data, statusCode: 201 });
  } catch (err) { next(err); }
}

export async function updateFrequency(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.updateFrequency(req.user!.tenantId, String(req.params.id), req.body);
    sendResponse({ res, message: 'Frequency updated', data });
  } catch (err) { next(err); }
}

export async function deleteFrequency(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.deleteFrequency(req.user!.tenantId, String(req.params.id));
    sendResponse({ res, message: 'Frequency deleted', data });
  } catch (err) { next(err); }
}

// ── Settings ────────────────────────────────────────────────

export async function getSettings(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.getSettings(req.user!.tenantId);
    sendResponse({ res, message: 'eMAR settings retrieved', data });
  } catch (err) { next(err); }
}

export async function updateSettings(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.updateSettings(req.user!.tenantId, req.body);
    sendResponse({ res, message: 'eMAR settings updated', data });
  } catch (err) { next(err); }
}

// ── Schedules ───────────────────────────────────────────────

export async function listSchedules(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { items, total, page, limit } = await svc.listSchedules(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, items, total, page, limit, 'Schedules retrieved');
  } catch (err) { next(err); }
}

export async function getSchedule(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.getScheduleById(req.user!.tenantId, String(req.params.id));
    sendResponse({ res, message: 'Schedule retrieved', data });
  } catch (err) { next(err); }
}

export async function getNdpsDoseContext(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { getPatientDoseContext } = await import('../ndps/ndps-patient-dose.service');
    const data = await getPatientDoseContext(req.user!.tenantId, String(req.params.id));
    sendResponse({ res, message: 'NDPS dose context retrieved', data });
  } catch (err) { next(err); }
}

export async function getNdpsPrescriptionItemContext(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { getPrescriptionItemDoseContext } = await import('../ndps/ndps-patient-dose.service');
    const data = await getPrescriptionItemDoseContext(req.user!.tenantId, String(req.params.id));
    sendResponse({ res, message: 'NDPS prescription item context retrieved', data });
  } catch (err) { next(err); }
}

// ── Dose actions ────────────────────────────────────────────

export async function giveDose(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.giveDose(req.user!.tenantId, req.user!.userId, String(req.params.id), req.body);
    sendResponse({ res, message: 'Dose recorded as given', data });
  } catch (err) { next(err); }
}

export async function holdDose(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.holdDose(req.user!.tenantId, req.user!.userId, String(req.params.id), req.body);
    sendResponse({ res, message: 'Dose held', data });
  } catch (err) { next(err); }
}

export async function refuseDose(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.refuseDose(req.user!.tenantId, req.user!.userId, String(req.params.id), req.body);
    sendResponse({ res, message: 'Dose marked refused', data });
  } catch (err) { next(err); }
}

export async function markMissed(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.markMissed(req.user!.tenantId, req.user!.userId, String(req.params.id), req.body);
    sendResponse({ res, message: 'Dose marked missed', data });
  } catch (err) { next(err); }
}

export async function amendDose(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.amendDose(req.user!.tenantId, req.user!.userId, String(req.params.id), req.body);
    sendResponse({ res, message: 'Dose amended', data });
  } catch (err) { next(err); }
}

export async function triggerPrn(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.triggerPrn(
      req.user!.tenantId,
      req.user!.userId,
      String(req.params.prescriptionItemId),
      req.body,
    );
    sendResponse({ res, message: 'PRN dose recorded', data, statusCode: 201 });
  } catch (err) { next(err); }
}

export async function catchUpDose(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.applyCatchUpDose(req.user!.tenantId, req.user!.userId, req.body);
    sendResponse({ res, message: 'Catch-up dose recorded', data, statusCode: 201 });
  } catch (err) { next(err); }
}

// ── Schedule generation ─────────────────────────────────────

export async function regenerate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.regenerate(req.user!.tenantId, String(req.params.prescriptionId));
    sendResponse({ res, message: 'Schedules regenerated', data });
  } catch (err) { next(err); }
}

// ── Audit ───────────────────────────────────────────────────

export async function getAudit(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await svc.getAudit(req.user!.tenantId, String(req.params.id));
    sendResponse({ res, message: 'Audit log retrieved', data });
  } catch (err) { next(err); }
}

// ── Lifecycle tick (admin/cron) ─────────────────────────────

export async function tick(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await svc.tickLifecycle(req.user!.tenantId);
    sendResponse({ res, message: 'Lifecycle tick complete', data: result });
  } catch (err) { next(err); }
}
