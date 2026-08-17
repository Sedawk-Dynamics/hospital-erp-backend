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
import { classifyFromSalts } from './salt-classifier';
import { loadDrugSaltRows, resolveSaltRows, syncDrugSalts } from './salt-classification.service';
import {
  buildRuleIndex,
  classify,
  parseSalts,
  normaliseBrand,
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

/**
 * Classify one drug.
 *
 * Prefers the salt master: the molecules are already resolved and carry their
 * own schedules, so this is a join rather than a string match. The text
 * classifier remains as the fallback for the two cases the salt path cannot
 * answer — the salt master not seeded yet, and a composition containing a
 * molecule no salt row covers. Falling back is better than guessing, because a
 * molecule silently dropped from a composition is exactly how a scheduled drug
 * comes out over-the-counter.
 *
 * `drugMasterId` lets a catalog drug read its STORED molecules instead of
 * re-resolving text. Returns null if neither path can answer.
 */
export async function classifyDrug(
  input: ClassificationInput,
  opts: { drugMasterId?: string | null } = {},
): Promise<ClassificationResult | null> {
  const index = await getRuleIndex();

  const saltRows = opts.drugMasterId
    ? await loadDrugSaltRows(opts.drugMasterId)
    : await resolveSaltRows(input.composition?.trim() || input.genericName?.trim() || '');

  if (saltRows) {
    // Schedule H2 stays a brand-level fact — it is a property of the notified
    // formulation, not of any molecule, so it cannot live on a salt row.
    const brandRule = index?.byBrand.get(normaliseBrand(input.brandName));
    return classifyFromSalts(
      { brandName: input.brandName, dosageForm: input.dosageForm, route: input.route, salts: saltRows },
      { requiresQrScan: Boolean(brandRule), qrFormulation: brandRule?.matchValue ?? null },
    );
  }

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
 * The fields the classifier actually reads. Re-classification is skipped unless
 * one of them changed, so an ordinary price or stock edit costs nothing.
 */
export function affectsClassification(patch: Record<string, unknown>): boolean {
  return ['name', 'drugName', 'genericName', 'composition', 'saltComposition', 'dosageForm']
    .some((k) => k in patch);
}

/**
 * Classify a platform catalog drug. Called when a super admin adds or edits one,
 * so the catalog is never left holding a drug the system has an opinion about
 * but has not recorded.
 *
 * Writes scheduleResolved, never the legacy `schedule` column — the counter's
 * compliance check reads that one, so filling it would switch enforcement on.
 * Never throws: a label must not be the reason a drug cannot be saved.
 */
export async function classifyDrugMasterItem(
  id: string,
  opts: { refreshComposition?: boolean } = {},
): Promise<void> {
  try {
    const row = await prisma.drugMaster.findUnique({
      where: { id },
      select: { id: true, name: true, genericName: true, saltComposition: true, dosageForm: true },
    });
    if (!row) return;
    // The classifier prefers `composition` over `genericName`, and it fills
    // `saltComposition` itself when the column is blank. That combination bites
    // on a later edit: change the generic name from tramadol to morphine and
    // the composition it derived earlier still says "Tramadol", so the drug
    // keeps its old schedule. When the caller knows the generic name just
    // changed, the stored composition is ignored and re-derived from it.
    // Re-derive the structured molecules FIRST. This is the ingestion point for
    // a catalog drug, and the only place its composition text is parsed —
    // classification then reads the rows, not the string.
    await syncDrugSalts(id);

    const result = await classifyDrug(
      {
        brandName: row.name,
        genericName: row.genericName,
        composition: opts.refreshComposition ? null : row.saltComposition,
        dosageForm: row.dosageForm,
      },
      { drugMasterId: id },
    );
    if (!result) return;
    await prisma.drugMaster.update({
      where: { id },
      data: {
        scheduleResolved: result.schedule,
        scheduleReason: result.reason,
        controlledClass: result.controlledClass,
        vaultControlled: result.vaultControlled,
        requiresQrScan: result.requiresQrScan,
        saltsJson: result.salts as unknown as object,
        classifiedAt: new Date(),
        classifierVersion: CLASSIFIER_VERSION,
        ...(opts.refreshComposition || !row.saltComposition
          ? result.composition
            ? { saltComposition: result.composition }
            : {}
          : {}),
      },
    });
  } catch (err) {
    logger.warn({ err, drugMasterId: id }, 'Catalog schedule classification failed; drug left unclassified');
  }
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
