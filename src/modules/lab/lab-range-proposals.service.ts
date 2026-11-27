// Gap 369: reference-range proposals, pathologist approval and sign-off status.
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { writeAudit } from '../../shared/audit';
import { isPlaceholderText } from './lab-catalog-quality';
import { suggestRange } from './lab-range-ai';
import {
  applyRangeToTest,
  formatRange,
  hasRange,
  liveRangeFor,
  liveRanges,
  qualifierProblem,
  qualifiersToText,
  rangeHash,
  rangeNameKey,
  rangeProblem,
  sameValues,
  snapshotRange,
  type LiveRange,
  type ProposalDraft,
  type RangeQualifier,
  type RangeValues,
} from './lab-range';

type Db = Prisma.TransactionClient | typeof prisma;

export type RangeOrigin =
  | 'ai_suggest'
  | 'manual'
  | 'test_create'
  | 'test_edit'
  | 'template'
  | 'import'
  | 'confirm_current';

const TEST_SELECT = {
  id: true,
  testName: true,
  testCode: true,
  sampleType: true,
  specimen: true,
  normalRange: true,
  unit: true,
  parameters: true,
  isActive: true,
  rangeVersion: true,
} as const;

// -------------------------------------------------------------
// Who may approve
// -------------------------------------------------------------

/**
 * Roles that stand for the pathologist's sign-off: lab_supervisor is the role
 * that verifies results and signs reports today ("the senior pathologist / lab
 * manager"); `pathologist` is the custom role name the rest of the app already
 * treats as the same thing.
 */
export const RANGE_APPROVER_ROLES = ['lab_supervisor', 'pathologist'] as const;

/**
 * Holding one of these as well disqualifies the account. A hospital admin holds
 * every permission and can hand out roles, so `lab_reports:approve` alone would
 * let an admin approve a range, and adding a role to their own account must not
 * turn them into one either.
 */
export const RANGE_APPROVER_BLOCKED_ROLES = ['admin', 'super_admin', 'lab_technician'] as const;

const roleKey = (name: string) => name.trim().toLowerCase().replace(/[\s-]+/g, '_');

export function canApproveRanges(roleNames: string[]): boolean {
  const roles = roleNames.map(roleKey);
  return (
    roles.some((r) => (RANGE_APPROVER_ROLES as readonly string[]).includes(r)) &&
    !roles.some((r) => (RANGE_APPROVER_BLOCKED_ROLES as readonly string[]).includes(r))
  );
}

/**
 * Read from the database, in this hospital, at the moment of signing: the token
 * still lists a role for a while after it is taken away.
 */
export async function assertRangeApprover(tenantId: string, userId: string): Promise<string> {
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId, isActive: true },
    select: {
      firstName: true,
      lastName: true,
      userRoles: { select: { role: { select: { name: true, tenantId: true } } } },
    },
  });
  const all = user?.userRoles ?? [];
  const here = all.filter((r) => r.role.tenantId === tenantId).map((r) => roleKey(r.role.name));
  const everywhere = all.map((r) => roleKey(r.role.name));
  const approver = here.some((r) => (RANGE_APPROVER_ROLES as readonly string[]).includes(r));
  if (!user || !approver || !canApproveRanges(everywhere)) {
    throw AppError.forbidden(
      'Only a pathologist (Lab Supervisor) can approve, reject or confirm reference ranges. ' +
        'An account that is also a hospital admin or lab technician cannot.',
    );
  }
  return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || 'Pathologist';
}

async function actorName(userId?: string | null): Promise<string | null> {
  if (!userId) return null;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
  return u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || null : null;
}

// -------------------------------------------------------------
// Creating proposals
// -------------------------------------------------------------

/**
 * File the range changes held back from a catalogue save. Runs inside the
 * caller's transaction so a save never lands without its proposals. A change
 * already waiting with the same values is not queued twice.
 */
export async function createRangeProposals(
  tx: Db,
  params: {
    tenantId: string;
    test: { id: string; testName: string; sampleType?: string | null; normalRange?: string | null; unit?: string | null; parameters?: unknown };
    drafts: ProposalDraft[];
    origin: RangeOrigin;
    userId?: string | null;
    userName?: string | null;
    /** Skip a draft that cannot be a range instead of failing (bulk template clone). */
    skipInvalid?: boolean;
  },
): Promise<number> {
  const { tenantId, test, drafts, origin } = params;
  if (drafts.length === 0) return 0;

  const usable = drafts.filter((d) => {
    const bad = rangeProblem(d.values);
    if (!bad) return true;
    if (params.skipInvalid) {
      logger.warn({ tenantId, testId: test.id, parameter: d.name, bad }, 'Range proposal skipped');
      return false;
    }
    throw AppError.badRequest(`${d.name}: ${bad}`, 'RANGE_INVALID');
  });

  const waiting = await tx.labRangeProposal.findMany({
    where: { tenantId, testId: test.id, status: 'pending' },
    select: { parameterKey: true, unit: true, refLow: true, refHigh: true, refText: true },
  });
  const rows = usable
    .filter((d) => !waiting.some((w) => w.parameterKey === d.key && sameValues(w, d.values)))
    .map((d) => {
      const live = liveRangeFor(test, d.key);
      return {
        tenantId,
        testId: test.id,
        parameterKey: d.key,
        parameterName: d.name.slice(0, 255),
        source: 'manual',
        origin,
        status: 'pending',
        unit: d.values.unit,
        refLow: d.values.refLow,
        refHigh: d.values.refHigh,
        refText: d.values.refText,
        baseLive: live ? (snapshotRange(live) as Prisma.InputJsonValue) : undefined,
        baseHash: live ? rangeHash(live) : null,
        proposedById: params.userId ?? null,
        proposedByName: params.userName ?? null,
      };
    });
  if (rows.length > 0) await tx.labRangeProposal.createMany({ data: rows });
  return rows.length;
}

async function loadTest(db: Db, tenantId: string, testId: string) {
  const test = await db.labTestCatalog.findFirst({ where: { id: testId, tenantId }, select: TEST_SELECT });
  if (!test) throw AppError.notFound('Lab test not found');
  return test;
}

function slotOrThrow(test: Parameters<typeof liveRangeFor>[0], key: string): LiveRange {
  const live = liveRangeFor(test, key);
  if (!live) {
    throw AppError.conflict('This parameter is no longer on the test. Reload the catalogue.', 'RANGE_CHANGED');
  }
  return live;
}

export interface RangeInput {
  unit?: string | null;
  refLow?: number | null;
  refHigh?: number | null;
  refText?: string | null;
  qualifiers?: RangeQualifier[] | null;
}

const clean = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

/** Turn what a person typed into storable values, or explain why it cannot be. */
function toValues(input: RangeInput, fallback: RangeValues): { values: RangeValues; qualifiers: RangeQualifier[] | null } {
  const qualifiers = input.qualifiers?.length ? input.qualifiers : null;
  if (qualifiers) {
    const bad = qualifierProblem(qualifiers);
    if (bad) throw AppError.badRequest(bad, 'RANGE_INVALID');
    if (input.refLow != null || input.refHigh != null) {
      throw AppError.badRequest('Give either one range or sex/age groups, not both', 'RANGE_INVALID');
    }
  }
  const values: RangeValues = {
    unit: input.unit === undefined ? fallback.unit : clean(input.unit),
    refLow: input.refLow ?? null,
    refHigh: input.refHigh ?? null,
    refText: qualifiers ? qualifiersToText(qualifiers) : clean(input.refText),
  };
  const bad = rangeProblem(values);
  if (bad) throw AppError.badRequest(bad, 'RANGE_INVALID');
  return { values, qualifiers };
}

export async function proposeRange(
  tenantId: string,
  userId: string,
  testId: string,
  parameterKey: string,
  input: RangeInput & { rationale?: string | null },
) {
  const test = await loadTest(prisma, tenantId, testId);
  const live = slotOrThrow(test, parameterKey);
  const { values, qualifiers } = toValues(input, live);
  if (sameValues(values, live)) {
    throw AppError.badRequest(
      hasRange(live)
        ? 'This is already the range in use. A pathologist can confirm it instead.'
        : 'Enter a low limit, a high limit or a text range',
      'RANGE_UNCHANGED',
    );
  }
  const row = await prisma.labRangeProposal.create({
    data: {
      tenantId,
      testId,
      parameterKey,
      parameterName: live.name,
      source: 'manual',
      origin: 'manual',
      status: 'pending',
      unit: values.unit,
      refLow: values.refLow,
      refHigh: values.refHigh,
      refText: values.refText,
      qualifiers: qualifiers ? (qualifiers as unknown as Prisma.InputJsonValue) : undefined,
      rationale: clean(input.rationale),
      baseLive: snapshotRange(live) as Prisma.InputJsonValue,
      baseHash: rangeHash(live),
      proposedById: userId,
      proposedByName: await actorName(userId),
    },
  });
  await writeAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'lab_range_proposal',
    entityId: row.id,
    description: `Range proposed for ${test.testName} / ${live.name}: ${formatRange(values) || 'no range'} ${values.unit ?? ''}`.trim(),
    newValues: { testId, parameterKey, ...values },
  });
  return row;
}

export async function suggestRangeWithAi(tenantId: string, userId: string, testId: string, parameterKey: string) {
  const test = await loadTest(prisma, tenantId, testId);
  const live = slotOrThrow(test, parameterKey);
  if (live.inputType !== 'number') {
    throw AppError.badRequest('AI suggestions are for numeric parameters only. Propose this one by hand.', 'RANGE_NOT_NUMERIC');
  }
  const open = await prisma.labRangeProposal.findFirst({
    where: { tenantId, testId, parameterKey, status: 'pending', source: 'ai' },
    select: { id: true },
  });
  if (open) {
    throw AppError.conflict(
      'An AI suggestion for this parameter is already waiting for the pathologist',
      'AI_SUGGESTION_PENDING',
    );
  }

  const specimen = clean(test.sampleType) ?? (isPlaceholderText(test.specimen) ? null : clean(test.specimen));
  const s = await suggestRange(
    tenantId,
    { testName: test.testName, parameter: live.name, unit: live.unit, specimen },
    live,
  );

  const row = await prisma.labRangeProposal.create({
    data: {
      tenantId,
      testId,
      parameterKey,
      parameterName: live.name,
      source: 'ai',
      origin: 'ai_suggest',
      status: 'pending',
      unit: s.values.unit,
      refLow: s.values.refLow,
      refHigh: s.values.refHigh,
      refText: s.values.refText,
      qualifiers: s.qualifiers ? (s.qualifiers as unknown as Prisma.InputJsonValue) : undefined,
      rationale: s.rationale,
      warnings: s.warnings.length ? s.warnings : undefined,
      aiProvider: s.provider.slice(0, 30),
      aiModel: s.model.slice(0, 100),
      baseLive: snapshotRange(live) as Prisma.InputJsonValue,
      baseHash: rangeHash(live),
      proposedById: userId,
      proposedByName: await actorName(userId),
    },
  });
  await writeAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'lab_range_proposal',
    entityId: row.id,
    description: `AI range suggestion requested for ${test.testName} / ${live.name}`,
    newValues: { testId, parameterKey, ...s.values, model: s.model },
  });
  return row;
}

// -------------------------------------------------------------
// Approve / reject / confirm
// -------------------------------------------------------------

export interface ApproveItem {
  id: string;
  /** Fingerprint of the live range the pathologist was looking at. */
  expectedLiveHash: string;
  edits?: RangeInput | null;
  note?: string | null;
}

const moved = () =>
  AppError.conflict(
    'The range in use changed while you were reviewing. Reload and check it again.',
    'RANGE_CHANGED',
  );

/**
 * Approve proposals for ONE test, all or nothing. Conditional three ways: the
 * proposal must still be pending, the live range must be the one the reviewer
 * saw, and the catalogue row must not have moved since it was read.
 */
export async function approveRangeProposals(tenantId: string, userId: string, items: ApproveItem[]) {
  const reviewer = await assertRangeApprover(tenantId, userId);
  const now = new Date();

  const done = await prisma.$transaction(async (tx) => {
    const out: Array<{ id: string; testId: string; testName: string; parameter: string; previous: unknown; applied: unknown; edited: boolean }> = [];
    let onlyTest: string | null = null;

    for (const item of items) {
      const p = await tx.labRangeProposal.findFirst({ where: { id: item.id, tenantId } });
      if (!p) throw AppError.notFound('Range proposal not found');
      if (onlyTest && onlyTest !== p.testId) {
        throw AppError.badRequest('Approve one test at a time');
      }
      onlyTest = p.testId;
      if (p.status !== 'pending') {
        throw AppError.conflict(`This proposal was already ${p.status}`, 'RANGE_ALREADY_REVIEWED');
      }
      if (p.source !== 'ai' && p.proposedById === userId) {
        throw new AppError(
          'You proposed this range, so another pathologist has to approve it',
          403,
          'SELF_APPROVAL',
        );
      }

      const test = await loadTest(tx, tenantId, p.testId);
      const live = slotOrThrow(test, p.parameterKey);
      if (rangeHash(live) !== item.expectedLiveHash) throw moved();
      if (rangeNameKey(live.name) !== rangeNameKey(p.parameterName)) throw moved();

      const proposed: RangeValues = { unit: p.unit, refLow: p.refLow, refHigh: p.refHigh, refText: p.refText };
      const final = item.edits ? toValues(item.edits, proposed).values : proposed;
      const bad = rangeProblem(final);
      if (bad) throw AppError.badRequest(bad, 'RANGE_INVALID');
      const edited = !sameValues(final, proposed);

      const columns = applyRangeToTest(test, p.parameterKey, final);
      const applied = liveRangeFor({ ...test, ...columns }, p.parameterKey);

      const claimed = await tx.labRangeProposal.updateMany({
        where: { id: p.id, tenantId, status: 'pending' },
        data: {
          status: 'approved',
          reviewedById: userId,
          reviewedByName: reviewer,
          reviewedAt: now,
          reviewNote: clean(item.note),
          editedValues: edited ? (final as unknown as Prisma.InputJsonValue) : undefined,
          previousLive: snapshotRange(live) as Prisma.InputJsonValue,
          appliedLive: applied ? (snapshotRange(applied) as Prisma.InputJsonValue) : undefined,
          appliedHash: applied ? rangeHash(applied) : null,
        },
      });
      if (claimed.count !== 1) {
        throw AppError.conflict('Another pathologist reviewed this proposal first', 'RANGE_ALREADY_REVIEWED');
      }
      const written = await tx.labTestCatalog.updateMany({
        where: { id: test.id, tenantId, rangeVersion: test.rangeVersion },
        data: {
          ...(columns.parameters !== undefined
            ? { parameters: columns.parameters as unknown as Prisma.InputJsonValue }
            : {}),
          ...(columns.normalRange !== undefined ? { normalRange: columns.normalRange } : {}),
          ...(columns.unit !== undefined ? { unit: columns.unit } : {}),
          rangeVersion: { increment: 1 },
        },
      });
      if (written.count !== 1) throw moved();

      out.push({
        id: p.id,
        testId: test.id,
        testName: test.testName,
        parameter: live.name,
        previous: snapshotRange(live),
        applied: applied ? snapshotRange(applied) : null,
        edited,
      });
    }
    return out;
  });

  for (const d of done) {
    await writeAudit({
      tenantId,
      userId,
      action: 'update',
      entityType: 'lab_range_proposal',
      entityId: d.id,
      description: `Reference range approved${d.edited ? ' with edits' : ''}: ${d.testName} / ${d.parameter}`,
      oldValues: d.previous,
      newValues: d.applied,
    });
  }
  return done;
}

export async function rejectRangeProposal(tenantId: string, userId: string, id: string, reason: string) {
  const reviewer = await assertRangeApprover(tenantId, userId);
  const p = await prisma.labRangeProposal.findFirst({ where: { id, tenantId } });
  if (!p) throw AppError.notFound('Range proposal not found');
  const res = await prisma.labRangeProposal.updateMany({
    where: { id, tenantId, status: 'pending' },
    data: {
      status: 'rejected',
      reviewedById: userId,
      reviewedByName: reviewer,
      reviewedAt: new Date(),
      reviewNote: reason.trim(),
    },
  });
  if (res.count !== 1) {
    throw AppError.conflict('This proposal has already been reviewed', 'RANGE_ALREADY_REVIEWED');
  }
  await writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'lab_range_proposal',
    entityId: id,
    description: `Reference range proposal rejected: ${p.parameterName}`,
    reason: reason.trim(),
  });
  return { id, status: 'rejected' as const };
}

/** Sign off ranges that are already live, exactly as they stand. */
export async function confirmCurrentRanges(
  tenantId: string,
  userId: string,
  testId: string,
  items: Array<{ parameterKey: string; expectedLiveHash: string }>,
  note?: string | null,
) {
  const reviewer = await assertRangeApprover(tenantId, userId);
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const test = await loadTest(tx, tenantId, testId);
    const rows = items.map((item) => {
      const live = slotOrThrow(test, item.parameterKey);
      if (rangeHash(live) !== item.expectedLiveHash) throw moved();
      if (!hasRange(live)) {
        throw AppError.badRequest(`${live.name} has no range to confirm`, 'RANGE_MISSING');
      }
      const snap = snapshotRange(live) as Prisma.InputJsonValue;
      return {
        tenantId,
        testId,
        parameterKey: live.key,
        parameterName: live.name,
        source: 'manual',
        origin: 'confirm_current',
        status: 'approved',
        unit: live.unit,
        refLow: live.refLow,
        refHigh: live.refHigh,
        refText: live.refText?.slice(0, 100) ?? null,
        baseLive: snap,
        baseHash: rangeHash(live),
        previousLive: snap,
        appliedLive: snap,
        appliedHash: rangeHash(live),
        proposedById: userId,
        proposedByName: reviewer,
        reviewedById: userId,
        reviewedByName: reviewer,
        reviewedAt: now,
        reviewNote: clean(note),
      };
    });
    // Lock: an edit landing at the same moment fails instead of being signed off unseen.
    const held = await tx.labTestCatalog.updateMany({
      where: { id: testId, tenantId, rangeVersion: test.rangeVersion },
      data: { rangeVersion: { increment: 1 } },
    });
    if (held.count !== 1) throw moved();
    await tx.labRangeProposal.createMany({ data: rows });
    return { testName: test.testName, names: rows.map((r) => r.parameterName) };
  });
  await writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'lab_test_catalog',
    entityId: testId,
    description: `Current reference ranges confirmed: ${result.testName} (${result.names.join(', ')})`,
    reason: clean(note) ?? undefined,
  });
  return { confirmed: result.names.length };
}

// -------------------------------------------------------------
// Status, queue and history
// -------------------------------------------------------------

export type SignOffStatus = 'signed_off' | 'not_signed_off' | 'no_range';

interface SignOff {
  parameterKey: string;
  appliedHash: string | null;
  reviewedByName: string | null;
  reviewedAt: Date | null;
}

function slotStatuses(
  test: { testName: string; sampleType: string | null; normalRange: string | null; unit: string | null; parameters: unknown },
  signOffs: SignOff[],
) {
  return liveRanges(test).map((live) => {
    const hash = rangeHash(live);
    // Newest first: only the latest approval counts, and only while it still
    // describes the range actually in use.
    const latest = signOffs.find((s) => s.parameterKey === live.key);
    const signed = latest?.appliedHash === hash;
    const status: SignOffStatus = !hasRange(live) ? 'no_range' : signed ? 'signed_off' : 'not_signed_off';
    return {
      key: live.key,
      name: live.name,
      inputType: live.inputType,
      unit: live.unit,
      refLow: live.refLow,
      refHigh: live.refHigh,
      refText: live.refText,
      rangeText: formatRange(live),
      liveHash: hash,
      status,
      signedOffBy: status === 'signed_off' ? (latest?.reviewedByName ?? null) : null,
      signedOffAt: status === 'signed_off' ? (latest?.reviewedAt ?? null) : null,
    };
  });
}

export type RangeFilter = 'all' | 'not_signed_off' | 'pending' | 'no_range';

export async function getRangeStatus(tenantId: string) {
  const [tests, approved, pending] = await Promise.all([
    prisma.labTestCatalog.findMany({
      where: { tenantId, isActive: true },
      select: TEST_SELECT,
      orderBy: { testName: 'asc' },
    }),
    prisma.labRangeProposal.findMany({
      where: { tenantId, status: 'approved' },
      orderBy: { reviewedAt: 'desc' },
      select: { testId: true, parameterKey: true, appliedHash: true, reviewedByName: true, reviewedAt: true },
    }),
    prisma.labRangeProposal.groupBy({
      by: ['testId'],
      where: { tenantId, status: 'pending' },
      _count: { _all: true },
    }),
  ]);
  const byTest = new Map<string, SignOff[]>();
  for (const a of approved) byTest.set(a.testId, [...(byTest.get(a.testId) ?? []), a]);
  const waiting = new Map(pending.map((p) => [p.testId, p._count._all]));

  const totals = { tests: tests.length, signedOff: 0, notSignedOff: 0, noRange: 0, pending: 0, testsNotSignedOff: 0 };
  const rows = tests.map((t) => {
    const ranges = slotStatuses(t, byTest.get(t.id) ?? []);
    const count = (s: SignOffStatus) => ranges.filter((r) => r.status === s).length;
    const row = {
      testId: t.id,
      testName: t.testName,
      testCode: t.testCode,
      sampleType: t.sampleType,
      signedOff: count('signed_off'),
      notSignedOff: count('not_signed_off'),
      noRange: count('no_range'),
      pending: waiting.get(t.id) ?? 0,
      ranges,
    };
    totals.signedOff += row.signedOff;
    totals.notSignedOff += row.notSignedOff;
    totals.noRange += row.noRange;
    totals.pending += row.pending;
    if (row.notSignedOff > 0) totals.testsNotSignedOff += 1;
    return row;
  });
  return { totals, tests: rows };
}

export function filterRangeStatus<T extends { notSignedOff: number; pending: number; noRange: number }>(
  rows: T[],
  filter: RangeFilter,
): T[] {
  if (filter === 'not_signed_off') return rows.filter((r) => r.notSignedOff > 0);
  if (filter === 'pending') return rows.filter((r) => r.pending > 0);
  if (filter === 'no_range') return rows.filter((r) => r.noRange > 0);
  return rows;
}

export async function listPendingProposals(tenantId: string, testId?: string) {
  const rows = await prisma.labRangeProposal.findMany({
    where: { tenantId, status: 'pending', ...(testId ? { testId } : {}), test: { isActive: true } },
    orderBy: [{ proposedAt: 'asc' }],
    include: { test: { select: TEST_SELECT } },
    take: 1000,
  });
  return rows.map(({ test, ...p }) => {
    const live = liveRangeFor(test, p.parameterKey);
    return {
      ...p,
      proposedText: formatRange(p),
      test: { id: test.id, testName: test.testName, testCode: test.testCode, sampleType: test.sampleType },
      live: live
        ? { unit: live.unit, refLow: live.refLow, refHigh: live.refHigh, refText: live.refText, rangeText: formatRange(live) }
        : null,
      liveHash: live ? rangeHash(live) : null,
      /** The live range is not the one this was proposed against. */
      stale: live ? p.baseHash != null && p.baseHash !== rangeHash(live) : true,
      orphaned: !live || rangeNameKey(live.name) !== rangeNameKey(p.parameterName),
    };
  });
}

export async function getTestRanges(tenantId: string, testId: string) {
  const test = await loadTest(prisma, tenantId, testId);
  const history = await prisma.labRangeProposal.findMany({
    where: { tenantId, testId },
    orderBy: { proposedAt: 'desc' },
    take: 500,
  });
  const approved = history
    .filter((h) => h.status === 'approved')
    .sort((a, b) => (b.reviewedAt?.getTime() ?? 0) - (a.reviewedAt?.getTime() ?? 0));
  return {
    test: { id: test.id, testName: test.testName, testCode: test.testCode, sampleType: test.sampleType },
    ranges: slotStatuses(test, approved),
    history: history.map((h) => ({ ...h, proposedText: formatRange(h) })),
  };
}
