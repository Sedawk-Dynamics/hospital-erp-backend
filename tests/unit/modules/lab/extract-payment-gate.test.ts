import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { extractResultsFromAttachment } from '../../../../src/modules/lab/lab.service';

// "Accepting a lab order and verifying payment are separate states — add an
// explicit payment verification step so processing isn't possible without it."
//
// The gate exists and covers entering results, marking a test done, and
// uploading a result file. It did NOT cover reading an uploaded file, which
// writes lab results just the same — so `POST /attachments/:id/extract` could
// record values for an order nobody had accepted and nobody had paid for,
// which is the hole the gate was added to close.

const TENANT = 'tenant-1';
const USER = 'user-1';

const attachment = {
  id: 'att-1',
  fileUrl: '/uploads/report.pdf',
  fileName: 'report.pdf',
  mimeType: 'application/pdf',
  labOrderItemId: 'item-1',
  labOrder: {
    id: 'order-1',
    patientId: 'pat-1',
    labOrderItems: [{ id: 'item-1', testId: 't1', test: { testName: 'CBC' } }],
  },
};

/** The order as the payment gate reads it. */
function stageOrder(over: Record<string, unknown>) {
  vi.mocked(prisma.labAttachment.findFirst).mockResolvedValue(attachment as never);
  vi.mocked(prisma.labOrder.findFirst).mockResolvedValue({
    paymentVerified: false,
    paymentDeferredReason: null,
    acceptedAt: null,
    ...over,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reading an uploaded report is result entry, and clears the same gate', () => {
  it('refuses an order nobody has accepted', async () => {
    stageOrder({ acceptedAt: null, paymentVerified: true });

    await expect(extractResultsFromAttachment(TENANT, 'att-1', USER)).rejects.toThrow(
      /has not been accepted/i,
    );
    expect(prisma.labResult.create).not.toHaveBeenCalled();
  });

  it('refuses an accepted order that has not been paid', async () => {
    stageOrder({ acceptedAt: new Date(), paymentVerified: false, paymentDeferredReason: null });

    await expect(extractResultsFromAttachment(TENANT, 'att-1', USER)).rejects.toThrow(
      /payment is pending/i,
    );
    expect(prisma.labResult.create).not.toHaveBeenCalled();
  });

  it('checks the gate before it looks at anything else', async () => {
    stageOrder({ acceptedAt: null });

    await expect(extractResultsFromAttachment(TENANT, 'att-1', USER)).rejects.toThrow();
    // Nothing read, nothing parsed, nothing written.
    expect(prisma.labResult.findMany).not.toHaveBeenCalled();
  });

  it('allows an order accepted on credit — deferred is a decision, not a gap', async () => {
    stageOrder({
      acceptedAt: new Date(),
      paymentVerified: false,
      paymentDeferredReason: 'Corporate credit',
    });
    vi.mocked(prisma.labResult.findMany).mockResolvedValue([] as never);

    // Gets past the gate. What happens next (file parsing) is not this test's
    // business — it must simply not be refused here.
    await extractResultsFromAttachment(TENANT, 'att-1', USER).catch(() => undefined);

    expect(prisma.labResult.findMany).toHaveBeenCalled();
  });

  it('allows a paid, accepted order', async () => {
    stageOrder({ acceptedAt: new Date(), paymentVerified: true });
    vi.mocked(prisma.labResult.findMany).mockResolvedValue([] as never);

    await extractResultsFromAttachment(TENANT, 'att-1', USER).catch(() => undefined);

    expect(prisma.labResult.findMany).toHaveBeenCalled();
  });
});
