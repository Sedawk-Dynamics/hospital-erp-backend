import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as emergencyService from './emergency.service';

// Mint a temporary emergency patient and route it as OP or IP.
export async function createEmergencyPatient(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await emergencyService.createEmergencyPatient(
      req.user!.tenantId,
      req.user!.userId,
      req.body,
    );
    sendResponse({ res, statusCode: 201, message: 'Emergency patient created', data });
  } catch (err) {
    next(err);
  }
}

// List active temp emergency patients + their held charges and OP/IP context.
export async function listEmergencyPatients(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await emergencyService.listEmergencyPatients(req.user!.tenantId);
    sendResponse({ res, message: 'Emergency patients retrieved', data });
  } catch (err) {
    next(err);
  }
}

// Register a temp emergency patient in place as a permanent patient.
export async function registerEmergencyPatient(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await emergencyService.registerEmergencyPatient(
      req.user!.tenantId,
      req.user!.userId,
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Emergency patient registered', data });
  } catch (err) {
    next(err);
  }
}

// Connect a temp emergency patient to an already-registered patient.
export async function mergeEmergencyPatient(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await emergencyService.mergeEmergencyPatient(
      req.user!.tenantId,
      req.user!.userId,
      req.params.id as string,
      req.body.targetPatientId as string,
    );
    sendResponse({ res, message: 'Emergency patient connected', data });
  } catch (err) {
    next(err);
  }
}
