import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import { AppError } from '../../shared/appError';
import * as patientsService from './patients.service';

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
