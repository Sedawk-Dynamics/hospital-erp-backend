import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { clearGstMasterCache, taxResolverFor } from '../../../../src/modules/gst/gst-resolver.service';
import { clearGstSlabCache } from '../../../../src/shared/gst-slabs';
import {
  commitInward, createBatch, createDispense, createFormularyItem, createPharmacySale, createReturn, createVendorReturnBatch,
  importFormularyItem, importFormularyItemsBulk, previewPharmacySale, updateFormularyItem,
} from '../../../../src/modules/pharmacy/pharmacy.service';
import { assertResolvedRateLegal, illegalRateReason, purchaseRateWarning } from '../../../../src/modules/gst/gst-retired-rate';
import { drugRateWhenReceived } from '../../../../src/modules/pharmacy/purchase-tax';
import { issueCreditNote } from '../../../../src/modules/gst/credit-note.service';
import { getPatientCharges } from '../../../../src/modules/billing/billing.service';
import { bulkUpsertHsnGstRates, createDrugMaster, updateDrugMaster } from '../../../../src/modules/drug-master/drug-master.service';
import { DRUG_GST_CLASSIFIER_VERSION } from '../../../../src/modules/drug-master/drug-gst.classifier';

// Gap #262 — 12% ended on 21 Sep 2025. It cannot be put ON a master, and an item
// still carrying it can be neither billed at it nor moved off it unseen. What
// was issued while it was legal keeps it.

const T = 'tenant-1';
const U = 'user-1';
const ADMIN = ['pharmacy_admin'];
const p = prisma as any;

const SLABS = [
  ...[0, 5, 12, 18, 28].map((r) => ({ ratePercent: r, from: '2017-07-01', to: '2025-09-21' as string | null })),
  ...[0, 5, 18, 40].map((r) => ({ ratePercent: r, from: '2025-09-22', to: null as string | null })),
].map((s) => ({
  ratePercent: s.ratePercent, label: `${s.ratePercent}%`, note: null,
  effectiveFrom: new Date(`${s.from}T00:00:00Z`), effectiveTo: s.to ? new Date(`${s.to}T00:00:00Z`) : null,
}));

const DRUG = {
  id: 'd1', drugName: 'Oldcillin', price: 112, packSize: 1, looseUnitLabel: 'vial', unitOfMeasurement: 'Vial',
  dosageForm: 'injection', taxPercent: 12, hsnCode: '3004', gstTreatment: null, category: 'drug',
};
const batch = (over: Record<string, unknown> = {}, drug: Record<string, unknown> = {}) => ({
  id: 'b1', tenantId: T, drugId: 'd1', batchNumber: 'BN1', quantityInStock: 50, isExpired: false, isRecalled: false,
  expiryDate: new Date('2030-12-31'), sellingPrice: 112, ...over, drug: { ...DRUG, ...drug },
});

beforeEach(() => {
  vi.resetAllMocks();
  clearGstMasterCache();
  clearGstSlabCache();
  p.gstSlab.findMany.mockResolvedValue(SLABS);
  p.hsnGstRate.findMany.mockResolvedValue([{ hsnCode: '3004', gstRate: 5, treatment: 'taxable', description: null }]);
  p.sacCode.findMany.mockResolvedValue([]);
  p.gstCategoryDefault.findMany.mockResolvedValue([]);
  p.tenant.findFirst.mockResolvedValue({ themeConfig: { gst: { registered: true, gstin: '27AAPFU0939F1ZV', inpatientCompositeExempt: true } } });
  p.admission.findFirst.mockResolvedValue(null);
  p.drugFormulary.findMany.mockResolvedValue([]);
  p.drugBatch.findMany.mockResolvedValue([]);
  p.user.findMany.mockResolvedValue([]);
  p.$transaction.mockImplementation((fn: any) => (typeof fn === 'function' ? fn(p) : Promise.all(fn)));
});

describe('262 — a master cannot be given a retired rate', () => {
  it('refuses a new medicine at 12% and names the allowed slabs', async () => {
    await expect(createFormularyItem(T, ADMIN, { drugName: 'Newcillin', taxPercent: 12, force: true } as any)).rejects.toThrow(
      /12% is not a legal GST rate on \d{4}-\d\d-\d\d\. "Newcillin" must use one of 0%, 5%, 18% or 40%\./,
    );
    expect(p.drugFormulary.create).not.toHaveBeenCalled();
  });

  it('refuses editing a medicine TO 12%, but not correcting one already on it', async () => {
    p.drugFormulary.findFirst.mockResolvedValue({ ...DRUG, tenantId: T, taxPercent: 5 });
    await expect(updateFormularyItem(T, ADMIN, 'd1', { taxPercent: 12 } as any)).rejects.toThrow(/0%, 5%, 18% or 40%/);
    expect(p.drugFormulary.update).not.toHaveBeenCalled();

    p.drugFormulary.findFirst.mockResolvedValue({ ...DRUG, tenantId: T });
    p.drugFormulary.update.mockResolvedValue({ ...DRUG });
    await updateFormularyItem(T, ADMIN, 'd1', { taxPercent: 12, minStock: 10 } as any);
    expect(p.drugFormulary.update).toHaveBeenCalled();
    // …and it is still 12% afterwards: nothing re-rated it.
    expect(p.drugFormulary.update.mock.calls[0][0].data.taxPercent).toBe(12);
  });

  it('refuses turning an exempt item taxable at the 12% it kept', async () => {
    p.drugFormulary.findFirst.mockResolvedValue({ ...DRUG, tenantId: T, gstTreatment: 'exempt', taxPercent: 12 });
    await expect(updateFormularyItem(T, ADMIN, 'd1', { gstTreatment: 'taxable' } as any)).rejects.toThrow(/not a legal GST rate/);
  });

  it('refuses the platform catalogue too', async () => {
    await expect(createDrugMaster(['super_admin'], U, { name: 'X', gstRate: 12 } as any)).rejects.toThrow(/12% is not a legal GST slab/);
    p.drugMaster.findUnique.mockResolvedValue({ id: 'm1', name: 'X', gstRate: 5, gstTreatment: null, aliases: [], tags: [] });
    await expect(updateDrugMaster(['super_admin'], 'm1', { gstRate: 28 } as any)).rejects.toThrow(/28% is not a legal GST slab/);
  });

  it('judges the rate on the effective date, not only today', async () => {
    expect(await illegalRateReason(12, 'X', new Date('2025-06-01'))).toBeNull();
    expect(await illegalRateReason(40, 'X', new Date('2025-06-01'))).toMatch(/0%, 5%, 12%, 18% or 28%/);
    expect(await illegalRateReason(0, 'X')).toBeNull();
    expect(await illegalRateReason(null, 'X')).toBeNull();
  });

  it('an unseeded slab master refuses nothing', async () => {
    clearGstSlabCache();
    p.gstSlab.findMany.mockResolvedValue([]);
    expect(await illegalRateReason(12, 'X')).toBeNull();
  });
});

describe('262 — imports', () => {
  const master = (over: Record<string, unknown>) => ({
    id: 'm1', name: 'Catcillin', isPublished: true, type: 'otc', gstRate: 12, gstTreatment: null, hsnCode: '3004',
    gstClassifierVersion: DRUG_GST_CLASSIFIER_VERSION, scheduleResolved: true, ...over,
  });

  it('a catalogue drug on 12% is not imported, with the reason', async () => {
    p.drugMaster.findUnique.mockResolvedValue(master({}));
    p.drugFormulary.findFirst.mockResolvedValue(null);
    await expect(importFormularyItem(T, ADMIN, { drugMasterId: 'm1' } as any)).rejects.toThrow(/"Catcillin" in the drug catalogue must use one of/);
    expect(p.drugFormulary.create).not.toHaveBeenCalled();
  });

  it('a bulk import leaves the bad rows out and lists them', async () => {
    p.drugMaster.findMany.mockResolvedValue([master({}), master({ id: 'm2', name: 'Goodcillin', gstRate: 5 })]);
    p.drugFormulary.createMany.mockResolvedValue({ count: 1 });
    const r = await importFormularyItemsBulk(T, ADMIN, { drugMasterIds: ['m1', 'm2'] });
    expect(r.created).toBe(1);
    expect(r.rejected).toEqual([{ drugMasterId: 'm1', drugName: 'Catcillin', reason: expect.stringMatching(/12% is not a legal GST rate/) }]);
    expect(p.drugFormulary.createMany.mock.calls[0][0].data.map((d: any) => d.drugName)).toEqual(['Goodcillin']);
  });

  it('an HSN paste saves the good rows, rejects the bad one and logs the change', async () => {
    p.hsnGstRate.findUnique.mockResolvedValue(null);
    p.hsnGstRate.create.mockResolvedValue({});
    const r = await bulkUpsertHsnGstRates(['super_admin'], [{ hsnCode: '3004', gstRate: 5 }, { hsnCode: '3005', gstRate: 12 }] as any, U);
    expect(r).toMatchObject({ created: 1, updated: 0 });
    expect(r.skipped).toEqual([{ hsnCode: '3005', reason: '12% is not a legal GST rate today. Use one of 0%, 5%, 18% or 40%.' }]);
    expect(p.gstRateChange.create).toHaveBeenCalledTimes(1);
  });
});

describe('262 — a sale of an item still on 12%', () => {
  const line = { drugBatchId: 'b1', quantity: 1, saleUnit: 'pack' as const };

  it('is blocked before payment, naming the item and who can fix it', async () => {
    p.drugBatch.findFirst.mockResolvedValue(batch());
    p.patient.findFirst.mockResolvedValue({ id: 'walk' });
    const err: any = await createPharmacySale(T, U, { items: [line], paymentMethod: 'cash' } as any).catch((e) => e);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('GST_RATE_RETIRED');
    expect(err.message).toMatch(/Oldcillin \(HSN 3004, 12% from the medicine itself\)/);
    expect(err.message).toMatch(/Allowed rates today: 0%, 5%, 18% or 40%/);
    expect(err.message).toMatch(/The rate has not been changed for you/);
    expect(err.message).toMatch(/Pharmacy Admin, Hospital Admin or Finance/);
    expect(err.details.items).toEqual([expect.objectContaining({ drugName: 'Oldcillin', ratePercent: 12 })]);
    // Nothing moved and nothing was taken.
    for (const m of [p.bill.create, p.payment.create, p.drugBatch.update, p.dispensingRecord.create]) expect(m).not.toHaveBeenCalled();
  });

  it('the cart says so while it is still being built, at the same rate it found', async () => {
    p.drugBatch.findFirst.mockResolvedValue(batch());
    const q = await previewPharmacySale(T, { items: [line] });
    expect(q.blockers).toHaveLength(1);
    expect(q.blockers[0]).toMatch(/Oldcillin/);
    expect(q.retiredRates).toEqual([{ drugName: 'Oldcillin', ratePercent: 12, hsnCode: '3004', source: 'item_master' }]);
    // Not silently re-rated to the HSN default of 5%.
    expect(q.lines[0]!.taxRatePercent).toBe(12);
  });

  it('a rate that came from an HSN default says so', async () => {
    p.hsnGstRate.findMany.mockResolvedValue([{ hsnCode: '3004', gstRate: 12, treatment: 'taxable', description: null }]);
    p.drugBatch.findFirst.mockResolvedValue(batch({}, { taxPercent: null }));
    const q = await previewPharmacySale(T, { items: [line] });
    expect(q.blockers[0]).toMatch(/12% from the HSN default for 3004/);
  });

  it('a legal rate and an exempt inpatient are not stopped', async () => {
    p.drugBatch.findFirst.mockResolvedValue(batch({}, { taxPercent: 5 }));
    expect((await previewPharmacySale(T, { items: [line] })).blockers).toEqual([]);
    p.drugBatch.findFirst.mockResolvedValue(batch());
    p.admission.findFirst.mockResolvedValue({ id: 'adm' });
    const ip = await previewPharmacySale(T, { patientId: 'p1', items: [line] });
    expect(ip.blockers).toEqual([]);
    expect(ip.lines[0]!.taxRatePercent).toBe(0);
  });
});

describe('262 — dispensing to a bill', () => {
  it('an OP prescription dispense is stopped before stock moves', async () => {
    p.drugBatch.findFirst.mockResolvedValue(batch());
    p.prescription.findFirst.mockResolvedValue({ visitId: 'v1' });
    await expect(
      createDispense(T, U, { drugBatchId: 'b1', prescriptionId: 'rx1', patientId: 'p1', quantityDispensed: 1 } as any),
    ).rejects.toThrow(/Cannot bill at a GST rate that is no longer legal: Oldcillin/);
    expect(p.drugBatch.update).not.toHaveBeenCalled();
  });

  it('an inpatient medicine that is exempt passes; a taxed one does not', async () => {
    const r = await taxResolverFor(T);
    const ctx = { kind: 'medicine' as const, hsnCode: '3004', itemRatePercent: 12, itemTreatment: 'taxable' as const, patientAdmitted: true, issuedForTreatment: true };
    expect(() => assertResolvedRateLegal(r, 'Oldcillin', r.determine(ctx))).not.toThrow();
    expect(() => assertResolvedRateLegal(r, 'Oldcillin', r.determine({ ...ctx, issuedForTreatment: false }))).toThrow(/Oldcillin/);
  });

  it('a pulled charge keeps 12% for the finalise check instead of slipping to the HSN 5%', async () => {
    p.dispensingRecord.findMany.mockResolvedValue([{
      id: 'dr1', quantityDispensed: 2, dispensedAt: new Date(), isTto: false,
      drugBatch: { ...batch(), gstPercent: 5 },
    }]);
    p.patient.findFirst.mockResolvedValue({ id: 'p1' });
    const out = await getPatientCharges(T, { patientId: 'p1', source: 'pharmacy', includeBilled: true });
    const row = out.charges.find((c) => c.referenceType === 'dispensing_record')!;
    expect(row).toMatchObject({ taxRate: 12, gstTreatment: 'taxable' });
    expect(row.description).toContain('2 vials');
  });
});

describe('262 — what was issued while 12% was legal keeps it', () => {
  it('a credit note mirrors the stored line, not today\'s slabs', async () => {
    const tx: any = {
      bill: { findFirst: vi.fn(async () => ({ id: 'bill', patientId: 'p1', billDate: new Date('2025-06-01') })) },
      billItem: { findMany: vi.fn(async () => [{
        id: 'bi', description: 'Oldcillin (Batch BN1) — 10 vials', quantity: 10, unitPrice: 112, taxableValue: 1000, taxPercent: 12,
        taxAmount: 120, cgstAmount: 60, sgstAmount: 60, igstAmount: 0, cessAmount: 0, totalAmount: 1120, gstTreatment: 'taxable', qtyUnits: null,
      }]) },
      creditNote: { create: vi.fn(async ({ data }: any) => ({ id: 'cn', creditNoteNumber: data.creditNoteNumber, totalAmount: data.totalAmount })) },
      gstDocumentSeries: {
        findFirst: vi.fn(async () => ({ id: 's', prefix: 'CN', lastNumber: 0, padding: 4 })),
        findUnique: vi.fn(async () => ({ id: 's', prefix: 'CN', lastNumber: 0, padding: 4 })),
        upsert: vi.fn(async () => ({ id: 's', prefix: 'CN', lastNumber: 1, nextNumber: 2, padding: 4 })),
        update: vi.fn(async () => ({ id: 's', prefix: 'CN', lastNumber: 1, nextNumber: 2, padding: 4 })),
        create: vi.fn(async () => ({ id: 's', prefix: 'CN', lastNumber: 1, nextNumber: 2, padding: 4 })),
      },
      $queryRaw: vi.fn(async () => [{ last_number: 1, lastNumber: 1, prefix: 'CN' }]),
      $queryRawUnsafe: vi.fn(async () => [{ last_number: 1, lastNumber: 1, prefix: 'CN' }]),
      tenant: { findFirst: vi.fn(async () => ({ themeConfig: {} })), findUnique: vi.fn(async () => ({ themeConfig: {} })) },
    };
    await issueCreditNote(tx, T, { billId: 'bill', reason: 'sales_return', lines: [{ billItemId: 'bi', share: 0.3 }] });
    const item = tx.creditNote.create.mock.calls[0][0].data.items.create[0];
    expect(item).toMatchObject({ taxPercent: 12, taxAmount: -36, taxableValue: -300, totalAmount: -336 });
    // An old line has no unit snapshot: its description is copied untouched.
    expect(item.description).toBe('Oldcillin (Batch BN1) — 10 vials');
  });

  it('a patient return of a 12% sale refunds what was billed and is not slab-checked', async () => {
    p.dispensingRecord.findFirst.mockResolvedValue({
      id: 'dr1', tenantId: T, drugBatchId: 'b1', patientId: 'p1', billId: null, quantityDispensed: 5, unitPrice: 112, discountPercent: 0, saleUnit: 'pack', taxPercent: 12,
    });
    p.drugReturn.aggregate.mockResolvedValue({ _sum: { quantity: 0 } });
    p.drugBatch.findFirst.mockResolvedValue(batch());
    p.patient.findFirst.mockResolvedValue({ id: 'p1' });
    p.drugReturn.create.mockResolvedValue({ id: 'r1' });
    p.drugReturn.findFirst.mockResolvedValue({ id: 'r1', status: 'pending', returnType: 'patient_return', drugBatchId: 'b1', quantity: 2, refundAmount: 224, billId: null });
    p.drugBatch.findUnique.mockResolvedValue(batch());
    p.drugBatch.update.mockResolvedValue(batch());
    await createReturn(T, U, ['pharmacist'], { returnType: 'patient_return', dispensingRecordId: 'dr1', quantity: 2 } as any);
    expect(p.drugReturn.create.mock.calls[0][0].data).toMatchObject({ quantity: 2, refundAmount: 224 });
  });
});

describe('262 — purchases and vendor returns keep the supplier\'s rate', () => {
  it('receives an old 12% invoice as it is, with no warning', async () => {
    p.drugFormulary.findFirst.mockResolvedValue({ ...DRUG, tenantId: T, taxPercent: 5 });
    p.drugBatch.findFirst.mockResolvedValue(null);
    p.drugBatch.create.mockImplementation(async ({ data }: any) => ({ id: 'nb', ...data, drug: DRUG }));
    const b: any = await createBatch(T, U, ADMIN, {
      drugId: 'd1', batchNumber: 'N1', expiryDate: '2030-01-01', quantityReceived: 10, gstPercent: 12, purchasePrice: 50, invoiceDate: '2025-06-01',
    } as any);
    expect(p.drugBatch.create.mock.calls[0][0].data.gstPercent).toBe(12);
    expect(b.gstRateWarning).toBeUndefined();
  });

  it('keeps 12% on an invoice dated after it ended, and says to check it', async () => {
    p.drugFormulary.findFirst.mockResolvedValue({ ...DRUG, tenantId: T, taxPercent: 5 });
    p.drugBatch.findFirst.mockResolvedValue(null);
    p.drugBatch.create.mockImplementation(async ({ data }: any) => ({ id: 'nb', ...data, drug: DRUG }));
    const b: any = await createBatch(T, U, ADMIN, {
      drugId: 'd1', batchNumber: 'N1', expiryDate: '2030-01-01', quantityReceived: 10, gstPercent: 12, purchasePrice: 50, invoiceDate: '2026-01-10',
    } as any);
    expect(p.drugBatch.create.mock.calls[0][0].data.gstPercent).toBe(12);
    expect(b.gstRateWarning).toMatch(/Recorded at 12% as on the supplier's document/);
    expect(await purchaseRateWarning(5, '2026-01-10')).toBeNull();
  });

  it('does not fill a blank purchase rate from a retired HSN default', async () => {
    p.hsnGstRate.findMany.mockResolvedValue([{ hsnCode: '3004', gstRate: 12, treatment: 'taxable', description: null }]);
    p.drugFormulary.findFirst.mockResolvedValue({ ...DRUG, tenantId: T, taxPercent: null });
    p.drugBatch.findFirst.mockResolvedValue(null);
    p.drugBatch.create.mockImplementation(async ({ data }: any) => ({ id: 'nb', ...data, drug: DRUG }));
    await createBatch(T, U, ADMIN, { drugId: 'd1', batchNumber: 'N1', expiryDate: '2030-01-01', quantityReceived: 10 } as any);
    expect(p.drugBatch.create.mock.calls[0][0].data.gstPercent).toBeUndefined();
  });

  it('stock entry does not create a NEW medicine at the supplier\'s 12%', async () => {
    const r = await commitInward(T, U, ADMIN, {
      lines: [{ action: 'create', kind: 'drug', drugName: 'Newcillin', gstPercent: 12, quantityReceived: 10, batchNumber: 'B', expiryDate: '2030-01-01' }],
    } as any);
    expect(r.failed).toBe(1);
    expect(r.results[0]!.message).toMatch(/12% is not a legal GST rate.*Add the medicine with its current rate first, then map this line/);
    expect(p.drugFormulary.create).not.toHaveBeenCalled();
  });

  it('reverses a vendor return at the batch\'s rate, whatever the drug is now', async () => {
    p.supplier.findFirst.mockResolvedValue({ id: 's1', name: 'Sup' });
    p.drugBatch.findMany.mockResolvedValue([{
      ...batch({ gstPercent: 12, purchasePrice: 100, inputCgst: 60, inputSgst: 60, createdAt: new Date('2025-06-01') }, { taxPercent: 5 }),
    }]);
    p.drugReturn.create.mockResolvedValue({ id: 'r1' });
    p.drugReturn.findFirst.mockResolvedValue({ id: 'r1', status: 'pending', returnType: 'vendor_return', drugBatchId: 'b1', quantity: 2 });
    p.drugReturn.findMany.mockResolvedValue([]);
    p.drugBatch.findUnique.mockResolvedValue(batch());
    p.drugBatch.update.mockResolvedValue(batch());
    await createVendorReturnBatch(T, U, ADMIN, { supplierId: 's1', lines: [{ drugBatchId: 'b1', quantity: 2 }], reason: 'expired' } as any);
    expect(p.drugReturn.create.mock.calls[0][0].data).toMatchObject({ inputGstPercent: 12, inputTaxableValue: 200, inputCgst: 12, inputSgst: 12 });
  });

  it('a batch with no rate uses the drug\'s rate from when it came in, not after a re-rate', async () => {
    const b = { drugId: 'd1', gstPercent: null, createdAt: new Date('2025-06-01') };
    p.gstItemRateChange.findFirst.mockResolvedValue({ previousRate: 12 });
    expect(await drugRateWhenReceived(T, b, 5)).toBe(12);
    p.gstItemRateChange.findFirst.mockResolvedValue(null);
    expect(await drugRateWhenReceived(T, b, 5)).toBe(5);
    expect(await drugRateWhenReceived(T, { ...b, gstPercent: 12 }, 5)).toBe(5); // batch rate decides; this is only the fallback
  });
});
