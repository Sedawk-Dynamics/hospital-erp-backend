import { describe, expect, it } from 'vitest';
import { splitBillSchema } from '../../../../src/modules/insurance/insurance.validation';

const BILL_ID = '11111111-1111-4111-8111-111111111111';
const CLAIM_ID = '22222222-2222-4222-8222-222222222222';
const POLICY_ID = '33333333-3333-4333-8333-333333333333';

describe('splitBillSchema', () => {
  it('accepts an exact manual TPA and patient allocation', () => {
    const result = splitBillSchema.safeParse({
      params: { billId: BILL_ID },
      body: { claimId: CLAIM_ID, insuranceAmount: 12000, patientAmount: 5900 },
    });

    expect(result.success).toBe(true);
  });

  it('requires both amounts and the claim for a manual allocation', () => {
    const result = splitBillSchema.safeParse({
      params: { billId: BILL_ID },
      body: { insuranceAmount: 12000 },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining(['body.patientAmount', 'body.claimId']),
      );
    }
  });

  it('keeps policy-based recalculation available', () => {
    const result = splitBillSchema.safeParse({
      params: { billId: BILL_ID },
      body: { policyId: POLICY_ID, claimAmount: 9000 },
    });

    expect(result.success).toBe(true);
  });
});
