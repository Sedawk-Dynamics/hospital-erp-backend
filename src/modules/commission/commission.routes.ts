import { Router } from 'express';
import { CommissionController } from './commission.controller';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  updateDefaultCommissionSchema,
  setHospitalCommissionSchema,
  hospitalCommissionParamsSchema,
} from './commission.validation';

const router = Router();
const controller = new CommissionController();

// All routes require super_admin
router.use(authenticate, requireRoles('super_admin'));

// Default commission settings
router.get('/default', controller.getDefaultCommission);
router.put('/default', validate(updateDefaultCommissionSchema), controller.updateDefaultCommission);

// Hospital-specific commission overrides
router.get('/hospitals', controller.listAllCommissions);
router.get('/hospitals/:tenantId', validate(hospitalCommissionParamsSchema), controller.getHospitalCommission);
router.put('/hospitals/:tenantId', validate(setHospitalCommissionSchema), controller.setHospitalCommission);
router.delete('/hospitals/:tenantId', validate(hospitalCommissionParamsSchema), controller.deleteHospitalCommission);

export { router as commissionRoutes };
