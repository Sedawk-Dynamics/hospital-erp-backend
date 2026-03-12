import { Router } from 'express';
import { tenantsController } from './tenants.controller';
import { usersController } from '../users/users.controller';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createTenantSchema,
  updateTenantSchema,
  createSubscriptionSchema,
  updateFeatureToggleSchema,
  tenantIdParamSchema,
} from './tenants.validation';
import { createUserSchema } from '../users/users.validation';

const router = Router();

router.post(
  '/',
  authenticate,
  requireRoles('super_admin'),
  validate(createTenantSchema),
  tenantsController.create,
);

router.get(
  '/',
  authenticate,
  requireRoles('super_admin'),
  tenantsController.findAll,
);

router.get(
  '/:id',
  authenticate,
  requireRoles('super_admin', 'admin'),
  validate(tenantIdParamSchema),
  tenantsController.findById,
);

router.put(
  '/:id',
  authenticate,
  requireRoles('super_admin'),
  validate(updateTenantSchema),
  tenantsController.update,
);

router.delete(
  '/:id',
  authenticate,
  requireRoles('super_admin'),
  validate(tenantIdParamSchema),
  tenantsController.deactivate,
);

router.post(
  '/:id/subscriptions',
  authenticate,
  requireRoles('super_admin'),
  validate(createSubscriptionSchema),
  tenantsController.createSubscription,
);

router.post(
  '/:id/bootstrap-roles',
  authenticate,
  requireRoles('super_admin'),
  validate(tenantIdParamSchema),
  tenantsController.bootstrapRoles,
);

router.put(
  '/:id/features',
  authenticate,
  requireRoles('super_admin', 'admin'),
  validate(updateFeatureToggleSchema),
  tenantsController.updateFeatureToggle,
);

// ─── TENANT-SCOPED USER MANAGEMENT (SUPER ADMIN) ───────────────────────

router.get(
  '/:tenantId/users',
  authenticate,
  requireRoles('super_admin'),
  usersController.findAllForTenant,
);

router.post(
  '/:tenantId/users',
  authenticate,
  requireRoles('super_admin'),
  validate(createUserSchema),
  usersController.createForTenant,
);

router.get(
  '/:tenantId/roles',
  authenticate,
  requireRoles('super_admin'),
  usersController.getRolesForTenant,
);

router.get(
  '/:tenantId/users/stats',
  authenticate,
  requireRoles('super_admin'),
  usersController.getStatsForTenant,
);

export { router as tenantRoutes };
