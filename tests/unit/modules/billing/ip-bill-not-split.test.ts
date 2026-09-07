import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getOrCreateRunningIpBill } from '../../../../src/modules/billing/billing.service';

const TENANT = 'tenant-1';
const ADMISSION = 'admission-1';
const PATIENT = 'patient-1';
const USER = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.admission.findFirst).mockResolvedValue({
    id: ADMISSION, patientId: PATIENT,
  } as never);
});

/**
 * An IP stay is ONE bill.
 *
 * This used to look for a `draft` and nothing else. "Generate / refresh bill"
 * finalizes the running bill to `pending`, and this runs for every active
 * admission on every worklist load — so the finalized bill was orphaned and a
 * brand-new empty one opened in its place. Charges followed the new bill and a
 * single stay ended up spread over four of them (1958.50 / 121.80 / 280700.00 /
 * 0.00). The worklist row sums every bill on the admission but names only the
 * first, so the collect dialog offered a total the payment endpoint had to
 * refuse: "Payment amount (282780.3) exceeds the balance due (1958.5)".
 */
describe('getOrCreateRunningIpBill — a finalized stay bill is still the stay bill', () => {
  it('reuses the admission\'s finalized IP bill instead of opening another', async () => {
    const finalized = { id: 'bill-1', billNumber: 'IPW-20260714-0003', status: 'pending' };
    vi.mocked(prisma.bill.findFirst)
      .mockResolvedValueOnce(null as never)        // no draft
      .mockResolvedValueOnce(finalized as never);  // ...but an open IP bill exists

    const bill = await getOrCreateRunningIpBill(TENANT, ADMISSION, USER);

    expect(bill).toMatchObject({ id: 'bill-1' });
    expect(prisma.bill.create).not.toHaveBeenCalled();

    const where = vi.mocked(prisma.bill.findFirst).mock.calls[1][0]!.where as any;
    expect(where.status).toEqual({ in: ['pending', 'partially_paid'] });
    expect(where.billNumber).toEqual({ startsWith: 'IPW-' });
  });

  it('still prefers an open draft when there is one', async () => {
    const draft = { id: 'bill-draft', billNumber: 'IPW-20260714-0003', status: 'draft' };
    vi.mocked(prisma.bill.findFirst).mockResolvedValueOnce(draft as never);

    const bill = await getOrCreateRunningIpBill(TENANT, ADMISSION, USER);

    expect(bill).toMatchObject({ id: 'bill-draft' });
    expect(prisma.bill.create).not.toHaveBeenCalled();
  });

  /**
   * A settled document is not reopened — charges arriving after an interim
   * settlement belong on a fresh bill.
   */
  it('opens a new bill when the only prior bill is fully paid', async () => {
    vi.mocked(prisma.bill.findFirst)
      .mockResolvedValueOnce(null as never)  // no draft
      .mockResolvedValueOnce(null as never)  // no open IP bill (the paid one does not match)
      .mockResolvedValueOnce(null as never)  // no adoptable patient draft
      .mockResolvedValueOnce(null as never); // numbering probe
    vi.mocked(prisma.bill.create).mockResolvedValue({ id: 'bill-new', billNumber: 'IPW-20260907-0001' } as never);

    const bill = await getOrCreateRunningIpBill(TENANT, ADMISSION, USER);

    expect(bill).toMatchObject({ id: 'bill-new' });
    expect(prisma.bill.create).toHaveBeenCalledTimes(1);
  });

  it('never adopts the advance bucket as the running bill', async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.bill.create).mockResolvedValue({ id: 'bill-new' } as never);

    await getOrCreateRunningIpBill(TENANT, ADMISSION, USER);

    for (const call of vi.mocked(prisma.bill.findFirst).mock.calls) {
      const where = call[0]!.where as any;
      if (where?.status === 'draft') {
        expect(where.billNumber).toEqual({ not: { startsWith: 'ADV-' } });
      }
    }
  });
});
