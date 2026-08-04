import { Router } from 'express';
import { usersController } from './users.controller';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission, requireRoles } from '../../middleware/authorize';
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

// Lookup user by phone/email — front-desk uses this to find an existing account-holder
// when registering a new family-member patient profile. Gated by patients:create since
// that's the capability the lookup feeds into.
userRouter.get(
  '/by-contact',
  authenticate,
  requirePermission('patients', 'create'),
  usersController.findByContact,
);

// Super admin: list all users across all hospital tenants
userRouter.get(
  '/all',
  authenticate,
  requireRoles('super_admin'),
  usersController.findAllGlobal,
);

// Super admin: hard-delete a user (any tenant)
userRouter.delete(
  '/all/:id',
  authenticate,
  requireRoles('super_admin'),
  usersController.hardDeleteGlobal,
);

// Super admin: toggle active status (any tenant)
userRouter.patch(
  '/all/:id',
  authenticate,
  requireRoles('super_admin'),
  usersController.toggleActiveGlobal,
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

// Literal path — must precede `/:id`, which would otherwise match
// "permissions" as an id and reject it as an invalid UUID.
roleRouter.get(
  '/permissions',
  authenticate,
  usersController.getPermissions,
);

roleRouter.put(
  '/:id',
  authenticate,
  requirePermission('roles', 'update'),
  validate(updateRoleSchema),
  usersController.updateRole,
);


roleRouter.post(
  '/:id/permissions',
  authenticate,
  requirePermission('roles', 'update'),
  validate(assignPermissionsSchema),
  usersController.assignPermissions,
);

export { userRouter, roleRouter };
