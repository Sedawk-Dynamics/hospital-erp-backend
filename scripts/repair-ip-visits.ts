import { prisma } from '../src/config/database';

// Existing 'admitted' patients whose visit was never normalised to an active
// IP encounter (the acceptAdmissionRequest bug) — the IP workspace can't find
// their visit, so doctor writes fail. Report, then repair.
async function main() {
  const admitted = await prisma.admission.findMany({
    where: { status: 'admitted' },
    select: {
      id: true,
      patientId: true,
      visitId: true,
      visit: { select: { id: true, visitType: true, status: true } },
      patient: { select: { firstName: true, lastName: true } },
    },
  });

  const broken = admitted.filter((a) => a.visit && (a.visit.visitType !== 'ip' || a.visit.status !== 'active'));
  console.log(`admitted total: ${admitted.length} | broken (visit not ip+active): ${broken.length}`);
  for (const a of broken) {
    console.log(`  admission ${a.id} · ${a.patient.firstName} ${a.patient.lastName} · visit ${a.visit!.id} type=${a.visit!.visitType} status=${a.visit!.status}`);
  }

  const doRepair = process.argv.includes('--fix');
  if (!doRepair) { console.log('\n(dry run — pass --fix to repair)'); return; }

  let fixed = 0;
  for (const a of broken) {
    await prisma.visit.update({ where: { id: a.visit!.id }, data: { visitType: 'ip', status: 'active' } });
    fixed++;
  }
  console.log(`\nRepaired ${fixed} visit(s) → visitType 'ip', status 'active'.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
