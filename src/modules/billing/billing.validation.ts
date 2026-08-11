import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

export const createServiceTariffSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Service name is required').max(300),
    code: z.string().min(1, 'Service code is required').max(50),
    category: z.enum([
      'consultation',
      'procedure',
      'lab',
      'imaging',
      'pharmacy',
      'room',
      'nursing',
      'surgery',
      'other',
    ]),
    description: z.string().max(1000).optional(),
    basePrice: z.number().positive('Base price must be positive'),
    taxRate: z.number().min(0).max(100).default(0),
    isActive: z.boolean().default(true),
    departmentId: z.string().uuid('Invalid department ID').optional(),
    // Imaging tariffs carry the modality so the doctor's order catalog can
    // route a picked study to the right ImagingType.
    modality: z
      .enum(['xray', 'mri', 'ct_scan', 'ultrasound', 'ecg', 'echo', 'other'])
      .optional()
      .nullable(),
  }),
});

export const updateServiceTariffSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(300).optional(),
    code: z.string().min(1).max(50).optional(),
    category: z
      .enum([
        'consultation',
        'procedure',
        'lab',
        'imaging',
        'pharmacy',
        'room',
        'nursing',
        'surgery',
        'other',
      ])
      .optional(),
    description: z.string().max(1000).optional().nullable(),
    basePrice: z.number().positive().optional(),
    taxRate: z.number().min(0).max(100).optional(),
    isActive: z.boolean().optional(),
    departmentId: z.string().uuid().optional().nullable(),
    modality: z
      .enum(['xray', 'mri', 'ct_scan', 'ultrasound', 'ecg', 'echo', 'other'])
      .optional()
      .nullable(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid tariff ID'),
  }),
});

export const getTariffsQuerySchema = z.object({
  query: paginationSchema.extend({
    category: z
      .enum([
        'consultation',
        'procedure',
        'lab',
        'imaging',
        'pharmacy',
        'room',
        'nursing',
        'surgery',
        'other',
      ])
      .optional(),
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    departmentId: z.string().uuid().optional(),
  }),
});

export const createBillSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    visitId: z.string().uuid('Invalid visit ID').optional(),
    admissionId: z.string().uuid('Invalid admission ID').optional(),
    appointmentId: z.string().uuid('Invalid appointment ID').optional(),
    notes: z.string().max(2000).optional(),
  }),
});

export const addBillItemSchema = z.object({
  body: z.object({
    serviceTariffId: z.string().uuid('Invalid service tariff ID').optional(),
    description: z.string().min(1, 'Description is required').max(500),
    quantity: z.number().int().positive('Quantity must be positive').default(1),
    unitPrice: z.number().positive('Unit price must be positive'),
    discount: z.number().min(0).default(0),
    taxRate: z.number().min(0).max(100).default(0),
    notes: z.string().max(500).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid bill ID'),
  }),
});

export const removeBillItemSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid bill ID'),
    itemId: z.string().uuid('Invalid item ID'),
  }),
});

// Front-desk edit of a draft bill's line — change price/qty/discount/tax/label.
// All fields optional (patch); unitPrice can be 0 to zero-out a charge.
export const updateBillItemSchema = z.object({
  body: z.object({
    description: z.string().min(1, 'Description is required').max(500).optional(),
    quantity: z.number().int().positive('Quantity must be positive').optional(),
    unitPrice: z.number().min(0, 'Unit price cannot be negative').optional(),
    discount: z.number().min(0).optional(),
    taxRate: z.number().min(0).max(100).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid bill ID'),
    itemId: z.string().uuid('Invalid item ID'),
  }),
});

export const createPaymentSchema = z.object({
  body: z.object({
    billId: z.string().uuid('Invalid bill ID'),
    amount: z.number().positive('Amount must be positive'),
    paymentMethod: z.enum([
      'cash',
      'credit_card',
      'debit_card',
      'bank_transfer',
      'upi',
      'cheque',
      'insurance',
      'wallet',
      'other',
    ]),
    referenceNumber: z.string().max(200).optional(),
    notes: z.string().max(1000).optional(),
  }),
});

export const createRefundSchema = z.object({
  body: z.object({
    paymentId: z.string().uuid('Invalid payment ID'),
    amount: z.number().positive('Refund amount must be positive'),
    reason: z.string().min(1, 'Refund reason is required').max(1000),
  }),
});

export const applyDiscountSchema = z.object({
  body: z.object({
    discountType: z.enum(['percentage', 'fixed']),
    discountValue: z.number().positive('Discount value must be positive'),
    reason: z.string().min(1, 'Discount reason is required').max(500),
    approvedBy: z.string().uuid('Invalid approver ID').optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid bill ID'),
  }),
});

export const getBillsQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    status: z.enum(['draft', 'pending', 'partially_paid', 'paid', 'cancelled', 'refunded']).optional(),
    // ip = admission-scoped bills; op = the rest.
    billType: z.enum(['ip', 'op']).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

// Consolidate / transfer-to-TPA operate on an admission.
export const admissionActionParamSchema = z.object({
  params: z.object({ admissionId: z.string().uuid('Invalid admission ID') }),
});

// Transfer to TPA — optionally with an explicit policy or inline new-policy details.
export const transferToTpaSchema = z.object({
  params: z.object({ admissionId: z.string().uuid('Invalid admission ID') }),
  body: z.object({
    policyId: z.string().uuid().optional(),
    newPolicy: z.object({
      insurerName: z.string().min(1).max(255),
      tpaName: z.string().max(255).optional(),
      policyNumber: z.string().max(100).optional(),
      coverageAmount: z.number().min(0).optional(),
      coPayPercent: z.number().min(0).max(100).optional(),
      deductibleAmount: z.number().min(0).optional(),
    }).optional(),
  }).optional(),
});

// Record a TPA payment against the admission's claim.
export const recordTpaSettlementSchema = z.object({
  params: z.object({ admissionId: z.string().uuid('Invalid admission ID') }),
  body: z.object({
    paidAmount: z.number().positive('Paid amount must be positive'),
    notes: z.string().max(500).optional(),
  }),
});

// Mark a bill line insurance-eligible (true) / patient-only (false) / unset (null).
export const setBillItemReimbursableSchema = z.object({
  params: z.object({ itemId: z.string().uuid('Invalid bill line ID') }),
  body: z.object({ isReimbursable: z.boolean().nullable() }),
});

export const getPaymentsQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    billId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    paymentMethod: z
      .enum([
        'cash',
        'credit_card',
        'debit_card',
        'bank_transfer',
        'upi',
        'cheque',
        'insurance',
        'wallet',
        'other',
      ])
      .optional(),
  }),
});

export const billIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid bill ID'),
  }),
});

export const refundIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid refund ID'),
  }),
});

export const patientIdParamSchema = z.object({
  params: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
  }),
});

export const tariffIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid tariff ID'),
  }),
});

// --- Week 12 schemas ---

export const splitPaymentSchema = z.object({
  body: z.object({
    billId: z.string().uuid('Invalid bill ID'),
    splits: z
      .array(
        z.object({
          amount: z.number().positive('Amount must be > 0'),
          paymentMethod: z.enum([
            'cash',
            'credit_card',
            'debit_card',
            'bank_transfer',
            'upi',
            'cheque',
            'insurance',
            'wallet',
            'other',
          ]),
          referenceNumber: z.string().max(200).optional(),
          notes: z.string().max(1000).optional(),
        }),
      )
      .min(1, 'At least one split is required'),
  }),
});

export const advancePaymentSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    amount: z.number().positive('Amount must be > 0'),
    paymentMethod: z.enum([
      'cash',
      'credit_card',
      'debit_card',
      'bank_transfer',
      'upi',
      'cheque',
      'insurance',
      'wallet',
      'other',
    ]),
    referenceNumber: z.string().max(200).optional(),
    notes: z.string().max(1000).optional(),
  }),
});

export const adjustAdvanceSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    billId: z.string().uuid('Invalid bill ID'),
    amount: z.number().positive('Amount must be > 0'),
  }),
});

export const reversePaymentSchema = z.object({
  body: z.object({
    paymentId: z.string().uuid('Invalid payment ID'),
    reason: z.string().min(3, 'Reason is required').max(1000),
  }),
});

export const cancelBillSchema = z.object({
  body: z.object({
    reason: z.string().min(3, 'Reason is required').max(1000),
  }),
  params: z.object({
    id: z.string().uuid('Invalid bill ID'),
  }),
});

export const rejectRefundSchema = z.object({
  body: z.object({
    reason: z.string().min(3, 'Reason is required').max(1000),
  }),
  params: z.object({
    id: z.string().uuid('Invalid refund ID'),
  }),
});

export const getRefundsSchema = z.object({
  query: paginationSchema.extend({
    status: z.enum(['requested', 'approved', 'processed', 'rejected']).optional(),
    patientId: z.string().uuid().optional(),
    billId: z.string().uuid().optional(),
  }),
});

export const getReceiptsSchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    billId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const receiptIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid receipt ID'),
  }),
});

export const dayEndQuerySchema = z.object({
  query: z.object({
    date: z.string().optional(),
  }),
});

export const advancePatientParamSchema = z.object({
  params: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
  }),
});

export const creditSettlementBillsParamSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
});

export type SplitPaymentInput = z.infer<typeof splitPaymentSchema>['body'];
export type AdvancePaymentInput = z.infer<typeof advancePaymentSchema>['body'];
export type AdjustAdvanceInput = z.infer<typeof adjustAdvanceSchema>['body'];
export type ReversePaymentInput = z.infer<typeof reversePaymentSchema>['body'];
export type CancelBillInput = z.infer<typeof cancelBillSchema>['body'];
export type RejectRefundInput = z.infer<typeof rejectRefundSchema>['body'];

export const getChargesQuerySchema = z.object({
  query: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    source: z
      .enum(['consultation', 'lab', 'pharmacy', 'imaging', 'room', 'ot', 'all'])
      .optional(),
    includeBilled: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
  }),
});

// --- Cash drawer close ---

export const drawerStatusQuerySchema = z.object({
  query: z.object({
    date: z.string().optional(),
    cashierId: z.string().uuid('Invalid cashier ID').optional(),
    openingFloat: z.coerce.number().min(0).optional(),
  }),
});

export const closeDrawerSchema = z.object({
  body: z.object({
    date: z.string().optional(),
    /** Omit to close your own drawer; a supervisor may name someone else's. */
    cashierId: z.string().uuid('Invalid cashier ID').optional(),
    openingFloat: z.number().min(0).optional(),
    countedCash: z.number().min(0, 'Counted cash cannot be negative'),
    /** Note count per denomination, e.g. { "500": 12, "200": 3 }. */
    denominations: z.record(z.string(), z.number().int().min(0)).optional(),
    notes: z.string().max(1000).optional(),
  }),
});

export const drawerClosuresQuerySchema = z.object({
  query: z.object({ date: z.string().optional() }),
});

export const drawerClosureIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid closure ID') }),
});

// Tenant-wide "what still needs a bill" worklist. Only the sources that are a
// discrete order somebody raised — room and consultation accrue on their own,
// pharmacy is dispensed at its own counter.
export const getPendingOrdersQuerySchema = z.object({
  query: z.object({
    source: z.enum(['lab', 'imaging', 'ot', 'all']).optional(),
    search: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(300).optional(),
  }),
});

// Bill an OT surgery (push its charge onto a hospital bill, optionally pay).
export const billOtRequestSchema = z.object({
  params: z.object({ otRequestId: z.string().uuid('Invalid OT request ID') }),
  body: z.object({
    collectPayment: z.boolean().optional(),
    paymentMethod: z
      .enum(['cash', 'credit_card', 'debit_card', 'bank_transfer', 'upi', 'cheque', 'insurance', 'wallet', 'other'])
      .optional(),
  }),
});

export const pullChargesSchema = z.object({
  body: z.object({
    charges: z
      .array(
        z.object({
          referenceType: z.string().min(1),
          referenceId: z.string().min(1),
          description: z.string().min(1).max(500),
          quantity: z.number().int().positive().default(1),
          unitPrice: z.number().nonnegative(),
          taxRate: z.number().min(0).max(100).optional(),
          category: z
            .enum([
              'consultation',
              'surgery',
              'room',
              'lab',
              'radiology',
              'pharmacy',
              'procedure',
              'consumable',
              'other',
            ])
            .optional(),
        }),
      )
      .min(1, 'At least one charge is required'),
  }),
  params: z.object({
    id: z.string().uuid('Invalid bill ID'),
  }),
});

// IP running ledger — a clinician posts a categorised charge onto the admission's bill.
// Only MANUAL categories are accepted: lab / radiology / pharmacy / surgery are
// auto-pulled onto the ledger when the doctor orders them, so they are not
// offered here (would double-count).
export const addIpChargeSchema = z.object({
  params: z.object({ admissionId: z.string().uuid('Invalid admission ID') }),
  body: z.object({
    category: z.enum(['consultation', 'procedure', 'consumable', 'room', 'other']),
    description: z.string().min(1).max(500),
    quantity: z.number().int().positive().default(1),
    unitPrice: z.number().positive(),
    taxRate: z.number().min(0).max(100).default(0),
    serviceTariffId: z.string().uuid().optional(),
    notes: z.string().max(500).optional(),
  }),
});

export const admissionLedgerParamSchema = z.object({
  params: z.object({ admissionId: z.string().uuid('Invalid admission ID') }),
});

export const removeIpChargeSchema = z.object({
  params: z.object({
    admissionId: z.string().uuid('Invalid admission ID'),
    itemId: z.string().uuid('Invalid charge ID'),
  }),
});

// A doctor records a visit / review round — logs it and posts the doctor's
// admin-configured visit fee (consultationFee). The fee is NOT sent by the
// client; only an optional review note.
export const recordDoctorVisitSchema = z.object({
  params: z.object({ admissionId: z.string().uuid('Invalid admission ID') }),
  body: z.object({
    review: z.string().max(1000).optional(),
  }),
});

export const setBillDiscountSchema = z.object({
  body: z.object({
    discountType: z.enum(['percentage', 'fixed']),
    discountValue: z.number().min(0, 'Discount cannot be negative'),
    reason: z.string().max(500).optional(),
    approvedBy: z.string().uuid().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid bill ID'),
  }),
});

export type GetChargesQuery = z.infer<typeof getChargesQuerySchema>['query'];
export type PullChargesInput = z.infer<typeof pullChargesSchema>['body'];
export type SetBillDiscountInput = z.infer<typeof setBillDiscountSchema>['body'];

export type CreateServiceTariffInput = z.infer<typeof createServiceTariffSchema>['body'];
export type UpdateServiceTariffInput = z.infer<typeof updateServiceTariffSchema>['body'];
export type CreateBillInput = z.infer<typeof createBillSchema>['body'];
export type AddBillItemInput = z.infer<typeof addBillItemSchema>['body'];
export type UpdateBillItemInput = z.infer<typeof updateBillItemSchema>['body'];
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>['body'];
export type CreateRefundInput = z.infer<typeof createRefundSchema>['body'];
export type ApplyDiscountInput = z.infer<typeof applyDiscountSchema>['body'];
export type GetBillsQuery = z.infer<typeof getBillsQuerySchema>['query'];
export type GetPaymentsQuery = z.infer<typeof getPaymentsQuerySchema>['query'];
