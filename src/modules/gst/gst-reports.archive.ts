// ---------------------------------------------------------------------------
// C-6 — the filed period archive.
//
// Every other report in this suite is LIVE: it reads today's bills. That is
// right for the month being worked on and wrong for one that is closed — a bill
// raised, amended or cancelled after a return went in changes what the reports
// say about a month whose figures are already with the government.
//
// So filing a period takes a copy. What is copied is the RETURN figures, not
// the register behind them: the rate summary, the HSN summary, the GSTR-1
// tables and the GSTR-3B boxes. Those are what was filed, and they are small
// enough to keep forever.
//
// Filing also LOCKS the period (gap item 281): status becomes Filed–Locked,
// and no money document dated inside it can be created or changed — the
// correction is a credit note in the current month. Re-opening stays possible
// and is recorded, for a period locked by mistake.
//
// Gap 281 — the amendment workflow. Reopening needs an amendment role and a
// correction reason; the ORIGINAL filed snapshot is never overwritten (a
// correction is appended to gst_filed_period_history as the next version);
// every reopen, correction and re-lock is audit-logged with who, why and which
// period; and A-13 diffs the period against that original, so a change made
// while it was open shows as an amendment in the next open return.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { logger } from '../../config/logger';
import { fullName } from '../../shared/person-name';
import { writeAudit } from '../../shared/audit';
import { returnPeriodLabel } from '../../shared/gst-period-lock';
import { financialYearFor } from './gst-document.service';
import { buildGstr1Json, returnPeriod } from './gst-reports.gstr1-json';
import { getRateWiseSummary, getHsnSummary, getExemptTurnover } from './gst-reports.sales';
import { getGstr1Summary, getGstr3bSummary } from './gst-reports.returns';
import { getItcReversalWorking } from './gst-reports.purchase';

/**
 * The headline "as filed" figures, read out of the one stored snapshot.
 *
 * C-6 and A-13 both show these. They used to read different parts of the
 * record, so the two screens showed different filed figures (gap item 281).
 */
export function filedHeadline(snapshot: unknown) {
  const snap = snapshot as Record<string, any> | null;
  return {
    outwardTaxableValue: Number(snap?.gstr3b?.outwardTaxable?.taxableValue ?? 0),
    outwardTax: Number(snap?.gstr3b?.outwardTaxable?.taxAmount ?? 0),
    netTaxPayable: Number(snap?.gstr3b?.netTaxPayable ?? 0),
    exemptTurnover: Number(snap?.exemptTurnover?.exemptTurnover ?? 0),
    reconciled: snap?.gstr1?.reconciliation?.register?.agrees === true,
    capturedAt: (snap?.capturedAt as string | undefined) ?? null,
  };
}

/** 'filed_locked' | 'filed_open' — open only when somebody re-opened it. */
export const filedStatus = (lockedAt: Date | null | undefined) => (lockedAt ? 'filed_locked' : 'filed_open');

/**
 * Who may reopen a filed period or re-file it as a correction (gap 281).
 *
 * The same people who own the hospital's GST registration — hospital admin and
 * the finance role — mirroring GST_REGISTRATION_ROLES in hospital-settings.
 * `billing:approve`, which opens the reports, also covers the front desk and
 * the cashier; neither may reopen a return that has gone to the government.
 */
export const GST_AMENDMENT_ROLES = ['super_admin', 'admin', 'billing_admin'] as const;

export function canAmendFiledPeriod(roles: readonly string[] | null | undefined): boolean {
  return (roles ?? []).some((r) => (GST_AMENDMENT_ROLES as readonly string[]).includes(r));
}

/** The person acting, as the routes know them. */
export interface GstActor {
  userId: string;
  roles: string[];
}

/** Gap 281: reopening or correcting a filed month needs a reason, always. */
function requireCorrectionReason(reason: string | null | undefined, act: string): string {
  const r = String(reason ?? '').trim();
  if (!r) {
    throw AppError.badRequest(
      `A correction reason is required to ${act} a filed return period — say what is being corrected and why.`,
    );
  }
  return r.slice(0, 1000);
}

function requireAmendRole(actor: GstActor, act: string): void {
  if (!canAmendFiledPeriod(actor.roles)) {
    throw AppError.forbidden(
      `Only a hospital admin or the finance (billing admin) role can ${act} a filed return period.`,
    );
  }
}

export interface FilePeriodInput {
  from: string;
  to: string;
  note?: string | null;
  sixDigit?: boolean;
  /** Required when the period has been filed before (gap 281). */
  reason?: string | null;
}

/**
 * Take the copy.
 *
 * Every figure comes from the same report the accountant checked on screen, run
 * once here, so what is archived is what they saw. Re-running each report a
 * second way to "verify" the snapshot would only introduce a second answer.
 *
 * FIRST FILING creates the period with its ORIGINAL snapshot and locks it.
 *
 * RE-FILING (gap 281) is a correction: the period must have been reopened,
 * the actor must hold an amendment role, and a reason is required. The
 * original snapshot is NEVER overwritten — a GSTR-1 that has gone in cannot be
 * revised, only amended in a later return, and the amendment tables are
 * declared against that original. The corrected figures are appended to the
 * history as the next version and the period is locked again.
 */
export async function filePeriod(
  tenantId: string,
  userId: string | null,
  input: FilePeriodInput,
  roles: string[] = [],
) {
  const from = new Date(`${input.from}T00:00:00.000Z`);
  const to = new Date(`${input.to}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw AppError.badRequest('A period needs a valid from and to date');
  }
  if (to < from) throw AppError.badRequest('The period ends before it starts');
  // Filing now locks the period (gap item 281). A month that has not ended
  // cannot be filed on the portal either, and locking it would stop today's
  // billing, so it is refused.
  // Today in India (UTC+5:30), so 1 December 02:00 IST can file November.
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const today = new Date(istNow.toISOString().slice(0, 10) + 'T00:00:00.000Z');
  if (to >= today) {
    throw AppError.badRequest('A period can only be filed after it has ended — its last day must be before today');
  }

  const period = returnPeriod(input.from, input.to);

  // Gap 281: is this a correction of a period already filed? Checked before
  // any report runs, so a refusal is immediate.
  const existing = await prisma.gstFiledPeriod.findUnique({
    where: { tenantId_returnPeriod: { tenantId, returnPeriod: period } },
    select: { id: true, lockedAt: true, periodFrom: true, periodTo: true },
  });
  let reason: string | null = null;
  if (existing) {
    requireAmendRole({ userId: userId ?? '', roles }, 'correct');
    reason = requireCorrectionReason(input.reason, 're-file');
    if (existing.lockedAt) {
      throw AppError.conflict(
        `${returnPeriodLabel(period)} is filed and locked. Reopen it with a correction reason before filing a correction.`,
        'PERIOD_LOCKED',
      );
    }
  }

  const query = { from: input.from, to: input.to, sixDigit: input.sixDigit };
  const [rateSummary, hsn, exempt, gstr1, gstr3b, itc, gstr1Json, declared] = await Promise.all([
    getRateWiseSummary(tenantId, query),
    getHsnSummary(tenantId, query),
    getExemptTurnover(tenantId, query),
    getGstr1Summary(tenantId, query),
    getGstr3bSummary(tenantId, query),
    getItcReversalWorking(tenantId, query),
    // The DOCUMENT-level record of what went in.
    //
    // Everything above is a total, and a total cannot answer "which invoice
    // changed". Amendments — tables 9A, 9C and 10 — are declared against the
    // original document number and its original period, so without the
    // documents themselves there is no way to find one and no way to report it.
    //
    // Stored in the file's own shape rather than a shape of our own: it is what
    // the portal received, so a diff against it is a diff against the truth
    // rather than against a second rendering of it.
    buildGstr1Json(tenantId, query).catch((err) => {
      logger.warn({ err, tenantId }, 'Could not capture the document detail for the filed snapshot');
      return null;
    }),
    // Gap 281: the amendments this return declares for EARLIER periods. Kept
    // so the next return does not declare them again — A-13 diffs an earlier
    // period against what was last declared for it, original or amended.
    import('./gst-reports.amendments')
      .then((m) => m.getGstr1Amendments(tenantId, { excludePeriod: period, withCurrentSections: true }))
      .catch((err) => {
        logger.warn({ err, tenantId }, 'Could not record the amendments declared in this filing');
        return null;
      }),
  ]);

  const declaredPeriods = declared?.currentSections ?? {};
  const snapshot = {
    /** Stamped so a snapshot read back years later says how it was made. */
    capturedAt: new Date().toISOString(),
    reportingDigits: hsn.reportingDigits,
    rateSummary: { byRate: rateSummary.byRate, byDepartment: rateSummary.byDepartment, totals: rateSummary.totals },
    hsnSummary: { byCode: hsn.byCode, totals: hsn.totals, unclassified: hsn.unclassified },
    exemptTurnover: {
      taxable: exempt.taxable, exempt: exempt.exempt, nilRated: exempt.nilRated,
      nonGst: exempt.nonGst, zeroRated: exempt.zeroRated, unclassified: exempt.unclassified,
      exemptTurnover: exempt.exemptTurnover, totalTurnover: exempt.totalTurnover,
      exemptRatio: exempt.exemptRatio,
    },
    gstr1: { tables: gstr1.tables, reconciliation: gstr1.reconciliation },
    /**
     * The sections of the file that can later be amended, exactly as filed.
     *
     * Only those three: table 12's HSN summary and the nil block are not
     * amendable at document level, and keeping the whole file would grow the
     * row without giving the amendment report anything more to work with.
     */
    gstr1Json: gstr1Json
      ? {
          b2b: (gstr1Json.json as Record<string, unknown>).b2b ?? [],
          b2cs: (gstr1Json.json as Record<string, unknown>).b2cs ?? [],
          cdnr: (gstr1Json.json as Record<string, unknown>).cdnr ?? [],
        }
      : null,
    gstr3b,
    itcReversal: { working: itc.working, reversal: itc.reversal, netCreditAvailable: itc.netCreditAvailable },
    ...(Object.keys(declaredPeriods).length
      ? {
          amendmentsDeclared: {
            count: declared?.summary.amendments ?? 0,
            periods: declaredPeriods,
          },
        }
      : {}),
  };

  const { clearPeriodLockCache } = await import('../../shared/gst-period-lock');

  if (existing) {
    // ── Gap 281: a correction. The original row and its snapshot stay. ──────
    const result = await prisma.$transaction(async (tx) => {
      const prior = await tx.gstFiledPeriodHistory.count({
        where: { filedPeriodId: existing.id, action: 'refiled' },
      });
      const version = prior + 2; // the original filing is version 1
      await tx.gstFiledPeriodHistory.create({
        data: {
          tenantId,
          filedPeriodId: existing.id,
          returnPeriod: period,
          action: 'refiled',
          version,
          reason,
          snapshot: snapshot as never,
          userId,
        },
      });
      // Locked again; nothing else on the original row moves.
      const row = await tx.gstFiledPeriod.update({
        where: { id: existing.id },
        data: { lockedAt: new Date(), lockedBy: userId },
        select: { id: true, filedAt: true, lockedAt: true },
      });
      return { row, version };
    });
    clearPeriodLockCache(tenantId);
    await writeAudit({
      tenantId,
      userId: userId ?? undefined,
      action: 'update',
      entityType: 'gst_filed_period',
      entityId: existing.id,
      description: `GST return period ${returnPeriodLabel(period)} re-filed as correction version ${result.version}; original filed snapshot preserved; period locked again`,
      reason: reason ?? undefined,
      newValues: {
        returnPeriod: period,
        version: result.version,
        outwardTax: gstr3b.outwardTaxable.taxAmount,
        outwardTaxableValue: gstr3b.outwardTaxable.taxableValue,
      },
    });
    logger.info(
      { tenantId, returnPeriod: period, version: result.version, by: userId },
      'GST period correction filed — original snapshot preserved',
    );
    return {
      id: result.row.id,
      returnPeriod: period,
      filedAt: result.row.filedAt,
      lockedAt: result.row.lockedAt ?? null,
      status: filedStatus(result.row.lockedAt),
      version: result.version,
      correction: true,
    };
  }

  let row;
  try {
    row = await prisma.gstFiledPeriod.create({
      data: {
        tenantId,
        financialYear: financialYearFor(from),
        returnPeriod: period,
        periodFrom: from,
        periodTo: to,
        filedBy: userId,
        note: input.note ?? null,
        snapshot: snapshot as never,
        // Filing locks the period (gap item 281).
        lockedAt: new Date(),
        lockedBy: userId,
      },
    });
  } catch (err) {
    // Two people filing the same month at once: the second is a correction
    // and has to go through the reopen-with-reason path.
    if ((err as { code?: string })?.code === 'P2002') {
      throw AppError.conflict(`${returnPeriodLabel(period)} has just been filed by somebody else.`, 'ALREADY_FILED');
    }
    throw err;
  }

  // The lock guard caches the locked list; drop it so the very next sale
  // dated into this period is refused.
  clearPeriodLockCache(tenantId);
  await writeAudit({
    tenantId,
    userId: userId ?? undefined,
    action: 'create',
    entityType: 'gst_filed_period',
    entityId: row.id,
    description: `GST return period ${returnPeriodLabel(period)} filed and locked`,
    newValues: { returnPeriod: period, outwardTax: gstr3b.outwardTaxable.taxAmount },
  });

  logger.info(
    { tenantId, returnPeriod: period, tax: gstr3b.outwardTaxable.taxAmount },
    'GST period archived as filed',
  );
  return {
    id: row.id,
    returnPeriod: period,
    filedAt: row.filedAt,
    lockedAt: row.lockedAt ?? null,
    status: filedStatus(row.lockedAt),
    version: 1,
    correction: false,
  };
}

/**
 * Lock a filed period, or open it again.
 *
 * Locking needs only the report gate. REOPENING (gap 281) is an amendment act:
 * it needs an amendment role and a correction reason, and it is recorded in the
 * period's history and the audit log with who, why and which period. QA could
 * previously send `locked: false` with no reason and it succeeded.
 */
export async function setFiledPeriodLock(
  tenantId: string,
  actor: GstActor,
  id: string,
  locked: boolean,
  reasonInput?: string | null,
) {
  let reason: string | null = null;
  if (!locked) {
    requireAmendRole(actor, 'reopen');
    reason = requireCorrectionReason(reasonInput, 'reopen');
  } else {
    reason = String(reasonInput ?? '').trim() || null;
  }

  const row = await prisma.gstFiledPeriod.findFirst({ where: { id, tenantId } });
  if (!row) throw AppError.notFound('Filed period not found');

  // Already in the state asked for: nothing to record.
  if (!!row.lockedAt === locked) {
    return { id: row.id, returnPeriod: row.returnPeriod, lockedAt: row.lockedAt ?? null, unchanged: true };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.gstFiledPeriod.update({
      where: { id },
      data: locked
        ? { lockedAt: new Date(), lockedBy: actor.userId }
        : { lockedAt: null, lockedBy: null },
      select: { id: true, returnPeriod: true, lockedAt: true },
    });
    await tx.gstFiledPeriodHistory.create({
      data: {
        tenantId,
        filedPeriodId: id,
        returnPeriod: row.returnPeriod,
        action: locked ? 'locked' : 'unlocked',
        reason,
        userId: actor.userId,
      },
    });
    return u;
  });

  const { clearPeriodLockCache } = await import('../../shared/gst-period-lock');
  clearPeriodLockCache(tenantId);

  await writeAudit({
    tenantId,
    userId: actor.userId,
    action: 'update',
    entityType: 'gst_filed_period',
    entityId: id,
    description: locked
      ? `GST return period ${returnPeriodLabel(row.returnPeriod)} locked`
      : `GST return period ${returnPeriodLabel(row.returnPeriod)} reopened for correction`,
    reason: reason ?? undefined,
    oldValues: { lockedAt: row.lockedAt },
    newValues: { lockedAt: updated.lockedAt, returnPeriod: row.returnPeriod },
  });

  logger.info(
    { tenantId, returnPeriod: updated.returnPeriod, locked, by: actor.userId, reason },
    locked ? 'GST return period locked' : 'GST return period reopened for correction',
  );
  return { ...updated, unchanged: false };
}

/** One entry of a filed period's trail, as the screens show it (gap 281). */
export interface FiledPeriodEvent {
  id: string;
  /** filed | unlocked | refiled | locked */
  action: string;
  version: number | null;
  reason: string | null;
  at: Date;
  by: string | null;
  /** Headline figures of the snapshot that version captured. */
  figures: ReturnType<typeof filedHeadline> | null;
}

type HistoryRow = {
  id: string; action: string; version: number | null; reason: string | null;
  userId: string | null; createdAt: Date; snapshot?: unknown;
};

/** Names for the user ids a trail carries, in one query. */
async function namesFor(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  try {
    const users = await prisma.user.findMany({
      where: { id: { in: wanted } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map((users ?? []).map((u) => [u.id, fullName(u)]));
  } catch {
    return new Map();
  }
}

/**
 * The whole trail of one period: the original filing (version 1, from the
 * period row itself) then every reopen, correction and re-lock in order.
 */
function trailOf(
  original: { id: string; filedAt: Date; filedBy: string | null; snapshot: unknown },
  history: HistoryRow[],
  names: Map<string, string>,
): FiledPeriodEvent[] {
  return [
    {
      id: `${original.id}:v1`,
      action: 'filed',
      version: 1,
      reason: null,
      at: original.filedAt,
      by: original.filedBy ? names.get(original.filedBy) ?? null : null,
      figures: filedHeadline(original.snapshot),
    },
    ...[...history]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((h) => ({
        id: h.id,
        action: h.action,
        version: h.version ?? null,
        reason: h.reason ?? null,
        at: h.createdAt,
        by: h.userId ? names.get(h.userId) ?? null : null,
        figures: h.snapshot ? filedHeadline(h.snapshot) : null,
      })),
  ];
}

/** Every period this hospital has filed, newest first. */
export async function listFiledPeriods(tenantId: string) {
  const rows = await prisma.gstFiledPeriod.findMany({
    where: { tenantId },
    orderBy: { periodFrom: 'desc' },
    select: {
      id: true, returnPeriod: true, financialYear: true, periodFrom: true,
      periodTo: true, filedAt: true, filedBy: true, note: true,
      lockedAt: true,
      filer: { select: { firstName: true, lastName: true } },
      locker: { select: { firstName: true, lastName: true } },
      snapshot: true,
      // Gap 281: the trail, without the corrected snapshots themselves.
      history: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, action: true, version: true, reason: true, userId: true, createdAt: true },
      },
    },
  });

  const names = await namesFor(rows.flatMap((r) => [r.filedBy, ...((r.history ?? []) as HistoryRow[]).map((h) => h.userId)]));

  return {
    periods: rows.map((r) => {
      const h = filedHeadline(r.snapshot);
      const history = (r.history ?? []) as HistoryRow[];
      const trail = trailOf(
        { id: r.id, filedAt: r.filedAt, filedBy: r.filedBy ?? null, snapshot: r.snapshot },
        history,
        names,
      ).map((e) => ({ ...e, figures: e.action === 'filed' ? e.figures : null }));
      const lastReopen = [...history].reverse().find((e) => e.action === 'unlocked');
      return {
        id: r.id,
        returnPeriod: r.returnPeriod,
        financialYear: r.financialYear,
        periodFrom: r.periodFrom,
        periodTo: r.periodTo,
        filedAt: r.filedAt,
        filedBy: r.filer ? fullName(r.filer) : null,
        note: r.note,
        // The lock was selected and never returned, so every period read
        // "Open" on screen even when it was locked (gap item 281).
        lockedAt: r.lockedAt,
        lockedBy: r.locker ? fullName(r.locker) : null,
        status: filedStatus(r.lockedAt),
        // The headline figures, so the list answers the question without
        // anybody having to open each snapshot. Always the ORIGINAL filing.
        outwardTaxableValue: h.outwardTaxableValue,
        outwardTax: h.outwardTax,
        netTaxPayable: h.netTaxPayable,
        exemptTurnover: h.exemptTurnover,
        reconciled: h.reconciled,
        // Gap 281: how many snapshots exist and the last reopen, at a glance.
        versions: 1 + history.filter((e) => e.action === 'refiled').length,
        reopenCount: history.filter((e) => e.action === 'unlocked').length,
        lastReopenReason: lastReopen?.reason ?? null,
        history: trail,
      };
    }),
  };
}

/**
 * Read one filing back, with today's figures beside it.
 *
 * The comparison is the point. If the live report now says something different
 * from what was filed, a bill in that month moved after the return went in —
 * which is a correction the hospital owes through a credit note, and the only
 * way to notice is to put the two numbers side by side.
 */
export async function getFiledPeriod(tenantId: string, id: string) {
  const row = await prisma.gstFiledPeriod.findFirst({
    where: { id, tenantId },
    include: {
      filer: { select: { firstName: true, lastName: true } },
      locker: { select: { firstName: true, lastName: true } },
      history: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!row) throw AppError.notFound('That period has not been filed from this system');

  const snap = row.snapshot as Record<string, any>;
  const from = row.periodFrom.toISOString().slice(0, 10);
  const to = row.periodTo.toISOString().slice(0, 10);
  const live = await getGstr3bSummary(tenantId, { from, to });

  const asFiled = filedHeadline(snap).outwardTax;
  const now = Number(live.outwardTaxable.taxAmount ?? 0);
  const drift = Math.round((now - asFiled) * 100) / 100;

  const history = ((row as { history?: HistoryRow[] }).history ?? []) as HistoryRow[];
  const names = await namesFor([row.filedBy, ...history.map((h) => h.userId)]);
  const trail = trailOf({ id: row.id, filedAt: row.filedAt, filedBy: row.filedBy ?? null, snapshot: snap }, history, names);
  const corrections = history
    .filter((h) => h.action === 'refiled' && h.snapshot)
    .sort((a, b) => (a.version ?? 0) - (b.version ?? 0));
  const latest = corrections.length ? corrections[corrections.length - 1] : null;

  return {
    id: row.id,
    returnPeriod: row.returnPeriod,
    financialYear: row.financialYear,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    filedAt: row.filedAt,
    filedBy: row.filer ? fullName(row.filer) : null,
    note: row.note,
    lockedAt: row.lockedAt,
    lockedBy: row.locker ? fullName(row.locker) : null,
    status: filedStatus(row.lockedAt),
    /** The ORIGINAL filing — never replaced by a correction (gap 281). */
    filed: filedHeadline(snap),
    snapshot: snap,
    /** Gap 281: every snapshot and every reopen / correction, oldest first. */
    history: trail,
    versions: 1 + corrections.length,
    latestCorrection: latest
      ? { version: latest.version, at: latest.createdAt, reason: latest.reason, figures: filedHeadline(latest.snapshot) }
      : null,
    /** What the same period says today, and whether it has moved since. */
    drift: {
      outwardTaxAsFiled: asFiled,
      outwardTaxNow: now,
      difference: drift,
      moved: Math.abs(drift) >= 0.01,
    },
    notes: [
      'This is the copy taken when the period was filed. The live reports read today’s bills and can differ.',
      ...(corrections.length
        ? [
            `${corrections.length} correction(s) have been filed since. The original snapshot is kept unchanged; the differences are declared as amendments (A-13) in the next open return.`,
          ]
        : []),
      ...(Math.abs(drift) >= 0.01
        ? [
            `The same period now shows ${drift > 0 ? 'more' : 'less'} outward tax than was filed. A bill in this month moved after the return went in — the correction belongs in the current month as a credit note.`,
          ]
        : []),
      row.lockedAt
        ? 'Filed and locked: no invoice, credit note or voucher dated in this period can be created or changed. Corrections go in the current period as a credit note.'
        : 'This period is filed but not locked — it was re-opened, or filed before filing locked the period. Bills in it can be changed; lock it once any correction is made.',
    ],
  };
}
