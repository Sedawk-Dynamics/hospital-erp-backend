import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { DIAGNOSTIC_UNAPPROVED_REASON, radiologyApprovalProblem, radiologyTaxFacts } from '../../../../src/shared/radiology-gst';
import { determineTax, tariffTaxContext } from '../../../../src/shared/gst-determination';
import { DEFAULT_GST_PROFILE, mergeGstProfile } from '../../../../src/shared/gst-profile';
import {
  approveRadiologyDiagnostic,
  createServiceTariff,
  setServiceTariffGstApproval,
  updateServiceTariff,
} from '../../../../src/modules/billing/billing.service';
import { createImagingRequest, getImagingBillingPreview } from '../../../../src/modules/imaging/imaging.service';

// #358: diagnostic scans are exempt, only cosmetic / non-medical ones are taxed,
// and nothing is 0% because nobody decided.

const T = 'tenant-1';
const U = 'user-1';
const ON = new Date('2026-11-25T06:00:00Z');
const profile = mergeGstProfile(DEFAULT_GST_PROFILE, { registered: true, gstin: '27AAPFU0939F1ZV' });
const p = prisma as any;
const study = (over: Record<string, unknown> = {}) => ({
  id: 't1', tenantId: T, category: 'radiology', serviceName: 'CT Brain', serviceCode: 'ct', basePrice: 3000, sacCode: null,
  gstTreatment: null, gstRatePercent: 0, gstApproved: false, isCosmetic: false, gstEffectiveFrom: null, isActive: true, ...over,
});
const bill = (t: any) => determineTax({ kind: 'imaging', on: ON, ...tariffTaxContext(t, ON) }, { profile });

beforeEach(() => {
  vi.resetAllMocks();
  p.gstTaxSlab?.findMany?.mockResolvedValue([]);
  p.serviceTariff.updateMany.mockResolvedValue({ count: 1 });
  p.serviceTariff.update.mockImplementation(async (a: any) => ({ ...study(), ...a.data }));
  p.serviceTariff.create.mockImplementation(async (a: any) => ({ id: 'n', ...a.data }));
});

describe('what a scan is billed at', () => {
  it('diagnostic, not approved: exempt, not blocked, with a warning', () => {
    const f = radiologyTaxFacts(study(), ON);
    expect(f).toMatchObject({ gstTreatment: 'exempt', taxRate: 0, gstApproved: false, blocked: false });
    expect(f.warning).toMatch(/GST is not set for CT Brain/);
    expect(bill(study())).toMatchObject({ treatment: 'exempt', ratePercent: 0, hsnSacCode: '999316', requiresResolution: false, reason: DIAGNOSTIC_UNAPPROVED_REASON });
  });

  it('a rate somebody left on an unapproved diagnostic study is not charged', () => {
    expect(bill(study({ gstTreatment: 'taxable', gstRatePercent: 18 }))).toMatchObject({ treatment: 'exempt', ratePercent: 0 });
  });

  it('diagnostic, approved: exempt 0% with no warning', () => {
    const t = study({ gstApproved: true, gstTreatment: 'exempt' });
    expect(radiologyTaxFacts(t, ON).warning).toBeNull();
    expect(bill(t)).toMatchObject({ treatment: 'exempt', requiresResolution: false, reason: 'Classified on the item, approved by the hospital' });
  });

  it('cosmetic, approved: its own rate and SAC', () => {
    expect(bill(study({ isCosmetic: true, gstApproved: true, gstTreatment: 'taxable', gstRatePercent: 5, sacCode: '999799' })))
      .toMatchObject({ treatment: 'taxable', ratePercent: 5, hsnSacCode: '999799', requiresResolution: false });
  });

  it.each([
    ['unset', { isCosmetic: true }],
    ['rate typed but not approved', { isCosmetic: true, gstTreatment: 'taxable', gstRatePercent: 18, sacCode: '999799' }],
    ['approved but dated later', { isCosmetic: true, gstTreatment: 'taxable', gstRatePercent: 18, sacCode: '999799', gstApproved: true, gstEffectiveFrom: new Date('2027-01-01') }],
    ['approved with no rate', { isCosmetic: true, gstTreatment: 'taxable', gstRatePercent: 0, gstApproved: true }],
  ])('cosmetic %s: held, never issued at 0% or a default 18%', (_n, over) => {
    expect(bill(study(over))).toMatchObject({ treatment: 'taxable', ratePercent: 0, requiresResolution: true, hsnSacCode: (over as any).sacCode ?? null });
    expect(radiologyTaxFacts(study(over), ON)).toMatchObject({ blocked: true });
  });

  it('a cosmetic PROCEDURE keeps its existing 18% default — the scan rule is not doubled onto it', () => {
    expect(determineTax({ kind: 'procedure', on: ON, isCosmetic: true, itemRatePercent: 0 }, { profile })).toMatchObject({ ratePercent: 18, requiresResolution: false });
  });
});

describe('approving', () => {
  it('"Approve selected as diagnostic" approves only what can be a diagnostic 0%, and names the rest', async () => {
    p.serviceTariff.findMany.mockResolvedValue([
      study({ id: 'a' }),
      study({ id: 'b', serviceName: 'Keepsake', isCosmetic: true }),
      study({ id: 'c', serviceName: 'Old MRI', gstTreatment: 'taxable', gstRatePercent: 12 }),
      study({ id: 'd', serviceName: 'USG', gstApproved: true, gstTreatment: 'exempt' }),
    ]);
    const out = await approveRadiologyDiagnostic(T, U, ['a', 'b', 'c', 'd', 'zzz']);
    expect(out.approved.map((r) => r.id)).toEqual(['a']);
    expect(out.skipped.map((r) => r.id)).toEqual(['b', 'c', 'd', 'zzz']);
    expect(p.serviceTariff.updateMany).toHaveBeenCalledTimes(1);
    expect(p.serviceTariff.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'a', tenantId: T, isCosmetic: false, gstRatePercent: 0 }, data: { gstTreatment: 'exempt', gstApproved: true },
    });
    expect(p.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('does not approve a row re-classified in the meantime', async () => {
    p.serviceTariff.findMany.mockResolvedValue([study({ id: 'a' })]);
    p.serviceTariff.updateMany.mockResolvedValue({ count: 0 });
    const out = await approveRadiologyDiagnostic(T, U, ['a']);
    expect(out.approved).toEqual([]);
    expect(out.skipped[0]!.reason).toMatch(/Changed by someone else/);
  });

  it('a cosmetic scan needs taxable treatment, a legal rate and a 6-digit SAC', () => {
    const c = { isCosmetic: true, gstTreatment: 'taxable', gstRatePercent: 18, sacCode: '999799' };
    expect(radiologyApprovalProblem(c, true)).toBeNull();
    expect(radiologyApprovalProblem({ ...c, gstTreatment: 'exempt' }, true)).toMatch(/taxable/);
    expect(radiologyApprovalProblem({ ...c, gstRatePercent: 0 }, true)).toMatch(/Enter the GST rate/);
    expect(radiologyApprovalProblem(c, false)).toMatch(/not a legal GST slab/);
    expect(radiologyApprovalProblem({ ...c, sacCode: '9997' }, true)).toMatch(/6-digit SAC/);
    expect(radiologyApprovalProblem({ isCosmetic: false, gstTreatment: 'taxable', gstRatePercent: 18 }, true)).toMatch(/exempt/);
  });

  it('the single approval refuses a contradiction and audits an approval', async () => {
    p.serviceTariff.findFirst.mockResolvedValue(study({ isCosmetic: true, gstTreatment: 'taxable', gstRatePercent: 0 }));
    await expect(setServiceTariffGstApproval(T, U, 't1', true)).rejects.toThrow(/Enter the GST rate/);
    expect(p.serviceTariff.update).not.toHaveBeenCalled();
    p.serviceTariff.findFirst.mockResolvedValue(study({ gstTreatment: 'exempt' }));
    await setServiceTariffGstApproval(T, U, 't1', true);
    expect(p.auditLog.create.mock.calls[0][0].data.description).toMatch(/approved/);
  });

  it('saving never approves, and refuses a taxed diagnostic study', async () => {
    const base = { name: 'CT', code: 'c', category: 'imaging', basePrice: 100, isActive: true } as any;
    await createServiceTariff(T, { ...base, taxRate: 0, gstTreatment: 'exempt' });
    expect(p.serviceTariff.create.mock.calls[0][0].data.gstApproved).toBeUndefined();
    await expect(createServiceTariff(T, { ...base, taxRate: 18 })).rejects.toThrow(/diagnostic scan is exempt/);
    await expect(createServiceTariff(T, { ...base, taxRate: 0, isCosmetic: true, gstTreatment: 'exempt' })).rejects.toThrow(/taxable/);
    await expect(createServiceTariff(T, { ...base, taxRate: 0, isCosmetic: true, sacCode: '99' })).rejects.toThrow(/6 digits/);
  });

  it('changing the purpose withdraws the approval; an old row can still have its price edited', async () => {
    p.serviceTariff.findFirst.mockResolvedValue(study({ gstApproved: true, gstTreatment: 'exempt' }));
    await updateServiceTariff(T, 't1', { isCosmetic: true, gstTreatment: 'taxable', taxRate: 0 } as any);
    expect(p.serviceTariff.update.mock.calls[0][0].data).toMatchObject({ isCosmetic: true, gstApproved: false });
    p.serviceTariff.findFirst.mockResolvedValue(study({ gstTreatment: 'taxable', gstRatePercent: 12 }));
    await updateServiceTariff(T, 't1', { basePrice: 10 } as any);
    expect(p.serviceTariff.update).toHaveBeenCalledTimes(2);
  });
});

describe('ordering and accepting', () => {
  it('remembers the study the doctor picked', async () => {
    p.patient.findFirst.mockResolvedValue({ id: 'pat' });
    p.visit.findFirst.mockResolvedValue({ id: 'v' });
    p.imagingRequest.create.mockResolvedValue({ id: 'r' });
    await createImagingRequest(T, U, { patientId: 'pat', visitId: 'v', imagingType: 'ct_scan', urgency: 'routine', serviceTariffId: 't9' } as any);
    expect(p.imagingRequest.create.mock.calls[0][0].data.serviceTariffId).toBe('t9');
  });

  it('a body part never matches an ordinary order onto a cosmetic study', async () => {
    p.imagingRequest.findFirst.mockResolvedValue({ id: 'r', patientId: 'pat', visitId: 'v', imagingType: 'other', bodyPart: 'Face', serviceTariffId: null });
    p.serviceTariff.findFirst.mockResolvedValue(null);
    await getImagingBillingPreview(T, 'r');
    const lookups = p.serviceTariff.findFirst.mock.calls.map((c: any[]) => c[0].where).filter((w: any) => w.category === 'radiology');
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((w: any) => w.isCosmetic === false)).toBe(true);
  });

  it('the accept preview says what is not set: a warning for diagnostic, a block for cosmetic', async () => {
    p.imagingRequest.findFirst.mockResolvedValue({ id: 'r', patientId: 'pat', visitId: 'v', imagingType: 'ct_scan', bodyPart: null, serviceTariffId: 't1' });
    p.serviceTariff.findFirst.mockResolvedValue(study());
    expect(await getImagingBillingPreview(T, 'r')).toMatchObject({ gstBlocked: false, gstWarning: expect.stringContaining('GST is not set') });
    p.serviceTariff.findFirst.mockResolvedValue(study({ isCosmetic: true, serviceName: 'Keepsake' }));
    expect(await getImagingBillingPreview(T, 'r')).toMatchObject({ gstBlocked: true, gstWarning: expect.stringContaining('Keepsake') });
  });
});
