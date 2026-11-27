import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { clearGstMasterCache } from '../../../../src/modules/gst/gst-resolver.service';
import { billOtRequest } from '../../../../src/modules/billing/billing.service';

const TENANT = 'tenant-1';
const USER = 'user-1';
const OT = 'ot-1';

// Gap 352 (retest): Complete / OT Billing posts the case through billOtRequest.
// A ₹0 tariff posts one labelled no-charge line, component tariffs post one
// line per component, and the single procedure amount is never added on top.
describe('billOtRequest — OT charge lines (gap 352)', () => {
  const tariff = (over: Record<string, unknown> = {}) => ({
    id: 't-1', serviceName: 'Appendectomy', basePrice: 18000,
    otTheatreCharge: null, otSurgeonCharge: null, otAnaesthesiaCharge: null, otAssistantCharge: null,
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearGstMasterCache();
    (prisma.otRequest.findFirst as any).mockResolvedValue({
      id: OT, tenantId: TENANT, patientId: 'p-1', procedureName: 'Appendectomy',
      billingAmount: null, serviceTariffId: 't-1', serviceTariff: null,
      surgeon: { user: { firstName: 'Asha', lastName: 'Rao' } }, doctor: null,
    });
    // Admitted patient → the running IP (draft) bill.
    (prisma.admission.findFirst as any).mockResolvedValue({ id: 'adm-1' });
    (prisma.bill.findFirst as any).mockResolvedValue({ id: 'bill-1', tenantId: TENANT, status: 'draft', admissionId: 'adm-1', billDate: new Date() });
    (prisma.bill.findUnique as any).mockResolvedValue({ id: 'bill-1', status: 'draft', billNumber: 'IPW-1', totalAmount: 0, amountPaid: 0, balanceDue: 0 });
    (prisma.billItem.findFirst as any).mockResolvedValue(null);
    (prisma.billItem.create as any).mockImplementation(async ({ data }: any) => ({ id: `bi-${data.referenceType}`, ...data }));
  });

  const createdLines = () => (prisma.billItem.create as any).mock.calls.map((c: any) => c[0].data);

  it('posts a labelled ₹0 — no charge line for a zero tariff', async () => {
    (prisma.serviceTariff.findFirst as any).mockResolvedValue(tariff({ basePrice: 0 }));
    await billOtRequest(TENANT, OT, USER);
    const lines = createdLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ referenceType: 'ot_request', referenceId: OT, unitPrice: 0 });
    expect(lines[0].description).toContain('₹0 — no charge');
  });

  it('posts theatre, surgeon and anaesthesia as separate lines, without the single amount', async () => {
    (prisma.serviceTariff.findFirst as any).mockResolvedValue(
      tariff({ basePrice: 18000, otTheatreCharge: 5000, otSurgeonCharge: 10000, otAnaesthesiaCharge: 3000 }),
    );
    await billOtRequest(TENANT, OT, USER);
    const lines = createdLines();
    expect(lines.map((l: any) => [l.referenceType, Number(l.unitPrice)])).toEqual([
      ['ot_request', 5000],
      ['ot_request_surgeon', 10000],
      ['ot_request_anaesthesia', 3000],
    ]);
    // No double count: 18,000 basePrice is not posted anywhere.
    expect(lines.reduce((s: number, l: any) => s + Number(l.unitPrice), 0)).toBe(18000);
    expect(lines.some((l: any) => Number(l.unitPrice) === 18000)).toBe(false);
    expect(lines[1].description).toBe('Surgeon fee — Appendectomy (Dr. Asha Rao)');
  });

  it('still refuses a case with no price at all', async () => {
    (prisma.serviceTariff.findFirst as any).mockResolvedValue(null);
    await expect(billOtRequest(TENANT, OT, USER)).rejects.toThrow('Set a billing amount');
  });

  it('an already-billed case (any component anchor) is not posted again', async () => {
    (prisma.serviceTariff.findFirst as any).mockResolvedValue(tariff({ otTheatreCharge: 5000 }));
    (prisma.billItem.findFirst as any).mockResolvedValue({ billId: 'bill-1' });
    await billOtRequest(TENANT, OT, USER);
    expect(prisma.billItem.create).not.toHaveBeenCalled();
    const where = (prisma.billItem.findFirst as any).mock.calls[0][0].where;
    expect(where.referenceType.in).toContain('ot_request_surgeon');
  });
});
