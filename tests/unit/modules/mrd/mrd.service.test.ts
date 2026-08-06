import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { generateDischargeSummary } from '../../../../src/modules/mrd/mrd.service';

const TENANT_ID = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
});

// A pin added AFTER the summary was first generated used to be invisible
// forever: the summary is built once, the editor never asks for a refresh, and
// refresh is a full rebuild that would wipe whatever the doctor had typed.
describe('generateDischargeSummary — folding pins into a draft', () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    id: 'ds1',
    admissionId: 'adm1',
    status: 'draft',
    diagnosesSummary: null,
    proceduresSummary: null,
    medicationReconciliation: null,
    dischargeInstructions: null,
    followUpInstructions: null,
    headerSummary: null,
    ...over,
  });

  const pin = (section: string, content: string) => ({
    id: `pin-${section}`,
    dischargeSection: section,
    content,
    createdAt: new Date('2026-08-01T06:00:00Z'),
    note: { createdAt: new Date(), doctor: { user: { firstName: 'Asha', lastName: 'Menon' } } },
  });

  it('appends a newly pinned section to its column', async () => {
    vi.mocked(prisma.dischargeSummary.findUnique).mockResolvedValue(draft() as any);
    vi.mocked(prisma.progressNotePin.findMany).mockResolvedValue([
      pin('advice', 'Rest for one week'),
    ] as any);
    vi.mocked(prisma.dischargeSummary.update).mockResolvedValue(draft() as any);

    await generateDischargeSummary(TENANT_ID, 'adm1');

    const data = (vi.mocked(prisma.dischargeSummary.update).mock.calls[0][0] as any).data;
    expect(data.dischargeInstructions).toContain('Rest for one week');
    expect(data.dischargeInstructions).toContain('Asha Menon');
  });

  // The whole reason this is additive rather than a rebuild.
  it('keeps text the doctor typed and adds the pin below it', async () => {
    vi.mocked(prisma.dischargeSummary.findUnique).mockResolvedValue(
      draft({ dischargeInstructions: 'Avoid driving for 48 hours.' }) as any,
    );
    vi.mocked(prisma.progressNotePin.findMany).mockResolvedValue([
      pin('advice', 'Rest for one week'),
    ] as any);
    vi.mocked(prisma.dischargeSummary.update).mockResolvedValue(draft() as any);

    await generateDischargeSummary(TENANT_ID, 'adm1');

    const data = (vi.mocked(prisma.dischargeSummary.update).mock.calls[0][0] as any).data;
    expect(data.dischargeInstructions).toContain('Avoid driving for 48 hours.');
    expect(data.dischargeInstructions).toContain('Rest for one week');
  });

  // Opening the editor repeatedly must not stack the same pin over and over.
  it('does not re-add a pin already present in the column', async () => {
    vi.mocked(prisma.dischargeSummary.findUnique).mockResolvedValue(
      draft({ dischargeInstructions: '- [01/08/2026 · Dr. Asha Menon] Rest for one week' }) as any,
    );
    vi.mocked(prisma.progressNotePin.findMany).mockResolvedValue([
      pin('advice', 'Rest for one week'),
    ] as any);

    await generateDischargeSummary(TENANT_ID, 'adm1');

    expect(prisma.dischargeSummary.update).not.toHaveBeenCalled();
  });

  it('routes each pin section to its own column', async () => {
    vi.mocked(prisma.dischargeSummary.findUnique).mockResolvedValue(draft() as any);
    vi.mocked(prisma.progressNotePin.findMany).mockResolvedValue([
      pin('diagnosis', 'Community-acquired pneumonia'),
      pin('medication', 'Continue amoxicillin'),
      pin('follow_up', 'Review in 2 weeks'),
    ] as any);
    vi.mocked(prisma.dischargeSummary.update).mockResolvedValue(draft() as any);

    await generateDischargeSummary(TENANT_ID, 'adm1');

    const data = (vi.mocked(prisma.dischargeSummary.update).mock.calls[0][0] as any).data;
    expect(data.diagnosesSummary).toContain('Community-acquired pneumonia');
    expect(data.medicationReconciliation).toContain('Continue amoxicillin');
    expect(data.followUpInstructions).toContain('Review in 2 weeks');
  });

  // A signed summary is a legal record — nothing may be added to it silently.
  it('never touches a summary that has been signed', async () => {
    vi.mocked(prisma.dischargeSummary.findUnique).mockResolvedValue(
      draft({ status: 'finalized' }) as any,
    );

    await generateDischargeSummary(TENANT_ID, 'adm1');

    expect(prisma.progressNotePin.findMany).not.toHaveBeenCalled();
    expect(prisma.dischargeSummary.update).not.toHaveBeenCalled();
  });
});
