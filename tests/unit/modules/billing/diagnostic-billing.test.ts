import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  resolveDiagnosticPayer,
  billDiagnosticOrder,
} from '../../../../src/modules/billing/billing.service';

// A lab order and an imaging request settle by the same rule, so these cover the
// one helper both departments call when their admin accepts:
//
//   OP  → a dedicated, finalized bill the department collects and prints against
//   IP / Emergency / Day Care → the admission's running ledger, settled at discharge
//
// and the thing that is easy to get wrong: idempotency has to hold across the
// WHOLE tenant, not per bill, or the same test is charged twice on two bills.

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveDiagnosticPayer', () => {
  it('routes to the stay ledger when the order sits on an admitted visit', async () => {
    vi.mocked(prisma.admission.findFirst).mockResolvedValueOnce({ id: 'adm-1' } as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ admission_type: 'daycare' }] as any);

    const payer = await resolveDiagnosticPayer(TENANT_ID, 'pat-1', 'visit-1');

    expect(payer).toEqual({ mode: 'ip', admissionId: 'adm-1', admissionType: 'daycare' });
  });

  it('falls back to any active admission for the patient', async () => {
    // A ward lab order is often raised against the OP visit that preceded the
    // admission, so a visit miss must not read as an outpatient.
    vi.mocked(prisma.admission.findFirst)
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({ id: 'adm-9' } as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ admission_type: 'emergency' }] as any);

    const payer = await resolveDiagnosticPayer(TENANT_ID, 'pat-1', 'visit-1');

    expect(payer.mode).toBe('ip');
    expect(payer.admissionType).toBe('emergency');
  });

  it('treats a null admission_type as a plain in-patient', async () => {
    vi.mocked(prisma.admission.findFirst).mockResolvedValueOnce({ id: 'adm-1' } as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ admission_type: null }] as any);

    const payer = await resolveDiagnosticPayer(TENANT_ID, 'pat-1', 'visit-1');

    expect(payer.admissionType).toBe('ip');
  });

  it('reads as outpatient when nobody is admitted', async () => {
    vi.mocked(prisma.admission.findFirst).mockResolvedValue(null as any);

    const payer = await resolveDiagnosticPayer(TENANT_ID, 'pat-1', 'visit-1');

    expect(payer).toEqual({ mode: 'op', admissionId: null, admissionType: null });
  });
});

describe('billDiagnosticOrder', () => {
  const CHARGES = [
    {
      referenceType: 'lab_order_item' as const,
      referenceId: 'item-1',
      description: 'CBC',
      unitPrice: 300,
    },
  ];

  it('posts nothing when there is nothing to charge', async () => {
    const result = await billDiagnosticOrder(TENANT_ID, USER_ID, {
      source: 'lab',
      patientId: 'pat-1',
      visitId: 'visit-1',
      charges: [],
    });

    expect(result).toBeNull();
    expect(prisma.billItem.create).not.toHaveBeenCalled();
  });

  it('skips a reference already billed anywhere in the tenant', async () => {
    // pullChargesToBill only dedupes WITHIN one bill. Without the tenant-wide
    // check, a test the front desk had already pulled onto a counter bill would
    // be charged a second time here, on a different bill.
    vi.mocked(prisma.billItem.findMany).mockResolvedValueOnce([
      { referenceId: 'item-1', billId: 'bill-existing', totalAmount: 300 },
    ] as any);
    vi.mocked(prisma.admission.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.bill.findFirst).mockResolvedValueOnce({
      id: 'bill-existing',
      billNumber: 'BILL-1',
      status: 'pending',
      totalAmount: 300,
      amountPaid: 300,
      balanceDue: 0,
    } as any);
    vi.mocked(prisma.billItem.findMany).mockResolvedValueOnce([{ totalAmount: 300 }] as any);

    const result = await billDiagnosticOrder(TENANT_ID, USER_ID, {
      source: 'lab',
      patientId: 'pat-1',
      visitId: 'visit-1',
      charges: CHARGES,
    });

    expect(result).toMatchObject({
      alreadyBilled: true,
      billId: 'bill-existing',
      chargeAmount: 300,
      balanceDue: 0,
    });
    // Nothing new was posted, so no bill was created.
    expect(prisma.bill.create).not.toHaveBeenCalled();
  });

  it('reports the admission type it settled against', async () => {
    vi.mocked(prisma.billItem.findMany).mockResolvedValueOnce([] as any);
    // Once for resolveDiagnosticPayer's visit lookup, once for the admission
    // getOrCreateRunningIpBill loads before it opens the running bill.
    vi.mocked(prisma.admission.findFirst).mockResolvedValue({
      id: 'adm-1',
      patientId: 'pat-1',
    } as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ admission_type: 'daycare' }] as any);
    // getOrCreateRunningIpBill finds the stay's running draft.
    vi.mocked(prisma.bill.findFirst).mockResolvedValueOnce({
      id: 'ipw-1',
      status: 'draft',
      admissionId: 'adm-1',
    } as any);
    // pullChargesToBill re-reads the bill and requires it to still be a draft.
    vi.mocked(prisma.bill.findFirst).mockResolvedValueOnce({ id: 'ipw-1', status: 'draft' } as any);
    vi.mocked(prisma.billItem.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.bill.findFirst).mockResolvedValueOnce({
      id: 'ipw-1',
      billNumber: 'IPW-20260811-0001',
      status: 'draft',
      totalAmount: 300,
      amountPaid: 0,
      balanceDue: 300,
    } as any);
    vi.mocked(prisma.billItem.findMany).mockResolvedValue([{ totalAmount: 300 }] as any);

    const result = await billDiagnosticOrder(TENANT_ID, USER_ID, {
      source: 'lab',
      patientId: 'pat-1',
      visitId: 'visit-1',
      charges: CHARGES,
    });

    expect(result).toMatchObject({ mode: 'ip', admissionType: 'daycare', admissionId: 'adm-1' });
    // An IP charge is never finalized here — the stay settles once, at discharge.
    expect(prisma.bill.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'pending' }) }),
    );
  });
});
