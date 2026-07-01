/**
 * Manual "seed everything" entry point: `npm run db:seed:all`.
 *
 * Runs the same ordered, idempotent pipeline the server runs automatically on
 * boot (src/bootstrap/auto-seed.ts) but without the AUTO_SEED gate or advisory
 * lock — handy for provisioning a fresh dev/staging database from the CLI.
 */
import 'dotenv/config';
import { prisma } from '../config/database';
import { runSeeds } from '../bootstrap/auto-seed';

runSeeds(prisma)
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
