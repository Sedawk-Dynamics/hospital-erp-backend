import { Router } from 'express';
import { hospitalsController } from './hospitals.controller';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createHospitalSchema,
  updateHospitalSchema,
  hospitalIdParamSchema,
} from './hospitals.validation';

const router = Router();

// Create a hospital (super_admin or admin)
// After switchHospital the JWT role includes 'admin', so we allow it here.
// The service layer handles ownership + subscription limit checks.
router.post(
  '/',
  authenticate,
  requireRoles('admin', 'super_admin'),
  validate(createHospitalSchema),
  hospitalsController.createHospital,
);

// Switch to a hospital (generates new tokens for the hospital tenant)
router.post(
  '/switch/:tenantId',
  authenticate,
  hospitalsController.switchHospital,
);

// List my hospitals (any authenticated user)
router.get(
  '/my',
  authenticate,
  hospitalsController.listMyHospitals,
);

// Get hospital creation limit for current user
router.get(
  '/my/limit',
  authenticate,
  hospitalsController.getHospitalLimit,
);

// Get a specific hospital I own
router.get(
  '/my/:id',
  authenticate,
  validate(hospitalIdParamSchema),
  hospitalsController.getMyHospital,
);

// Update a specific hospital I own
router.put(
  '/my/:id',
  authenticate,
  validate(updateHospitalSchema),
  hospitalsController.updateMyHospital,
);

export { router as hospitalsRoutes };
