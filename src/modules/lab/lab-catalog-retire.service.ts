// Gap 369: keep one test, retire its near-duplicate. The duplicate is switched
// off, never deleted: every past order, result and report still points at it.
import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { writeAudit } from '../../shared/audit';
import { findCatalogIssues } from './lab-catalog-quality';
import { buildSearchTokens, normaliseAliases } from './lab-templates.service';
import { formatRange, liveRanges, normaliseUnit, paramRange, rangeNameKey, rawParams } from './lab-range';
import type { ParameterSpec } from './lab.validation';

const RETIRE_ROLES = new Set(['admin', 'super_admin', 'lab_supervisor', 'pathologist']);

export function assertCanRetire(roles: string[]): void {
  const keys = roles.map((r) => r.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  if (!keys.some((r) => RETIRE_ROLES.has(r))) {
    throw AppError.forbidden('Only a hospital admin or lab supervisor can retire a lab test');
  }
}

const SELECT = {
  id: true,
  testName: true,
  testCode: true,
  sampleType: true,
  specimen: true,
  unit: true,
  normalRange: true,
  price: true,
  parameters: true,
  aliases: true,
  tags: true,
  isActive: true,
  replacedByTestId: true,
} as const;

/** Schema cap on aliases per test. */
const MAX_ALIASES = 25;

type Row = {
  testName: string;
  testCode: string | null;
  sampleType: string | null;
  specimen: string | null;
  unit: string | null;
  normalRange: string | null;
  parameters: unknown;
};

/**
 * Clinical differences: anything that means the two are not the same test.
 * These block a retirement until someone confirms them with a reason.
 */
export function clinicalDifferences(keep: Row, retire: Row): string[] {
  const out: string[] = [];
  const text = (v: string | null) => (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (text(keep.sampleType) !== text(retire.sampleType)) {
    out.push(`Sample type: ${keep.sampleType || 'not set'} (kept) / ${retire.sampleType || 'not set'} (retired)`);
  }
  if (text(keep.specimen) !== text(retire.specimen)) {
    out.push(`Specimen: ${keep.specimen || 'not set'} (kept) / ${retire.specimen || 'not set'} (retired)`);
  }
  if (normaliseUnit(keep.unit) !== normaliseUnit(retire.unit)) {
    out.push(`Unit: ${keep.unit || 'not set'} (kept) / ${retire.unit || 'not set'} (retired)`);
  }
  const units = (r: Row) =>
    new Map(
      rawParams(r.parameters).map((p) => [
        rangeNameKey(p.name),
        { name: String(p.name ?? ''), unit: paramRange(p).unit },
      ]),
    );
  const a = units(keep);
  const b = units(retire);
  for (const [key, p] of b) {
    const other = a.get(key);
    if (!other) out.push(`${p.name} is measured only by the test being retired`);
    else if (normaliseUnit(other.unit) !== normaliseUnit(p.unit)) {
      out.push(`${p.name} unit: ${other.unit || 'not set'} (kept) / ${p.unit || 'not set'} (retired)`);
    }
  }
  for (const [key, p] of a) {
    if (!b.has(key)) out.push(`${p.name} is measured only by the test being kept`);
  }
  return out;
}

async function load(tenantId: string, id: string) {
  const row = await prisma.labTestCatalog.findFirst({ where: { id, tenantId }, select: SELECT });
  if (!row) throw AppError.notFound('Lab test not found');
  return row;
}

async function findReferences(tenantId: string, test: Awaited<ReturnType<typeof load>>) {
  const same = { equals: test.testName, mode: 'insensitive' as const };
  const named = (code: string, name: string) => [
    { [name]: same },
    ...(test.testCode ? [{ [code]: { equals: test.testCode, mode: 'insensitive' as const } }] : []),
  ];
  const [orderItems, openOrderItems, pendingRanges, serviceRates, packageRates, tariffs] = await Promise.all([
    prisma.labOrderItem.count({ where: { testId: test.id, labOrder: { tenantId } } }),
    prisma.labOrderItem.count({
      where: { testId: test.id, labOrder: { tenantId }, status: { notIn: ['completed', 'cancelled'] } },
    }),
    prisma.labRangeProposal.count({ where: { tenantId, testId: test.id, status: 'pending' } }),
    prisma.payerServiceRate.findMany({
      where: { contract: { tenantId }, OR: named('serviceCode', 'serviceName') },
      select: { id: true, serviceCode: true, serviceName: true },
      take: 50,
    }),
    prisma.payerPackageRate.findMany({
      where: { contract: { tenantId } },
      select: { id: true, packageCode: true, packageName: true, inclusions: true },
      take: 500,
    }),
    prisma.serviceTariff.findMany({
      where: { tenantId, OR: named('serviceCode', 'serviceName') },
      select: { id: true, serviceCode: true, serviceName: true },
      take: 50,
    }),
  ]);
  const needle = test.testName.toLowerCase();
  const packages = packageRates.filter(
    (p) =>
      p.packageName.toLowerCase() === needle ||
      (p.inclusions != null && JSON.stringify(p.inclusions).toLowerCase().includes(needle)),
  );
  return {
    orderItems,
    openOrderItems,
    pendingRanges,
    // These match by NAME or CODE, not by a link, so nothing here can be
    // re-pointed safely: they are listed for a person to change.
    needsAttention: [
      ...serviceRates.map((r) => ({ kind: 'Payer rate', label: `${r.serviceName} (${r.serviceCode})` })),
      ...packages.map((r) => ({ kind: 'Payer package', label: `${r.packageName} (${r.packageCode})` })),
      ...tariffs.map((r) => ({
        kind: 'Service tariff',
        label: r.serviceCode ? `${r.serviceName} (${r.serviceCode})` : r.serviceName,
      })),
    ],
  };
}

const brief = (t: Awaited<ReturnType<typeof load>>) => ({
  id: t.id,
  testName: t.testName,
  testCode: t.testCode,
  sampleType: t.sampleType,
  specimen: t.specimen,
  unit: t.unit,
  price: t.price,
  isActive: t.isActive,
  ranges: liveRanges(t).map((r) => ({ name: r.name, unit: r.unit, rangeText: formatRange(r) })),
});

export async function previewRetire(tenantId: string, roles: string[], retireId: string, keepId: string) {
  assertCanRetire(roles);
  if (retireId === keepId) throw AppError.badRequest('Choose two different tests');
  const [retire, keep] = [await load(tenantId, retireId), await load(tenantId, keepId)];
  return {
    retire: brief(retire),
    keep: brief(keep),
    differences: clinicalDifferences(keep, retire),
    references: await findReferences(tenantId, retire),
  };
}

export async function retireDuplicate(
  tenantId: string,
  userId: string,
  roles: string[],
  retireId: string,
  input: { keepTestId: string; reason?: string | null; confirmDifferences?: boolean },
) {
  assertCanRetire(roles);
  if (retireId === input.keepTestId) throw AppError.badRequest('Choose two different tests');
  const [retire, keep] = [await load(tenantId, retireId), await load(tenantId, input.keepTestId)];
  if (!retire.isActive) throw AppError.conflict('This test is already inactive', 'TEST_ALREADY_RETIRED');
  if (!keep.isActive) throw AppError.conflict('The test to keep is inactive. Choose an active one.', 'KEEP_INACTIVE');

  const reason = input.reason?.trim() ?? '';
  const differences = clinicalDifferences(keep, retire);
  if (differences.length > 0 && (!input.confirmDifferences || reason.length < 5)) {
    throw AppError.conflict(
      `These tests are not identical: ${differences.join('; ')}. Confirm with a reason to retire ${retire.testName} anyway.`,
      'TESTS_DIFFER',
      { differences },
    );
  }

  const references = await findReferences(tenantId, retire);
  // Someone searching for the old name finds the kept test. Doctors order from
  // search, so this is what points NEW orders at it.
  const aliases = normaliseAliases([
    ...keep.aliases,
    ...(rangeNameKey(retire.testName) === rangeNameKey(keep.testName) ? [] : [retire.testName]),
    ...retire.aliases,
  ].map((a) => a.slice(0, 120))).slice(0, MAX_ALIASES);

  await prisma.$transaction(async (tx) => {
    // Lock the kept row first: two people retiring each into the other at once
    // must not leave the hospital with neither.
    const kept = await tx.labTestCatalog.updateMany({
      where: { id: keep.id, tenantId, isActive: true },
      data: {
        aliases,
        searchTokens: buildSearchTokens({
          name: keep.testName,
          code: keep.testCode,
          sampleType: keep.sampleType,
          aliases,
          tags: keep.tags,
          parameters: keep.parameters as unknown as ParameterSpec[] | null,
        }),
      },
    });
    if (kept.count !== 1) throw AppError.conflict('The test to keep was just made inactive', 'KEEP_INACTIVE');
    const done = await tx.labTestCatalog.updateMany({
      where: { id: retire.id, tenantId, isActive: true },
      data: {
        isActive: false,
        replacedByTestId: keep.id,
        retiredAt: new Date(),
        retiredById: userId,
        retireReason: reason || 'Duplicate',
      },
    });
    if (done.count !== 1) throw AppError.conflict('Someone else has just retired this test', 'TEST_ALREADY_RETIRED');
    // Anything already retired into this one now points at the survivor.
    await tx.labTestCatalog.updateMany({
      where: { tenantId, replacedByTestId: retire.id },
      data: { replacedByTestId: keep.id },
    });
  });

  await writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'lab_test_catalog',
    entityId: retire.id,
    description: `Lab test retired as a duplicate: ${retire.testName}, kept ${keep.testName}`,
    reason: reason || undefined,
    oldValues: { isActive: true },
    newValues: { isActive: false, replacedByTestId: keep.id, differences, openOrderItems: references.openOrderItems },
  });
  return { retiredId: retire.id, keptId: keep.id, differences, references };
}

/** Groups of active tests with near-identical names. */
export async function getDuplicateGroups(tenantId: string) {
  const rows = await prisma.labTestCatalog.findMany({ where: { tenantId, isActive: true }, select: SELECT });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return findCatalogIssues(rows)
    .filter((i) => i.kind === 'duplicate_name')
    .map((i) => ({ message: i.message, tests: i.testIds.map((id) => brief(byId.get(id)!)) }));
}
