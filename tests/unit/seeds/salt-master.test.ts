import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../src/config/database';
import { saltFactsChanged, markSaltProductsStale } from '../../../src/seeds/salt-master';

/**
 * The boot seed rewrites every molecule no person has decided. When it changes
 * what the classifier reads — a schedule, an NDPS limit — the drugs containing
 * that molecule were classified on the old facts, and the backfill skips rows
 * already at the current classifier version. So a change has to be spotted and
 * those drugs put back in the queue.
 */

const facts = (over: Record<string, unknown> = {}) => ({
  scheduleCode: 'H', controlledClass: null, narcoticClass: null, vaultControlled: false,
  exemptIfCombination: false, maxPerUnitMg: null, maxConcentrationPercent: null,
  fallbackSchedule: null, topicalExempt: false, ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('saltFactsChanged', () => {
  it('spots a schedule the seed filled in', () => {
    expect(saltFactsChanged(facts({ scheduleCode: null }), facts({ scheduleCode: 'H' }))).toBe(true);
  });

  it('compares an NDPS limit by value', () => {
    expect(saltFactsChanged(facts({ maxPerUnitMg: '100' }), facts({ maxPerUnitMg: '100' }))).toBe(false);
    expect(saltFactsChanged(facts({ maxPerUnitMg: '100' }), facts({ maxPerUnitMg: '50' }))).toBe(true);
  });

  it('stays quiet when nothing the classifier reads has moved', () => {
    expect(saltFactsChanged(facts(), facts())).toBe(false);
  });
});

describe('markSaltProductsStale', () => {
  it('re-queues the drugs containing the salts and the formulary rows inheriting them', async () => {
    (prisma.drugMaster.updateMany as any).mockResolvedValue({ count: 3 });
    (prisma.drugFormulary.updateMany as any).mockResolvedValue({ count: 1 });

    expect(await markSaltProductsStale(prisma as never, ['s1'])).toBe(3);

    const master = (prisma.drugMaster.updateMany as any).mock.calls[0][0];
    expect(master).toEqual({
      where: { salts: { some: { saltId: { in: ['s1'] } } } },
      data: { classifierVersion: null },
    });
    const formulary = (prisma.drugFormulary.updateMany as any).mock.calls[0][0];
    // A pharmacist's manual schedule is never re-queued.
    expect(JSON.stringify(formulary.where)).toContain('manual');
    expect(formulary.data).toEqual({ classifierVersion: null });
  });
});
