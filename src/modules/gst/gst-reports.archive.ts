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
// What this deliberately does NOT do is lock the period. The spec asks that a
// filed month be closed to edits, with corrections made through a credit note
// in the current month. That is the right rule and it takes away something
// staff can do today, so it needs the hospital to agree before it ships. Until
// then the archive matters MORE, not less: with the lines still free to move,
// the snapshot is the only record of what actually went in.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { logger } from '../../config/logger';
import { fullName } from '../../shared/person-name';
import { financialYearFor } from './gst-document.service';
import { returnPeriod } from './gst-reports.gstr1-json';
import { getRateWiseSummary, getHsnSummary, getExemptTurnover } from './gst-reports.sales';
import { getGstr1Summary, getGstr3bSummary } from './gst-reports.returns';
import { getItcReversalWorking } from './gst-reports.purchase';

export interface FilePeriodInput {
  from: string;
  to: string;
  note?: string | null;
  sixDigit?: boolean;
}

/**
 * Take the copy.
 *
 * Every figure comes from the same report the accountant checked on screen, run
 * once here, so what is archived is what they saw. Re-running each report a
 * second way to "verify" the snapshot would only introduce a second answer.
 */
export async function filePeriod(tenantId: string, userId: string | null, input: FilePeriodInput) {
  const from = new Date(`${input.from}T00:00:00.000Z`);
  const to = new Date(`${input.to}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw AppError.badRequest('A period needs a valid from and to date');
  }
  if (to < from) throw AppError.badRequest('The period ends before it starts');

  const query = { from: input.from, to: input.to, sixDigit: input.sixDigit };
  const [rateSummary, hsn, exempt, gstr1, gstr3b, itc] = await Promise.all([
    getRateWiseSummary(tenantId, query),
    getHsnSummary(tenantId, query),
    getExemptTurnover(tenantId, query),
    getGstr1Summary(tenantId, query),
    getGstr3bSummary(tenantId, query),
    getItcReversalWorking(tenantId, query),
  ]);

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
    gstr3b,
    itcReversal: { working: itc.working, reversal: itc.reversal, netCreditAvailable: itc.netCreditAvailable },
  };

  const period = returnPeriod(input.from, input.to);
  const row = await prisma.gstFiledPeriod.upsert({
    where: { tenantId_returnPeriod: { tenantId, returnPeriod: period } },
    // Re-filing a month REPLACES the snapshot rather than adding a second one:
    // there is only ever one answer to "what did you file for September", and a
    // revised return is still that one answer.
    create: {
      tenantId,
      financialYear: financialYearFor(from),
      returnPeriod: period,
      periodFrom: from,
      periodTo: to,
      filedBy: userId,
      note: input.note ?? null,
      snapshot: snapshot as never,
    },
    update: {
      periodFrom: from,
      periodTo: to,
      filedAt: new Date(),
      filedBy: userId,
      note: input.note ?? null,
      snapshot: snapshot as never,
    },
  });

  logger.info(
    { tenantId, returnPeriod: period, tax: gstr3b.outwardTaxable.taxAmount },
    'GST period archived as filed',
  );
  return { id: row.id, returnPeriod: period, filedAt: row.filedAt };
}

/**
 * Lock a filed period, or open it again.
 *
 * A separate act from filing, deliberately. Archiving the figures is a record;
 * locking shuts the doors on every bill dated inside the period, and a hospital
 * wants the snapshot the moment it files while it may not want the month closed
 * until it has checked. So nothing is locked unless somebody locks it.
 *
 * Re-opening is allowed and recorded rather than forbidden. A period gets
 * locked by mistake, and the alternative to an audited unlock is somebody
 * editing the row in the database.
 */
export async function setFiledPeriodLock(
  tenantId: string,
  userId: string,
  id: string,
  locked: boolean,
) {
  const row = await prisma.gstFiledPeriod.findFirst({ where: { id, tenantId } });
  if (!row) throw AppError.notFound('Filed period not found');

  const updated = await prisma.gstFiledPeriod.update({
    where: { id },
    data: locked
      ? { lockedAt: new Date(), lockedBy: userId }
      : { lockedAt: null, lockedBy: null },
    select: { id: true, returnPeriod: true, lockedAt: true },
  });

  const { clearPeriodLockCache } = await import('../../shared/gst-period-lock');
  clearPeriodLockCache(tenantId);

  logger.info(
    { tenantId, returnPeriod: updated.returnPeriod, locked, by: userId },
    locked ? 'GST return period locked' : 'GST return period unlocked',
  );
  return updated;
}

/** Every period this hospital has filed, newest first. */
export async function listFiledPeriods(tenantId: string) {
  const rows = await prisma.gstFiledPeriod.findMany({
    where: { tenantId },
    orderBy: { periodFrom: 'desc' },
    select: {
      id: true, returnPeriod: true, financialYear: true, periodFrom: true,
      periodTo: true, filedAt: true, note: true,
      lockedAt: true,
      filer: { select: { firstName: true, lastName: true } },
      locker: { select: { firstName: true, lastName: true } },
      snapshot: true,
    },
  });

  return {
    periods: rows.map((r) => {
      const snap = r.snapshot as Record<string, any> | null;
      return {
        id: r.id,
        returnPeriod: r.returnPeriod,
        financialYear: r.financialYear,
        periodFrom: r.periodFrom,
        periodTo: r.periodTo,
        filedAt: r.filedAt,
        filedBy: r.filer ? fullName(r.filer) : null,
        note: r.note,
        // The headline figures, so the list answers the question without
        // anybody having to open each snapshot.
        outwardTax: Number(snap?.gstr3b?.outwardTaxable?.taxAmount ?? 0),
        netTaxPayable: Number(snap?.gstr3b?.netTaxPayable ?? 0),
        exemptTurnover: Number(snap?.exemptTurnover?.exemptTurnover ?? 0),
        reconciled: snap?.gstr1?.reconciliation?.register?.agrees === true,
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
    include: { filer: { select: { firstName: true, lastName: true } } },
  });
  if (!row) throw AppError.notFound('That period has not been filed from this system');

  const snap = row.snapshot as Record<string, any>;
  const from = row.periodFrom.toISOString().slice(0, 10);
  const to = row.periodTo.toISOString().slice(0, 10);
  const live = await getGstr3bSummary(tenantId, { from, to });

  const asFiled = Number(snap?.gstr3b?.outwardTaxable?.taxAmount ?? 0);
  const now = Number(live.outwardTaxable.taxAmount ?? 0);
  const drift = Math.round((now - asFiled) * 100) / 100;

  return {
    id: row.id,
    returnPeriod: row.returnPeriod,
    financialYear: row.financialYear,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    filedAt: row.filedAt,
    filedBy: row.filer ? fullName(row.filer) : null,
    note: row.note,
    snapshot: snap,
    /** What the same period says today, and whether it has moved since. */
    drift: {
      outwardTaxAsFiled: asFiled,
      outwardTaxNow: now,
      difference: drift,
      moved: Math.abs(drift) >= 0.01,
    },
    notes: [
      'This is the copy taken when the period was filed. The live reports read today’s bills and can differ.',
      ...(Math.abs(drift) >= 0.01
        ? [
            `The same period now shows ${drift > 0 ? 'more' : 'less'} outward tax than was filed. A bill in this month moved after the return went in — the correction belongs in the current month as a credit note.`,
          ]
        : []),
      'Filing does not lock the period. Closing a filed month to edits takes something away from the front desk, so it needs the hospital to agree to it first.',
    ],
  };
}
