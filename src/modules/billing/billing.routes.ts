import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createServiceTariffSchema,
  updateServiceTariffSchema,
  getTariffsQuerySchema,
  createBillSchema,
  addBillItemSchema,
  removeBillItemSchema,
  createPaymentSchema,
  createRefundSchema,
  applyDiscountSchema,
  getBillsQuerySchema,
  getPaymentsQuerySchema,
  billIdParamSchema,
  refundIdParamSchema,
  patientIdParamSchema,
} from './billing.validation';
import * as controller from './billing.controller';

export const billingRoutes = Router();

// --- Service Tariffs ---

billingRoutes.post(
  '/tariffs',
  authenticate,
  requirePermission('billing', 'create'),
  validate(createServiceTariffSchema),
  controller.createServiceTariff,
);

billingRoutes.get(
  '/tariffs',
  authenticate,
  validate(getTariffsQuerySchema),
  controller.getServiceTariffs,
);

billingRoutes.put(
  '/tariffs/:id',
  authenticate,
  requirePermission('billing', 'update'),
  validate(updateServiceTariffSchema),
  controller.updateServiceTariff,
);

// --- Patient Bills (must be before /:id) ---

billingRoutes.get(
  '/patient/:patientId',
  authenticate,
  validate(patientIdParamSchema),
  controller.getPatientBills,
);

// --- Payments ---

billingRoutes.post(
  '/payments',
  authenticate,
  requirePermission('payments', 'create'),
  validate(createPaymentSchema),
  controller.createPayment,
);

billingRoutes.get(
  '/payments',
  authenticate,
  requirePermission('payments', 'read'),
  validate(getPaymentsQuerySchema),
  controller.getPayments,
);

// --- Refunds ---

billingRoutes.post(
  '/refunds',
  authenticate,
  validate(createRefundSchema),
  controller.createRefund,
);

billingRoutes.patch(
  '/refunds/:id/approve',
  authenticate,
  requirePermission('billing', 'approve'),
  validate(refundIdParamSchema),
  controller.approveRefund,
);

// --- Bills ---

billingRoutes.post(
  '/',
  authenticate,
  requirePermission('billing', 'create'),
  validate(createBillSchema),
  controller.createBill,
);

billingRoutes.get(
  '/',
  authenticate,
  requirePermission('billing', 'read'),
  validate(getBillsQuerySchema),
  controller.getBills,
);

billingRoutes.get(
  '/:id',
  authenticate,
  validate(billIdParamSchema),
  controller.getBillById,
);

billingRoutes.post(
  '/:id/items',
  authenticate,
  validate(addBillItemSchema),
  controller.addBillItem,
);

billingRoutes.delete(
  '/:id/items/:itemId',
  authenticate,
  validate(removeBillItemSchema),
  controller.removeBillItem,
);

billingRoutes.patch(
  '/:id/finalize',
  authenticate,
  requirePermission('billing', 'approve'),
  validate(billIdParamSchema),
  controller.finalizeBill,
);

billingRoutes.post(
  '/:id/discounts',
  authenticate,
  requirePermission('billing', 'update'),
  validate(applyDiscountSchema),
  controller.applyDiscount,
);
