/**
 * Applies the salt classifier to live data.
 *
 * The classifier next door is pure; this owns the two things it cannot — the
 * salt reference (cached, since it is platform data that changes only when
 * someone edits a molecule) and reading a drug's molecules back.
 *
 * There are two ways a drug's molecules reach the classifier:
 *
 *   - a CATALOG drug has them stored as DrugSalt rows, parsed once at ingestion
 *   - a hospital's OWN formulary drug has no catalog row to hang them off, so
 *     its composition text is resolved against the same salt master in memory
 *
 * Both end up with the same SaltRow[] carrying the same schedules, so the two
 * kinds of drug cannot disagree about what a molecule is.
 */

import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { parseSalts, saltLookupKeys, normaliseSalt } from './drug-schedule.classifier';
import type { SaltRow } from './salt-classifier';

/** Salt reference, cached. ~1,858 molecules plus their synonyms. */
const CACHE_TTL_MS = 10 * 60 * 1000;

type SaltFacts = Omit<SaltRow, 'strengthValue' | 'strengthUnit' | 'perVolumeValue'>;

interface SaltIndex {
  /** Every spelling — canonical and synonym — to the molecule it means. */
  byNorm: Map<string, SaltFacts>;
  byId: Map<string, SaltFacts>;
  /** The same spellings to the molecule's id, so writing a link needs no scan. */
  idByNorm: Map<string, string>;
}

let cached: { index: SaltIndex; at: number } | null = null;

/** Drop the cache — call after seeding salts or editing one. */
export function invalidateSaltCache(): void {
  cached = null;
}

export async function getSaltIndex(): Promise<SaltIndex | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.index;

  const salts = await prisma.salt.findMany({
    include: { synonyms: { select: { norm: true } }, classes: { include: { class: true } } },
  });
  if (!salts.length) return null; // not seeded yet — the caller falls back

  const byNorm = new Map<string, SaltFacts>();
  const byId = new Map<string, SaltFacts>();
  const idByNorm = new Map<string, string>();

  for (const s of salts) {
    const row = {
      name: s.name,
      scheduleCode: s.scheduleCode,
      controlledClass: s.controlledClass,
      narcoticClass: s.narcoticClass,
      vaultControlled: s.vaultControlled,
      exemptIfCombination: s.exemptIfCombination,
      maxPerUnitMg: s.maxPerUnitMg === null ? null : Number(s.maxPerUnitMg),
      maxConcentrationPercent:
        s.maxConcentrationPercent === null ? null : Number(s.maxConcentrationPercent),
      fallbackSchedule: s.fallbackSchedule,
      topicalExempt: s.topicalExempt,
      classes: s.classes.map((c) => ({ name: c.class.name, scheduleCode: c.class.scheduleCode })),
    };
    byId.set(s.id, row);
    byNorm.set(s.norm, row);
    idByNorm.set(s.norm, s.id);
    // A canonical norm always wins — a synonym must never shadow a molecule
    // that has a row of its own.
    for (const syn of s.synonyms) {
      if (byNorm.has(syn.norm)) continue;
      byNorm.set(syn.norm, row);
      idByNorm.set(syn.norm, s.id);
    }
  }

  cached = { index: { byNorm, byId, idByNorm }, at: Date.now() };
  return cached.index;
}

function lookup(norm: string, index: SaltIndex): SaltFacts | null {
  for (const key of saltLookupKeys(norm)) {
    const hit = index.byNorm.get(key);
    if (hit) return hit;
  }
  return null;
}

/** The same walk, returning the id — used when writing a link. */
function lookupId(norm: string, index: SaltIndex): string | null {
  for (const key of saltLookupKeys(norm)) {
    const hit = index.idByNorm.get(key);
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve composition TEXT against the salt master, without storing anything.
 *
 * Used for a hospital's own formulary drug, which has no catalog row to hang
 * DrugSalt rows off. Returns null when a molecule cannot be resolved at all,
 * because a partial answer would silently drop an ingredient — and a dropped
 * ingredient is exactly how a scheduled drug reads as over-the-counter.
 */
export async function resolveSaltRows(text: string | null | undefined): Promise<SaltRow[] | null> {
  const index = await getSaltIndex();
  if (!index) return null;

  const parsed = parseSalts(text ?? '');
  if (!parsed.length) return [];

  const rows: SaltRow[] = [];
  for (const p of parsed) {
    const salt = lookup(p.norm, index);
    if (!salt) return null; // unknown molecule — fall back rather than guess
    rows.push({
      ...salt,
      strengthValue: p.strengthValue,
      strengthUnit: p.strengthUnit,
      perVolumeValue: p.perVolumeMl,
    });
  }
  return rows;
}

/** Read a catalog drug's stored molecules. Null when it has none yet. */
export async function loadDrugSaltRows(drugMasterId: string): Promise<SaltRow[] | null> {
  const index = await getSaltIndex();
  if (!index) return null;

  const links = await prisma.drugSalt.findMany({
    where: { drugMasterId },
    orderBy: { position: 'asc' },
    select: {
      saltId: true, strengthValue: true, strengthUnit: true, perVolumeValue: true,
    },
  });
  if (!links.length) return null;

  const rows: SaltRow[] = [];
  for (const l of links) {
    const salt = index.byId.get(l.saltId);
    if (!salt) return null; // stale cache against a deleted molecule
    rows.push({
      ...salt,
      strengthValue: l.strengthValue === null ? null : Number(l.strengthValue),
      strengthUnit: l.strengthUnit,
      perVolumeValue: l.perVolumeValue === null ? null : Number(l.perVolumeValue),
    });
  }
  return rows;
}

/**
 * Record a molecule the salt master has never seen, as UNDECIDED.
 *
 * scheduleCode stays NULL on purpose — that is the difference between "nobody
 * has decided" and "it is over the counter", and it is what puts the molecule
 * in the review queue rather than letting it read as safe.
 *
 * Returns the id, or null if it could not be created (a race with another
 * request creating the same molecule is resolved by reading it back).
 */
async function ensureUndecidedSalt(raw: string, norm: string): Promise<string | null> {
  if (!norm) return null;
  try {
    const row = await prisma.salt.create({
      data: {
        name: raw.trim() || norm,
        norm,
        scheduleCode: null,
        source: null,
        scheduleNote:
          'Seen in a drug added after the schedule lists were loaded, and not named in any of them — needs a decision.',
      },
    });
    return row.id;
  } catch {
    // Unique violation: another request got there first. Read it back rather
    // than failing — two requests adding the same new molecule is normal.
    const existing = await prisma.salt.findUnique({ where: { norm }, select: { id: true } });
    return existing?.id ?? null;
  }
}

/**
 * Write a drug's molecules from STRUCTURED input — no parsing at all.
 *
 * The other path, syncDrugSalts, reads a sentence and works out what it means.
 * This one is handed the answer: a molecule, a number and a unit. It is the
 * better path and the one the add-drug form now uses; parsing survives for
 * bulk imports, pasted text and the 254K rows that arrived as prose.
 *
 * A molecule nobody has recorded is added UNDECIDED, exactly as the parsing
 * path does — typing a new molecule into the form is precisely the moment it
 * should reach the review queue.
 *
 * Never throws: a drug must still save even if its molecules cannot be linked.
 */
export async function writeStructuredSalts(
  drugMasterId: string,
  salts: Array<{
    name: string;
    strengthValue?: number | null;
    strengthUnit?: string | null;
    perVolumeValue?: number | null;
    perVolumeUnit?: string | null;
  }>,
): Promise<number> {
  try {
    const index = await getSaltIndex();
    if (!index) return 0;

    const seen = new Set<string>();
    const rows: {
      drugMasterId: string; saltId: string;
      strengthValue: number | null; strengthUnit: string | null;
      perVolumeValue: number | null; perVolumeUnit: string | null; position: number;
    }[] = [];
    let discovered = 0;

    for (const s of salts) {
      const norm = normaliseSalt(s.name);
      let saltId = lookupId(norm, index);
      if (!saltId) {
        saltId = await ensureUndecidedSalt(s.name, norm);
        if (saltId) discovered += 1;
      }
      if (!saltId || seen.has(saltId)) continue;
      seen.add(saltId);
      rows.push({
        drugMasterId,
        saltId,
        strengthValue: s.strengthValue ?? null,
        strengthUnit: s.strengthUnit ?? null,
        perVolumeValue: s.perVolumeValue ?? null,
        perVolumeUnit: s.perVolumeUnit ?? null,
        position: rows.length,
      });
    }

    if (discovered) {
      invalidateSaltCache();
      logger.info(
        { drugMasterId, discovered },
        'New molecule(s) recorded as undecided from a structured composition',
      );
    }

    await prisma.$transaction([
      prisma.drugSalt.deleteMany({ where: { drugMasterId } }),
      ...(rows.length
        ? [prisma.drugSalt.createMany({ data: rows as never, skipDuplicates: true })]
        : []),
    ]);
    return rows.length;
  } catch (err) {
    logger.warn({ err, drugMasterId }, 'Could not write structured salts; drug left as it was');
    return 0;
  }
}

/**
 * Re-derive one catalog drug's stored molecules from its composition text.
 *
 * Called when a drug is created or its composition edited — this is the ONE
 * place the text is parsed. Everything downstream reads the rows.
 *
 * Never throws: a drug must still save even if its molecules cannot be resolved.
 */
export async function syncDrugSalts(drugMasterId: string): Promise<number> {
  try {
    const index = await getSaltIndex();
    if (!index) return 0;

    const drug = await prisma.drugMaster.findUnique({
      where: { id: drugMasterId },
      select: { saltComposition: true, genericName: true },
    });
    if (!drug) return 0;

    const parsed = parseSalts(drug.saltComposition || drug.genericName || '');
    const seen = new Set<string>();
    const rows: {
      drugMasterId: string; saltId: string;
      strengthValue: number | null; strengthUnit: string | null;
      perVolumeValue: number | null; perVolumeUnit: string | null; position: number;
    }[] = [];

    let discovered = 0;
    for (const p of parsed) {
      // Two spellings of one molecule resolve to the same id, so they cannot
      // become two links on the same drug.
      let saltId = lookupId(p.norm, index);

      // A molecule nobody has ever recorded. It used to be skipped, which meant
      // the drug was classified from a PARTIAL composition and the new molecule
      // never reached the review queue — the one place it should have surfaced.
      // Adding it undecided is the honest outcome: the system does not pretend
      // to know a schedule it has never been told, and a person is asked.
      if (!saltId) {
        saltId = await ensureUndecidedSalt(p.raw, p.norm);
        if (saltId) discovered += 1;
      }
      if (!saltId || seen.has(saltId)) continue;
      seen.add(saltId);
      rows.push({
        drugMasterId,
        saltId,
        strengthValue: p.strengthValue,
        strengthUnit: p.strengthUnit,
        perVolumeValue: p.perVolumeMl,
        perVolumeUnit: p.perVolumeMl ? 'ml' : null,
        position: rows.length,
      });
    }

    if (discovered) {
      // The index is now stale — it was built before these rows existed.
      invalidateSaltCache();
      logger.info(
        { drugMasterId, discovered },
        'New molecule(s) recorded as undecided; they now appear in the salt review queue',
      );
    }

    await prisma.$transaction([
      prisma.drugSalt.deleteMany({ where: { drugMasterId } }),
      ...(rows.length
        ? [prisma.drugSalt.createMany({ data: rows as never, skipDuplicates: true })]
        : []),
    ]);
    return rows.length;
  } catch (err) {
    logger.warn({ err, drugMasterId }, 'Could not sync structured salts; drug left as it was');
    return 0;
  }
}
