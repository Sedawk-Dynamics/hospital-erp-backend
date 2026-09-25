import { z } from 'zod';

const uuid = z.string().uuid();
const optionalText = z.string().trim().min(1).optional();
const amount = z.coerce.number().finite().nonnegative();
const positiveAmount = z.coerce.number().finite().positive();

export const caseIdParamSchema = z.object({ params: z.object({ id: uuid }) });
export const claimIdParamSchema = z.object({ params: z.object({ id: uuid }) });

export const createCorporatePayerSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(255),
    code: z.string().trim().max(50).optional(),
    contactPerson: z.string().trim().max(100).optional(),
    phone: z.string().trim().max(20).optional(),
    email: z.string().email().optional(),
    address: optionalText,
    gstin: z.string().trim().length(15).optional(),
    creditDays: z.coerce.number().int().min(0).max(365).default(30),
  }),
});

export const createGovernmentSchemeSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(255),
    schemeCode: z.string().trim().max(100).optional(),
    contactPerson: z.string().trim().max(100).optional(),
    phone: z.string().trim().max(20).optional(),
    email: z.string().email().optional(),
    portalUrl: z.string().url().optional(),
  }),
});

export const payerListQuerySchema = z.object({
  query: z.object({
    search: optionalText,
    isActive: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  }),
});

const caseType = z.enum(['insurance', 'corporate', 'governmentScheme']);
const settlementMode = z.enum(['cashless', 'reimbursement', 'credit']);
const payerType = z.enum(['insurer', 'tpa', 'corporate', 'governmentScheme']);

export const createInsuranceCaseSchema = z.object({
  body: z.object({
    patientId: uuid,
    admissionId: uuid.optional(),
    visitId: uuid.optional(),
    caseType,
    settlementMode,
    insurerId: uuid.optional(),
    tpaId: uuid.optional(),
    corporatePayerId: uuid.optional(),
    governmentSchemePayerId: uuid.optional(),
    paymentResponsibleType: payerType,
    paymentResponsibleId: uuid,
    claimAdministratorType: payerType.optional(),
    claimAdministratorId: uuid.optional(),
    policyIds: z.array(uuid).max(5).default([]),
    memberId: z.string().trim().max(100).optional(),
    employeeId: z.string().trim().max(100).optional(),
    abhaNumber: z.string().trim().max(20).optional(),
    priority: z.enum(['routine', 'urgent', 'critical', 'deceased']).default('routine'),
    emergency: z.boolean().default(false),
    notes: optionalText,
  }).superRefine((value, ctx) => {
    if (value.caseType === 'insurance' && !value.insurerId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['insurerId'], message: 'Insurer is required for an insurance case' });
    }
    if (value.caseType === 'corporate' && !value.corporatePayerId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['corporatePayerId'], message: 'Corporate payer is required' });
    }
    if (value.caseType === 'governmentScheme' && !value.governmentSchemePayerId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['governmentSchemePayerId'], message: 'Government scheme is required' });
    }
    if (Boolean(value.claimAdministratorType) !== Boolean(value.claimAdministratorId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['claimAdministratorId'], message: 'Administrator type and id must be supplied together' });
    }
  }),
});

export const insuranceCaseQuerySchema = z.object({
  query: z.object({
    patientId: uuid.optional(),
    admissionId: uuid.optional(),
    caseType: caseType.optional(),
    settlementMode: settlementMode.optional(),
    status: z.enum(['open', 'eligibilityPending', 'eligible', 'preAuthPending', 'authorized', 'admitted', 'treatment', 'dischargeAuthorizationPending', 'discharged', 'claimSubmitted', 'queryPending', 'approved', 'settled', 'closed', 'cancelled']).optional(),
    priority: z.enum(['routine', 'urgent', 'critical', 'deceased']).optional(),
    search: optionalText,
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  }),
});

export const updateInsuranceCaseStatusSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    status: z.enum(['open', 'eligibilityPending', 'eligible', 'preAuthPending', 'authorized', 'admitted', 'treatment', 'dischargeAuthorizationPending', 'discharged', 'claimSubmitted', 'queryPending', 'approved', 'settled', 'closed', 'cancelled']),
    notes: optionalText,
  }),
});

export const addCasePolicySchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    policyId: uuid,
    sequence: z.coerce.number().int().min(1).max(5),
    allocatedAmount: amount.optional(),
    originalDocumentsHeld: z.boolean().default(false),
    deductionCertificateUrl: z.string().url().optional(),
  }),
});

export const recordEligibilitySchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    policyId: uuid.optional(),
    isEligible: z.boolean(),
    coverageAvailable: amount.optional(),
    coPayPercent: z.coerce.number().min(0).max(100).optional(),
    deductibleAmount: amount.optional(),
    roomRentLimit: amount.optional(),
    waitingPeriodMet: z.boolean().optional(),
    exclusions: z.array(z.string()).optional(),
    source: z.string().trim().max(100).optional(),
    reference: z.string().trim().max(100).optional(),
    rawResponse: z.unknown().optional(),
    validUntil: z.coerce.date().optional(),
  }),
});

export const emergencyIntimationSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({ reference: optionalText, notes: optionalText }),
});

export const physicalReleaseSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    undertaking: z.string().trim().min(5),
    deceased: z.boolean().default(false),
  }),
});

const contractBody = z.object({
  payerType,
  payerId: uuid,
  name: z.string().trim().min(2).max(255),
  contractNumber: z.string().trim().max(100).optional(),
  validFrom: z.coerce.date(),
  validTo: z.coerce.date(),
  submissionWindowDays: z.coerce.number().int().min(1).max(365).default(15),
  queryResponseHours: z.coerce.number().int().min(1).max(720).default(24),
  paymentDueDays: z.coerce.number().int().min(1).max(365).default(30),
  roomRentCap: amount.optional(),
  roomRentCapPercent: z.coerce.number().min(0).max(100).optional(),
  terms: z.unknown().optional(),
  isActive: z.boolean().default(true),
  serviceRates: z.array(z.object({
    serviceTariffId: uuid.optional(), serviceCode: z.string().trim().min(1).max(100),
    serviceName: z.string().trim().min(1).max(255), agreedRate: amount,
    effectiveFrom: z.coerce.date(), effectiveTo: z.coerce.date().optional(),
  })).default([]),
  packageRates: z.array(z.object({
    packageCode: z.string().trim().min(1).max(100), packageName: z.string().trim().min(1).max(255),
    agreedAmount: amount, inclusions: z.unknown().optional(), exclusions: z.unknown().optional(),
    effectiveFrom: z.coerce.date(), effectiveTo: z.coerce.date().optional(),
  })).default([]),
  documentRequirements: z.array(z.object({
    code: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(255),
    category: z.enum(['identity', 'eligibility', 'clinical', 'diagnostic', 'billing', 'authorization', 'settlement', 'correspondence', 'other']),
    isRequired: z.boolean().default(true), appliesTo: settlementMode.optional(), sortOrder: z.coerce.number().int().default(0),
  })).default([]),
  nonPayableRules: z.array(z.object({
    itemCode: z.string().trim().max(100).optional(), itemPattern: z.string().trim().max(255).optional(),
    reason: z.string().trim().min(1), patientPayable: z.boolean().default(true), isActive: z.boolean().default(true),
  }).refine((rule) => rule.itemCode || rule.itemPattern, 'Item code or pattern is required')).default([]),
}).refine((value) => value.validTo >= value.validFrom, { path: ['validTo'], message: 'Valid-to must not precede valid-from' });

export const createPayerContractSchema = z.object({ body: contractBody });
export const updatePayerContractSchema = z.object({ params: z.object({ id: uuid }), body: contractBody });
export const contractQuerySchema = z.object({
  query: z.object({ payerType: payerType.optional(), payerId: uuid.optional(), activeOn: z.coerce.date().optional() }),
});

export const coveragePreviewSchema = z.object({
  params: z.object({ id: uuid }),
  query: z.object({ billId: uuid }),
});

export const applyCoverageSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({ billId: uuid }),
});

export const createEnhancementSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    procedureDescription: z.string().trim().min(3), estimatedCost: positiveAmount,
    diagnosisCode: z.string().trim().max(50).optional(), procedureCode: z.string().trim().max(50).optional(),
    submissionChannel: z.enum(['portal', 'email', 'nhcx', 'api', 'manual']).optional(),
    submissionReference: z.string().trim().max(100).optional(), notes: optionalText,
  }),
});

export const requestFinalAuthorizationSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    claimId: uuid.optional(), finalAmount: positiveAmount, procedureDescription: z.string().trim().min(3).default('Final discharge authorization'),
    submissionChannel: z.enum(['portal', 'email', 'nhcx', 'api', 'manual']).optional(),
    submissionReference: z.string().trim().max(100).optional(), notes: optionalText,
  }),
});

export const addClaimDocumentSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    code: z.string().trim().max(100).optional(), name: z.string().trim().min(1).max(255),
    category: z.enum(['identity', 'eligibility', 'clinical', 'diagnostic', 'billing', 'authorization', 'settlement', 'correspondence', 'other']),
    fileUrl: z.string().url(), mimeType: z.string().trim().max(100).optional(), fileHash: z.string().trim().max(128).optional(),
  }),
});

export const verifyClaimDocumentSchema = z.object({
  params: z.object({ documentId: uuid }),
  body: z.object({ status: z.enum(['verified', 'rejected']), rejectionReason: optionalText }),
}).superRefine((value, ctx) => {
  if (value.body.status === 'rejected' && !value.body.rejectionReason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body', 'rejectionReason'], message: 'Rejection reason is required' });
  }
});

export const raiseClaimQuerySchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    queryReference: z.string().trim().max(100).optional(), subject: z.string().trim().min(2).max(255),
    queryText: z.string().trim().min(3), responseDueAt: z.coerce.date().optional(), responseHours: z.coerce.number().int().min(1).max(720).optional(),
  }),
});

export const respondClaimQuerySchema = z.object({
  params: z.object({ queryId: uuid }),
  body: z.object({ responseText: z.string().trim().min(3) }),
});

export const resolveClaimQuerySchema = z.object({ params: z.object({ queryId: uuid }) });

export const recordSettlementSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    grossApprovedAmount: amount, grossPaidAmount: amount, tdsAmount: amount.default(0),
    tdsSection: z.string().trim().max(50).optional(), tdsRate: z.coerce.number().min(0).max(100).optional(),
    disallowedAmount: amount.default(0), disallowanceReason: optionalText, netPaidAmount: amount,
    paymentReference: z.string().trim().max(100).optional(), bankReference: z.string().trim().max(100).optional(),
    bankStatementDate: z.coerce.date().optional(), tdsCertificateNumber: z.string().trim().max(100).optional(),
    tdsCertificateDate: z.coerce.date().optional(), settlementDate: z.coerce.date(), notes: optionalText,
  }).superRefine((value, ctx) => {
    const expected = Number((value.grossPaidAmount - value.tdsAmount).toFixed(2));
    if (Math.abs(expected - value.netPaidAmount) > 0.01) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['netPaidAmount'], message: 'Net paid must equal gross paid less TDS' });
    }
    if (value.disallowedAmount > 0 && !value.disallowanceReason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['disallowanceReason'], message: 'Disallowance reason is required' });
    }
  }),
});

export const bulkSettlementSchema = z.object({
  body: z.object({ settlements: z.array(z.object({ claimId: uuid }).and(recordSettlementSchema.shape.body)).min(1).max(100) }),
});

export const requestWriteOffSchema = z.object({
  params: z.object({ id: uuid }), body: z.object({ amount: positiveAmount, reason: z.string().trim().min(5) }),
});

export const decideWriteOffSchema = z.object({
  params: z.object({ writeOffId: uuid }),
  body: z.object({ decision: z.enum(['approved', 'rejected']), decisionNote: optionalText }),
});

export const createAdjustmentSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    adjustmentType: z.enum(['supplementaryPayment', 'creditNote', 'debitNote']), amount: positiveAmount,
    reference: z.string().trim().max(100).optional(), reason: z.string().trim().min(3), effectiveDate: z.coerce.date(),
  }),
});

export const queueExchangeSchema = z.object({
  body: z.object({
    claimId: uuid.optional(), preAuthId: uuid.optional(), channel: z.enum(['portal', 'email', 'nhcx', 'api', 'manual']),
    messageType: z.string().trim().min(2).max(100), transactionId: z.string().trim().min(3).max(100).optional(),
    payload: z.unknown(),
  }).refine((value) => value.claimId || value.preAuthId, 'A claim or pre-authorization is required'),
});

export const workflowReportQuerySchema = z.object({
  query: z.object({
    fromDate: z.coerce.date().optional(), toDate: z.coerce.date().optional(), payerType: payerType.optional(), payerId: uuid.optional(),
  }),
});

export const bankMatchQuerySchema = z.object({
  query: z.object({ bankReference: z.string().trim().min(3).max(100) }),
});

export type CreateInsuranceCaseInput = z.infer<typeof createInsuranceCaseSchema>['body'];
export type RecordEligibilityInput = z.infer<typeof recordEligibilitySchema>['body'];
export type ContractInput = z.infer<typeof createPayerContractSchema>['body'];
export type SettlementInput = z.infer<typeof recordSettlementSchema>['body'];
