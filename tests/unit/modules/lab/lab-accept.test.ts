import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { acceptLabOrder } from '../../../../src/modules/lab/lab.service';
import * as billing from '../../../../src/modules/billing/billing.service';

// lab.service imports these bindings directly, so they have to be replaced at
// the module boundary — spying on the namespace object does not reach an ESM
// import that was already bound. Everything else in billing stays real.
vi.mock('../../../../src/modules/billing/billing.service', async (importOriginal) => {
  const actual = await importOriginal<typeof billing>();
  return {
    ...actual,
    billDiagnosticOrder: vi.fn(),
    createPayment: vi.fn(),
  };
});

const billDiagnosticOrder = vi.mocked(billing.billDiagnosticOrder);
const createPayment = vi.mocked(billing.createPayment);

const OP_BILL = {
  mode: 'op' as const,
  admissionId: null,
  admissionType: null,
  billId: 'bill-1',
  billNumber: 'BILL-1',
  billStatus: 'pending',
  chargeAmount: 300,
  totalAmount: 300,
  amountPaid: 0,
  balanceDue: 300,
  alreadyBilled: false,
};

// Accepting is now the lab's whole counter transaction: charge the order, take
// the money (or record why it is being deferred), admit it, hand it over. These
// pin the money side, because getting it wrong either blocks a patient at the
// bench or admits work against a collection that never happened.

const TENANT_ID = 'tenant-1';
const ACCEPTOR = 'supervisor-1';

const ORDER = {
  id: 'order-1',
  tenantId: TENANT_ID,
  status: 'ordered',
  patientId: 'pat-1',
  visitId: 'visit-1',
  assignedToId: null,
  acceptedAt: null,
  notes: null,
  paymentVerified: false,
  paymentVerifiedBy: null,
  paymentVerifiedAt: null,
  paymentDeferredReason: null,
  // Accept prices the order before it asks for money, so the same findFirst mock
  // has to satisfy the charge builder too.
  labOrderItems: [{ id: 'item-1', status: 'pending', test: { testName: 'CBC', price: 300 } }],
};

const UPDATED = {
  ...ORDER,
  status: 'received',
  patient: { id: 'pat-1', firstName: 'Asha', lastName: 'Rao', mrn: 'MRN1' },
  labOrderItems: [{ id: 'item-1', test: { testName: 'CBC' } }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.labOrder.findFirst).mockResolvedValue(ORDER as any);
  vi.mocked(prisma.labOrder.update).mockResolvedValue(UPDATED as any);
});

describe('acceptLabOrder', () => {
  it('collects at the lab counter and clears the payment gate', async () => {
    billDiagnosticOrder.mockResolvedValue(OP_BILL);
    createPayment.mockResolvedValue({ payment: { id: 'pay-1' }, receipt: { id: 'rcp-1' } } as any);
    vi.mocked(prisma.bill.findUnique).mockResolvedValue({ balanceDue: 0 } as any);

    await acceptLabOrder(TENANT_ID, 'order-1', ACCEPTOR, {
      payment: { paymentMethod: 'cash' },
    } as any);

    // Amount omitted means "the whole balance" — the counter's normal case.
    expect(createPayment).toHaveBeenCalledWith(
      TENANT_ID,
      ACCEPTOR,
      expect.objectContaining({ billId: 'bill-1', amount: 300, paymentMethod: 'cash' }),
    );
    expect(prisma.labOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentVerified: true,
          paymentDeferredReason: null,
          status: 'received',
        }),
      }),
    );
  });

  it('leaves the gate closed on a part payment and records why', async () => {
    billDiagnosticOrder.mockResolvedValue(OP_BILL);
    createPayment.mockResolvedValue({} as any);
    vi.mocked(prisma.bill.findUnique).mockResolvedValue({ balanceDue: 100 } as any);

    await acceptLabOrder(TENANT_ID, 'order-1', ACCEPTOR, {
      payment: { paymentMethod: 'cash', amount: 200 },
    } as any);

    const data = vi.mocked(prisma.labOrder.update).mock.calls[0]![0]!.data as any;
    expect(data.paymentVerified).toBe(false);
    expect(data.paymentDeferredReason).toBe('Part payment collected');
    // The work is still admitted — the money and the bench are separate concerns.
    expect(data.status).toBe('received');
  });

  it('never collects for an admitted patient — the charge is on the stay ledger', async () => {
    billDiagnosticOrder.mockResolvedValue({
      ...OP_BILL,
      mode: 'ip',
      admissionId: 'adm-1',
      admissionType: 'emergency',
      billId: 'ipw-1',
      billNumber: 'IPW-1',
      billStatus: 'draft',
    });

    const result = await acceptLabOrder(TENANT_ID, 'order-1', ACCEPTOR, {
      payment: { paymentMethod: 'cash' },
    } as any);

    // Even with a payment in the request: an IP charge settles once, at
    // discharge. Taking it here would bill the stay twice.
    expect(createPayment).not.toHaveBeenCalled();
    expect((result as any).billing.mode).toBe('ip');
    const data = vi.mocked(prisma.labOrder.update).mock.calls[0]![0]!.data as any;
    expect(data.paymentVerified).toBe(true);
  });

  it('admits an unpaid order on credit, keeping the reason', async () => {
    billDiagnosticOrder.mockResolvedValue(OP_BILL);

    await acceptLabOrder(TENANT_ID, 'order-1', ACCEPTOR, {
      deferReason: 'TPA / Insurance — billed to payer',
    } as any);

    expect(createPayment).not.toHaveBeenCalled();
    const data = vi.mocked(prisma.labOrder.update).mock.calls[0]![0]!.data as any;
    expect(data.paymentVerified).toBe(false);
    expect(data.paymentDeferredReason).toBe('TPA / Insurance — billed to payer');
  });

  it('clears the gate when the front desk already settled it', async () => {
    billDiagnosticOrder.mockResolvedValue({
      ...OP_BILL,
      billStatus: 'paid',
      amountPaid: 300,
      balanceDue: 0,
      alreadyBilled: true,
    });

    await acceptLabOrder(TENANT_ID, 'order-1', ACCEPTOR, {} as any);

    // Refusing over money we have already taken would strand the patient.
    expect(createPayment).not.toHaveBeenCalled();
    const data = vi.mocked(prisma.labOrder.update).mock.calls[0]![0]!.data as any;
    expect(data.paymentVerified).toBe(true);
  });

  it('refuses to accept a cancelled order', async () => {
    vi.mocked(prisma.labOrder.findFirst).mockResolvedValue({
      ...ORDER,
      status: 'cancelled',
    } as any);

    await expect(acceptLabOrder(TENANT_ID, 'order-1', ACCEPTOR, {} as any)).rejects.toThrow(
      'Cannot accept a cancelled order',
    );
  });
});
