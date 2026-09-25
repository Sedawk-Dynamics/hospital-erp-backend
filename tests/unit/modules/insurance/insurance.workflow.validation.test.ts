import { describe, expect, it } from 'vitest';
import {
  createInsuranceCaseSchema,
  queueExchangeSchema,
  recordSettlementSchema,
  requestFinalAuthorizationSchema,
  coveragePreviewSchema,
  applyCoverageSchema,
} from '../../../../src/modules/insurance/insurance.workflow.validation';
import { createClaimSchema, createPreAuthSchema } from '../../../../src/modules/insurance/insurance.validation';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

describe('insurance workflow validation', () => {
  it('requires the concrete payer master for each case type', () => {
    const parsed = createInsuranceCaseSchema.safeParse({
      body: {
        patientId: ID,
        caseType: 'insurance',
        settlementMode: 'cashless',
        paymentResponsibleType: 'insurer',
        paymentResponsibleId: ID2,
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.path.includes('insurerId'))).toBe(true);
  });

  it('accepts corporate credit without pretending the corporation is a TPA', () => {
    const parsed = createInsuranceCaseSchema.parse({
      body: {
        patientId: ID,
        caseType: 'corporate',
        settlementMode: 'credit',
        corporatePayerId: ID2,
        paymentResponsibleType: 'corporate',
        paymentResponsibleId: ID2,
      },
    });

    expect(parsed.body.caseType).toBe('corporate');
    expect(parsed.body.policyIds).toEqual([]);
  });

  it('accepts a claim against a payer case when no insurance policy exists', () => {
    const parsed = createClaimSchema.parse({
      body: {
        insuranceCaseId: ID,
        patientId: ID2,
        billId: '33333333-3333-4333-8333-333333333333',
        claimAmount: 12_000,
      },
    });

    expect(parsed.body.policyId).toBeUndefined();
    expect(parsed.body.tier).toBe('primary');
  });

  it('keeps the hospital request number separate from payer references', () => {
    const parsed = createPreAuthSchema.parse({
      body: {
        insuranceCaseId: ID,
        patientId: ID2,
        procedureDescription: 'Emergency surgery',
      },
    });

    expect(parsed.body).not.toHaveProperty('approvalNumber');
  });

  it('enforces net bank receipt as gross paid less TDS', () => {
    const invalid = recordSettlementSchema.safeParse({
      params: { id: ID },
      body: {
        grossApprovedAmount: 10_000,
        grossPaidAmount: 10_000,
        tdsAmount: 1_000,
        netPaidAmount: 10_000,
        disallowedAmount: 0,
        settlementDate: '2026-09-20',
      },
    });
    expect(invalid.success).toBe(false);

    const valid = recordSettlementSchema.parse({
      params: { id: ID },
      body: {
        grossApprovedAmount: 10_000,
        grossPaidAmount: 10_000,
        tdsAmount: 1_000,
        tdsSection: 'Configured by accounts',
        tdsRate: 10,
        netPaidAmount: 9_000,
        disallowedAmount: 0,
        settlementDate: '2026-09-20',
      },
    });
    expect(valid.body.netPaidAmount).toBe(9_000);
  });

  it('applies the three-hour final discharge authorization contract', () => {
    const parsed = requestFinalAuthorizationSchema.parse({
      params: { id: ID },
      body: { finalAmount: 50_000 },
    });
    expect(parsed.body.procedureDescription).toBe('Final discharge authorization');
  });

  it('requires an exchange to identify a claim or pre-authorization', () => {
    const parsed = queueExchangeSchema.safeParse({
      body: { channel: 'nhcx', messageType: 'claim-submit', payload: { resourceType: 'Claim' } },
    });
    expect(parsed.success).toBe(false);
  });

  it('requires a concrete bill when previewing or applying payer contract coverage', () => {
    expect(coveragePreviewSchema.safeParse({ params: { id: ID }, query: {} }).success).toBe(false);
    expect(coveragePreviewSchema.safeParse({ params: { id: ID }, query: { billId: ID2 } }).success).toBe(true);
    expect(applyCoverageSchema.safeParse({ params: { id: ID }, body: { billId: ID2 } }).success).toBe(true);
  });
});
