import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as service from './dicom.service';

export async function createStudy(
  req: AuthenticatedRequest, res: Response, next: NextFunction,
) {
  try {
    const data = await service.createStudy(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'DICOM study saved', data });
  } catch (err) { next(err); }
}

export async function addInstance(
  req: AuthenticatedRequest, res: Response, next: NextFunction,
) {
  try {
    const data = await service.addInstance(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, statusCode: 201, message: 'DICOM instance saved', data });
  } catch (err) { next(err); }
}

export async function getStudies(
  req: AuthenticatedRequest, res: Response, next: NextFunction,
) {
  try {
    const result = await service.getStudies(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.studies, result.total, result.page, result.limit, 'Studies retrieved');
  } catch (err) { next(err); }
}

export async function getStudyById(
  req: AuthenticatedRequest, res: Response, next: NextFunction,
) {
  try {
    const data = await service.getStudyById(req.user!.tenantId, req.params.id as string);
    // Convert BigInt fields to numbers for JSON serialization.
    const serialized = JSON.parse(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
    sendResponse({ res, message: 'Study retrieved', data: serialized });
  } catch (err) { next(err); }
}

export async function getStudiesByPatient(
  req: AuthenticatedRequest, res: Response, next: NextFunction,
) {
  try {
    const data = await service.getStudiesByPatient(
      req.user!.tenantId,
      req.params.patientId as string,
    );
    sendResponse({ res, message: 'Patient studies retrieved', data });
  } catch (err) { next(err); }
}

export async function getWorklist(
  req: AuthenticatedRequest, res: Response, next: NextFunction,
) {
  try {
    const data = await service.getWorklist(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'DICOM worklist retrieved', data });
  } catch (err) { next(err); }
}
