import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { pickRateChangeReason, recordItemRateChange } from '../../../../src/modules/gst/gst-rate-log';
import { updateFormularyItem } from '../../../../src/modules/pharmacy/pharmacy.service';
import { updateServiceTariff } from '../../../../src/modules/billing/billing.service';

const TENANT = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
});

/** The audit row's reason, once the fire-and-forget write has landed. */
async function loggedReason(): Promise<string | null> {
  await vi.waitFor(() => expect(prisma.gstItemRateChange.create).toHaveBeenCalled());
  return (prisma.gstItemRateChange.create as any).mock.calls[0][0].data.reason;
}

describe('pickRateChangeReason (gap 279 / 263)', () => {
  it('prefers gstChangeReason, then gstRateReason, then the fallback', () => {
    expect(pickRateChangeReason({ gstChangeReason: 'Notification 05/2026', gstRateReason: 'x' }, 'f')).toBe('Notification 05/2026');
    expect(pickRateChangeReason({ gstRateReason: '  Supplier invoice at 12%  ' }, 'f')).toBe('Supplier invoice at 12%');
    expect(pickRateChangeReason({ gstChangeReason: '  ', gstRateReason: null }, 'fallback')).toBe('fallback');
    expect(pickRateChangeReason(undefined, 'fallback')).toBe('fallback');
  });
});

describe('recordItemRateChange', () => {
  it('stores the given reason against the change', async () => {
    await recordItemRateChange({
      tenantId: TENANT, itemType: 'drug', itemId: 'd1', itemName: 'QALOC20',
      before: { rate: 5, code: '3004', treatment: 'taxable' },
      after: { rate: 12, code: '3004', treatment: 'taxable' },
      reason: 'Rate revised per supplier', changedBy: 'u1',
    });
    expect((prisma.gstItemRateChange.create as any).mock.calls[0][0].data).toMatchObject({
      previousRate: 5, newRate: 12, action: 'update', reason: 'Rate revised per supplier',
    });
  });
});

describe('save paths pass the typed reason into the audit row', () => {
  it('formulary drug edit records the form\'s gstRateReason, not the generic text', async () => {
    const existing = {
      id: 'd1', tenantId: TENANT, drugName: 'QALOC20', category: 'drug', taxPercent: 5,
      hsnCode: '3004', gstTreatment: 'taxable', gtin: null, casePackGtin: null,
    };
    (prisma.drugFormulary.findFirst as any).mockResolvedValue(existing);
    (prisma.drugFormulary.update as any).mockResolvedValue({ ...existing, taxPercent: 12 });

    await updateFormularyItem(TENANT, ['admin'], 'd1', {
      taxPercent: 12, gstRateReason: 'Supplier bills it at 12%',
    } as any);

    expect(await loggedReason()).toBe('Supplier bills it at 12%');
  });

  it('service tariff edit records gstChangeReason or, failing that, gstRateReason', async () => {
    const existing = {
      id: 's1', tenantId: TENANT, serviceName: 'QALOC20 Room', serviceCode: 'R1', category: 'room',
      gstRatePercent: 0, sacCode: '999311', gstTreatment: 'exempt', isCosmetic: false,
      gstApproved: false, gstEffectiveFrom: null,
    };
    (prisma.serviceTariff.findFirst as any).mockResolvedValue(existing);
    (prisma.serviceTariff.update as any).mockResolvedValue({ ...existing, gstRatePercent: 5, gstTreatment: 'taxable' });

    await updateServiceTariff(TENANT, 's1', {
      taxRate: 5, gstTreatment: 'taxable', gstRateReason: 'Room rent above ₹5,000',
    } as any);

    expect(await loggedReason()).toBe('Room rent above ₹5,000');
  });
});
