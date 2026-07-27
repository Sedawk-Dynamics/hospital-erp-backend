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
  addIpChargeSchema,
  admissionLedgerParamSchema,
  admissionActionParamSchema,
  transferToTpaSchema,
  recordTpaSettlementSchema,
  setBillItemReimbursableSchema,
  removeIpChargeSchema,
  recordDoctorVisitSchema,
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
  billOtRequestSchema,
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

// Push an OT surgery's charge onto a hospital bill (+ optional payment).
billingRoutes.post(
  '/ot/:otRequestId/bill',
  authenticate,
  requirePermission('billing', 'create'),
  validate(billOtRequestSchema),
  controller.billOtRequest,
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
  requirePermission('billing', 'update'),
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

// IP billing worklist — one row per admission, listed from admission (literal
// path: must sit before GET /:id so it isn't captured as an id).
billingRoutes.get(
  '/ip-admissions',
  authenticate,
  requirePermission('billing', 'read'),
  controller.getIpAdmissionsForBilling,
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
  requirePermission('billing', 'create'),
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
  requirePermission('billing', 'update'),
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

// Undo an accidental finalize while nothing has been collected yet, so the
// counter can add the missing items to the same bill. Allowed at billing:update
// (not approve) so a cashier can recover their own mistake — the service still
// guards it (only an unpaid, claim-free 'pending' bill can be reopened).
billingRoutes.patch(
  '/:id/reopen',
  authenticate,
  requirePermission('billing', 'update'),
  validate(billIdParamSchema),
  controller.reopenBill,
);

// G5 (2.1): assemble an admission's discharge bill (pull outstanding charges +
// finalize; optional advance application).
billingRoutes.post(
  '/admissions/:admissionId/assemble-final',
  authenticate,
  requirePermission('billing', 'create'),
  controller.assembleDischargeBill,
);

// IP running ledger — read the live itemized ledger; a clinician (doctor/nurse)
// or billing staff posts a charge onto it. Authenticated care-team access (the
// ledger is clinical + financial data the whole IP team needs to see/record).
billingRoutes.get(
  '/admissions/:admissionId/ledger',
  authenticate,
  validate(admissionLedgerParamSchema),
  controller.getAdmissionLedger,
);
billingRoutes.post(
  '/admissions/:admissionId/charges',
  authenticate,
  validate(addIpChargeSchema),
  controller.addIpCharge,
);
// Remove a manually-posted ledger charge (care team / billing only — service-gated).
billingRoutes.delete(
  '/admissions/:admissionId/charges/:itemId',
  authenticate,
  validate(removeIpChargeSchema),
  controller.removeIpCharge,
);
// A doctor records a visit / review round (logs it + posts the visit fee).
billingRoutes.post(
  '/admissions/:admissionId/doctor-visit',
  authenticate,
  validate(recordDoctorVisitSchema),
  controller.recordDoctorVisit,
);
// The full admission timeline (admit → discharge) — same care-team access as the ledger.
billingRoutes.get(
  '/admissions/:admissionId/activity',
  authenticate,
  validate(admissionLedgerParamSchema),
  controller.getAdmissionActivity,
);
// Billing-counter: consolidate the admission's charges onto its single IP bill
// (+ finalize) and, for insurance patients, transfer that bill to the TPA.
billingRoutes.post(
  '/admissions/:admissionId/consolidate',
  authenticate,
  requirePermission('billing', 'update'),
  validate(admissionActionParamSchema),
  controller.consolidateAdmissionBill,
);
billingRoutes.post(
  '/admissions/:admissionId/transfer-to-tpa',
  authenticate,
  requirePermission('billing', 'update'),
  validate(transferToTpaSchema),
  controller.transferAdmissionToTpa,
);
// Record a TPA payment (approve-if-needed + settle) against the admission's claim.
billingRoutes.post(
  '/admissions/:admissionId/tpa-settlement',
  authenticate,
  requirePermission('billing', 'update'),
  validate(recordTpaSettlementSchema),
  controller.recordTpaSettlement,
);
// Deposit at the billing counter: cut it from the running IP bill, or return the
// unused part to the patient (e.g. insurance covered the charges in full).
billingRoutes.post(
  '/admissions/:admissionId/apply-deposit',
  authenticate,
  requirePermission('billing', 'update'),
  validate(admissionActionParamSchema),
  controller.applyDepositToBill,
);
billingRoutes.post(
  '/admissions/:admissionId/refund-deposit',
  authenticate,
  requirePermission('billing', 'update'),
  validate(admissionActionParamSchema),
  controller.refundDeposit,
);
// Line-level insurance split — mark a bill line insurance-eligible / patient-only.
billingRoutes.patch(
  '/bill-items/:itemId/reimbursable',
  authenticate,
  requirePermission('billing', 'update'),
  validate(setBillItemReimbursableSchema),
  controller.setBillItemReimbursable,
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
