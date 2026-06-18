import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';

import { runPharmacyExpiryAlerts } from '../../../../src/modules/pharmacy/pharmacy.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

describe('Pharmacy — G5 expiry handling (auto-flag + near-expiry alerts)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('force run flags expired batches and alerts recipients about near-expiry stock', async () => {
    // No settings row → getInventorySettingsSafe falls back to defaults.
    (prisma.inventorySetting.findUnique as any).mockResolvedValue(undefined);
    (prisma.inventorySetting.upsert as any).mockResolvedValue(undefined);
    (prisma.drugBatch.updateMany as any).mockResolvedValue({ count: 2 }); // 2 expired flagged
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', batchNumber: 'BN1', quantityInStock: 50, expiryDate: '2026-07-15', drug: { drugName: 'Amox 500' } },
    ]);
    (prisma.notification.findFirst as any).mockResolvedValue(null); // no open alert
    (prisma.user.findMany as any).mockResolvedValue([{ id: 'mgr-1' }]); // a recipient
    (prisma.notification.createMany as any).mockResolvedValue({ count: 1 });

    const res = await runPharmacyExpiryAlerts(TENANT_ID, USER_ID, { force: true });

    expect(res.expiredFlagged).toBe(2);
    expect(res.expiryAlerts).toBe(1);
    expect(prisma.drugBatch.updateMany).toHaveBeenCalledTimes(1); // the flag pass
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1); // the alert
  });

  it('respects the per-pharmacy toggles when run unattended (not forced)', async () => {
    (prisma.inventorySetting.findUnique as any).mockResolvedValue({
      id: 's1', tenantId: TENANT_ID,
      autoFlagExpired: false, expiryAlertEnabled: false,
      expiryAlertMonths: 3, alertRecipientRoles: [],
    });

    const res = await runPharmacyExpiryAlerts(TENANT_ID, USER_ID);

    expect(res.expiredFlagged).toBe(0);
    expect(res.expiryAlerts).toBe(0);
    // Neither pass ran: no flag write, no batch scan.
    expect(prisma.drugBatch.updateMany).not.toHaveBeenCalled();
    expect(prisma.drugBatch.findMany).not.toHaveBeenCalled();
  });

  it('does not re-notify a batch that already has an open alert', async () => {
    (prisma.inventorySetting.findUnique as any).mockResolvedValue(undefined);
    (prisma.inventorySetting.upsert as any).mockResolvedValue(undefined);
    (prisma.drugBatch.updateMany as any).mockResolvedValue({ count: 0 });
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', batchNumber: 'BN1', quantityInStock: 50, expiryDate: '2026-07-15', drug: { drugName: 'Amox 500' } },
    ]);
    (prisma.notification.findFirst as any).mockResolvedValue({ id: 'existing' }); // open alert exists

    const res = await runPharmacyExpiryAlerts(TENANT_ID, USER_ID, { force: true });

    expect(res.expiryAlerts).toBe(0);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });
});
