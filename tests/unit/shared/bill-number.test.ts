import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createBillInSeries,
  nextBillNumberInSeries,
  billSeriesPrefix,
  isBillNumberClash,
} from '../../../src/shared/bill-number';
import { getISTDateStr } from '../../../src/shared/date.utils';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const PATIENT = 'patient-1';

/**
 * A stand-in for the Prisma transaction client, backed by a set of bill numbers
 * already in `bills` — ACROSS ALL TENANTS, which is the point: `bill_number` is
 * globally unique, so another hospital's number blocks ours.
 */
function fakeTx(taken: Set<string>) {
  const findWhere: any[] = [];
  const created: string[] = [];
  const tx = {
    bill: {
      findFirst: vi.fn(async (args: any) => {
        findWhere.push(args.where);
        const prefix = args.where.billNumber?.startsWith ?? '';
        const matching = [...taken].filter((n) => n.startsWith(prefix)).sort();
        const last = matching[matching.length - 1];
        return last ? { billNumber: last } : null;
      }),
      create: vi.fn(async (args: any) => {
        const n = args.data.billNumber;
        created.push(n);
        if (taken.has(n)) {
          // What Prisma raises when the unique index refuses the row.
          throw Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
            meta: { target: ['bill_number'] },
          });
        }
        taken.add(n);
        return { id: `bill-${created.length}`, ...args.data };
      }),
    },
  };
  return { tx, findWhere, created };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('billSeriesPrefix', () => {
  it('builds the series on the hospital’s own calendar day', () => {
    expect(billSeriesPrefix('IPW')).toBe(`IPW-${getISTDateStr()}-`);
  });
});

describe('nextBillNumberInSeries', () => {
  it('starts a fresh day at 0001', async () => {
    const { tx } = fakeTx(new Set());
    expect(await nextBillNumberInSeries(tx, 'IPW')).toBe(`${billSeriesPrefix('IPW')}0001`);
  });

  it('reads the maximum across ALL tenants, not just its own', async () => {
    // The heart of the bug: with a tenant-scoped lookup this tenant sees no
    // IPW- bills, computes 0001, and collides with the other hospital's row.
    const prefix = billSeriesPrefix('IPW');
    const { tx, findWhere } = fakeTx(new Set([`${prefix}0001`, `${prefix}0002`]));

    const next = await nextBillNumberInSeries(tx, 'IPW');

    for (const w of findWhere) expect(w.tenantId).toBeUndefined();
    expect(next).toBe(`${prefix}0003`);
  });

  it('takes the next number after the highest, not after the count', async () => {
    // A count-based sequence repeats a live number as soon as there is a gap —
    // which any deleted bill leaves behind.
    const prefix = billSeriesPrefix('IPW');
    const { tx } = fakeTx(new Set([`${prefix}0001`, `${prefix}0007`]));

    // count = 2, so a count-based allocator would have produced 0003.
    expect(await nextBillNumberInSeries(tx, 'IPW')).toBe(`${prefix}0008`);
  });

  it('keeps two series independent', async () => {
    const { tx } = fakeTx(new Set([`${billSeriesPrefix('IPW')}0009`]));
    expect(await nextBillNumberInSeries(tx, 'OTK')).toBe(`${billSeriesPrefix('OTK')}0001`);
  });
});

describe('isBillNumberClash', () => {
  it('recognises a bill-number collision', () => {
    expect(isBillNumberClash({ code: 'P2002', meta: { target: ['bill_number'] } })).toBe(true);
  });

  it('does not claim any other unique violation', () => {
    expect(isBillNumberClash({ code: 'P2002', meta: { target: ['mrn'] } })).toBe(false);
    expect(isBillNumberClash({ code: 'P2025' })).toBe(false);
    expect(isBillNumberClash(new Error('boom'))).toBe(false);
  });
});

describe('createBillInSeries', () => {
  it('creates the bill with the allocated number and the caller’s fields', async () => {
    const { tx, created } = fakeTx(new Set());

    const bill = await createBillInSeries(tx, 'IPW', {
      tenantId: TENANT,
      patientId: PATIENT,
      admissionId: 'admission-1',
      status: 'draft',
    });

    expect(created).toEqual([`${billSeriesPrefix('IPW')}0001`]);
    expect(bill.admissionId).toBe('admission-1');
    expect(bill.tenantId).toBe(TENANT);
  });

  it('does not collide with a number another tenant already holds', async () => {
    const prefix = billSeriesPrefix('IPW');
    const { tx, created } = fakeTx(new Set([`${prefix}0001`]));

    await expect(
      createBillInSeries(tx, 'IPW', { tenantId: OTHER_TENANT, patientId: PATIENT }),
    ).resolves.toBeTruthy();

    expect(created).toEqual([`${prefix}0002`]);
  });

  it('reports a lost race as retriable rather than as a constraint error', async () => {
    // Someone claims the number between the read and the create — the window
    // this cannot close from inside a transaction.
    const taken = new Set<string>();
    const { tx } = fakeTx(taken);
    tx.bill.findFirst.mockImplementationOnce(async () => {
      taken.add(`${billSeriesPrefix('IPW')}0001`);
      return null;
    });

    await expect(
      createBillInSeries(tx, 'IPW', { tenantId: TENANT, patientId: PATIENT }),
    ).rejects.toThrow(/please retry/i);
  });

  it('lets an unrelated failure through untouched', async () => {
    const { tx } = fakeTx(new Set());
    tx.bill.create.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      createBillInSeries(tx, 'IPW', { tenantId: TENANT, patientId: PATIENT }),
    ).rejects.toThrow('connection lost');
  });
});
