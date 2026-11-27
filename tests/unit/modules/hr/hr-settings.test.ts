import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';

import {
  getHrSettings,
  updateHrSettings,
  rosterWeekStart,
  DEFAULT_HR_SETTINGS,
} from '../../../../src/modules/hospital-settings/hospital-settings.service';

const TENANT = 'tenant-1';

// Gap 313: the roster week start is a tenant HR setting (default Sunday).
describe('HR settings — roster week start day', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults to Sunday when nothing is stored', async () => {
    (prisma.tenant.findFirst as any).mockResolvedValue({ themeConfig: {} });
    expect(await getHrSettings(TENANT)).toEqual({ rosterWeekStartDay: 0 });
    expect(DEFAULT_HR_SETTINGS.rosterWeekStartDay).toBe(0);
  });

  it('reads the stored day and ignores a malformed one', async () => {
    (prisma.tenant.findFirst as any).mockResolvedValue({ themeConfig: { hrSettings: { rosterWeekStartDay: 1 } } });
    expect((await getHrSettings(TENANT)).rosterWeekStartDay).toBe(1);
    (prisma.tenant.findFirst as any).mockResolvedValue({ themeConfig: { hrSettings: { rosterWeekStartDay: 9 } } });
    expect((await getHrSettings(TENANT)).rosterWeekStartDay).toBe(0);
  });

  it('saves under themeConfig.hrSettings and keeps the other keys', async () => {
    (prisma.tenant.findFirst as any).mockResolvedValue({ themeConfig: { gst: { registered: true } } });
    const saved = await updateHrSettings(TENANT, { rosterWeekStartDay: 1 });
    expect(saved.rosterWeekStartDay).toBe(1);
    const data = (prisma.tenant.update as any).mock.calls[0][0].data;
    expect(data.themeConfig).toEqual({ gst: { registered: true }, hrSettings: { rosterWeekStartDay: 1 } });
  });

  it('refuses a day outside 0–6', async () => {
    (prisma.tenant.findFirst as any).mockResolvedValue({ themeConfig: {} });
    await expect(updateHrSettings(TENANT, { rosterWeekStartDay: 7 })).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('anchors the week on the configured day', () => {
    const wed = new Date(2026, 10, 11, 15, 0); // Wed 11 Nov 2026
    expect(rosterWeekStart(wed, 0).getDate()).toBe(8); // Sun 8 Nov
    expect(rosterWeekStart(wed, 1).getDate()).toBe(9); // Mon 9 Nov
    expect(rosterWeekStart(wed, 3).getDate()).toBe(11); // the Wednesday itself
    expect(rosterWeekStart(wed, 4).getDate()).toBe(5); // Thu 5 Nov
  });
});
