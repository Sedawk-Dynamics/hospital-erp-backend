import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getAdmissionLedger } from '../../../../src/modules/billing/billing.service';

const TENANT = 'tenant-1';
const ADMISSION = 'admission-1';
const PATIENT = 'patient-1';

// A billing role passes assertIpLedgerAccess outright, so the test does not
// have to stand up a doctor profile or a nurse assignment.
const ACTOR = { userId: 'user-1', roles: ['admin'] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.admission.findFirst).mockResolvedValue({
    id: ADMISSION,
    patientId: PATIENT,
    depositAmount: 0,
    billingCategory: 'cash',
    admissionDate: new Date('2026-08-20T04:00:00.000Z'),
    visitId: null,
  } as never);
});

describe('getAdmissionLedger — the advance bucket is not a bill', () => {
  /**
   * A patient's advance money sits on a sentinel `ADV-…` bill whose `amountPaid`
   * IS the running advance balance. The ledger already counts that balance
   * separately as money held for the patient (`advanceOnFile`). If the bucket
   * were also summed as one of the stay's bills, its balance would be counted a
   * second time through `paid` — understating what the patient still owes and
   * overstating what is refundable.
   *
   * Ward charge paths used to be able to pick the bucket as "the patient's open
   * bill" and then stamp the admission onto it, so a row can carry this
   * admissionId even though nothing was ever billed on it. The query has to
   * exclude it by bill number, not rely on the admissionId being absent.
   */
  it('excludes the advance bucket from the bills it reads', async () => {
    vi.mocked(prisma.bill.findMany).mockResolvedValue([] as never);

    await getAdmissionLedger(TENANT, ADMISSION, ACTOR);

    const where = vi.mocked(prisma.bill.findMany).mock.calls[0][0]!.where as any;
    expect(where.billNumber).toEqual({ not: { startsWith: 'ADV-' } });
  });

  it('does not count an advance balance twice when a bucket carries the admission', async () => {
    // The bucket is handed back alongside the real IP bill — the shape a row
    // stamped by the old ward charge paths produces. It must not reach the sums.
    vi.mocked(prisma.bill.findMany).mockResolvedValue([
      {
        id: 'bill-adv',
        billNumber: 'ADV-patient1-1755000000000',
        status: 'pending',
        admissionId: ADMISSION,
        totalAmount: 0,
        // The advance balance. Summed as a bill, this lands in `paid`.
        amountPaid: 10000,
        balanceDue: 0,
        discountAmount: 0,
        insuranceCoveredAmount: 0,
        billItems: [],
      },
      {
        id: 'bill-ip',
        billNumber: 'IPW-20260824-0001',
        status: 'draft',
        totalAmount: 2800,
        amountPaid: 0,
        balanceDue: 2800,
        discountAmount: 0,
        insuranceCoveredAmount: 0,
        billItems: [
          {
            id: 'item-1',
            description: 'Room charge',
            category: 'room',
            quantity: 1,
            unitPrice: 2800,
            totalAmount: 2800,
            taxPercent: 0,
            isReimbursable: null,
            isAutoPulled: true,
            referenceType: 'room',
            referenceId: 'stay-1',
            createdAt: new Date('2026-08-21T04:00:00.000Z'),
          },
        ],
      },
    ] as never);

    const ledger = await getAdmissionLedger(TENANT, ADMISSION, ACTOR);

    // `paid` is real cash collected against bills. The ₹10,000 in the bucket is
    // not that — it is money held for the patient, reported separately as the
    // deposit. Counting it here made a ₹2,800 stay look ₹10,000 overpaid.
    expect(ledger.totals.paid).toBe(0);
    expect(ledger.totals.grandTotal).toBe(2800);
    // Only the real bill is listed for the stay.
    expect(ledger.bills.map((b: { billNumber: string }) => b.billNumber)).toEqual([
      'IPW-20260824-0001',
    ]);
  });
});
