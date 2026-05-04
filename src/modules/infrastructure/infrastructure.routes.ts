import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './infrastructure.controller';
import {
  createDepartmentSchema,
  updateDepartmentSchema,
  listDepartmentsSchema,
  departmentIdParamSchema,
  createFloorSchema,
  updateFloorSchema,
  listFloorsSchema,
  floorIdParamSchema,
  createWardSchema,
  updateWardSchema,
  listWardsSchema,
  wardIdParamSchema,
  createBedSchema,
  bulkCreateBedsSchema,
  updateBedSchema,
  listBedsSchema,
  bedAvailabilitySchema,
  bedIdParamSchema,
} from './infrastructure.validation';

export const infrastructureRoutes = Router();

// --- Departments ---
infrastructureRoutes.post('/departments', authenticate, requirePermission('departments', 'create'), validate(createDepartmentSchema), controller.createDepartment);
infrastructureRoutes.get('/departments', authenticate, requirePermission('departments', 'read'), validate(listDepartmentsSchema), controller.getDepartments);
infrastructureRoutes.get('/departments/:id', authenticate, requirePermission('departments', 'read'), validate(departmentIdParamSchema), controller.getDepartmentById);
infrastructureRoutes.put('/departments/:id', authenticate, requirePermission('departments', 'update'), validate(updateDepartmentSchema), controller.updateDepartment);
infrastructureRoutes.delete('/departments/:id', authenticate, requirePermission('departments', 'delete'), validate(departmentIdParamSchema), controller.deleteDepartment);

// --- Floors ---
infrastructureRoutes.post('/floors', authenticate, requirePermission('floors', 'create'), validate(createFloorSchema), controller.createFloor);
infrastructureRoutes.get('/floors', authenticate, requirePermission('floors', 'read'), validate(listFloorsSchema), controller.getFloors);
infrastructureRoutes.get('/floors/:id', authenticate, requirePermission('floors', 'read'), validate(floorIdParamSchema), controller.getFloorById);
infrastructureRoutes.put('/floors/:id', authenticate, requirePermission('floors', 'update'), validate(updateFloorSchema), controller.updateFloor);
infrastructureRoutes.delete('/floors/:id', authenticate, requirePermission('floors', 'delete'), validate(floorIdParamSchema), controller.deleteFloor);

// --- Wards ---
infrastructureRoutes.post('/wards', authenticate, requirePermission('wards', 'create'), validate(createWardSchema), controller.createWard);
infrastructureRoutes.get('/wards', authenticate, requirePermission('wards', 'read'), validate(listWardsSchema), controller.getWards);
infrastructureRoutes.get('/wards/:id', authenticate, requirePermission('wards', 'read'), validate(wardIdParamSchema), controller.getWardById);
infrastructureRoutes.put('/wards/:id', authenticate, requirePermission('wards', 'update'), validate(updateWardSchema), controller.updateWard);
infrastructureRoutes.delete('/wards/:id', authenticate, requirePermission('wards', 'delete'), validate(wardIdParamSchema), controller.deleteWard);

// --- Beds ---
infrastructureRoutes.post('/beds', authenticate, requirePermission('beds', 'create'), validate(createBedSchema), controller.createBed);
infrastructureRoutes.post('/beds/bulk', authenticate, requirePermission('beds', 'create'), validate(bulkCreateBedsSchema), controller.bulkCreateBeds);
infrastructureRoutes.get('/beds', authenticate, requirePermission('beds', 'read'), validate(listBedsSchema), controller.getBeds);
infrastructureRoutes.get('/beds/availability', authenticate, requirePermission('beds', 'read'), validate(bedAvailabilitySchema), controller.getBedAvailability);
infrastructureRoutes.get('/occupancy', authenticate, requirePermission('beds', 'read'), controller.getOccupancy);
infrastructureRoutes.get('/beds/:id', authenticate, requirePermission('beds', 'read'), validate(bedIdParamSchema), controller.getBedById);
infrastructureRoutes.put('/beds/:id', authenticate, requirePermission('beds', 'update'), validate(updateBedSchema), controller.updateBed);
infrastructureRoutes.delete('/beds/:id', authenticate, requirePermission('beds', 'delete'), validate(bedIdParamSchema), controller.deleteBed);
