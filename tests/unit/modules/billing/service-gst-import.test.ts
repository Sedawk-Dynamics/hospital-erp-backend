import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { applyServiceGstImport, previewServiceGstImport, serviceGstTemplate } from '../../../../src/modules/billing/service-gst-import.service';
import { clearGstSlabCache } from '../../../../src/shared/gst-slabs';

// #264: the hospital admin's services list — previewed row by row, applied only
// where valid, never approving anything.

const T = 'tenant-1';
const U = 'user-1';
const p = prisma as any;
const tariff = (over: Record<string, unknown> = {}) => ({
  id: 't1', serviceName: 'Laser therapy', serviceCode: 'LAS', category: 'procedure', sacCode: null,
  gstTreatment: null, gstRatePercent: 0, gstApproved: false, isCosmetic: false, isActive: true, ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  rowNumber: 2, serviceCode: 'LAS', serviceName: 'Laser therapy', sacCode: '999722', treatment: 'taxable', gstPercent: '18', ...over,
});
const slabModel = Object.keys(p).find((k) => /slab/i.test(k));

beforeEach(() => {
  vi.resetAllMocks();
  clearGstSlabCache();
  const slabs = [0, 5, 18, 40].map((r) => ({ ratePercent: r, effectiveFrom: new Date('2025-09-22'), effectiveTo: null, isActive: true }));
  for (const m of ['gstSlab', 'gstTaxSlab', 'gstRateSlab', slabModel].filter(Boolean) as string[]) p[m].findMany.mockResolvedValue(slabs);
  p.serviceTariff.findMany.mockResolvedValue([
    tariff(), tariff({ id: 't2', serviceName: 'CT Brain', serviceCode: 'CT', category: 'radiology' }),
    tariff({ id: 't3', serviceName: 'Filler', serviceCode: 'FIL', isCosmetic: true }),
    tariff({ id: 't4', serviceName: 'Twin', serviceCode: 'A' }), tariff({ id: 't5', serviceName: 'Twin', serviceCode: 'B' }),
  ]);
  p.sacCode.findMany.mockResolvedValue([{ sacCode: '999722' }]);
  p.serviceTariff.updateMany.mockResolvedValue({ count: 1 });
});

const errorsOf = async (over: Record<string, unknown>) => (await previewServiceGstImport(T, [row(over)] as any)).rows[0]!.errors.join('; ');

describe('preview', () => {
  it('accepts a good row and writes nothing', async () => {
    const out = await previewServiceGstImport(T, [row()] as any);
    expect(out.rows[0]).toMatchObject({ status: 'ready', tariffId: 't1', errors: [], next: { sacCode: '999722', treatment: 'taxable', gstPercent: 18 } });
    expect(out.summary).toEqual({ total: 1, ready: 1, unchanged: 0, errors: 0 });
    expect(p.serviceTariff.updateMany).not.toHaveBeenCalled();
    expect(p.auditLog.create).not.toHaveBeenCalled();
  });

  it('matches by name when the code is blank, whatever the case', async () => {
    const out = await previewServiceGstImport(T, [row({ serviceCode: '', serviceName: ' laser  THERAPY ' })] as any);
    expect(out.rows[0]).toMatchObject({ status: 'ready', tariffId: 't1' });
  });

  it.each([
    ['an unknown code', { serviceCode: 'NOPE' }, /No service has the code "NOPE"/],
    ['a code and a name that disagree', { serviceName: 'CT Brain' }, /is "Laser therapy", not "CT Brain"/],
    ['an ambiguous name', { serviceCode: '', serviceName: 'Twin' }, /name of 2 services/],
    ['no service', { serviceCode: '', serviceName: '' }, /Enter the service code/],
    ['a 4-digit SAC', { sacCode: '9997' }, /must be 6 digits/],
    ['a SAC with letters', { sacCode: '99A722' }, /must be 6 digits/],
    ['an HSN in the SAC column', { sacCode: '300490' }, /start with 99/],
    ['no SAC', { sacCode: '' }, /SAC is required/],
    ['an unknown treatment', { treatment: 'free' }, /not one of/],
    ['a taxable service at 0%', { gstPercent: 0 }, /above 0/],
    ['a taxable service with no rate', { gstPercent: '' }, /required for a taxable/],
    ['a rate that is not a slab', { gstPercent: '12' }, /not a legal GST slab/],
    ['an exempt service with a rate', { treatment: 'exempt', gstPercent: '18%' }, /cannot carry GST/],
    ['a GST % that is not a number', { gstPercent: 'abc' }, /not a number/],
    ['a cosmetic service as exempt', { serviceCode: 'FIL', serviceName: 'Filler', treatment: 'exempt', gstPercent: 0 }, /marked cosmetic/],
    ['a diagnostic scan as taxable', { serviceCode: 'CT', serviceName: 'CT Brain' }, /diagnostic scan is exempt/],
  ])('refuses %s', async (_n, over, msg) => {
    expect(await errorsOf(over)).toMatch(msg);
  });

  it('refuses the same service twice in one file', async () => {
    const out = await previewServiceGstImport(T, [row(), row({ rowNumber: 3 })] as any);
    expect(out.rows[1]!.errors.join()).toMatch(/already on row 2/);
  });

  it('says when a change would withdraw an approval, and when nothing changes', async () => {
    p.serviceTariff.findMany.mockResolvedValue([tariff({ gstApproved: true, sacCode: '999722', gstTreatment: 'taxable', gstRatePercent: 5 })]);
    expect((await previewServiceGstImport(T, [row()] as any)).rows[0]!.warnings.join()).toMatch(/withdraws the approval/);
    p.serviceTariff.findMany.mockResolvedValue([tariff({ gstApproved: true, sacCode: '999722', gstTreatment: 'taxable', gstRatePercent: 18 })]);
    expect((await previewServiceGstImport(T, [row()] as any)).rows[0]).toMatchObject({ status: 'unchanged', warnings: [] });
  });
});

describe('apply', () => {
  it('writes only valid rows, leaves them unapproved, and audits each', async () => {
    const out = await applyServiceGstImport(T, U, [row(), row({ rowNumber: 3, serviceCode: 'CT', serviceName: 'CT Brain' })] as any);
    expect(out).toMatchObject({ applied: 1, failed: 1 });
    expect(p.serviceTariff.updateMany).toHaveBeenCalledTimes(1);
    expect(p.serviceTariff.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 't1', tenantId: T, sacCode: null, gstTreatment: null },
      data: { sacCode: '999722', gstTreatment: 'taxable', gstRatePercent: 18, gstApproved: false },
    });
    expect(p.auditLog.create).toHaveBeenCalledTimes(1);
    expect(p.auditLog.create.mock.calls[0][0].data.description).toMatch(/row 2.*Laser therapy.*awaiting approval/);
  });

  it('never touches an unchanged row, so an existing approval survives', async () => {
    p.serviceTariff.findMany.mockResolvedValue([tariff({ gstApproved: true, sacCode: '999722', gstTreatment: 'taxable', gstRatePercent: 18 })]);
    expect(await applyServiceGstImport(T, U, [row()] as any)).toMatchObject({ applied: 0 });
    expect(p.serviceTariff.updateMany).not.toHaveBeenCalled();
  });

  it('reports a row somebody else changed meanwhile', async () => {
    p.serviceTariff.updateMany.mockResolvedValue({ count: 0 });
    const out = await applyServiceGstImport(T, U, [row()] as any);
    expect(out.results[0]).toMatchObject({ applied: false, reason: expect.stringMatching(/Changed by someone else/) });
    expect(p.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('template', () => {
  it('lists the active services to fill in', async () => {
    const t = await serviceGstTemplate(T);
    expect(t.columns).toEqual(['Service code', 'Service name', 'SAC', 'Treatment', 'GST %']);
    expect(t.rows[0]).toEqual(['LAS', 'Laser therapy', '', '', '']);
  });
});
