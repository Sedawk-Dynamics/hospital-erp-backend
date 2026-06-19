import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getIpBillingSummary } from '../../../../src/modules/pharmacy/pharmacy.service';

const TENANT_ID = 'tenant-1';

describe('Pharmacy — §4.1 Flow 2 IP billing / TPA summary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds a TPA summary for an insurance patient (insurer + grouped charges)', async () => {
    (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1', mrn: 'MRN1', firstName: 'A', lastName: 'B' });
    (prisma.admission.findFirst as any).mockResolvedValue({ id: 'adm1', billingCategory: 'insurance', depositAmount: 0, admissionDate: new Date('2026-06-01') });
    (prisma.insurancePolicy.findFirst as any).mockResolvedValue({
      policyNumber: 'POL1', planName: 'Gold', insurer: { name: 'Acme Ins' }, tpa: { name: 'MediTPA' },
    });
    (prisma.bill.findMany as any).mockResolvedValue([
      {
        id: 'b1', billNumber: 'PH1', billDate: new Date(), totalAmount: 100, amountPaid: 0, balanceDue: 100, status: 'pending',
        billItems: [
          { description: 'Amox', category: 'pharmacy', quantity: 1, unitPrice: 100, totalAmount: 100 },
          { description: 'CBC', category: 'lab', quantity: 1, unitPrice: 50, totalAmount: 50 },
        ],
      },
    ]);

    const res = await getIpBillingSummary(TENANT_ID, 'p1');

    expect(res.isTpa).toBe(true);
    expect(res.category).toBe('insurance');
    expect(res.insurance).toMatchObject({ insurer: 'Acme Ins', tpa: 'MediTPA', policyNumber: 'POL1' });
    expect(res.totals.totalBilled).toBe(100);
    expect(res.totals.balanceDue).toBe(100);
    // Charges grouped by service category (highest first).
    expect(res.categoryTotals).toEqual([
      { category: 'pharmacy', amount: 100 },
      { category: 'lab', amount: 50 },
    ]);
  });

  it('treats a patient with no admission as a plain cash statement (no TPA header)', async () => {
    (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p2', mrn: 'MRN2', firstName: 'C', lastName: 'D' });
    (prisma.admission.findFirst as any).mockResolvedValue(null);
    (prisma.bill.findMany as any).mockResolvedValue([]);

    const res = await getIpBillingSummary(TENANT_ID, 'p2');

    expect(res.isTpa).toBe(false);
    expect(res.category).toBe('cash');
    expect(res.insurance).toBeNull();
    // No insurer lookup for a non-TPA patient.
    expect(prisma.insurancePolicy.findFirst).not.toHaveBeenCalled();
  });

  it('rejects an unknown patient', async () => {
    (prisma.patient.findFirst as any).mockResolvedValue(null);
    await expect(getIpBillingSummary(TENANT_ID, 'nope')).rejects.toThrow(/not found/i);
  });

  it('splits pharmacy dispenses into reimbursable vs non-reimbursable + take-home (TTO)', async () => {
    (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1', mrn: 'MRN1', firstName: 'A', lastName: 'B' });
    (prisma.admission.findFirst as any).mockResolvedValue({ id: 'adm1', billingCategory: 'insurance', depositAmount: 0, admissionDate: new Date() });
    (prisma.insurancePolicy.findFirst as any).mockResolvedValue(null);
    (prisma.bill.findMany as any).mockResolvedValue([]);
    (prisma.dispensingRecord.findMany as any).mockResolvedValue([
      { lineTotal: 200, isTto: false, drugBatch: { drug: { isReimbursable: true } } },   // claimable
      { lineTotal: 50, isTto: false, drugBatch: { drug: { isReimbursable: false } } },    // patient pays (e.g. gloves)
      { lineTotal: 120, isTto: true, drugBatch: { drug: { isReimbursable: true } } },     // discharge take-home
    ]);

    const res = await getIpBillingSummary(TENANT_ID, 'p1');
    expect(res.pharmacySplit).toEqual({ reimbursable: 320, nonReimbursable: 50, takeHome: 120 });
  });
});
