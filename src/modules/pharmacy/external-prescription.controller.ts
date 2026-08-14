import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import { AppError } from '../../shared/appError';
import { getFileUrl } from '../../services/upload.service';
import * as service from './external-prescription.service';
import { parsePrescriptionFile } from './external-prescription.service';

/**
 * Read a photo of a paper prescription and return the fields it could make out.
 *
 * The response is a DRAFT for the operator to confirm — it deliberately does not
 * create anything. A mis-read registration number would make the statutory
 * register wrong, so a human always signs off before the record exists.
 */
export async function ocrPrescription(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) throw AppError.badRequest('No prescription image uploaded');
    const parsed = await parsePrescriptionFile(file);
    sendResponse({
      res,
      message: 'Prescription read',
      // The stored image doubles as the retained copy a Schedule X sale needs,
      // so its URL comes back with the draft and is saved alongside the record.
      data: { ...parsed, imageUrl: getFileUrl(file.filename) },
    });
  } catch (err) {
    next(err);
  }
}

export async function createExternalPrescription(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await service.createExternalPrescription(
      req.user!.tenantId,
      req.user!.userId,
      req.body,
    );
    sendResponse({ res, statusCode: 201, message: 'Outside prescription recorded', data });
  } catch (err) {
    next(err);
  }
}

export async function getExternalPrescription(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await service.getExternalPrescription(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Outside prescription retrieved', data });
  } catch (err) {
    next(err);
  }
}

export async function listExternalPrescriptions(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { items, total, page, limit } = await service.listExternalPrescriptions(
      req.user!.tenantId,
      req.query as never,
    );
    sendPaginatedResponse(res, items, total, page, limit, 'Outside prescriptions retrieved');
  } catch (err) {
    next(err);
  }
}
