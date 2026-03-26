import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createOnlineOrder,
  verifyOnlinePayment,
  handleWebhook,
  getBankStatus,
} from './online-payments.controller';
import {
  createOnlineOrderSchema,
  verifyOnlinePaymentSchema,
} from './online-payments.validation';

const router = Router();

// Webhook - NO auth middleware (Razorpay calls this externally)
router.post('/webhook', handleWebhook);

// Authenticated routes
router.post(
  '/create-order',
  authenticate,
  requirePermission('payments', 'create'),
  validate(createOnlineOrderSchema),
  createOnlineOrder
);

router.post(
  '/verify',
  authenticate,
  validate(verifyOnlinePaymentSchema),
  verifyOnlinePayment
);

router.get('/bank-status', authenticate, getBankStatus);

export { router as onlinePaymentsRoutes };
