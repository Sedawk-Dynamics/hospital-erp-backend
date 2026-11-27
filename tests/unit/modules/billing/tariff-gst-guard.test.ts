import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { guardTariffGstFields } from '../../../../src/modules/billing/tariff-gst-guard';

// #264: only users with the GST settings right change a service's GST
// classification or switch it on or off. The radiology admin keeps its scans.

const p = prisma as any;
const run = async (roles: string[], body: Record<string, unknown>, id?: string) => {
  const next = vi.fn();
  guardTariffGstFields({ user: { roles, tenantId: 't1' }, body, params: id ? { id } : {} } as any, {} as any, next);
  await vi.waitFor(() => expect(next).toHaveBeenCalled());
  const err = next.mock.calls[0][0];
  return err ? (err.statusCode as number) : 'ok';
};

beforeEach(() => {
  vi.resetAllMocks();
  p.serviceTariff.findFirst.mockResolvedValue({ category: 'consultation' });
});

describe('GST fields on a service', () => {
  it('lets the front desk change a price or name, but not the SAC, rate or on/off', async () => {
    expect(await run(['front_desk'], { basePrice: 600, name: 'OPD' }, 'x')).toBe('ok');
    for (const body of [{ sacCode: '999312' }, { taxRate: 18 }, { gstTreatment: 'taxable' }, { isActive: false }, { isCosmetic: true }, { gstEffectiveFrom: '2026-12-01' }]) {
      expect(await run(['front_desk'], body, 'x')).toBe(403);
    }
  });

  it('lets the hospital admin, billing admin and super admin change them', async () => {
    for (const role of ['admin', 'billing_admin', 'super_admin']) {
      expect(await run([role], { sacCode: '999312', isActive: false }, 'x')).toBe('ok');
    }
  });

  it('a new service may start active, but not with a classification, from the front desk', async () => {
    expect(await run(['front_desk'], { name: 'Dressing', basePrice: 50, isActive: true })).toBe('ok');
    expect(await run(['front_desk'], { name: 'Dressing', basePrice: 50, sacCode: '999312' })).toBe(403);
  });

  it('lets the radiology admin set a scan, and only a scan', async () => {
    p.serviceTariff.findFirst.mockResolvedValue({ category: 'radiology' });
    expect(await run(['radiology_admin'], { sacCode: '999316', isActive: false }, 'scan')).toBe('ok');
    expect(await run(['radiology_admin'], { category: 'imaging', sacCode: '999316' })).toBe('ok');
    // ...not a consultation, and not by turning a scan into something else.
    p.serviceTariff.findFirst.mockResolvedValue({ category: 'consultation' });
    expect(await run(['radiology_admin'], { isActive: false }, 'opd')).toBe(403);
    p.serviceTariff.findFirst.mockResolvedValue({ category: 'radiology' });
    expect(await run(['radiology_admin'], { category: 'procedure', sacCode: '999312' }, 'scan')).toBe(403);
    expect(await run(['radiology_admin'], { category: 'procedure', sacCode: '999312' })).toBe(403);
  });
});
