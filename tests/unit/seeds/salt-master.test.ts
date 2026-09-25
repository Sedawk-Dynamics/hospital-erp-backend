import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../src/config/database';
import {
  saltFactsChanged,
  markSaltProductsStale,
  preferStricterScheduleRule,
} from '../../../src/seeds/salt-master';

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

describe('cross-schedule molecule resolution', () => {
  const rule = (scheduleCode: string, matchValue = 'Medicine') => ({
    scheduleCode, matchType: 'salt', matchValue,
    matchNorm: matchValue.toLowerCase(), aliases: [],
  });

  it('keeps Schedule H when a later Schedule G row names the same molecule', () => {
    const h = rule('H', 'Bleomycin');
    const g = rule('G', 'Bleomycin');
    expect(preferStricterScheduleRule(h, g)).toBe(h);
  });

  it('chooses the strictest rule independently of input order', () => {
    for (const [loose, strict] of [
      [rule('H', 'Cefotaxime'), rule('H1', 'Cefotaxime')],
      [rule('H', 'Methylphenidate'), rule('X', 'Methylphenidate')],
    ]) {
      expect(preferStricterScheduleRule(loose, strict)).toBe(strict);
      expect(preferStricterScheduleRule(strict, loose)).toBe(strict);
    }
  });
});

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
