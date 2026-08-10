import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { cancelKit, requestKit } from '../../../../src/modules/ot-kit/ot-kit.service';

const TENANT_ID = 'tenant-1';
const NURSE_ID = 'user-nurse-1';
const OTHER_ID = 'user-nurse-2';
const PHARMACIST_ROLES = ['pharmacist'];
const NURSE_ROLES = ['nurse'];

// The ward nurse usually raises the pre-op kit for the surgeon. Requesting was
// always open to any authenticated staff; withdrawing was pharmacy-only, which
// meant a nurse who picked the wrong preference card had to telephone the
// pharmacy to undo their own untouched request.

describe('OtKitService — cancelKit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.$transaction as any).mockImplementation((arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg ?? []),
    );
    vi.mocked(prisma.otKitIssue.update).mockResolvedValue({
      id: 'kit-1',
      status: 'cancelled',
      items: [],
    } as any);
  });

  /** A kit sitting in `requested`, raised by the nurse, nothing issued yet. */
  function mockKit(over: Record<string, unknown> = {}) {
    vi.mocked(prisma.otKitIssue.findFirst).mockResolvedValue({
      id: 'kit-1',
      tenantId: TENANT_ID,
      status: 'requested',
      requestedById: NURSE_ID,
      notes: null,
      items: [],
      ...over,
    } as any);
  }

  it('lets the requester withdraw their own kit while it is still only a request', async () => {
    mockKit();

    const result = await cancelKit(TENANT_ID, NURSE_ID, NURSE_ROLES, 'kit-1', 'Surgery deferred');

    expect(result.status).toBe('cancelled');
    expect(prisma.otKitIssue.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'kit-1' } }),
    );
  });

  it('refuses a different nurse trying to withdraw someone else’s kit', async () => {
    mockKit({ requestedById: OTHER_ID });

    await expect(
      cancelKit(TENANT_ID, NURSE_ID, NURSE_ROLES, 'kit-1'),
    ).rejects.toThrow('You do not have permission to cancel an OT kit.');
    expect(prisma.otKitIssue.update).not.toHaveBeenCalled();
  });

  it('refuses the requester once the pharmacy has issued the kit', async () => {
    // Stock has physically left the pharmacy at this point, so putting it back
    // is a pharmacy action — not something the ward can do unilaterally.
    mockKit({ status: 'issued' });

    await expect(
      cancelKit(TENANT_ID, NURSE_ID, NURSE_ROLES, 'kit-1'),
    ).rejects.toThrow('You do not have permission to cancel an OT kit.');
    expect(prisma.otKitIssue.update).not.toHaveBeenCalled();
  });

  it('still lets the pharmacy pull back an issued kit', async () => {
    mockKit({ status: 'issued', requestedById: OTHER_ID });

    const result = await cancelKit(TENANT_ID, 'user-pharmacist', PHARMACIST_ROLES, 'kit-1');

    expect(result.status).toBe('cancelled');
  });

  it('returns a reversed batch to stock when the pharmacy pulls an issued kit', async () => {
    mockKit({
      status: 'issued',
      requestedById: OTHER_ID,
      items: [{ id: 'item-1', drugBatchId: 'batch-1', issuedQty: 5 }],
    });
    vi.mocked(prisma.drugBatch.update).mockResolvedValue({} as any);
    vi.mocked(prisma.otKitIssueItem.update).mockResolvedValue({} as any);

    await cancelKit(TENANT_ID, 'user-pharmacist', PHARMACIST_ROLES, 'kit-1');

    expect(prisma.drugBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: { quantityInStock: { increment: 5 } },
    });
  });

  it('never cancels a reconciled kit — it has already been billed', async () => {
    mockKit({ status: 'reconciled' });

    await expect(
      cancelKit(TENANT_ID, 'user-pharmacist', PHARMACIST_ROLES, 'kit-1'),
    ).rejects.toThrow('A reconciled kit cannot be cancelled');
  });

  it('is idempotent on an already-cancelled kit', async () => {
    mockKit({ status: 'cancelled' });

    const result = await cancelKit(TENANT_ID, NURSE_ID, NURSE_ROLES, 'kit-1');

    expect(result.status).toBe('cancelled');
    expect(prisma.otKitIssue.update).not.toHaveBeenCalled();
  });

  it('reports a missing kit as not found rather than as forbidden', async () => {
    vi.mocked(prisma.otKitIssue.findFirst).mockResolvedValue(null);

    await expect(
      cancelKit(TENANT_ID, NURSE_ID, NURSE_ROLES, 'no-such-kit'),
    ).rejects.toThrow('OT kit issue not found');
  });
});

describe('OtKitService — requestKit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.$transaction as any).mockImplementation((arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg ?? []),
    );
  });

  it('records who raised the kit, so the ward can withdraw its own', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'patient-1' } as any);
    vi.mocked(prisma.surgicalTemplate.findFirst).mockResolvedValue({ id: 'tpl-1' } as any);
    vi.mocked(prisma.otKitIssue.count).mockResolvedValue(0);
    vi.mocked(prisma.otKitIssue.create).mockResolvedValue({ id: 'kit-1' } as any);

    await requestKit(TENANT_ID, NURSE_ID, {
      patientId: 'patient-1',
      templateId: 'tpl-1',
      otRequestId: 'ot-1',
    });

    expect(prisma.otKitIssue.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestedById: NURSE_ID,
        status: 'requested',
        patientId: 'patient-1',
        templateId: 'tpl-1',
        otRequestId: 'ot-1',
      }),
    });
  });

  it('rejects a kit for a patient that is not in this tenant', async () => {
    vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);

    await expect(
      requestKit(TENANT_ID, NURSE_ID, { patientId: 'someone-elses-patient' }),
    ).rejects.toThrow('Patient not found');
  });
});
