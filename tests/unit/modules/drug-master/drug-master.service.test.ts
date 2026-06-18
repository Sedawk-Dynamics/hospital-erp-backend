import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { suggestDrugMaster } from '../../../../src/modules/drug-master/drug-master.service';

describe('DrugMaster — G11 suggest (pharmacist → unpublished suggestion)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates an UNPUBLISHED entry stamped with the requesting user', async () => {
    (prisma.drugMaster.create as any).mockImplementation((args: any) =>
      Promise.resolve({ id: 'dm1', ...args.data }),
    );

    const res = await suggestDrugMaster('user-9', {
      name: 'Newbrand 20',
      genericName: 'Telmisartan',
      manufacturer: 'Acme',
    } as any);

    const data = (prisma.drugMaster.create as any).mock.calls[0][0].data;
    // Never auto-published — it's a pending suggestion for platform review.
    expect(data.isPublished).toBe(false);
    expect(data.createdById).toBe('user-9');
    expect(data.name).toBe('Newbrand 20');
    expect(data.searchTokens).toBeTruthy();
    expect(res.id).toBe('dm1');
  });
});
