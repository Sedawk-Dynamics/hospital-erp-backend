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
  getChargesQuerySchema,
  pullChargesSchema,
  setBillDiscountSchema,
  splitPaymentSchema,
  advancePaymentSchema,
  adjustAdvanceSchema,
  reversePaymentSchema,
  cancelBillSchema,
  rejectRefundSchema,
  getRefundsSchema,
  getReceiptsSchema,
  receiptIdParamSchema,
  dayEndQuerySchema,
  advancePatientParamSchema,
  creditSettlementBillsParamSchema,
} from './billing.validation';
import * as controller from './billing.controller';

export const billingRoutes = Router();

// --- Charges (auto-pull from clinical sources) ---

billingRoutes.get(
  '/charges',
  authenticate,
  requirePermission('billing', 'read'),
  validate(getChargesQuerySchema),
  controller.getCharges,
);

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

billingRoutes.delete(
  '/tariffs/:id',
  authenticate,
  requirePermission('billing', 'delete'),
  controller.deleteServiceTariff,
);

// --- Collection Summary ---

billingRoutes.get(
  '/collection-summary',
  authenticate,
  requirePermission('billing', 'read'),
  controller.getCollectionSummary,
);

// --- Day-End Report (Week 12) ---

billingRoutes.get(
  '/day-end',
  authenticate,
  requirePermission('billing', 'read'),
  validate(dayEndQuerySchema),
  controller.getDayEndReport,
);

// --- Receipts (Week 12) ---

billingRoutes.get(
  '/receipts',
  authenticate,
  requirePermission('billing', 'read'),
  validate(getReceiptsSchema),
  controller.listReceipts,
);

billingRoutes.get(
  '/receipts/:id/pdf',
  authenticate,
  requirePermission('billing', 'read'),
  validate(receiptIdParamSchema),
  controller.getReceiptPdf,
);

// --- Advance payment (Week 12) ---

billingRoutes.post(
  '/payments/advance',
  authenticate,
  requirePermission('payments', 'create'),
  validate(advancePaymentSchema),
  controller.createAdvancePayment,
);

billingRoutes.post(
  '/payments/advance/adjust',
  authenticate,
  requirePermission('payments', 'create'),
  validate(adjustAdvanceSchema),
  controller.adjustAdvance,
);

billingRoutes.get(
  '/payments/advance/:patientId',
  authenticate,
  requirePermission('payments', 'read'),
  validate(advancePatientParamSchema),
  controller.getPatientAdvanceBalance,
);

// --- Split payment (Week 12) ---

billingRoutes.post(
  '/payments/split',
  authenticate,
  requirePermission('payments', 'create'),
  validate(splitPaymentSchema),
  controller.createSplitPayment,
);

// --- Payment reversal (Week 12) ---

billingRoutes.post(
  '/reversals',
  authenticate,
  requirePermission('billing', 'approve'),
  validate(reversePaymentSchema),
  controller.reversePayment,
);

// --- Refunds list + reject (Week 12) ---

billingRoutes.get(
  '/refunds',
  authenticate,
  requirePermission('billing', 'read'),
  validate(getRefundsSchema),
  controller.getRefunds,
);

billingRoutes.patch(
  '/refunds/:id/reject',
  authenticate,
  requirePermission('billing', 'approve'),
  validate(rejectRefundSchema),
  controller.rejectRefund,
);

// --- Credit Settlements ---

billingRoutes.get(
  '/credit-settlements',
  authenticate,
  requirePermission('billing', 'read'),
  controller.getCreditSettlements,
);

billingRoutes.get(
  '/credit-settlements/:id/bills',
  authenticate,
  requirePermission('billing', 'read'),
  validate(creditSettlementBillsParamSchema),
  controller.getCreditSettlementBills,
);

billingRoutes.post(
  '/credit-settlements/:id/settle',
  authenticate,
  requirePermission('billing', 'create'),
  controller.settleCredit,
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

billingRoutes.post(
  '/:id/pull-charges',
  authenticate,
  requirePermission('billing', 'create'),
  validate(pullChargesSchema),
  controller.pullCharges,
);

billingRoutes.patch(
  '/:id/discount',
  authenticate,
  requirePermission('billing', 'update'),
  validate(setBillDiscountSchema),
  controller.setBillDiscount,
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

billingRoutes.patch(
  '/:id/cancel',
  authenticate,
  requirePermission('billing', 'approve'),
  validate(cancelBillSchema),
  controller.cancelBill,
);

billingRoutes.post(
  '/:id/discounts',
  authenticate,
  requirePermission('billing', 'update'),
  validate(applyDiscountSchema),
  controller.applyDiscount,
);
