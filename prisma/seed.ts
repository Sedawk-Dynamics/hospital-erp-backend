// Thin wrapper kept at the path Prisma expects (package.json#prisma.seed and
// the Dockerfile's dist-seed build). The actual platform seed logic now lives
// in src/seeds/platform.ts so it can also be imported by the server's
// auto-seed-on-boot orchestrator (see src/bootstrap/auto-seed.ts).
import { seedPlatform } from '../src/seeds/platform';

seedPlatform()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  });
