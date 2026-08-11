import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { rejectLabReport } from '../../../../src/modules/lab/lab.service';

// The other half of the lab admin's decision. Approving existed; refusing did
// not, so a report that was wrong could only be published or left in the queue.

const TENANT_ID = 'tenant-1';
const ADMIN = 'lab-admin-1';

const REPORT = {
  id: 'rep-1',
  status: 'review',
  labOrderId: 'order-1',
  labOrder: {
    id: 'order-1',
    assignedToId: 'tech-1',
    patient: { firstName: 'Asha', lastName: 'Rao', mrn: 'MRN1' },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.labReport.findFirst).mockResolvedValue(REPORT as any);
  vi.mocked(prisma.$transaction).mockResolvedValue([
    { id: 'rep-1', status: 'draft', correctionNotes: 'Wrong file' },
    {},
  ] as any);
});

describe('rejectLabReport', () => {
  it('sends the report back to draft with the reason recorded', async () => {
    const result = await rejectLabReport(TENANT_ID, 'rep-1', ADMIN, '  Wrong file  ');

    expect(result.status).toBe('draft');
    expect(prisma.labReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'draft', correctionNotes: 'Wrong file' }),
      }),
    );
    // The technician who ran it is told, or the report silently stops moving.
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'tech-1', title: 'Lab report sent back' }),
      }),
    );
  });

  it('falls back to the last uploader when nobody is assigned', async () => {
    vi.mocked(prisma.labReport.findFirst).mockResolvedValue({
      ...REPORT,
      labOrder: { ...REPORT.labOrder, assignedToId: null },
    } as any);
    vi.mocked(prisma.labAttachment.findFirst).mockResolvedValue({ uploadedBy: 'tech-9' } as any);

    await rejectLabReport(TENANT_ID, 'rep-1', ADMIN, 'Repeat the run');

    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'tech-9' }) }),
    );
  });

  it('records a default reason rather than sending back a blank one', async () => {
    await rejectLabReport(TENANT_ID, 'rep-1', ADMIN, '   ');

    const ops = vi.mocked(prisma.$transaction).mock.calls[0]![0] as any[];
    expect(ops).toHaveLength(2);
    expect(prisma.labReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'draft',
          correctionNotes: 'Sent back by the lab admin for changes.',
        }),
      }),
    );
  });

  it('puts the order back on the bench', async () => {
    // Submitting marks the order `completed`. Without this the sent-back order
    // would sit on the Completed tab — off the work queue the technician looks
    // at — and never get corrected.
    await rejectLabReport(TENANT_ID, 'rep-1', ADMIN, 'Repeat');

    expect(prisma.labOrder.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { status: 'in_progress' },
    });
  });

  it('refuses to send back a published report', async () => {
    vi.mocked(prisma.labReport.findFirst).mockResolvedValue({
      ...REPORT,
      status: 'published',
    } as any);

    await expect(rejectLabReport(TENANT_ID, 'rep-1', ADMIN, 'x')).rejects.toThrow(
      'issue a correction instead',
    );
  });

  it('refuses to send back something already sitting as a draft', async () => {
    vi.mocked(prisma.labReport.findFirst).mockResolvedValue({
      ...REPORT,
      status: 'draft',
    } as any);

    await expect(rejectLabReport(TENANT_ID, 'rep-1', ADMIN, 'x')).rejects.toThrow(
      'already a draft with the lab',
    );
  });
});
