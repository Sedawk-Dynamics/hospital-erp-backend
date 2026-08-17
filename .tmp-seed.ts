import { PrismaClient } from '@prisma/client';
import { seedSaltMaster } from './src/seeds/salt-master';
async function main() {
  const p = new PrismaClient();
  const t0 = Number(process.env.T0 ?? 0);
  const t = await seedSaltMaster(p);
  console.log('totals:', t);
  const [c]: any[] = await p.$queryRawUnsafe(
    `SELECT COUNT(*)::int total,
            COUNT(*) FILTER (WHERE schedule_code IS NULL)::int undecided,
            COUNT(*) FILTER (WHERE source='cdsco')::int cdsco,
            COUNT(*) FILTER (WHERE source='class')::int cls,
            COUNT(*) FILTER (WHERE source='ndps')::int ndps
     FROM salts`);
  console.log('salts:', c);
  const dist: any[] = await p.$queryRawUnsafe(
    `SELECT COALESCE(schedule_code,'(undecided)') s, COUNT(*)::int n FROM salts GROUP BY 1 ORDER BY 2 DESC`);
  console.log('by schedule:', dist.map((r) => `${r.s}=${r.n}`).join('  '));
  const [syn]: any[] = await p.$queryRawUnsafe(`SELECT COUNT(*)::int n FROM salt_synonyms`);
  const [cl]: any[] = await p.$queryRawUnsafe(`SELECT COUNT(*)::int n FROM therapeutic_classes`);
  console.log(`synonyms: ${syn.n}   classes: ${cl.n}`);
  await p.$disconnect();
}
main();
