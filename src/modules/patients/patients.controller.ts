import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import { AppError } from '../../shared/appError';
import * as patientsService from './patients.service';
import * as tempService from './patients.temporary.service';

export async function create(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const patient = await patientsService.create(tenantId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Patient created successfully',
      data: patient,
    });
  } catch (err) {
    next(err);
  }
}

export async function findAll(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const { patients, total, page, limit } = await patientsService.findAll(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, patients, total, page, limit, 'Patients retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function findById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const patient = await patientsService.findById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Patient retrieved successfully',
      data: patient,
    });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const patient = await patientsService.update(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Patient updated successfully',
      data: patient,
    });
  } catch (err) {
    next(err);
  }
}

export async function searchPatients(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const patients = await patientsService.search(tenantId, req.query as any);
    sendResponse({
      res,
      message: 'Search results',
      data: patients,
    });
  } catch (err) {
    next(err);
  }
}

// Global (cross-hospital) lookup by phone/ABHA — find a person already on the
// ERP so the desk pre-fills instead of re-registering. Not tenant-scoped.
export async function globalLookup(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await patientsService.globalLookup({
      phone: (req.query.phone as string) || undefined,
      abha: (req.query.abha as string) || undefined,
    });
    sendResponse({ res, message: 'Global patient lookup', data: result });
  } catch (err) {
    next(err);
  }
}

// Unified cross-hospital history for a patient (read-only, aggregates every
// hospital the same person has visited).
export async function globalHistory(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await patientsService.getGlobalPatientHistory(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Unified patient history', data });
  } catch (err) {
    next(err);
  }
}

export async function addEmergencyContact(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const contact = await patientsService.addEmergencyContact(req.params.id as string, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Emergency contact added successfully',
      data: contact,
    });
  } catch (err) {
    next(err);
  }
}

export async function addAllergy(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const allergy = await patientsService.addAllergy(req.params.id as string, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Allergy added successfully',
      data: allergy,
    });
  } catch (err) {
    next(err);
  }
}

export async function addFamilyHistory(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const history = await patientsService.addFamilyHistory(req.params.id as string, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Family history added successfully',
      data: history,
    });
  } catch (err) {
    next(err);
  }
}

export async function addDocument(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const document = await patientsService.addDocument(req.params.id as string, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Document added successfully',
      data: document,
    });
  } catch (err) {
    next(err);
  }
}

export async function getVisitHistory(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const visits = await patientsService.getVisitHistory(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Visit history retrieved successfully',
      data: visits,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * List all patient profiles linked to a given user, scoped to current tenant.
 * Used by front-desk to show the family profiles already registered under a user.
 */
export async function findByUser(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const profiles = await patientsService.findByUser(
      req.params.userId as string,
      tenantId,
    );
    sendResponse({
      res,
      message: 'User patient profiles',
      data: profiles,
    });
  } catch (err) {
    next(err);
  }
}

// ── Temporary (provisional) patient ─────────────────────────

export async function createTemporary(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const patient = await tempService.createTemporaryPatient(
      req.user!.tenantId,
      req.user!.userId,
      req.body,
    );
    sendResponse({
      res,
      statusCode: 201,
      message: 'Temporary patient created successfully',
      data: patient,
    });
  } catch (err) {
    next(err);
  }
}

export async function registerTemporary(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const patient = await tempService.registerTemporaryPatient(
      req.user!.tenantId,
      req.user!.userId,
      req.params.id as string,
      req.body,
    );
    sendResponse({
      res,
      message: 'Temporary patient registered successfully',
      data: patient,
    });
  } catch (err) {
    next(err);
  }
}

export async function mergeTemporary(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await tempService.mergeTemporaryPatient(
      req.user!.tenantId,
      req.user!.userId,
      req.params.id as string,
      req.body.targetPatientId,
    );
    sendResponse({
      res,
      message: 'Temporary patient connected to existing patient successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
