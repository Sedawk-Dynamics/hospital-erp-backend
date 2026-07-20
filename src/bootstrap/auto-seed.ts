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
import { seedFormTemplates } from '../seeds/form-templates';
import { seedPhysicalObservations } from '../seeds/physical-observations';
import { seedIcdCodes } from '../seeds/icd-codes';
import { seedDrugMaster } from '../seeds/drug-master';
import { seedPackSizes } from '../seeds/pack-sizes';
import { seedPackPrices } from '../seeds/pack-prices';
import { seedImagingModalities } from '../seeds/imaging-modalities';
import { seedHsnGstRates } from '../seeds/hsn-gst-rates';

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
  await step('form-templates', () => seedFormTemplates(db));
  await step('physical-observations', () => seedPhysicalObservations(db));

  // 3. ICD-10 catalog — a few thousand rows; seed once, then skip.
  const icdCount = await db.icdCode.count({ where: { tenantId: null } });
  if (icdCount === 0) {
    await step('icd-codes', () => seedIcdCodes(db));
  } else {
    logger.info(`[auto-seed] ↷ icd-codes skipped (${icdCount} present)`);
  }

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
