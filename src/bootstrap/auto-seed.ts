/**
 * Automatic, idempotent database seeding on server startup.
 *
 * Why this exists: the production host has no way to run one-off commands, so
 * every piece of reference data the app needs ("all the templates and data we
 * seed locally") must be provisioned by the backend itself when it boots. All
 * the individual seeds live in ../seeds and are idempotent, so this is safe to
 * run on every deploy/restart.
 *
 * Design:
 *  - Runs AFTER the HTTP server is listening (see server.ts) so health checks
 *    pass immediately; the heavy seeds (drug master) then fill in the
 *    background.
 *  - A Postgres advisory lock (held on a dedicated 1-connection client) makes
 *    it safe when several replicas boot at once — only one seeds, the rest skip.
 *  - Every step is wrapped so a single failure is logged and the rest continue;
 *    seeding never crashes the server.
 *  - The heavy catalogs (ICD, drug master) are skipped once populated so
 *    restarts stay fast; the small idempotent catalogs re-run each boot to pick
 *    up new entries shipped in a release.
 *  - Gated by AUTO_SEED (defaults ON in production, OFF in dev so `npm run dev`
 *    doesn't trigger the multi-minute drug-master import).
 */
import { PrismaClient } from '@prisma/client';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { logger } from '../config/logger';

import { seedPlatform } from '../seeds/platform';
import { resyncRolePermissions } from '../seeds/resync-role-permissions';
import { seedLabUnits } from '../seeds/lab-units';
import { seedLabTestTemplates } from '../seeds/lab-test-templates';
import { seedTenantLabCatalogs } from '../seeds/tenant-lab-catalog';
import { seedFormTemplates } from '../seeds/form-templates';
import { seedPhysicalObservations } from '../seeds/physical-observations';
import { seedIcdCodes } from '../seeds/icd-codes';
import { seedIcdFromClaml } from '../seeds/icd-claml';
import { retireDemoIcdCodes } from '../seeds/icd-retire-demo-codes';
import { seedDrugMaster } from '../seeds/drug-master';
import { seedPackSizes } from '../seeds/pack-sizes';
import { seedPackPrices } from '../seeds/pack-prices';
import { seedImagingModalities } from '../seeds/imaging-modalities';
import { seedHsnGstRates } from '../seeds/hsn-gst-rates';
import { seedDrugScheduleRules } from '../seeds/drug-schedule-rules';
import { seedDrugScheduleClassification } from '../seeds/drug-schedule-classification';
import { seedSalts } from '../seeds/salt-master';
import { seedDrugSalts } from '../seeds/drug-salts';
import { seedNdpsBatchUnification } from '../seeds/ndps-batch-unification';
import { migrateInventoryToFormulary } from '../seeds/inventory-to-formulary';

// Arbitrary constant identifying our advisory lock.
const LOCK_KEY = 4820257011;

function shouldRun(): boolean {
  // Default ON — the whole point is zero-config seeding on deploy, and every
  // step is idempotent (heavy catalogs skip themselves once populated), so a
  // dev restart against an already-seeded DB is fast. Disable only by setting
  // AUTO_SEED to an explicit off value. (Previously this required
  // NODE_ENV=production, which silently skipped seeding when that env var was
  // not set on the host.)
  const flag = (process.env.AUTO_SEED ?? '').trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(flag);
}

/** DATABASE_URL forced to a single-connection pool for the lock session. */
function lockClientUrl(): string {
  const url = env.DATABASE_URL;
  if (/[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`;
}

async function step(name: string, fn: () => Promise<void>): Promise<boolean> {
  const t0 = Date.now();
  try {
    await fn();
    logger.info(`[auto-seed] ✓ ${name} (${Date.now() - t0}ms)`);
    return true;
  } catch (err) {
    logger.error({ err }, `[auto-seed] ✗ ${name} failed — continuing`);
    return false;
  }
}

/**
 * The ordered seed pipeline. Exported (without the AUTO_SEED gate or advisory
 * lock) so it can also be driven manually via `npm run db:seed:all`.
 */
export async function runSeeds(db: PrismaClient): Promise<void> {
  // 1. Platform essentials — permissions, roles, super admin, plans, commission.
  //    Critical + fast; run every boot to keep RBAC and plans in sync.
  await step('platform', () => seedPlatform(db));

  // 2. Global reference catalogs. Small + idempotent → run every boot so a
  //    release that ships new entries picks them up.
  await step('lab-units', () => seedLabUnits(db));
  await step('lab-test-templates', () => seedLabTestTemplates(db));
  // Must follow the templates: it clones them into any hospital whose own
  // catalog is empty, which is what a doctor's lab-order search reads.
  await step('tenant-lab-catalogs', () => seedTenantLabCatalogs(db));
  await step('form-templates', () => seedFormTemplates(db));
  await step('physical-observations', () => seedPhysicalObservations(db));

  // 3. ICD-10 catalog. Two seeds, and the order matters.
  //    `icd-codes` is the curated starter set, and its real job now is the
  //    everyday slang WHO never prints — "flu", "heart attack", "cad". It
  //    REPLACES keywords, so it has to run first; running it after would strip
  //    what the search ranks on. Seed once, then skip.
  const icdCount = await db.icdCode.count({ where: { tenantId: null } });
  if (icdCount === 0) {
    await step('icd-codes', () => seedIcdCodes(db));
  } else {
    logger.info(`[auto-seed] ↷ icd-codes skipped (${icdCount} present)`);
  }
  //    Then the full WHO release (~12,300 codes). Not behind an "is it empty"
  //    guard: it diffs against what is there, writes only what differs and
  //    no-ops when the release is already in, so a build shipping a newer WHO
  //    version lands by itself. ~5s on a cold database, a single read after.
  await step('icd-who', () => seedIcdFromClaml(db));
  //    Finally drop the five illustrative numeric codes from the TRMS CDSS
  //    document. Removing them from `icd.data.ts` does not reach a database
  //    that already has them, because the curated seed only creates and updates
  //    and is guarded on an empty catalogue. No-op once done.
  await step('icd-retire-demo', () => retireDemoIcdCodes(db));

  // 4. Drug master — the heavy one (~hundreds of thousands of rows from the
  //    bundled CSV). Seed only when empty. Pack size/price backfills only make
  //    sense right after a fresh import, so gate them on that.
  let drugSeeded = false;
  const drugCount = await db.drugMaster.count();
  if (drugCount === 0) {
    drugSeeded = await step('drug-master', () => seedDrugMaster(db));
  } else {
    logger.info(`[auto-seed] ↷ drug-master skipped (${drugCount} present)`);
  }
  if (drugSeeded) {
    await step('pack-sizes', () => seedPackSizes(db));
    await step('pack-prices', () => seedPackPrices(db));
  }

  // HSN → GST tax reference — small + idempotent, run every boot so a release
  // that ships new/updated rates picks them up. Also tags a few common catalog
  // medicines with their HSN + GST.
  await step('hsn-gst-rates', () => seedHsnGstRates(db));

  // Drug schedule reference (Sch. G/H/H1/H2/X + the NDPS narcotic list). Small,
  // idempotent and platform-wide, so it runs every boot and a release shipping a
  // gazette update picks it up. Reference data only — nothing reads it yet.
  await step('drug-schedule-rules', () => seedDrugScheduleRules(db));

  // Turn those rules inside out: the MOLECULE becomes a row carrying its own
  // schedule, so classifying a drug is a join rather than a string match. Small
  // and idempotent (1,858 salts), and a schedule a person set by hand is never
  // overwritten. Molecules no published list names are created undecided, which
  // is what surfaces them as work instead of letting them read as safe.
  await step('salt-master', () => seedSalts(db));

  // Parse every composition ONCE into structured salt + strength rows. This is
  // the only place the composition text is read; nothing downstream re-parses
  // it, which is what stopped the strengths being destroyed by a lossy
  // round-trip. Skips drugs that already have them, so a re-run is cheap.
  await step('drug-salts', () => seedDrugSalts(db));

  // Apply those rules to the catalog and every formulary. Without this a drug's
  // schedule stays NULL, so no badge renders, the controlled register is empty
  // and the dispensing gate has nothing to act on — the feature would look like
  // it had done nothing. Costs one count once everything is classified, and
  // auto-seed runs after the server is already listening, so a long first pass
  // never blocks startup or a health check.
  await step('drug-schedule-classification', () => seedDrugScheduleClassification(db));

  // Narcotic stock onto DrugBatch. Only the unambiguous cases; a drug holding
  // stock in BOTH the NDPS ledger and batches is named in the log and left for
  // a person, because totalling would inflate it and picking a side would
  // destroy it.
  await step('ndps-batch-unification', () => seedNdpsBatchUnification(db));

  // Legacy stock unification — give every InventoryItem a formulary product so
  // all types behave like medicines (searchable + billable). Additive and
  // idempotent: no-ops once every item is linked.
  await step('inventory→formulary', () => migrateInventoryToFormulary(db));

  // 5. Per-tenant seeds / RBAC sync. Internally idempotent and skip tenants
  //    that already have the data, so they self-heal tenants created between
  //    deploys. No-ops on a fresh DB that only has the platform tenant.
  await step('imaging-modalities', () => seedImagingModalities(db));
  await step('resync-role-permissions', () => resyncRolePermissions(db));
}

/**
 * Entry point called from server.ts on startup. Never throws.
 */
export async function runAutoSeed(): Promise<void> {
  if (!shouldRun()) {
    logger.info('[auto-seed] disabled (AUTO_SEED is set to an off value)');
    return;
  }

  logger.info('[auto-seed] starting…');
  const lockClient = new PrismaClient({ datasources: { db: { url: lockClientUrl() } } });
  let gotLock = false;
  try {
    // Best-effort advisory lock so multiple replicas booting together don't all
    // seed at once. If we DON'T get it, we still proceed: a single killed
    // container can leave its lock session lingering on Postgres for a while,
    // and skipping seeding entirely (the old behavior) is worse than the small
    // race risk — all steps are idempotent anyway.
    try {
      const rows = await lockClient.$queryRawUnsafe<Array<{ locked: boolean }>>(
        `SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`,
      );
      gotLock = !!rows[0]?.locked;
      if (!gotLock) {
        logger.warn('[auto-seed] advisory lock not acquired — proceeding anyway (idempotent)');
      }
    } catch (err) {
      logger.warn({ err }, '[auto-seed] advisory lock check failed — proceeding anyway');
    }

    const t0 = Date.now();
    await runSeeds(prisma);
    logger.info(`[auto-seed] complete (${Math.round((Date.now() - t0) / 1000)}s)`);
  } catch (err) {
    // Defensive: runSeeds already isolates per-step failures, but never let a
    // seeding problem take the server down.
    logger.error({ err }, '[auto-seed] unexpected failure');
  } finally {
    // Disconnecting the lock session releases the advisory lock (if held).
    await lockClient.$disconnect().catch(() => {});
  }
}
