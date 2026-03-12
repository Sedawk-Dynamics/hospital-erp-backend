import { Router } from 'express';
import { usersController } from './users.controller';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createUserSchema,
  updateUserSchema,
  assignRoleSchema,
  removeRoleParamsSchema,
  createRoleSchema,
  updateRoleSchema,
  assignPermissionsSchema,
  userIdParamSchema,
} from './users.validation';

const userRouter = Router();
const roleRouter = Router();

// ─── USER ROUTES ────────────────────────────────────────────────────────

userRouter.get(
  '/stats',
  authenticate,
  requirePermission('users', 'read'),
  usersController.getStats,
);

userRouter.post(
  '/',
  authenticate,
  requirePermission('users', 'create'),
  validate(createUserSchema),
  usersController.create,
);

userRouter.get(
  '/',
  authenticate,
  requirePermission('users', 'read'),
  usersController.findAll,
);

userRouter.get(
  '/:id',
  authenticate,
  requirePermission('users', 'read'),
  validate(userIdParamSchema),
  usersController.findById,
);

userRouter.put(
  '/:id',
  authenticate,
  requirePermission('users', 'update'),
  validate(updateUserSchema),
  usersController.update,
);

userRouter.delete(
  '/:id',
  authenticate,
  requirePermission('users', 'delete'),
  validate(userIdParamSchema),
  usersController.deactivate,
);

userRouter.post(
  '/:id/roles',
  authenticate,
  requirePermission('roles', 'update'),
  validate(assignRoleSchema),
  usersController.assignRole,
);

userRouter.delete(
  '/:id/roles/:roleId',
  authenticate,
  requirePermission('roles', 'update'),
  validate(removeRoleParamsSchema),
  usersController.removeRole,
);

// ─── ROLE ROUTES ────────────────────────────────────────────────────────

roleRouter.get(
  '/',
  authenticate,
  usersController.getRoles,
);

roleRouter.post(
  '/',
  authenticate,
  requirePermission('roles', 'create'),
  validate(createRoleSchema),
  usersController.createRole,
);

roleRouter.put(
  '/:id',
  authenticate,
  requirePermission('roles', 'update'),
  validate(updateRoleSchema),
  usersController.updateRole,
);

roleRouter.get(
  '/permissions',
  authenticate,
  usersController.getPermissions,
);

roleRouter.post(
  '/:id/permissions',
  authenticate,
  requirePermission('roles', 'update'),
  validate(assignPermissionsSchema),
  usersController.assignPermissions,
);

export { userRouter, roleRouter };
