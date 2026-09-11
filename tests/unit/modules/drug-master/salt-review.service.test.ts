import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/modules/drug-master/drug-schedule.service', () => ({
  classifyDrugMasterItem: vi.fn(),
}));
vi.mock('../../../../src/modules/drug-master/salt-classification.service', () => ({
  invalidateSaltCache: vi.fn(),
}));

import { prisma } from '../../../../src/config/database';
import { decideSalt } from '../../../../src/modules/drug-master/salt-review.service';
import { classifyDrugMasterItem } from '../../../../src/modules/drug-master/drug-schedule.service';

/**
 * A decision about a molecule is marked `manual`, which the boot seed never
 * touches again. Saving NO schedule is not a decision — it puts the molecule
 * back in the queue — and marking that manual left it undecided for good.
 */

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.salt.findUnique as any).mockResolvedValue({ id: 's1', name: 'Pregabalin' });
  (prisma.salt.update as any).mockImplementation(async ({ data }: any) => ({ id: 's1', ...data }));
  (prisma.drugSalt.findMany as any).mockResolvedValue([{ drugMasterId: 'm1' }, { drugMasterId: 'm2' }]);
});

describe('decideSalt', () => {
  it('marks a decision manual, so no re-seed undoes it, and re-classifies its products', async () => {
    const r = await decideSalt('s1', 'u1', { scheduleCode: 'H1' });

    const data = (prisma.salt.update as any).mock.calls[0][0].data;
    expect(data).toMatchObject({ scheduleCode: 'H1', source: 'manual', reviewedById: 'u1' });
    expect(classifyDrugMasterItem).toHaveBeenCalledTimes(2);
    expect(r?.reclassified).toBe(2);
  });

  it('returns a molecule saved with no schedule to the seed, not to "set by hand"', async () => {
    await decideSalt('s1', 'u1', { scheduleCode: null });

    const data = (prisma.salt.update as any).mock.calls[0][0].data;
    expect(data.scheduleCode).toBeNull();
    expect(data.source).toBeNull();
    expect(data.scheduleNote).toMatch(/review queue/);
    // Its products still follow at once — undecided is an answer too.
    expect(classifyDrugMasterItem).toHaveBeenCalledTimes(2);
  });
});
