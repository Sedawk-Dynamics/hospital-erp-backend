/**
 * Structured-composition check, against the real database.
 *
 * Covers the path a drug now takes when someone types its molecules into the
 * form instead of a sentence: create from salts, edit one strength, a molecule
 * nobody has recorded, and the text-only path that bulk imports still use.
 *
 *   npm run db:check-composition        (no server needed — calls the service)
 *
 * Creates its own fixtures, tagged STRUCT-<timestamp>, and deletes them.
 */
import { PrismaClient } from '@prisma/client';
import { createDrugMaster, updateDrugMaster } from '../../src/modules/drug-master/drug-master.service';

async function main() {
  const p = new PrismaClient();
  const TAG = `STRUCT-${Date.now()}`;
  const ADMIN = ['super_admin'];
  let pass = 0, fail = 0;
  const ck = (n: string, ok: boolean, d = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`);
    ok ? pass++ : fail++;
  };

  const dump = async (id: string) => {
    const [m]: any[] = await p.$queryRawUnsafe(
      `SELECT salt_composition AS c, schedule_resolved AS s FROM drug_master WHERE id=$1`, id);
    const links: any[] = await p.$queryRawUnsafe(
      `SELECT s.name AS salt, COALESCE(s.schedule_code,'undecided') AS sc,
              ds.strength_value AS v, ds.strength_unit AS u
       FROM drug_salts ds JOIN salts s ON s.id=ds.salt_id
       WHERE ds.drug_master_id=$1 ORDER BY ds.position`, id);
    return { m, links };
  };

  // ── 1. Create from STRUCTURED input — no text sent at all ──
  const created: any = await createDrugMaster(ADMIN, 'u1', {
    name: `${TAG} Combi`,
    salts: [
      { name: 'Ibuprofen', strengthValue: 400, strengthUnit: 'mg' },
      { name: 'Paracetamol', strengthValue: 325, strengthUnit: 'mg' },
    ],
  } as never);
  const a = await dump(created.id);
  console.log('\n--- created from structured salts (no text sent) ---');
  console.log('  composition rendered:', a.m.c);
  for (const l of a.links) console.log(`     ${l.salt} ${l.v}${l.u} (${l.sc})`);
  ck('text rendered from the rows', a.m.c === 'Ibuprofen (400mg) + Paracetamol (325mg)', a.m.c);
  ck('both molecules linked', a.links.length === 2);
  ck('strength stored as a number + unit', Number(a.links[0].v) === 400 && a.links[0].u === 'mg');
  ck('schedule derived from the molecules', a.m.s === 'H', `resolved ${a.m.s}`);

  // ── 2. Edit one strength — the rest must survive ──
  const edited: any = await updateDrugMaster(ADMIN, created.id, {
    salts: [
      { name: 'Ibuprofen', strengthValue: 200, strengthUnit: 'mg' },
      { name: 'Paracetamol', strengthValue: 325, strengthUnit: 'mg' },
    ],
  } as never);
  const b = await dump(edited.id);
  ck('edit rewrites the text from the rows', b.m.c === 'Ibuprofen (200mg) + Paracetamol (325mg)', b.m.c);
  ck('edit keeps both links', b.links.length === 2);
  ck('edit keeps the schedule', b.m.s === 'H', `resolved ${b.m.s}`);

  // ── 3. A molecule nobody knows, sent structurally ──
  const novel: any = await createDrugMaster(ADMIN, 'u1', {
    name: `${TAG} Novel`,
    salts: [
      { name: 'Paracetamol', strengthValue: 500, strengthUnit: 'mg' },
      { name: 'Qwertyzine', strengthValue: 10, strengthUnit: 'mg' },
    ],
  } as never);
  const c = await dump(novel.id);
  console.log('\n--- unknown molecule, sent structurally ---');
  console.log('  composition:', c.m.c);
  for (const l of c.links) console.log(`     ${l.salt} ${l.v}${l.u} (${l.sc})`);
  ck('the unknown molecule is kept in the composition', /Qwertyzine/.test(c.m.c ?? ''));
  ck('it is linked, not dropped', c.links.length === 2);
  ck('it lands in the review queue as undecided',
    c.links.some((l: any) => l.salt === 'Qwertyzine' && l.sc === 'undecided'));

  // ── 4. The TEXT path still works (bulk imports, old clients) ──
  const legacy: any = await createDrugMaster(ADMIN, 'u1', {
    name: `${TAG} Legacy`,
    genericName: 'Tramadol (50mg) + Paracetamol (325mg)',
  } as never);
  const d = await dump(legacy.id);
  ck('text-only create still classifies', d.m.s === 'H1', `resolved ${d.m.s}`);
  ck('text-only create still links molecules', d.links.length === 2);

  // cleanup
  const ids = [created.id, novel.id, legacy.id];
  await p.$executeRawUnsafe(
    `DELETE FROM drug_salts WHERE drug_master_id = ANY($1::text[])`, ids);
  await p.drugMaster.deleteMany({ where: { name: { startsWith: TAG } } });
  await p.$executeRawUnsafe(`DELETE FROM salts WHERE norm = 'qwertyzine'`);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail ? 1 : 0);
}
main();
