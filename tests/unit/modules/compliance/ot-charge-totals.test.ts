import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  getPendingOrders,
  otComponentTotal,
  updateServiceTariff,
} from '../../../../src/modules/billing/billing.service';

const TENANT = 'tenant-1';

// Gap 352 (retest 3): "incorrect OT total and misleading ₹0 label".
describe('OT charge totals (gap 352 retest)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('totals only the configured components; null when none is set', () => {
    expect(otComponentTotal({ otTheatreCharge: 5000, otSurgeonCharge: 10000, otAnaesthesiaCharge: null })).toBe(15000);
    expect(otComponentTotal({ otTheatreCharge: 0, otSurgeonCharge: 0 })).toBe(0);
    expect(otComponentTotal({ otTheatreCharge: null })).toBeNull();
    expect(otComponentTotal({})).toBeNull();
  });

  it('keeps a component tariff\'s base price equal to the component total', async () => {
    (prisma.serviceTariff.findFirst as any).mockResolvedValue({
      id: 't-1', tenantId: TENANT, category: 'surgery', serviceCode: 'APP', basePrice: 18000,
      otTheatreCharge: 5000, otSurgeonCharge: null, otAnaesthesiaCharge: null, otAssistantCharge: null,
      gstRatePercent: 0, sacCode: null, gstTreatment: null, isCosmetic: false,
    });
    (prisma.serviceTariff.update as any).mockImplementation(async ({ data }: any) => ({ id: 't-1', ...data }));
    await updateServiceTariff(TENANT, 't-1', { basePrice: 18000, otSurgeonCharge: 10000 } as any);
    const data = (prisma.serviceTariff.update as any).mock.calls[0][0].data;
    expect(Number(data.basePrice)).toBe(15000);
  });

  it('prices unbilled OT orders from the tariff, not the typed amount alone', async () => {
    (prisma.otRequest.findMany as any).mockResolvedValue([
      {
        id: 'ot-1', tenantId: TENANT, procedureName: 'Appendectomy', billingAmount: null, serviceTariffId: 't-1',
        status: 'completed', createdAt: new Date('2026-11-20T05:00:00Z'),
        patient: { id: 'p-1', firstName: 'A', lastName: 'B', mrn: 'M1' },
      },
      {
        id: 'ot-2', tenantId: TENANT, procedureName: 'Free camp cataract', billingAmount: null, serviceTariffId: 't-0',
        status: 'completed', createdAt: new Date('2026-11-20T06:00:00Z'),
        patient: { id: 'p-2', firstName: 'C', lastName: 'D', mrn: 'M2' },
      },
      {
        id: 'ot-3', tenantId: TENANT, procedureName: 'Unpriced', billingAmount: null, serviceTariffId: null,
        status: 'scheduled', createdAt: new Date('2026-11-20T07:00:00Z'),
        patient: { id: 'p-3', firstName: 'E', lastName: 'F', mrn: 'M3' },
      },
    ]);
    (prisma.serviceTariff.findFirst as any).mockImplementation(async ({ where }: any) =>
      where.id === 't-1'
        ? { id: 't-1', serviceName: 'Appendectomy', basePrice: 15000, otTheatreCharge: 5000, otSurgeonCharge: 10000 }
        : where.id === 't-0'
          ? { id: 't-0', serviceName: 'Free camp cataract', basePrice: 0 }
          : null,
    );
    (prisma.serviceTariff.findMany as any).mockResolvedValue([]);
    (prisma.billItem.findMany as any).mockResolvedValue([]);
    const out: any = await getPendingOrders(TENANT, { source: 'ot' } as any);
    const byRef = new Map(out.orders.map((o: any) => [o.referenceId, o]));
    expect((byRef.get('ot-1') as any).amount).toBe(15000);
    expect((byRef.get('ot-2') as any).amount).toBe(0);
    expect((byRef.get('ot-2') as any).description).toContain('₹0 — no charge');
    expect(byRef.has('ot-3')).toBe(false);
    expect(out.summary.totalAmount).toBe(15000);
  });
});
