import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as clinicalService from './clinical.service';

// ==================== Visits ====================

export async function createVisit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const visit = await clinicalService.createVisit(tenantId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Visit created successfully',
      data: visit,
    });
  } catch (err) {
    next(err);
  }
}

export async function getVisits(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { visits, total, page, limit } = await clinicalService.getVisits(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, visits, total, page, limit, 'Visits retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getVisitById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const visit = await clinicalService.getVisitById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Visit retrieved successfully',
      data: visit,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateVisit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const visit = await clinicalService.updateVisit(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Visit updated successfully',
      data: visit,
    });
  } catch (err) {
    next(err);
  }
}

export async function closeVisit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const visit = await clinicalService.closeVisit(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Visit closed successfully',
      data: visit,
    });
  } catch (err) {
    next(err);
  }
}

// ==================== Admissions ====================

export async function createAdmission(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const admission = await clinicalService.createAdmission(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Admission created successfully',
      data: admission,
    });
  } catch (err) {
    next(err);
  }
}

export async function getAdmissions(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { admissions, total, page, limit } = await clinicalService.getAdmissions(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, admissions, total, page, limit, 'Admissions retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getAdmissionById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const admission = await clinicalService.getAdmissionById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Admission retrieved successfully',
      data: admission,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateAdmission(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const admission = await clinicalService.updateAdmission(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Admission updated successfully',
      data: admission,
    });
  } catch (err) {
    next(err);
  }
}

export async function dischargePatient(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const admission = await clinicalService.dischargePatient(tenantId, req.params.id as string, userId, req.body);
    sendResponse({
      res,
      message: 'Patient discharged successfully',
      data: admission,
    });
  } catch (err) {
    next(err);
  }
}

// ==================== Transfers ====================

export async function createTransfer(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const transfer = await clinicalService.createTransfer(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Transfer request created successfully',
      data: transfer,
    });
  } catch (err) {
    next(err);
  }
}

export async function getTransfers(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { transfers, total, page, limit } = await clinicalService.getTransfers(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, transfers, total, page, limit, 'Transfers retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getTransferById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const transfer = await clinicalService.getTransferById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Transfer retrieved successfully',
      data: transfer,
    });
  } catch (err) {
    next(err);
  }
}

export async function approveTransfer(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const transfer = await clinicalService.approveTransfer(tenantId, req.params.id as string, userId, req.body);
    sendResponse({
      res,
      message: 'Transfer status updated successfully',
      data: transfer,
    });
  } catch (err) {
    next(err);
  }
}

// ==================== Vitals ====================

export async function recordVitals(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const vital = await clinicalService.recordVitals(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Vitals recorded successfully',
      data: vital,
    });
  } catch (err) {
    next(err);
  }
}

export async function getAllVitals(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { vitals, total, page, limit } = await clinicalService.getAllVitals(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, vitals, total, page, limit, 'Vitals retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getVitals(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { vitals, total, page, limit } = await clinicalService.getVitals(
      tenantId,
      req.params.patientId as string,
      req.query as any,
    );
    sendPaginatedResponse(res, vitals, total, page, limit, 'Vitals retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getLatestVitals(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const vital = await clinicalService.getLatestVitals(tenantId, req.params.patientId as string);
    sendResponse({
      res,
      message: 'Latest vitals retrieved successfully',
      data: vital,
    });
  } catch (err) {
    next(err);
  }
}

// ==================== Diagnoses ====================

export async function addDiagnosis(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const diagnosis = await clinicalService.addDiagnosis(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Diagnosis added successfully',
      data: diagnosis,
    });
  } catch (err) {
    next(err);
  }
}

export async function getAllDiagnoses(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { diagnoses, total, page, limit } = await clinicalService.getAllDiagnoses(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, diagnoses, total, page, limit, 'Diagnoses retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getDiagnoses(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { diagnoses, total, page, limit } = await clinicalService.getDiagnoses(
      tenantId,
      req.params.patientId as string,
      req.query as any,
    );
    sendPaginatedResponse(res, diagnoses, total, page, limit, 'Diagnoses retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function updateDiagnosis(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const diagnosis = await clinicalService.updateDiagnosis(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Diagnosis updated successfully',
      data: diagnosis,
    });
  } catch (err) {
    next(err);
  }
}

export async function deleteDiagnosis(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    await clinicalService.deleteDiagnosis(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Diagnosis deleted successfully',
    });
  } catch (err) {
    next(err);
  }
}

// ==================== OT Requests ====================

export async function createOtRequest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const otRequest = await clinicalService.createOtRequest(tenantId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'OT request created successfully',
      data: otRequest,
    });
  } catch (err) {
    next(err);
  }
}

export async function getOtRequests(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { otRequests, total, page, limit } = await clinicalService.getOtRequests(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, otRequests, total, page, limit, 'OT requests retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getOtRequestById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const otRequest = await clinicalService.getOtRequestById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'OT request retrieved successfully',
      data: otRequest,
    });
  } catch (err) {
    next(err);
  }
}

// ==================== Reservations ====================

export async function createReservation(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const data = await clinicalService.createReservation(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Reservation created',
      data,
    });
  } catch (err) {
    next(err);
  }
}

export async function getReservations(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { reservations, total, page, limit } = await clinicalService.getReservations(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, reservations, total, page, limit, 'Reservations retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getReservationById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await clinicalService.getReservationById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Reservation retrieved',
      data,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateReservation(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await clinicalService.updateReservation(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Reservation updated',
      data,
    });
  } catch (err) {
    next(err);
  }
}

// ==================== Estimations ====================

export async function createEstimation(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const data = await clinicalService.createEstimation(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Estimation created',
      data,
    });
  } catch (err) {
    next(err);
  }
}

export async function getEstimations(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { estimations, total, page, limit } = await clinicalService.getEstimations(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, estimations, total, page, limit, 'Estimations retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getEstimationById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await clinicalService.getEstimationById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Estimation retrieved',
      data,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateEstimation(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await clinicalService.updateEstimation(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Estimation updated',
      data,
    });
  } catch (err) {
    next(err);
  }
}

// ==================== Clinical Orders (Nurse View) ====================

export async function getClinicalOrders(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const data = await clinicalService.getClinicalOrders(tenantId, req.query as any);
    sendResponse({
      res,
      message: 'Clinical orders retrieved',
      data,
    });
  } catch (err) {
    next(err);
  }
}

export async function acknowledgeClinicalOrder(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const data = await clinicalService.acknowledgeClinicalOrder(tenantId, userId, req.body);
    sendResponse({
      res,
      message: 'Order acknowledged',
      data,
    });
  } catch (err) {
    next(err);
  }
}
