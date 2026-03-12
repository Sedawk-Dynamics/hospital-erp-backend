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
  createWardSchema,
  updateWardSchema,
  listWardsSchema,
  wardIdParamSchema,
  createRoomSchema,
  updateRoomSchema,
  listRoomsSchema,
  roomIdParamSchema,
  createBedSchema,
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

// --- Wards ---
infrastructureRoutes.post('/wards', authenticate, requirePermission('wards', 'create'), validate(createWardSchema), controller.createWard);
infrastructureRoutes.get('/wards', authenticate, requirePermission('wards', 'read'), validate(listWardsSchema), controller.getWards);
infrastructureRoutes.get('/wards/:id', authenticate, requirePermission('wards', 'read'), validate(wardIdParamSchema), controller.getWardById);
infrastructureRoutes.put('/wards/:id', authenticate, requirePermission('wards', 'update'), validate(updateWardSchema), controller.updateWard);
infrastructureRoutes.delete('/wards/:id', authenticate, requirePermission('wards', 'delete'), validate(wardIdParamSchema), controller.deleteWard);

// --- Rooms ---
infrastructureRoutes.post('/rooms', authenticate, requirePermission('rooms', 'create'), validate(createRoomSchema), controller.createRoom);
infrastructureRoutes.get('/rooms', authenticate, requirePermission('rooms', 'read'), validate(listRoomsSchema), controller.getRooms);
infrastructureRoutes.get('/rooms/:id', authenticate, requirePermission('rooms', 'read'), validate(roomIdParamSchema), controller.getRoomById);
infrastructureRoutes.put('/rooms/:id', authenticate, requirePermission('rooms', 'update'), validate(updateRoomSchema), controller.updateRoom);
infrastructureRoutes.delete('/rooms/:id', authenticate, requirePermission('rooms', 'delete'), validate(roomIdParamSchema), controller.deleteRoom);

// --- Beds ---
infrastructureRoutes.post('/beds', authenticate, requirePermission('beds', 'create'), validate(createBedSchema), controller.createBed);
infrastructureRoutes.get('/beds', authenticate, requirePermission('beds', 'read'), validate(listBedsSchema), controller.getBeds);
infrastructureRoutes.get('/beds/availability', authenticate, requirePermission('beds', 'read'), validate(bedAvailabilitySchema), controller.getBedAvailability);
infrastructureRoutes.get('/beds/:id', authenticate, requirePermission('beds', 'read'), validate(bedIdParamSchema), controller.getBedById);
infrastructureRoutes.put('/beds/:id', authenticate, requirePermission('beds', 'update'), validate(updateBedSchema), controller.updateBed);
infrastructureRoutes.delete('/beds/:id', authenticate, requirePermission('beds', 'delete'), validate(bedIdParamSchema), controller.deleteBed);
