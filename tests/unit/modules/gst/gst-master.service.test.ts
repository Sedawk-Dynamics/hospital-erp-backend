import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  matchLongestPrefix,
  readTreatment,
  listSacCodes,
  createSacCode,
  updateSacCode,
  deactivateSacCode,
} from '../../../../src/modules/gst/gst-master.service';

const SUPER = ['super_admin'];
const ADMIN = ['admin'];

const rows = [
  { code: '9993', gstRate: 0, treatment: 'exempt', description: 'Human health' },
  { code: '999312', gstRate: 0, treatment: 'exempt', description: 'Consultation' },
  { code: '999319', gstRate: 18, treatment: 'taxable', description: 'Other human health' },
  { code: '996332', gstRate: 5, treatment: 'taxable', description: 'Canteen' },
  { code: '9018', gstRate: 5, treatment: null, description: 'Instruments' },
];

describe('readTreatment', () => {
  it('trusts a recorded treatment', () => {
    expect(readTreatment('exempt', 0)).toBe('exempt');
    expect(readTreatment('nil_rated', 0)).toBe('nil_rated');
  });

  // A row saved before the column existed must never come back undefined —
  // every consumer branches on it.
  it('reads a legacy row from its rate', () => {
    expect(readTreatment(null, 5)).toBe('taxable');
    expect(readTreatment(null, 0)).toBe('nil_rated');
    expect(readTreatment('nonsense', 12)).toBe('taxable');
  });
});

describe('matchLongestPrefix', () => {
  it('falls back to the chapter heading', () => {
    expect(matchLongestPrefix('999311', rows)).toMatchObject({ code: '9993', treatment: 'exempt' });
  });

  // The point of prefix matching: a specific code beats its heading, which is
  // how cosmetic work stays taxable while the rest of healthcare is exempt.
  it('lets a specific code beat its heading', () => {
    expect(matchLongestPrefix('999319', rows)).toMatchObject({
      code: '999319',
      ratePercent: 18,
      treatment: 'taxable',
    });
  });

  it('normalises punctuation before matching', () => {
    expect(matchLongestPrefix('9993.12', rows)).toMatchObject({ code: '999312' });
  });

  it('returns nothing when no row is a prefix', () => {
    expect(matchLongestPrefix('8471', rows)).toBeNull();
    expect(matchLongestPrefix(null, rows)).toBeNull();
    expect(matchLongestPrefix('abc', rows)).toBeNull();
  });

  it('reads a legacy row treatment from its rate', () => {
    expect(matchLongestPrefix('9018', rows)!.treatment).toBe('taxable');
  });
});

describe('SAC master management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Platform reference data: one hospital's auditor does not get to change what
  // a code means for every other hospital.
  it('refuses anyone who is not a super admin', async () => {
    await expect(createSacCode(ADMIN, { sacCode: '9993', gstRate: 0 })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(updateSacCode(ADMIN, 'x', { gstRate: 5 })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(deactivateSacCode(ADMIN, 'x')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('normalises the code on the way in', async () => {
    (prisma.sacCode.findUnique as any).mockResolvedValue(null);
    (prisma.sacCode.create as any).mockResolvedValue({ id: 's1', sacCode: '999312', gstRate: 0 });
    await createSacCode(SUPER, { sacCode: '9993.12', gstRate: 0, treatment: 'exempt' });
    expect((prisma.sacCode.create as any).mock.calls[0][0].data.sacCode).toBe('999312');
  });

  it('rejects a code with no digits', async () => {
    await expect(createSacCode(SUPER, { sacCode: 'abc', gstRate: 0 })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('refuses a duplicate rather than silently overwriting', async () => {
    (prisma.sacCode.findUnique as any).mockResolvedValue({ id: 's1', sacCode: '9993' });
    await expect(createSacCode(SUPER, { sacCode: '9993', gstRate: 0 })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(prisma.sacCode.create as any).not.toHaveBeenCalled();
  });

  // A row that claims to be exempt at 18% says two different things. The rate
  // loses, because the treatment is the legal position and the rate follows it.
  it('forces a non-taxable treatment to a zero rate', async () => {
    (prisma.sacCode.findUnique as any).mockResolvedValue(null);
    (prisma.sacCode.create as any).mockResolvedValue({ id: 's1', gstRate: 0 });
    await createSacCode(SUPER, { sacCode: '9993', gstRate: 18, treatment: 'exempt' });
    const d = (prisma.sacCode.create as any).mock.calls[0][0].data;
    expect(d.gstRate).toBe(0);
    expect(d.treatment).toBe('exempt');
  });

  it('infers a treatment when none is given', async () => {
    (prisma.sacCode.findUnique as any).mockResolvedValue(null);
    (prisma.sacCode.create as any).mockResolvedValue({ id: 's1', gstRate: 18 });
    await createSacCode(SUPER, { sacCode: '997212', gstRate: 18 });
    expect((prisma.sacCode.create as any).mock.calls[0][0].data.treatment).toBe('taxable');
  });

  it('keeps the stored treatment when only the rate is edited', async () => {
    (prisma.sacCode.findUnique as any).mockResolvedValue({
      id: 's1',
      sacCode: '997212',
      gstRate: 18,
      treatment: 'taxable',
    });
    (prisma.sacCode.update as any).mockResolvedValue({ id: 's1', gstRate: 12 });
    await updateSacCode(SUPER, 's1', { gstRate: 12 });
    const d = (prisma.sacCode.update as any).mock.calls[0][0].data;
    expect(d).toMatchObject({ gstRate: 12, treatment: 'taxable' });
  });

  // A code that priced a bill last year has to stay resolvable, or that bill
  // can no longer be explained.
  it('deactivates rather than deletes', async () => {
    (prisma.sacCode.findUnique as any).mockResolvedValue({ id: 's1' });
    (prisma.sacCode.update as any).mockResolvedValue({ id: 's1' });
    await deactivateSacCode(SUPER, 's1');
    expect((prisma.sacCode.update as any).mock.calls[0][0].data).toEqual({ isActive: false });
    expect(prisma.sacCode.delete as any).not.toHaveBeenCalled();
  });

  it('lists rows with a resolved treatment and a numeric rate', async () => {
    (prisma.sacCode.findMany as any).mockResolvedValue([
      { id: 's1', sacCode: '9018', gstRate: 5, treatment: null },
    ]);
    const out = await listSacCodes();
    expect(out[0]).toMatchObject({ gstRate: 5, treatment: 'taxable' });
  });
});
