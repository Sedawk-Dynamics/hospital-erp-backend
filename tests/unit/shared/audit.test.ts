import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../src/config/database';
import { writeAudit } from '../../../src/shared/audit';
import { getRequestContext } from '../../../src/config/request-context';

vi.mock('../../../src/config/request-context', () => ({
  getRequestContext: vi.fn(() => undefined),
}));

// The audit trail is the only forensic record of a counter that takes money by
// hand. Two properties matter more than anything it writes: it must attribute
// the action to a person, and it must never take down the work it describes.

describe('writeAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRequestContext).mockReturnValue(undefined as any);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any);
  });

  it('writes the row with the acting user', async () => {
    await writeAudit({
      tenantId: 'tenant-1',
      userId: 'user-1',
      action: 'update',
      entityType: 'bill',
      entityId: 'bill-1',
      description: 'Bill finalized',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'update',
        entityType: 'bill',
        entityId: 'bill-1',
        description: 'Bill finalized',
      }),
    });
  });

  it('appends the reason to the description', async () => {
    // Discounts, cancellations and reversals all carry a justification. It has
    // to land in the searchable description, not only in a JSON blob.
    await writeAudit({
      tenantId: 'tenant-1',
      userId: 'user-1',
      action: 'update',
      entityType: 'bill',
      entityId: 'bill-1',
      description: 'Concession on bill BILL-1: 10%',
      reason: 'Staff family',
    });

    const arg = vi.mocked(prisma.auditLog.create).mock.calls[0]![0] as any;
    expect(arg.data.description).toBe('Concession on bill BILL-1: 10% — Reason: Staff family');
  });

  it('falls back to the request-context user and stamps IP and agent', async () => {
    vi.mocked(getRequestContext).mockReturnValue({
      userId: 'ctx-user',
      ipAddress: '10.0.0.5',
      userAgent: 'Chrome',
    } as any);

    await writeAudit({
      tenantId: 'tenant-1',
      action: 'create',
      entityType: 'payment',
      entityId: 'payment-1',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'ctx-user',
        ipAddress: '10.0.0.5',
        userAgent: 'Chrome',
      }),
    });
  });

  it('skips silently when there is no actor to attribute', async () => {
    // A system job has nobody to blame; an audit row with a null user is worse
    // than none, and AuditLog.userId is required anyway.
    await writeAudit({
      tenantId: 'tenant-1',
      action: 'update',
      entityType: 'bill',
      entityId: 'bill-1',
    });

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('never throws, so a failed audit cannot undo the payment it describes', async () => {
    // This is the whole reason the helper swallows errors. The audit write
    // happens after the money transaction commits; if it were allowed to throw
    // it would surface as a failed request for work that already succeeded.
    vi.mocked(prisma.auditLog.create).mockRejectedValue(new Error('db down'));

    await expect(
      writeAudit({
        tenantId: 'tenant-1',
        userId: 'user-1',
        action: 'create',
        entityType: 'payment',
        entityId: 'payment-1',
      }),
    ).resolves.toBeUndefined();
  });
});
