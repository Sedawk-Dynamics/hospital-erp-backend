/**
 * Applies the schedule classifier to live data.
 *
 * The classifier itself is pure; this module owns the two things it cannot: the
 * rule index (loaded once and cached, since the rules are platform reference
 * data that only change when the seed runs) and writing the result back.
 *
 * Everything here is best-effort by design. Classification is a LABEL — if it
 * fails, the drug is still created, still sellable, still billable. It must
 * never be the reason a pharmacist cannot add a medicine, so every entry point
 * swallows its errors and logs them.
 */

import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import {
  buildRuleIndex,
  classify,
  parseSalts,
  CLASSIFIER_VERSION,
  type RuleIndex,
  type ScheduleRuleLike,
  type ClassificationResult,
  type ClassificationInput,
} from './drug-schedule.classifier';

/**
 * Cached rule index. ~989 rows that change only when the seed runs, so a short
 * TTL keeps a long-lived server fresh without re-querying on every drug create.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
let cached: { index: RuleIndex; at: number } | null = null;

/** Drop the cache — call after seeding or editing rules. */
export function invalidateScheduleRuleCache(): void {
  cached = null;
}

export async function getRuleIndex(): Promise<RuleIndex | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.index;
  const rules = (await prisma.drugScheduleRule.findMany({
    where: { isActive: true },
  })) as unknown as ScheduleRuleLike[];
  if (!rules.length) {
    // Reference data not seeded yet — classification is simply unavailable.
    return null;
  }
  cached = { index: buildRuleIndex(rules), at: Date.now() };
  return cached.index;
}

/** Classify without touching the database. Returns null if rules are missing. */
export async function classifyDrug(
  input: ClassificationInput,
): Promise<ClassificationResult | null> {
  const index = await getRuleIndex();
  if (!index) return null;
  return classify(input, index);
}

/** The columns a classification writes onto a formulary row. */
function formularyPatch(r: ClassificationResult, source: 'auto' | 'inherited') {
  return {
    schedule: r.schedule,
    scheduleSource: source,
    scheduleReason: r.reason,
    controlledClass: r.controlledClass,
    vaultControlled: r.vaultControlled,
    requiresQrScan: r.requiresQrScan,
    saltsJson: r.salts as unknown as object,
    classifiedAt: new Date(),
    classifierVersion: CLASSIFIER_VERSION,
  };
}

/**
 * Classify a freshly-created formulary row and write the result back.
 *
 * A catalog-linked drug INHERITS the platform decision, so the same product
 * never carries two different schedules in two hospitals. An own-formulary drug
 * is classified from its own composition.
 *
 * Never throws. Returns the patch that was applied, or null if nothing was.
 */
export async function classifyFormularyItem(
  formularyId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const row = await prisma.drugFormulary.findUnique({
      where: { id: formularyId },
      select: {
        id: true, drugName: true, genericName: true, composition: true,
        dosageForm: true, drugMasterId: true, scheduleSource: true,
        drugMaster: {
          select: {
            scheduleResolved: true, scheduleReason: true, controlledClass: true,
            vaultControlled: true, requiresQrScan: true, saltsJson: true,
          },
        },
      },
    });
    if (!row) return null;
    // A pharmacist's override outranks the classifier, permanently.
    if (row.scheduleSource === 'manual') return null;

    const inherited = row.drugMasterId && row.drugMaster?.scheduleResolved;
    let patch: Record<string, unknown>;

    if (inherited) {
      const m = row.drugMaster!;
      patch = {
        schedule: m.scheduleResolved,
        scheduleSource: 'inherited',
        scheduleReason: m.scheduleReason ?? 'Inherited from the platform drug catalog.',
        controlledClass: m.controlledClass,
        vaultControlled: m.vaultControlled,
        requiresQrScan: m.requiresQrScan,
        saltsJson: m.saltsJson ?? undefined,
        classifiedAt: new Date(),
        classifierVersion: CLASSIFIER_VERSION,
      };
      // Inheriting a platform schedule says nothing about the local salt text,
      // so still derive the composition from this row's own generic name.
      if (!row.composition && row.genericName) {
        const salts = parseSalts(row.genericName);
        if (salts.length) patch.composition = salts.map((s) => s.raw).join(' + ');
      }
    } else {
      const result = await classifyDrug({
        brandName: row.drugName,
        genericName: row.genericName,
        composition: row.composition,
        dosageForm: row.dosageForm,
      });
      if (!result) return null;
      patch = formularyPatch(result, 'auto');
      // Backfill the composition column while we have the parsed salts, but
      // never overwrite a value the pharmacist entered.
      if (!row.composition && result.composition) {
        (patch as Record<string, unknown>).composition = result.composition;
      }
    }

    await prisma.drugFormulary.update({ where: { id: formularyId }, data: patch as never });
    return patch;
  } catch (err) {
    // A label must never be the reason a drug cannot be added.
    logger.warn({ err, formularyId }, 'Schedule classification failed; drug left unclassified');
    return null;
  }
}

/**
 * Classify many formulary rows at once (bulk catalog import).
 *
 * Runs sequentially rather than in parallel: this is a background nicety on an
 * operation the user has already been told succeeded, and hammering the pool
 * with N concurrent updates would compete with live traffic.
 */
export async function classifyFormularyItems(ids: string[]): Promise<void> {
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await classifyFormularyItem(id);
  }
}

/**
 * Precomputed fields for a formulary row about to be created from a catalog
 * drug, so a bulk `createMany` can carry the schedule in its initial insert
 * instead of needing a second pass. Safe on a catalog row that was never
 * classified — it simply returns nothing to write.
 */
export function inheritedScheduleFields(master: {
  scheduleResolved?: string | null;
  scheduleReason?: string | null;
  controlledClass?: string | null;
  vaultControlled?: boolean | null;
  requiresQrScan?: boolean | null;
}): Record<string, unknown> {
  if (!master?.scheduleResolved) return {};
  return {
    schedule: master.scheduleResolved,
    scheduleSource: 'inherited',
    scheduleReason: master.scheduleReason ?? 'Inherited from the platform drug catalog.',
    controlledClass: master.controlledClass ?? null,
    vaultControlled: master.vaultControlled ?? false,
    requiresQrScan: master.requiresQrScan ?? false,
    classifiedAt: new Date(),
    classifierVersion: CLASSIFIER_VERSION,
  };
}

/**
 * A pharmacy admin's manual override. Marked `manual` so no re-run of the
 * classifier or the backfill can ever undo it.
 */
export async function overrideFormularySchedule(
  tenantId: string,
  formularyId: string,
  userId: string,
  data: { schedule: string; reason?: string | null },
) {
  const row = await prisma.drugFormulary.findFirst({
    where: { id: formularyId, tenantId },
    select: { id: true, drugName: true, schedule: true },
  });
  if (!row) return null;
  const updated = await prisma.drugFormulary.update({
    where: { id: formularyId },
    data: {
      schedule: data.schedule,
      scheduleSource: 'manual',
      scheduleReason:
        data.reason?.trim() ||
        `Manually set to Schedule ${data.schedule} by a pharmacy administrator.`,
      scheduleOverriddenById: userId,
      scheduleOverriddenAt: new Date(),
      classifierVersion: CLASSIFIER_VERSION,
    },
  });
  logger.info(
    { tenantId, formularyId, from: row.schedule, to: data.schedule, userId },
    'Drug schedule manually overridden',
  );
  return updated;
}
