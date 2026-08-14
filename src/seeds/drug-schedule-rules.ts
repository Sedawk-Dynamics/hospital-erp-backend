/**
 * Seed the platform-wide drug schedule reference — the rules that let the
 * classifier answer "what schedule is this medicine, and is it controlled?".
 *
 * Source of truth: the CDSCO publication of the Drugs & Cosmetics Rules 1945
 * (Schedules G, H, H1, H2 and the Schedule-X list under the NDPS Act), plus the
 * hospital's NDPS narcotic/psychotropic list. The published PDF's text layer is
 * imperfect OCR, so the extracted names were hand-corrected against official INN
 * spellings before being written to src/seeds/data/drug-schedule-rules.json —
 * every correction is recorded in docs/NDPS_Scheduled_Drugs_Plan.md.
 *
 * Two independent axes live in this table and are deliberately NOT collapsed:
 *   scheduleCode    — what the counter must collect (Rx / register / Rx copy)
 *   controlledClass — which register and report the drug appears in
 * Tramadol is Schedule H1 (CDSCO) and a psychotropic (NDPS list): it dispenses
 * normally with an H1 register line and still appears in the controlled
 * register. One boolean cannot express that, which is why there are two fields.
 *
 * This seed is REFERENCE DATA ONLY. Nothing reads these rows yet — the
 * classifier lands in a later phase — so running it changes no behaviour.
 *
 * Idempotent: upserts on (scheduleCode, matchType, matchNorm), so re-running
 * refreshes a rule in place and never duplicates. Rows whose key disappears from
 * the fixture are deactivated rather than deleted, so a rule that once
 * classified a drug is never silently lost from the audit trail.
 *
 * Run with `npm run db:seed:drug-schedules`.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import RULES from './data/drug-schedule-rules.json';

let prisma!: PrismaClient;

interface RuleSeed {
  scheduleCode: string;
  matchType: string;
  matchValue: string;
  matchNorm: string;
  aliases?: string[];
  pattern?: string;
  controlledClass?: string;
  isNarcotic?: boolean;
  narcoticClass?: string;
  vaultControlled?: boolean;
  exemptIfCombination?: boolean;
  maxPerUnitMg?: number;
  maxConcentrationPercent?: number;
  fallbackSchedule?: string;
  topicalExempt?: boolean;
  notes?: string;
}

const dec = (n: number | undefined) =>
  n === undefined || n === null ? null : new Prisma.Decimal(n);

async function main(): Promise<void> {
  const rules = RULES as RuleSeed[];
  console.log(`=== drug schedule rules: ${rules.length} in fixture ===`);

  let created = 0;
  let updated = 0;
  const seenKeys: string[] = [];

  for (const r of rules) {
    const data = {
      matchValue: r.matchValue,
      aliases: r.aliases ?? [],
      pattern: r.pattern ?? null,
      controlledClass: r.controlledClass ?? null,
      isNarcotic: r.isNarcotic ?? false,
      narcoticClass: r.narcoticClass ?? null,
      vaultControlled: r.vaultControlled ?? false,
      exemptIfCombination: r.exemptIfCombination ?? false,
      maxPerUnitMg: dec(r.maxPerUnitMg),
      maxConcentrationPercent: dec(r.maxConcentrationPercent),
      fallbackSchedule: r.fallbackSchedule ?? null,
      topicalExempt: r.topicalExempt ?? false,
      notes: r.notes ?? null,
      isActive: true,
    };

    const existing = await prisma.drugScheduleRule.findUnique({
      where: {
        scheduleCode_matchType_matchNorm: {
          scheduleCode: r.scheduleCode,
          matchType: r.matchType,
          matchNorm: r.matchNorm,
        },
      },
      select: { id: true },
    });

    if (existing) {
      await prisma.drugScheduleRule.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await prisma.drugScheduleRule.create({
        data: {
          scheduleCode: r.scheduleCode,
          matchType: r.matchType,
          matchNorm: r.matchNorm,
          ...data,
        },
      });
      created += 1;
    }
    seenKeys.push(`${r.scheduleCode}|${r.matchType}|${r.matchNorm}`);
  }

  // Retire any rule no longer present in the fixture (e.g. a gazette repeal).
  // Deactivated, never deleted — an audit must still be able to explain why a
  // drug was classified the way it was last year.
  const live = await prisma.drugScheduleRule.findMany({
    where: { isActive: true },
    select: { id: true, scheduleCode: true, matchType: true, matchNorm: true },
  });
  const keep = new Set(seenKeys);
  const stale = live.filter(
    (x) => !keep.has(`${x.scheduleCode}|${x.matchType}|${x.matchNorm}`),
  );
  if (stale.length) {
    await prisma.drugScheduleRule.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: { isActive: false },
    });
  }

  const counts = await prisma.drugScheduleRule.groupBy({
    by: ['scheduleCode'],
    where: { isActive: true },
    _count: { _all: true },
  });
  console.log(`  created ${created}, updated ${updated}, deactivated ${stale.length}`);
  for (const c of counts.sort((a, b) => a.scheduleCode.localeCompare(b.scheduleCode))) {
    console.log(`  Schedule ${c.scheduleCode.padEnd(4)} ${c._count._all}`);
  }
  console.log('=== done ===');
}

export async function seedDrugScheduleRules(client?: PrismaClient): Promise<void> {
  const owns = !client;
  prisma = client ?? new PrismaClient();
  try {
    await main();
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedDrugScheduleRules()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
