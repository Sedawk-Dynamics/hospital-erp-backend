import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as prescriptionsService from './prescriptions.service';
import { getDrugHistoryForDoctor } from './drug-history.service';
import { streamPrescriptionPdf } from './prescription-pdf';
import { getHospitalBranding } from '../hospital-branding/hospital-branding.service';

export async function getDrugHistory(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const patientId = req.params.patientId as string;
    const data = await getDrugHistoryForDoctor(tenantId, patientId);
    sendResponse({ res, message: 'Drug history retrieved', data });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Prescriptions
// ============================================================

export async function createPrescription(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const prescription = await prescriptionsService.createPrescription(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Prescription created successfully',
      data: prescription,
    });
  } catch (err) {
    next(err);
  }
}

export async function getPrescriptions(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { prescriptions, total, page, limit } = await prescriptionsService.getPrescriptions(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, prescriptions, total, page, limit, 'Prescriptions retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getPrescriptionById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const prescription = await prescriptionsService.getPrescriptionById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Prescription retrieved successfully',
      data: prescription,
    });
  } catch (err) {
    next(err);
  }
}

// Branded prescription PDF (uses the hospital admin's PDF Builder letterhead).
export async function downloadPrescriptionPdf(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const [prescription, branding] = await Promise.all([
      prescriptionsService.getPrescriptionById(tenantId, req.params.id as string),
      getHospitalBranding(tenantId),
    ]);
    streamPrescriptionPdf(res, prescription as never, branding);
  } catch (err) {
    next(err);
  }
}

export async function updatePrescription(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const prescription = await prescriptionsService.updatePrescription(
      tenantId,
      req.params.id as string,
      req.body,
    );
    sendResponse({
      res,
      message: 'Prescription updated successfully',
      data: prescription,
    });
  } catch (err) {
    next(err);
  }
}

export async function cancelPrescription(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const prescription = await prescriptionsService.cancelPrescription(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Prescription cancelled successfully',
      data: prescription,
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Prescription Items
// ============================================================

export async function addPrescriptionItem(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const item = await prescriptionsService.addPrescriptionItem(
      tenantId,
      req.params.id as string,
      req.body,
    );
    sendResponse({
      res,
      statusCode: 201,
      message: 'Prescription item added successfully',
      data: item,
    });
  } catch (err) {
    next(err);
  }
}

export async function updatePrescriptionItem(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const item = await prescriptionsService.updatePrescriptionItem(
      tenantId,
      req.params.id as string,
      req.params.itemId as string,
      req.body,
    );
    sendResponse({
      res,
      message: 'Prescription item updated successfully',
      data: item,
    });
  } catch (err) {
    next(err);
  }
}

export async function removePrescriptionItem(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await prescriptionsService.removePrescriptionItem(
      tenantId,
      req.params.id as string,
      req.params.itemId as string,
    );
    sendResponse({
      res,
      message: 'Prescription item removed successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Medication Administration
// ============================================================

export async function recordAdministration(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const record = await prescriptionsService.recordAdministration(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Medication administration recorded successfully',
      data: record,
    });
  } catch (err) {
    next(err);
  }
}

export async function getAdministrationRecords(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { records, total, page, limit } = await prescriptionsService.getAdministrationRecords(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(
      res,
      records,
      total,
      page,
      limit,
      'Administration records retrieved successfully',
    );
  } catch (err) {
    next(err);
  }
}

export async function getAdministrationSchedule(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const schedule = await prescriptionsService.getAdministrationSchedule(
      tenantId,
      req.query as any,
    );
    sendResponse({
      res,
      message: 'Administration schedule retrieved successfully',
      data: schedule,
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// Allergy Check & Formulary Search
// ============================================================

export async function checkAllergy(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await prescriptionsService.checkAllergy(tenantId, req.query as any);
    sendResponse({
      res,
      message: 'Allergy check completed',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function searchFormulary(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const drugs = await prescriptionsService.searchFormulary(tenantId, req.query as any);
    sendResponse({
      res,
      message: 'Formulary search results',
      data: drugs,
    });
  } catch (err) {
    next(err);
  }
}

export async function checkInteractions(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await prescriptionsService.checkInteractions(tenantId, req.body);
    sendResponse({
      res,
      message: 'Drug interaction check complete',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
