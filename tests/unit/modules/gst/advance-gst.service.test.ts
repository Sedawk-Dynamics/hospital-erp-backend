import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  computeAdvanceTax,
  advancePaymentTaxFields,
  issueRefundVoucher,
  issueRefundVoucherBestEffort,
} from '../../../../src/modules/gst/advance-gst.service';
import { recordAdmissionDepositReceipt } from '../../../../src/modules/billing/billing.service';
import { DEFAULT_GST_PROFILE, mergeGstProfile } from '../../../../src/shared/gst-profile';

const REGISTERED = mergeGstProfile(DEFAULT_GST_PROFILE, {
  gstin: '27AAPFU0939F1ZV',
  registered: true,
});

describe('computeAdvanceTax', () => {
  // The ordinary hospital advance. A deposit is money against treatment, and
  // treatment is exempt, so nothing is due when it is taken.
  it('exempts a deposit taken against treatment', () => {
    const t = computeAdvanceTax(REGISTERED, { amount: 10000 });
    expect(t).toMatchObject({
      gstTreatment: 'exempt',
      taxRatePercent: 0,
      taxableValue: 10000,
      taxAmount: 0,
    });
    expect(t.reason).toContain('exempt supply');
  });

  it('exempts one taken against nothing in particular', () => {
    expect(computeAdvanceTax(REGISTERED, { amount: 5000, purpose: 'other' }).gstTreatment).toBe(
      'exempt',
    );
  });

  // For a service the time of supply is the earlier of invoice or payment, so
  // an advance against a taxable supply fixes the liability at receipt.
  it('taxes an advance against a room above the threshold', () => {
    const t = computeAdvanceTax(REGISTERED, { amount: 10000, purpose: 'accommodation' });
    expect(t.gstTreatment).toBe('taxable');
    expect(t.taxRatePercent).toBe(5);
    // Money in hand is tax-inclusive: the patient handed over 10,000.
    expect(t.taxableValue).toBe(9523.81);
    expect(t.taxAmount).toBe(476.19);
    expect(t.cgstAmount + t.sgstAmount).toBeCloseTo(476.19, 2);
  });

  it('taxes an advance against non-therapeutic work at 18%', () => {
    const t = computeAdvanceTax(REGISTERED, { amount: 20000, purpose: 'non_therapeutic' });
    expect(t.taxRatePercent).toBe(18);
    expect(t.taxableValue).toBe(16949.15);
    expect(t.taxAmount).toBe(3050.85);
  });

  it('honours a rate the hospital states over the default', () => {
    const t = computeAdvanceTax(REGISTERED, {
      amount: 10000,
      purpose: 'accommodation',
      ratePercent: 12,
    });
    expect(t.taxRatePercent).toBe(12);
  });

  it('routes an out-of-state advance to IGST', () => {
    const t = computeAdvanceTax(REGISTERED, {
      amount: 10000,
      purpose: 'non_therapeutic',
      placeOfSupplyStateCode: '29',
    });
    expect(t.igstAmount).toBeGreaterThan(0);
    expect(t.cgstAmount).toBe(0);
    expect(t.sgstAmount).toBe(0);
  });

  // Never invent tax on a hospital that is not registered.
  it('charges nothing when the hospital is not registered', () => {
    const t = computeAdvanceTax(DEFAULT_GST_PROFILE, { amount: 10000, purpose: 'accommodation' });
    expect(t).toMatchObject({ gstTreatment: 'exempt', taxAmount: 0 });
    expect(t.reason).toContain('not registered');
  });

  it('charges nothing before the cut-over', () => {
    const p = mergeGstProfile(REGISTERED, { effectiveFrom: '2027-04-01' });
    const t = computeAdvanceTax(p, {
      amount: 10000,
      purpose: 'accommodation',
      on: new Date('2026-09-02T06:00:00Z'),
    });
    expect(t.taxAmount).toBe(0);
    expect(t.reason).toContain('before this hospital started filing');
  });

  // The taxable value plus the tax must always be the money that changed hands.
  it('never collects more than the patient handed over', () => {
    for (const purpose of ['treatment', 'accommodation', 'non_therapeutic'] as const) {
      const t = computeAdvanceTax(REGISTERED, { amount: 7777, purpose });
      expect(t.taxableValue + t.taxAmount).toBeCloseTo(7777, 2);
    }
  });
});

describe('advancePaymentTaxFields', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allots a receipt voucher number for a registered hospital', async () => {
    (prisma.gstDocumentSeries.upsert as any).mockResolvedValue({ prefix: 'RV', lastNumber: 2 });
    const f = await advancePaymentTaxFields(prisma, 'tenant-1', REGISTERED, { amount: 5000 });
    expect(f.voucherType).toBe('receipt_voucher');
    expect(f.voucherNumber).toBe('RV/2026-27/000002');
    expect(f.gstTreatment).toBe('exempt');
  });

  it('records the position without a number when unregistered', async () => {
    const f = await advancePaymentTaxFields(prisma, 'tenant-1', DEFAULT_GST_PROFILE, {
      amount: 5000,
    });
    expect(f.voucherNumber).toBeNull();
    expect(prisma.gstDocumentSeries.upsert as any).not.toHaveBeenCalled();
  });

  // Taking a patient's money must not fail because a number could not be
  // allotted. The tax position is still recorded.
  it('still records the tax when the voucher number cannot be allotted', async () => {
    (prisma.gstDocumentSeries.upsert as any).mockRejectedValue(new Error('series is locked'));
    const f = await advancePaymentTaxFields(prisma, 'tenant-1', REGISTERED, {
      amount: 10000,
      purpose: 'accommodation',
    });
    expect(f.voucherNumber).toBeNull();
    expect(f.gstTreatment).toBe('taxable');
    expect(f.taxAmount).toBe(476.19);
  });
});

describe('recordAdmissionDepositReceipt', () => {
  beforeEach(() => vi.clearAllMocks());

  const DEP = {
    patientId: 'pat-1',
    admissionId: 'adm-1',
    amount: 20000,
  };

  function setup() {
    (prisma.bill.findFirst as any).mockResolvedValue({ id: 'adv-bucket' });
    (prisma.receipt.findFirst as any).mockResolvedValue(null);
    (prisma.tenant.findFirst as any).mockResolvedValue({
      themeConfig: { gst: { registered: true, gstin: '27AAPFU0939F1ZV' } },
    });
    (prisma.gstDocumentSeries.upsert as any).mockResolvedValue({ prefix: 'RV', lastNumber: 9 });
    (prisma.payment.create as any).mockResolvedValue({ id: 'pay-1' });
    (prisma.receipt.create as any).mockResolvedValue({ id: 'rcp-1' });
  }

  // The gap this closes: money was written to depositAmount as a bare number
  // with no date, no tender, nobody named and nothing to hand the patient.
  it('writes a payment and a receipt for the money taken', async () => {
    setup();
    const out = await recordAdmissionDepositReceipt(prisma, 'tenant-1', 'user-1', DEP);
    expect(out).toMatchObject({ paymentId: 'pay-1' });
    const pay = (prisma.payment.create as any).mock.calls[0][0].data;
    expect(pay).toMatchObject({
      amount: 20000,
      paymentType: 'advance',
      status: 'completed',
      processedBy: 'user-1',
      gstTreatment: 'exempt',
    });
    expect(prisma.receipt.create as any).toHaveBeenCalled();
  });

  // The marker is what lets this row exist without disturbing any existing
  // figure — it must never be read as deposit money applied to a bill.
  it('marks the row as a RECEIPT, not an application', async () => {
    setup();
    await recordAdmissionDepositReceipt(prisma, 'tenant-1', 'user-1', DEP);
    const txn = (prisma.payment.create as any).mock.calls[0][0].data.transactionId;
    expect(txn).toBe('IPDEPRCPT:adm-1');

    // The two prefixes are one character apart and the consequence of a
    // collision is not subtle: getAdmissionDepositState counts every row whose
    // transactionId starts with 'IPDEP:' as deposit money ALREADY APPLIED to a
    // bill. If a receipt row matched that, every deposit would be read as fully
    // spent the instant it was taken and availableToApply would sit at zero.
    //
    // It does not match, because the sixth character is 'R' and not ':'. Pinned
    // here so a later rename cannot quietly break it.
    expect(txn.startsWith('IPDEP:')).toBe(false);
  });

  it('records the tender the desk actually took', async () => {
    setup();
    await recordAdmissionDepositReceipt(prisma, 'tenant-1', 'user-1', {
      ...DEP,
      paymentMethod: 'upi',
    });
    expect((prisma.payment.create as any).mock.calls[0][0].data.paymentMethod).toBe('upi');
  });

  it('writes nothing when no deposit was taken', async () => {
    setup();
    expect(
      await recordAdmissionDepositReceipt(prisma, 'tenant-1', 'user-1', { ...DEP, amount: 0 }),
    ).toBeNull();
    expect(prisma.payment.create as any).not.toHaveBeenCalled();
  });
});

describe('issueRefundVoucher', () => {
  beforeEach(() => vi.clearAllMocks());

  /** A taxable advance: ₹10,000 against a deluxe room at 5%. */
  const TAXABLE_ADVANCE = {
    id: 'adv-1',
    amount: 10000,
    paymentMethod: 'cash',
    gstTreatment: 'taxable',
    taxRatePercent: 5,
    taxableValue: 9523.81,
    taxAmount: 476.19,
    cgstAmount: 238.1,
    sgstAmount: 238.09,
    igstAmount: 0,
    voucherNumber: 'RV/2026-27/000001',
  };

  function setup(source: any = TAXABLE_ADVANCE) {
    (prisma.payment.findFirst as any).mockResolvedValue(source);
    (prisma.gstDocumentSeries.upsert as any).mockResolvedValue({ prefix: 'RFV', lastNumber: 1 });
    (prisma.payment.create as any).mockResolvedValue({ id: 'refund-1' });
  }

  it('numbers the voucher from its own series', async () => {
    setup();
    const out = await issueRefundVoucher(prisma, 'tenant-1', {
      sourceAdvancePaymentId: 'adv-1',
      patientId: 'pat-1',
      billId: 'adv-bucket',
      amount: 10000,
    });
    expect(out?.voucherNumber).toBe('RFV/2026-27/000001');
    expect((prisma.gstDocumentSeries.upsert as any).mock.calls[0][0].where
      .tenantId_documentType_financialYear.documentType).toBe('refund_voucher');
  });

  // Mirrors rather than recomputes, so the pair nets to zero however the
  // masters have moved since the advance was taken.
  it('reverses the receipt voucher tax exactly, and negatively', async () => {
    setup();
    await issueRefundVoucher(prisma, 'tenant-1', {
      sourceAdvancePaymentId: 'adv-1',
      patientId: 'pat-1',
      billId: 'adv-bucket',
      amount: 10000,
    });
    const d = (prisma.payment.create as any).mock.calls[0][0].data;
    expect(d.taxableValue).toBe(-9523.81);
    expect(d.taxAmount).toBe(-476.19);
    expect(d.cgstAmount).toBe(-238.1);
    expect(d.sgstAmount).toBe(-238.09);
    // The money out keeps the existing convention: positive, with the type
    // carrying the direction.
    expect(d.amount).toBe(10000);
    expect(d.paymentType).toBe('refund');
    expect(d.voucherType).toBe('refund_voucher');
    expect(d.sourceAdvancePaymentId).toBe('adv-1');
  });

  it('scales a part refund, tax included', async () => {
    setup();
    await issueRefundVoucher(prisma, 'tenant-1', {
      sourceAdvancePaymentId: 'adv-1',
      patientId: 'pat-1',
      billId: 'adv-bucket',
      amount: 4000,
    });
    const d = (prisma.payment.create as any).mock.calls[0][0].data;
    expect(d.taxAmount).toBe(-190.48); // 40% of 476.19
    expect(d.amount).toBe(4000);
  });

  // More going back than came in would over-reverse the tax.
  it('never reverses more tax than the advance carried', async () => {
    setup();
    await issueRefundVoucher(prisma, 'tenant-1', {
      sourceAdvancePaymentId: 'adv-1',
      patientId: 'pat-1',
      billId: 'adv-bucket',
      amount: 999999,
    });
    expect((prisma.payment.create as any).mock.calls[0][0].data.taxAmount).toBe(-476.19);
  });

  // The ordinary hospital case: an exempt deposit going back reverses nothing,
  // because nothing was charged. The voucher still exists as the document.
  it('reverses no tax on an exempt deposit, but still issues the voucher', async () => {
    setup({ ...TAXABLE_ADVANCE, gstTreatment: 'exempt', taxRatePercent: 0,
            taxableValue: 10000, taxAmount: 0, cgstAmount: 0, sgstAmount: 0 });
    const out = await issueRefundVoucher(prisma, 'tenant-1', {
      sourceAdvancePaymentId: 'adv-1',
      patientId: 'pat-1',
      billId: 'adv-bucket',
      amount: 10000,
    });
    expect(out?.taxReversed).toBe(0);
    expect(out?.voucherNumber).toBe('RFV/2026-27/000001');
    expect((prisma.payment.create as any).mock.calls[0][0].data.taxableValue).toBe(-10000);
  });

  it('writes nothing when there is no advance to refund against', async () => {
    (prisma.payment.findFirst as any).mockResolvedValue(null);
    expect(
      await issueRefundVoucher(prisma, 'tenant-1', {
        sourceAdvancePaymentId: 'gone',
        patientId: 'pat-1',
        billId: 'b',
        amount: 100,
      }),
    ).toBeNull();
    expect(prisma.payment.create as any).not.toHaveBeenCalled();
  });

  // Handing a patient their money back must not fail over a document.
  it('never throws through the best-effort wrapper', async () => {
    (prisma.payment.findFirst as any).mockRejectedValue(new Error('database is gone'));
    await expect(
      issueRefundVoucherBestEffort(prisma, 'tenant-1', {
        sourceAdvancePaymentId: 'adv-1',
        patientId: 'pat-1',
        billId: 'b',
        amount: 100,
      }),
    ).resolves.toBeUndefined();
  });
});
