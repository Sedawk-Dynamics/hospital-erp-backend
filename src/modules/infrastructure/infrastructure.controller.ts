import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as service from './infrastructure.service';

// Departments
export async function createDepartment(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createDepartment(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Department created', data });
  } catch (err) { next(err); }
}
export async function getDepartments(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getDepartments(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.departments, result.total, result.page, result.limit, 'Departments retrieved');
  } catch (err) { next(err); }
}
export async function getDepartmentById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getDepartmentById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Department retrieved', data });
  } catch (err) { next(err); }
}
export async function updateDepartment(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateDepartment(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Department updated', data });
  } catch (err) { next(err); }
}
export async function deleteDepartment(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await service.deleteDepartment(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Department deleted' });
  } catch (err) { next(err); }
}

// Wards
export async function createWard(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createWard(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Ward created', data });
  } catch (err) { next(err); }
}
export async function getWards(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getWards(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.wards, result.total, result.page, result.limit, 'Wards retrieved');
  } catch (err) { next(err); }
}
export async function getWardById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getWardById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Ward retrieved', data });
  } catch (err) { next(err); }
}
export async function updateWard(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateWard(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Ward updated', data });
  } catch (err) { next(err); }
}
export async function deleteWard(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await service.deleteWard(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Ward deleted' });
  } catch (err) { next(err); }
}

// Floors
export async function createFloor(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createFloor(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Floor created', data });
  } catch (err) { next(err); }
}
export async function getFloors(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getFloors(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.floors, result.total, result.page, result.limit, 'Floors retrieved');
  } catch (err) { next(err); }
}
export async function getFloorById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getFloorById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Floor retrieved', data });
  } catch (err) { next(err); }
}
export async function updateFloor(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateFloor(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Floor updated', data });
  } catch (err) { next(err); }
}
export async function deleteFloor(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await service.deleteFloor(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Floor deleted' });
  } catch (err) { next(err); }
}

// Beds
export async function createBed(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createBed(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Bed created', data });
  } catch (err) { next(err); }
}
export async function bulkCreateBeds(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.bulkCreateBeds(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: `${data.count} beds created`, data });
  } catch (err) { next(err); }
}
export async function getBeds(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getBeds(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.beds, result.total, result.page, result.limit, 'Beds retrieved');
  } catch (err) { next(err); }
}
export async function getBedById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getBedById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Bed retrieved', data });
  } catch (err) { next(err); }
}
export async function updateBed(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateBed(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Bed updated', data });
  } catch (err) { next(err); }
}
export async function deleteBed(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await service.deleteBed(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Bed deleted' });
  } catch (err) { next(err); }
}
export async function getBedAvailability(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getBedAvailability(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Bed availability retrieved', data });
  } catch (err) { next(err); }
}

// Occupancy
export async function getOccupancy(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const { wardId, floorId, departmentId } = req.query as { wardId?: string; floorId?: string; departmentId?: string };
    const data = await service.getOccupancy(tenantId, { wardId, floorId, departmentId });
    sendResponse({ res, message: 'Occupancy data retrieved', data });
  } catch (err) { next(err); }
}
