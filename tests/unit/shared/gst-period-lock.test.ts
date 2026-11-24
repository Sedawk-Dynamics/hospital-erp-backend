import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../../../src/config/database';
import { assertPeriodOpen, clearPeriodLockCache, returnPeriodLabel } from '../../../src/shared/gst-period-lock';

beforeEach(() => {
  clearPeriodLockCache();
  (prisma.gstFiledPeriod.findMany as any).mockResolvedValue([
    { periodFrom: new Date('2026-10-01T00:00:00Z'), periodTo: new Date('2026-10-31T00:00:00Z'), returnPeriod: '102026' },
  ]);
});

describe('returnPeriodLabel', () => {
  it('reads MMYYYY as a month a person recognises', () => {
    expect(returnPeriodLabel('102026')).toBe('Oct 2026');
    expect(returnPeriodLabel('012027')).toBe('Jan 2027');
    expect(returnPeriodLabel('Q3')).toBe('Q3');
  });
});

describe('assertPeriodOpen (gap 310)', () => {
  it('names the locked period as "Oct 2026", not the portal code', async () => {
    const err = await assertPeriodOpen('t1', new Date('2026-10-15T10:00:00Z')).catch((e) => e);
    expect(err?.message).toContain('Return period Oct 2026 has been filed and locked');
    expect(err?.message).not.toContain('102026');
  });

  it('lets a date outside the locked period through', async () => {
    await expect(assertPeriodOpen('t1', new Date('2026-11-02T10:00:00Z'))).resolves.toBeUndefined();
  });
});
