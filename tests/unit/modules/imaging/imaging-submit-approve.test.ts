import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  submitImagingResult,
  reopenImagingResult,
  verifyImagingResult,
} from '../../../../src/modules/imaging/imaging.service';

// The radiologist's Mark as Done step. It was removed on 2026-06-01 (the admin
// approved straight off a draft) and is back, because uploading a file is not
// the same as finishing: without it, a half-loaded study sat in the approval
// queue with no way for the person who uploaded it to take it back.
//
// draft — the radiologist's, editable
// finalized — submitted, in the admin's queue
// published — approved, visible to the doctor and the patient

const TENANT_ID = 'tenant-1';
const RADIOLOGIST = 'rad-1';
const ADMIN = 'admin-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('submitImagingResult', () => {
  it('moves the draft to finalized and completes the request', async () => {
    vi.mocked(prisma.imagingResult.findFirst).mockResolvedValueOnce({
      id: 'res-1',
      status: 'draft',
      imagingRequestId: 'req-1',
      impression: null,
    } as any);
    vi.mocked(prisma.imagingAttachment.count).mockResolvedValueOnce(2);
    vi.mocked(prisma.$transaction).mockResolvedValueOnce([
      {
        id: 'res-1',
        status: 'finalized',
        imagingRequest: { id: 'req-1', imagingType: 'ct_scan', bodyPart: 'head' },
        patient: { firstName: 'Asha', lastName: 'Rao' },
      },
      {},
    ] as any);

    const result = await submitImagingResult(TENANT_ID, 'res-1', RADIOLOGIST, 'No bleed');

    expect(result.status).toBe('finalized');
  });

  it('refuses to submit a report with no files — the files ARE the report', async () => {
    vi.mocked(prisma.imagingResult.findFirst).mockResolvedValueOnce({
      id: 'res-1',
      status: 'draft',
      imagingRequestId: 'req-1',
    } as any);
    vi.mocked(prisma.imagingAttachment.count).mockResolvedValueOnce(0);

    await expect(submitImagingResult(TENANT_ID, 'res-1', RADIOLOGIST)).rejects.toThrow(
      'Upload the study files before marking this done',
    );
  });

  it('refuses to re-submit a published report', async () => {
    vi.mocked(prisma.imagingResult.findFirst).mockResolvedValueOnce({
      id: 'res-1',
      status: 'published',
      imagingRequestId: 'req-1',
    } as any);

    await expect(submitImagingResult(TENANT_ID, 'res-1', RADIOLOGIST)).rejects.toThrow(
      'already published',
    );
  });
});

describe('verifyImagingResult', () => {
  it('refuses to publish a study the radiologist has not marked done', async () => {
    // This is the whole point of reinstating the step: approving a draft would
    // release half a study to the doctor behind the radiologist's back.
    vi.mocked(prisma.imagingResult.findFirst).mockResolvedValueOnce({
      id: 'res-1',
      status: 'draft',
      imagingRequestId: 'req-1',
    } as any);

    await expect(verifyImagingResult(TENANT_ID, 'res-1', ADMIN)).rejects.toThrow(
      'still a draft with the radiologist',
    );
  });

  it('refuses to publish an already-published report', async () => {
    vi.mocked(prisma.imagingResult.findFirst).mockResolvedValueOnce({
      id: 'res-1',
      status: 'published',
    } as any);

    await expect(verifyImagingResult(TENANT_ID, 'res-1', ADMIN)).rejects.toThrow(
      'already verified and published',
    );
  });
});

describe('reopenImagingResult', () => {
  it('sends a submitted report back to the radiologist as a draft', async () => {
    vi.mocked(prisma.imagingResult.findFirst).mockResolvedValueOnce({
      id: 'res-1',
      status: 'finalized',
      imagingRequestId: 'req-1',
      radiologistId: RADIOLOGIST,
    } as any);
    vi.mocked(prisma.$transaction).mockResolvedValueOnce([
      { id: 'res-1', status: 'draft', imagingRequest: {}, patient: {} },
      {},
    ] as any);

    const result = await reopenImagingResult(TENANT_ID, 'res-1', ADMIN, 'Need a lateral view');

    expect(result.status).toBe('draft');
    // The radiologist is told, or the report silently reappears on their bench.
    expect(prisma.notification.create).toHaveBeenCalled();
  });

  it('will not pull back a published report', async () => {
    vi.mocked(prisma.imagingResult.findFirst).mockResolvedValueOnce({
      id: 'res-1',
      status: 'published',
      imagingRequestId: 'req-1',
    } as any);

    await expect(reopenImagingResult(TENANT_ID, 'res-1', ADMIN)).rejects.toThrow(
      'publish a correction instead',
    );
  });

  it('is a no-op error on something already sitting as a draft', async () => {
    vi.mocked(prisma.imagingResult.findFirst).mockResolvedValueOnce({
      id: 'res-1',
      status: 'draft',
      imagingRequestId: 'req-1',
    } as any);

    await expect(reopenImagingResult(TENANT_ID, 'res-1', ADMIN)).rejects.toThrow(
      'already a draft with the radiologist',
    );
  });
});
