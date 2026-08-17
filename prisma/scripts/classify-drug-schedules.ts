/**
 * Operator front-end for the drug schedule classification.
 *
 *   npm run db:classify-schedules -- --dry-run          report only, writes nothing
 *   npm run db:classify-schedules                       apply
 *   npm run db:classify-schedules -- --only=formulary   skip the platform catalog
 *   npm run db:classify-schedules -- --tenant=<id>      one hospital only
 *   npm run db:classify-schedules -- --force            re-do already-classified rows
 *
 * The classification itself runs automatically on every deploy (auto-seed step
 * `drug-schedule-classification`), so this is for the times you want to see the
 * distribution before committing to it, re-run after changing the rules, or
 * scope the work to one hospital. Both paths call the SAME implementation in
 * src/seeds/drug-schedule-classification.ts — there is no second copy to drift.
 *
 * Note: drug_master.schedule is deliberately never written. The old counter
 * compliance check read that column, so filling it would switch enforcement on
 * as a side effect of classifying. The classifier writes schedule_resolved.
 */

import 'dotenv/config';
import { prisma } from '../../src/config/database';
import {
  runClassification,
  type ClassificationOptions,
} from '../../src/seeds/drug-schedule-classification';
import type { ClassificationResult } from '../../src/modules/drug-master/drug-schedule.classifier';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => args.find((a) => a.startsWith(`${f}=`))?.split('=')[1];

const DRY = has('--dry-run');

interface Tally {
  total: number;
  schedule: Record<string, number>;
  controlled: Record<string, number>;
  needsReview: number;
  samples: Record<string, string[]>;
}

const newTally = (): Tally => ({ total: 0, schedule: {}, controlled: {}, needsReview: 0, samples: {} });

function record(t: Tally, r: ClassificationResult, label: string) {
  t.total += 1;
  t.schedule[r.schedule] = (t.schedule[r.schedule] ?? 0) + 1;
  if (r.controlledClass) {
    const key = `${r.controlledClass}${r.vaultControlled ? ' (vault)' : ''}`;
    t.controlled[key] = (t.controlled[key] ?? 0) + 1;
  }
  if (r.needsReview) t.needsReview += 1;
  const bucket = (t.samples[r.schedule] ??= []);
  if (bucket.length < 5) bucket.push(`${label} → ${r.reason}`);
}

function print(t: Tally, title: string, changed: number) {
  console.log(`\n===== ${title} — ${t.total} rows =====`);
  if (!t.total) return;
  for (const k of ['X', 'H1', 'H', 'H2', 'G', 'OTC']) {
    const n = t.schedule[k];
    if (!n) continue;
    console.log(`  ${k.padEnd(4)} ${String(n).padStart(7)}  ${((n / t.total) * 100).toFixed(1)}%`);
  }
  const ctrl = Object.entries(t.controlled);
  console.log(`  controlled: ${ctrl.length ? ctrl.map(([k, v]) => `${k}=${v}`).join(', ') : 'none'}`);
  if (t.needsReview) {
    console.log(`  ⚠ needs review: ${t.needsReview} (unreadable strength on a controlled molecule)`);
  }
  console.log(`  ${DRY ? 'would change' : 'changed'}: ${changed}`);
  for (const k of ['X', 'H1', 'H', 'H2', 'G', 'OTC']) {
    if (!t.samples[k]?.length) continue;
    console.log(`  --- ${k} ---`);
    for (const s of t.samples[k]) console.log(`      ${s.slice(0, 150)}`);
  }
}

async function main() {
  const master = newTally();
  const formulary = newTally();

  const opts: ClassificationOptions = {
    dryRun: DRY,
    force: has('--force'),
    tenantId: val('--tenant'),
    only: val('--only') as ClassificationOptions['only'],
    onRow: (r, label, table) => record(table === 'master' ? master : formulary, r, label),
    log: (m) => console.log(m),
  };

  console.log(DRY ? '*** DRY RUN — nothing will be written ***' : '*** APPLYING ***');
  const t = await runClassification(prisma, opts);

  if (opts.only !== 'formulary') print(master, 'DRUG MASTER (platform catalog)', t.masterChanged);
  if (opts.only !== 'master') print(formulary, 'DRUG FORMULARY (hospital stock)', t.formularyChanged);

  const manual = await prisma.drugFormulary.count({
    where: { ...(opts.tenantId ? { tenantId: opts.tenantId } : {}), scheduleSource: 'manual' },
  });
  if (manual) console.log(`\n  ${manual} drug(s) skipped — a pharmacist set their schedule by hand.`);

  console.log(
    '\nNote: drug_master.schedule is intentionally left untouched — the old counter ' +
      'compliance check read it, and enforcement is switched on separately.',
  );
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
