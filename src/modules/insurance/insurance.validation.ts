import { z } from 'zod';
import { paginationSchema, booleanQueryParam } from '../../shared/pagination';

// ============================================================
// Param schemas
// ============================================================

export const idParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid ID'),
  }),
});

// ============================================================
// Insurers
// ============================================================

export const createInsurerSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(255),
    contactPerson: z.string().max(100).optional(),
    phone: z.string().max(20).optional(),
    email: z.string().email('Invalid email').max(255).optional(),
    address: z.string().optional(),
    // The payer's own registration. `validate()` REPLACES req.body with the
    // parsed object, so a field the schema does not name is silently dropped —
    // this must be listed here or nothing reaches the writer. The state is
    // never accepted separately: it is derived from the GSTIN.
    gstin: z.string().max(15).optional().nullable(),
    isActive: z.boolean().default(true),
  }),
});

export const updateInsurerSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    contactPerson: z.string().max(100).optional().nullable(),
    phone: z.string().max(20).optional().nullable(),
    email: z.string().email('Invalid email').max(255).optional().nullable(),
    address: z.string().optional().nullable(),
    // The payer's own registration. `validate()` REPLACES req.body with the
    // parsed object, so a field the schema does not name is silently dropped —
    // this must be listed here or nothing reaches the writer. The state is
    // never accepted separately: it is derived from the GSTIN.
    gstin: z.string().max(15).optional().nullable(),
    isActive: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid insurer ID'),
  }),
});

export const getInsurersQuerySchema = z.object({
  query: paginationSchema.extend({
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

// ============================================================
// TPA Providers
// ============================================================

export const createTPASchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(255),
    contactPerson: z.string().max(100).optional(),
    phone: z.string().max(20).optional(),
    email: z.string().email('Invalid email').max(255).optional(),
    address: z.string().optional(),
    // The payer's own registration. `validate()` REPLACES req.body with the
    // parsed object, so a field the schema does not name is silently dropped —
    // this must be listed here or nothing reaches the writer. The state is
    // never accepted separately: it is derived from the GSTIN.
    gstin: z.string().max(15).optional().nullable(),
    isActive: z.boolean().default(true),
  }),
});

export const updateTPASchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    contactPerson: z.string().max(100).optional().nullable(),
    phone: z.string().max(20).optional().nullable(),
    email: z.string().email('Invalid email').max(255).optional().nullable(),
    address: z.string().optional().nullable(),
    // The payer's own registration. `validate()` REPLACES req.body with the
    // parsed object, so a field the schema does not name is silently dropped —
    // this must be listed here or nothing reaches the writer. The state is
    // never accepted separately: it is derived from the GSTIN.
    gstin: z.string().max(15).optional().nullable(),
    isActive: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid TPA ID'),
  }),
});

export const getTPAsQuerySchema = z.object({
  query: paginationSchema.extend({
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

// ============================================================
// Insurance Policies
// ============================================================

export const createPolicySchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    insurerId: z.string().uuid('Invalid insurer ID'),
    tpaId: z.string().uuid('Invalid TPA ID').optional(),
    policyNumber: z.string().min(1, 'Policy number is required').max(100),
    groupNumber: z.string().max(100).optional(),
    planName: z.string().max(255).optional(),
    coverageAmount: z.number().positive('Coverage amount must be positive').optional(),
    coPayPercent: z.number().min(0).max(100).default(0),
    deductibleAmount: z.number().min(0).default(0),
    exclusions: z.string().optional(),
    validFrom: z.string().min(1, 'Valid from date is required'),
    validTo: z.string().min(1, 'Valid to date is required'),
    status: z.enum(['active', 'expired', 'cancelled']).default('active'),
  }),
});

export const updatePolicySchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID').optional(),
    insurerId: z.string().uuid('Invalid insurer ID').optional(),
    tpaId: z.string().uuid('Invalid TPA ID').optional().nullable(),
    policyNumber: z.string().min(1).max(100).optional(),
    groupNumber: z.string().max(100).optional().nullable(),
    planName: z.string().max(255).optional().nullable(),
    coverageAmount: z.number().positive().optional().nullable(),
    coPayPercent: z.number().min(0).max(100).optional(),
    deductibleAmount: z.number().min(0).optional(),
    exclusions: z.string().optional().nullable(),
    validFrom: z.string().optional(),
    validTo: z.string().optional(),
    status: z.enum(['active', 'expired', 'cancelled']).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid policy ID'),
  }),
});

export const getPoliciesQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    insurerId: z.string().uuid().optional(),
    tpaId: z.string().uuid().optional(),
    status: z.enum(['active', 'expired', 'cancelled']).optional(),
  }),
});

export const verifyPolicySchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid policy ID'),
  }),
});

export const patientIdParamSchema = z.object({
  params: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
  }),
});

// ============================================================
// Insurance Claims
// ============================================================

export const createClaimSchema = z.object({
  body: z.object({
    policyId: z.string().uuid('Invalid policy ID'),
    patientId: z.string().uuid('Invalid patient ID'),
    billId: z.string().uuid('Invalid bill ID'),
    claimAmount: z.number().positive('Claim amount must be positive'),
    notes: z.string().optional(),
    documentsUrl: z.any().optional(),
    expiryDays: z.number().int().positive().optional(),
  }),
});

export const updateClaimSchema = z.object({
  body: z.object({
    claimAmount: z.number().positive('Claim amount must be positive').optional(),
    notes: z.string().optional().nullable(),
    documentsUrl: z.any().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid claim ID'),
  }),
});

export const getClaimsQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    policyId: z.string().uuid().optional(),
    status: z
      .enum([
        'submitted',
        'under_review',
        'approved',
        'partially_approved',
        'rejected',
        'resubmitted',
        'settled',
        'partially_settled',
        'cancelled',
      ])
      .optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    expiringWithinDays: z.coerce.number().int().positive().optional(),
  }),
});

export const approveClaimSchema = z.object({
  body: z.object({
    approvedAmount: z.number().positive('Approved amount must be positive'),
    notes: z.string().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid claim ID'),
  }),
});

export const rejectClaimSchema = z.object({
  body: z.object({
    rejectionReason: z.string().min(1, 'Rejection reason is required'),
    notes: z.string().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid claim ID'),
  }),
});

export const partialApproveClaimSchema = z.object({
  body: z.object({
    approvedAmount: z.number().positive('Approved amount must be positive'),
    rejectionReason: z.string().optional(),
    notes: z.string().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid claim ID'),
  }),
});

export const settleClaimSchema = z.object({
  body: z.object({
    paidAmount: z.number().positive('Paid amount must be positive'),
    settlementDate: z.string().optional(),
    notes: z.string().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid claim ID'),
  }),
});

export const resubmitClaimSchema = z.object({
  body: z.object({
    claimAmount: z.number().positive('Claim amount must be positive').optional(),
    additionalDocumentsUrl: z.any().optional(),
    notes: z.string().min(1, 'Resubmission notes are required'),
    expiryDays: z.number().int().positive().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid claim ID'),
  }),
});

export const cancelClaimSchema = z.object({
  body: z.object({
    reason: z.string().min(1, 'Cancellation reason is required'),
  }),
  params: z.object({
    id: z.string().uuid('Invalid claim ID'),
  }),
});

// ============================================================
// Pre-Authorization Requests
// ============================================================

export const createPreAuthSchema = z.object({
  body: z.object({
    policyId: z.string().uuid('Invalid policy ID'),
    patientId: z.string().uuid('Invalid patient ID'),
    procedureDescription: z.string().min(1, 'Procedure description is required'),
    estimatedCost: z.number().positive('Estimated cost must be positive').optional(),
    validFrom: z.string().optional(),
    validTo: z.string().optional(),
    notes: z.string().optional(),
  }),
});

export const updatePreAuthSchema = z.object({
  body: z.object({
    procedureDescription: z.string().min(1).optional(),
    estimatedCost: z.number().positive().optional().nullable(),
    notes: z.string().optional().nullable(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid pre-auth request ID'),
  }),
});

export const getPreAuthsQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    policyId: z.string().uuid().optional(),
    status: z
      .enum(['pending', 'approved', 'denied', 'expired', 'on_hold', 'cancelled'])
      .optional(),
  }),
});

export const approvePreAuthSchema = z.object({
  body: z.object({
    approvalNumber: z.string().max(100).optional(),
    approvedAmount: z.number().positive('Approved amount must be positive').optional(),
    validFrom: z.string().optional(),
    validTo: z.string().optional(),
    notes: z.string().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid pre-auth request ID'),
  }),
});

export const rejectPreAuthSchema = z.object({
  body: z.object({
    notes: z.string().min(1, 'Rejection reason is required'),
  }),
  params: z.object({
    id: z.string().uuid('Invalid pre-auth request ID'),
  }),
});

export const holdPreAuthSchema = z.object({
  body: z.object({
    reason: z.string().min(1, 'Hold reason is required'),
  }),
  params: z.object({
    id: z.string().uuid('Invalid pre-auth request ID'),
  }),
});

// ============================================================
// Calc / Bill split / Reports
// ============================================================

export const calcResponsibilitySchema = z.object({
  query: z.object({
    policyId: z.string().uuid('Invalid policy ID'),
    billId: z.string().uuid('Invalid bill ID'),
  }),
});

export const splitBillSchema = z.object({
  body: z.object({
    policyId: z.string().uuid('Invalid policy ID'),
    claimAmount: z.number().positive().optional(),
  }),
  params: z.object({
    billId: z.string().uuid('Invalid bill ID'),
  }),
});

export const reportsQuerySchema = z.object({
  query: z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    insurerId: z.string().uuid().optional(),
    tpaId: z.string().uuid().optional(),
  }),
});

// ============================================================
// TPA Communication Logs
// ============================================================

/**
 * A logged interaction hangs off a claim, a pre-authorization, or a TPA on its
 * own (a general enquiry). One of the three is required — a log attached to
 * nothing cannot be found again, and a row nobody can retrieve is not an audit
 * trail.
 */
export const createTpaLogSchema = z.object({
  body: z
    .object({
      claimId: z.string().uuid('Invalid claim ID').optional(),
      preAuthId: z.string().uuid('Invalid pre-authorization ID').optional(),
      tpaId: z.string().uuid('Invalid TPA ID').optional(),
      communicationType: z.enum(['email', 'phone', 'portal', 'letter'], {
        message: 'Communication type is required',
      }),
      direction: z.enum(['inbound', 'outbound'], { message: 'Direction is required' }),
      subject: z.string().min(1, 'Subject is required').max(255),
      content: z.string().max(5000).optional(),
    })
    .refine((b) => !!(b.claimId || b.preAuthId || b.tpaId), {
      message: 'Attach the log to a claim, a pre-authorization or a TPA',
      path: ['claimId'],
    }),
});

/**
 * Every filter the log list offers must be declared here: `validate()` replaces
 * `req.query` with the parsed object, so an undeclared filter is dropped
 * silently rather than rejected.
 */
export const getTpaLogsQuerySchema = z.object({
  query: paginationSchema.extend({
    claimId: z.string().uuid().optional(),
    preAuthId: z.string().uuid().optional(),
    tpaId: z.string().uuid().optional(),
    direction: z.enum(['inbound', 'outbound']).optional(),
    communicationType: z.enum(['email', 'phone', 'portal', 'letter']).optional(),
    isSystem: booleanQueryParam,
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

// ============================================================
// Inferred types
// ============================================================

export type CreateInsurerInput = z.infer<typeof createInsurerSchema>['body'];
export type UpdateInsurerInput = z.infer<typeof updateInsurerSchema>['body'];
export type CreateTPAInput = z.infer<typeof createTPASchema>['body'];
export type UpdateTPAInput = z.infer<typeof updateTPASchema>['body'];
export type CreatePolicyInput = z.infer<typeof createPolicySchema>['body'];
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>['body'];
export type CreateClaimInput = z.infer<typeof createClaimSchema>['body'];
export type UpdateClaimInput = z.infer<typeof updateClaimSchema>['body'];
export type ApproveClaimInput = z.infer<typeof approveClaimSchema>['body'];
export type RejectClaimInput = z.infer<typeof rejectClaimSchema>['body'];
export type PartialApproveClaimInput = z.infer<typeof partialApproveClaimSchema>['body'];
export type SettleClaimInput = z.infer<typeof settleClaimSchema>['body'];
export type ResubmitClaimInput = z.infer<typeof resubmitClaimSchema>['body'];
export type CancelClaimInput = z.infer<typeof cancelClaimSchema>['body'];
export type CreatePreAuthInput = z.infer<typeof createPreAuthSchema>['body'];
export type UpdatePreAuthInput = z.infer<typeof updatePreAuthSchema>['body'];
export type ApprovePreAuthInput = z.infer<typeof approvePreAuthSchema>['body'];
export type RejectPreAuthInput = z.infer<typeof rejectPreAuthSchema>['body'];
export type HoldPreAuthInput = z.infer<typeof holdPreAuthSchema>['body'];
export type SplitBillInput = z.infer<typeof splitBillSchema>['body'];
export type CreateTpaLogInput = z.infer<typeof createTpaLogSchema>['body'];
