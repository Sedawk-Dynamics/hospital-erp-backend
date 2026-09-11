/**
 * Seed the salt master — the structured replacement for classifying by string.
 *
 * Deciding a drug's schedule used to mean parsing its composition text and
 * matching each molecule against DrugScheduleRule by name, on every
 * classification of every drug. This seed turns that reference data inside out:
 * the MOLECULE becomes a row, its schedule becomes a column, and classification
 * becomes a join.
 *
 * Two sources feed it, and the order matters:
 *
 *   1. The 989 published rules — the schedules themselves. A molecule named in
 *      Schedule H1 gets scheduleCode 'H1' and source 'cdsco'.
 *   2. The catalog's own compositions — 1,685 distinct molecules across 253,987
 *      products. Anything here that no rule names is created with scheduleCode
 *      NULL, which is the point: an unmapped molecule becomes visible work
 *      instead of silently reading over-the-counter. That is how warfarin,
 *      rosuvastatin and pregabalin sat unscheduled without anyone noticing.
 *
 * A rule's aliases and the catalog's alternate spellings both become synonyms,
 * so "Diclofenac" resolves to the same row as the published "Diclofenac
 * Sodium/Potassium/Acid".
 *
 * Idempotent, and a human's decision outranks it: a salt whose source is
 * 'manual' is never rewritten by a re-run.
 */

import type { PrismaClient } from '@prisma/client';
import { logger } from '../config/logger';
import {
  parseSalts,
  normaliseSalt,
  saltLookupKeys,
  type ScheduleRuleLike,
} from '../modules/drug-master/drug-schedule.classifier';

export interface SaltSeedTotals {
  classes: number;
  saltsCreated: number;
  saltsUpdated: number;
  synonyms: number;
  classLinks: number;
  undecided: number;
}

/** The schedule fields a salt carries, resolved from one rule. */
function scheduleFieldsFrom(rule: ScheduleRuleLike) {
  return {
    scheduleCode: rule.scheduleCode,
    exemptIfCombination: Boolean(rule.exemptIfCombination),
    maxPerUnitMg: (rule.maxPerUnitMg ?? null) as never,
    maxConcentrationPercent: (rule.maxConcentrationPercent ?? null) as never,
    fallbackSchedule: rule.fallbackSchedule ?? null,
    topicalExempt: Boolean(rule.topicalExempt),
  };
}

function ndpsFieldsFrom(rule: ScheduleRuleLike) {
  return {
    controlledClass: rule.controlledClass ?? null,
    narcoticClass: rule.narcoticClass ?? null,
    vaultControlled: Boolean(rule.vaultControlled),
  };
}

export async function seedSaltMaster(prisma: PrismaClient): Promise<SaltSeedTotals> {
  const totals: SaltSeedTotals = {
    classes: 0, saltsCreated: 0, saltsUpdated: 0, synonyms: 0, classLinks: 0, undecided: 0,
  };

  const rules = (await prisma.drugScheduleRule.findMany({
    where: { isActive: true },
  })) as unknown as ScheduleRuleLike[];
  if (!rules.length) {
    logger.warn('Salt master seed skipped — no schedule rules are seeded yet');
    return totals;
  }

  // ── 1. Therapeutic classes ────────────────────────────────────────────────
  // Schedule H names six CATEGORIES rather than molecules; "Antibiotics" is an
  // entry in those words. They cannot live in the salt table because a molecule
  // belongs to one without ever being named individually.
  const classRules = rules.filter((r) => r.matchType === 'class');
  const classIdByName = new Map<string, string>();
  for (const r of classRules) {
    const row = await prisma.therapeuticClass.upsert({
      where: { name: r.matchValue },
      update: { scheduleCode: r.scheduleCode, pattern: r.pattern ?? null },
      create: { name: r.matchValue, scheduleCode: r.scheduleCode, pattern: r.pattern ?? null },
    });
    classIdByName.set(r.matchValue, row.id);
    totals.classes += 1;
  }

  // ── 2. Resolve every known spelling to the rule that owns it ──────────────
  // A rule's matchNorm is its canonical key; its aliases are extra keys for the
  // same molecule. Salt rules and the NDPS overlay are indexed separately
  // because a molecule can be in both — tramadol is Schedule H1 AND psychotropic.
  const cdscoByNorm = new Map<string, ScheduleRuleLike>();
  const ndpsByNorm = new Map<string, ScheduleRuleLike>();
  for (const r of rules) {
    if (r.matchType !== 'salt') continue;
    const target = r.scheduleCode === 'NDPS' ? ndpsByNorm : cdscoByNorm;
    for (const key of [r.matchNorm, ...(r.aliases ?? [])]) {
      if (key && !target.has(key)) target.set(key, r);
    }
  }

  const findRule = (norm: string, index: Map<string, ScheduleRuleLike>) => {
    for (const key of saltLookupKeys(norm)) {
      const hit = index.get(key);
      if (hit) return hit;
    }
    return null;
  };

  // ── 3. Every molecule that exists, from both sources ─────────────────────
  // Keyed by the CANONICAL norm — the rule's own key when a rule owns the
  // molecule, otherwise the catalog's spelling. Everything else becomes a
  // synonym pointing at it.
  interface Draft {
    norm: string;
    name: string;
    spellings: Map<string, string>; // norm -> raw, for synonyms
    cdsco: ScheduleRuleLike | null;
    ndps: ScheduleRuleLike | null;
    products: number;
  }
  const drafts = new Map<string, Draft>();

  const draftFor = (canonNorm: string, name: string): Draft => {
    let d = drafts.get(canonNorm);
    if (!d) {
      d = { norm: canonNorm, name, spellings: new Map(), cdsco: null, ndps: null, products: 0 };
      drafts.set(canonNorm, d);
    }
    return d;
  };

  // 3a. Molecules the published lists name — these carry the schedules.
  for (const r of rules) {
    if (r.matchType !== 'salt') continue;
    const isNdps = r.scheduleCode === 'NDPS';
    // An NDPS molecule may also be named by a CDSCO rule; both write to the same
    // draft, keyed on whichever norm the CDSCO rule uses when there is one.
    const cdscoHit = isNdps ? findRule(r.matchNorm, cdscoByNorm) : r;
    const canon = cdscoHit ? cdscoHit.matchNorm : r.matchNorm;
    const d = draftFor(canon, cdscoHit ? cdscoHit.matchValue : r.matchValue);
    if (isNdps) d.ndps = r;
    else d.cdsco = r;
    for (const a of r.aliases ?? []) if (a && a !== canon) d.spellings.set(a, a);
  }

  // 3b. Molecules the catalog actually stocks. Distinct compositions only —
  // 253,987 products collapse to far fewer distinct strings.
  const compositions: { c: string | null }[] = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT COALESCE(salt_composition, generic_name) AS c
     FROM drug_master
     WHERE COALESCE(salt_composition, generic_name) IS NOT NULL`,
  );

  for (const row of compositions) {
    for (const salt of parseSalts(row.c)) {
      if (!salt.norm) continue;
      const cdscoHit = findRule(salt.norm, cdscoByNorm);
      const ndpsHit = findRule(salt.norm, ndpsByNorm);
      const canon = cdscoHit ? cdscoHit.matchNorm : ndpsHit ? ndpsHit.matchNorm : salt.norm;
      const d = draftFor(canon, cdscoHit?.matchValue ?? ndpsHit?.matchValue ?? salt.raw);
      if (cdscoHit) d.cdsco = cdscoHit;
      if (ndpsHit) d.ndps = ndpsHit;
      d.products += 1;
      if (salt.norm !== canon) d.spellings.set(salt.norm, salt.raw);
    }
  }

  // ── 4. Write the salts ────────────────────────────────────────────────────
  // With the facts the classifier reads, so a change can be spotted at the end.
  const existing = await prisma.salt.findMany({
    select: { norm: true, source: true, id: true, ...SALT_FACTS },
  });
  const bySavedNorm = new Map(existing.map((s) => [s.norm, s]));

  const classPatterns = classRules
    .map((r) => ({ rule: r, re: r.pattern ? new RegExp(r.pattern, 'i') : null }))
    .filter((c) => c.re);

  for (const d of drafts.values()) {
    const prior = bySavedNorm.get(d.norm);
    // A person's decision is permanent; a re-seed must not undo it.
    if (prior?.source === 'manual') continue;

    // A named molecule outranks the class it belongs to, exactly as the string
    // classifier did — cefixime is H1 by name, not H via "Antibiotics".
    const matchedClass = d.cdsco
      ? null
      : classPatterns.find((c) => c.re!.test(d.name) || c.re!.test(d.norm)) ?? null;

    let scheduleCode: string | null = null;
    let source: string | null = null;
    let note: string | null = null;

    if (d.cdsco) {
      scheduleCode = d.cdsco.scheduleCode;
      source = 'cdsco';
      note = `Named in Schedule ${d.cdsco.scheduleCode} as "${d.cdsco.matchValue}".`;
    } else if (matchedClass) {
      scheduleCode = matchedClass.rule.scheduleCode;
      source = 'class';
      note = `Falls under the "${matchedClass.rule.matchValue}" class entry of Schedule ${matchedClass.rule.scheduleCode}.`;
    } else if (d.ndps) {
      // Schedule H names the NDPS Act as an entry in its own right, so an
      // NDPS-listed molecule is a prescription drug even when no salt rule
      // spells it out. Without this, morphine and fentanyl read OTC.
      scheduleCode = 'H';
      source = 'ndps';
      note = 'Listed in the NDPS Act, 1985, which Schedule H covers as an entry in its own right.';
    } else {
      totals.undecided += 1;
      note = 'Not named in any published schedule list — needs a decision.';
    }

    const data = {
      name: d.name,
      scheduleCode,
      source,
      scheduleNote: note,
      ...(d.cdsco ? scheduleFieldsFrom(d.cdsco) : {}),
      ...(d.ndps ? ndpsFieldsFrom(d.ndps) : {}),
      // The concentration exemption lives on the NDPS rule, not the CDSCO one.
      ...(d.ndps
        ? {
            exemptIfCombination: Boolean(d.ndps.exemptIfCombination),
            maxPerUnitMg: (d.ndps.maxPerUnitMg ?? null) as never,
            maxConcentrationPercent: (d.ndps.maxConcentrationPercent ?? null) as never,
            fallbackSchedule: d.ndps.fallbackSchedule ?? null,
          }
        : {}),
    };

    const salt = await prisma.salt.upsert({
      where: { norm: d.norm },
      update: data,
      create: { norm: d.norm, ...data },
    });
    if (prior) totals.saltsUpdated += 1;
    else totals.saltsCreated += 1;

    // ── Synonyms ───────────────────────────────────────────────────────────
    for (const [synNorm, raw] of d.spellings) {
      // A synonym must never shadow a molecule that has its own row.
      if (drafts.has(synNorm)) continue;
      try {
        await prisma.saltSynonym.upsert({
          where: { norm: synNorm },
          update: { saltId: salt.id, name: raw },
          create: { saltId: salt.id, norm: synNorm, name: raw },
        });
        totals.synonyms += 1;
      } catch (err) {
        // Two molecules claiming one spelling is a data problem worth seeing,
        // not a reason to abort the seed.
        logger.warn({ err, synNorm, salt: d.name }, 'Salt synonym collision, skipped');
      }
    }

    if (matchedClass) {
      const classId = classIdByName.get(matchedClass.rule.matchValue);
      if (classId) {
        await prisma.saltTherapeuticClass.upsert({
          where: { saltId_classId: { saltId: salt.id, classId } },
          update: {},
          create: { saltId: salt.id, classId },
        });
        totals.classLinks += 1;
      }
    }
  }

  // A molecule whose facts just changed — a rule shipped in a release, or one
  // an administrator returned to the review queue that a published list names
  // — leaves every drug containing it classified on the old facts, and the
  // backfill skips rows already at the current classifier version. Marked
  // stale, they are redone by the classification step that runs next.
  const changed = await saltsWithChangedFacts(prisma, existing);
  if (changed.length) {
    const drugs = await markSaltProductsStale(prisma, changed);
    logger.info({ salts: changed.length, drugs }, 'Salt facts changed; their drugs will be re-classified');
  }

  logger.info(totals, 'Salt master seeded');
  return totals;
}

/** The salt columns the classifier reads. A change to any of them re-classifies. */
const SALT_FACTS = {
  scheduleCode: true, controlledClass: true, narcoticClass: true, vaultControlled: true,
  exemptIfCombination: true, maxPerUnitMg: true, maxConcentrationPercent: true,
  fallbackSchedule: true, topicalExempt: true,
} as const;

type SaltFacts = Record<keyof typeof SALT_FACTS, unknown>;

/** Decimals compare by value, so both sides go through String(). */
export function saltFactsChanged(before: SaltFacts, after: SaltFacts): boolean {
  return (Object.keys(SALT_FACTS) as (keyof typeof SALT_FACTS)[]).some(
    (k) => String(before[k] ?? null) !== String(after[k] ?? null),
  );
}

/** The salts whose facts differ from what was read before the seed wrote. */
async function saltsWithChangedFacts(
  prisma: PrismaClient,
  before: ({ id: string } & SaltFacts)[],
): Promise<string[]> {
  const now = await prisma.salt.findMany({ select: { id: true, ...SALT_FACTS } });
  const byId = new Map(now.map((s) => [s.id, s]));
  return before
    .filter((b) => {
      const after = byId.get(b.id);
      return after !== undefined && saltFactsChanged(b, after);
    })
    .map((b) => b.id);
}

/**
 * Mark every drug containing one of these salts for re-classification, and the
 * hospital formulary rows that inherit from those drugs. A pharmacist's manual
 * schedule stays.
 */
export async function markSaltProductsStale(prisma: PrismaClient, saltIds: string[]): Promise<number> {
  const containing = { salts: { some: { saltId: { in: saltIds } } } };
  const drugs = await prisma.drugMaster.updateMany({
    where: containing,
    data: { classifierVersion: null },
  });
  await prisma.drugFormulary.updateMany({
    where: {
      drugMaster: containing,
      OR: [{ scheduleSource: null }, { scheduleSource: { not: 'manual' } }],
    },
    data: { classifierVersion: null },
  });
  return drugs.count;
}

/** Auto-seed entry point. */
export async function seedSalts(prisma: PrismaClient): Promise<void> {
  const t = await seedSaltMaster(prisma);
  if (t.undecided > 0) {
    logger.warn(
      { undecided: t.undecided },
      'Molecules with no published schedule — they classify as unknown until someone decides',
    );
  }
}
