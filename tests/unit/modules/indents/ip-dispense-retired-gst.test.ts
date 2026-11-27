import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { clearGstMasterCache } from '../../../../src/modules/gst/gst-resolver.service';
import { clearGstSlabCache } from '../../../../src/shared/gst-slabs';
import { dispenseIpPrescription } from '../../../../src/modules/indents/indents.service';

// Gap #262 — an IP medicine still on 12%. Exempt with the treatment it passes;
// where the hospital taxes it, the issue stops with the message. A life-saving
// drug is never withheld for a tax setting (the bill's finalise check stops it).

const DRUG = {
  id: 'd1', drugName: 'Oldcillin', price: 5, taxPercent: 12, hsnCode: '3004', gstTreatment: null, category: 'drug',
  packSize: 10, looseUnitLabel: 'Capsule', unitOfMeasurement: 'Strip', dosageForm: 'capsule',
  isNarcotic: false, isLifeSaving: false, isReimbursable: null, schedule: 'H', controlledClass: null, vaultControlled: false,
};

function setup(drug: Record<string, unknown>, compositeExempt: boolean) {
  (prisma.prescription.findFirst as any).mockResolvedValue({
    id: 'rx', tenantId: 't', patientId: 'p', prescriptionType: 'ip',
    prescriptionItems: [{ id: 'i1', drugId: 'd1', isPrn: false, quantity: 15 }], visit: { admission: { id: 'adm' } },
  });
  (prisma.dispensingRecord.findFirst as any).mockResolvedValue(null);
  (prisma.tenant.findFirst as any).mockResolvedValue({
    themeConfig: { gst: { registered: true, gstin: '27AAPFU0939F1ZV', inpatientCompositeExempt: compositeExempt } },
  });
  (prisma.gstSlab.findMany as any).mockResolvedValue(
    [0, 5, 18, 40].map((r) => ({ ratePercent: r, label: `${r}%`, effectiveFrom: new Date('2025-09-22'), effectiveTo: null, note: null })),
  );
  const tx: any = {
    admission: { findFirst: vi.fn().mockResolvedValue({ id: 'adm' }) },
    bill: { findFirst: vi.fn().mockResolvedValue({ id: 'bill', admissionId: 'adm' }), update: vi.fn(), create: vi.fn() },
    drugFormulary: { findFirst: vi.fn().mockResolvedValue({ ...DRUG, ...drug }) },
    drugBatch: {
      findMany: vi.fn().mockResolvedValue([{ id: 'b1', batchNumber: 'B-1', quantityInStock: 100, sellingPrice: 5, expiryDate: new Date('2030-01-31') }]),
      update: vi.fn(),
    },
    dispensingRecord: { create: vi.fn().mockResolvedValue({ id: 'rec' }) },
    billItem: { create: vi.fn() },
    emarSchedule: { updateMany: vi.fn() },
    prescription: { update: vi.fn() },
  };
  (prisma.$transaction as any).mockImplementation((fn: any) => fn(tx));
  return tx;
}

const dispense = () => dispenseIpPrescription('t', 'u', ['pharmacy_admin'], 'rx');

beforeEach(() => {
  vi.clearAllMocks();
  clearGstMasterCache();
  clearGstSlabCache();
});

describe('262 — IP issue of an item on a retired rate', () => {
  it('passes when the medicine is exempt with the treatment, and words the line (345)', async () => {
    const tx = setup({}, true);
    await dispense();
    const line = tx.billItem.create.mock.calls[0][0].data;
    expect(line).toMatchObject({ taxPercent: 0, quantity: 15, qtyUnits: { packSize: 10, packNoun: 'strip', looseNoun: 'capsule' } });
    expect(line.description).toContain('1 strip + 5 capsules (15 capsules)');
  });

  it('stops where this hospital taxes IP medicine, before a charge is posted', async () => {
    const tx = setup({}, false);
    await expect(dispense()).rejects.toThrow(/Cannot bill at a GST rate that is no longer legal: Oldcillin \(HSN 3004, 12%/);
    expect(tx.billItem.create).not.toHaveBeenCalled();
  });

  it('does not withhold a life-saving drug', async () => {
    const tx = setup({ isLifeSaving: true }, false);
    await dispense();
    expect(tx.billItem.create).toHaveBeenCalled();
  });
});
