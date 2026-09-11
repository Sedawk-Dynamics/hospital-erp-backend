import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { ensureBundledRelease } from '../modules/drug-master/drug-catalog.release';
import { seedSalts } from './salt-master';
import { seedDrugSalts } from './drug-salts';
import { seedDrugScheduleClassification } from './drug-schedule-classification';

/**
 * The platform drug catalogue: bring the database up to the vendor release
 * bundled with this build (prisma/scripts/data/drug-catalog).
 *
 *   npm run db:seed:drug-master             # apply the bundled release, if not yet
 *   npm run db:seed:drug-master -- --force  # re-apply it (only changed rows move)
 *
 * Costs one query when the release is already in. Otherwise it imports it,
 * re-points hospital formulary rows imported from the old open dataset at the
 * same products, and removes the old rows — see drug-catalog.release.ts.
 *
 * Run from the CLI, it then does what the auto-seed's later steps would: new
 * molecules into the salt master, compositions into salt links, schedules.
 */

/** Returns true when a release was applied. */
export async function seedDrugMaster(
  client?: PrismaClient,
  opts: { force?: boolean; log?: (m: string) => void } = {},
): Promise<boolean> {
  const owns = !client;
  const prisma = client ?? new PrismaClient();
  try {
    return (await ensureBundledRelease(prisma, opts)) !== null;
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

/**
 * What has to follow any write to the catalogue. The auto-seed runs these as
 * steps of their own; a refresh from the super-admin screen and the CLI call
 * this. Each is idempotent and cheap once there is nothing left to do.
 */
export async function runCatalogFollowUps(db: PrismaClient): Promise<void> {
  await seedSalts(db);
  await seedDrugSalts(db);
  await seedDrugScheduleClassification(db);
}

if (require.main === module) {
  const prisma = new PrismaClient();
  const log = (m: string) => console.log(m); // eslint-disable-line no-console
  seedDrugMaster(prisma, { force: process.argv.includes('--force'), log })
    .then(async (applied) => {
      log(applied ? 'Release applied — updating salts and schedules…' : 'Catalogue already at the bundled release.');
      if (applied || process.argv.includes('--follow-ups')) await runCatalogFollowUps(prisma);
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (e) => {
      console.error(e); // eslint-disable-line no-console
      await prisma.$disconnect();
      process.exit(1);
    });
}
