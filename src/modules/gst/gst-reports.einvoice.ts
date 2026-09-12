// ---------------------------------------------------------------------------
// Group D — e-invoice and e-way bill.
//
// Section 11.5 lists three reports:
//
//   D-1  E-invoice (IRN) Register  — every invoice sent to the portal, its IRN,
//                                    acknowledgement number and date
//   D-2  Failed IRN Report         — invoices the portal did not accept, and
//                                    why; these must be fixed within the limit
//   D-3  E-way Bill Register       — only where goods physically move above the
//                                    threshold, which is rare for a hospital
//
// WHEN THEY APPLY. The detailed report said "only needed once the hospital
// crosses Rs. 5 crore aggregate annual turnover". The owner's correction 14
// rejects that wording outright: "Don't make that a permanent hard-coded rule
// ... Applicable where e-invoicing/e-way bill requirements apply to the
// hospital for the relevant period. That keeps the software from becoming
// obsolete when thresholds/rules change." So nothing here knows what five
// crore is. Applicability is two switches on the hospital's own GST profile,
// and the deadline and the consignment threshold are numbers beside them.
//
// WHAT THESE REPORTS DO NOT DO. They do not talk to an Invoice Registration
// Portal. Nothing in this system does yet — that needs a provider, credentials
// and the hospital's own decision about which one. What these do is hold the
// portal's answer up against what the hospital issued and say where the two
// disagree, which is the part an accountant needs and the part that survives
// whichever provider is eventually chosen.
//
// So an empty D-1 does NOT mean "all good". It means nothing has been sent,
// and each report says which of those two it is IN WORDS rather than leaving a
// blank table to be read as a clean bill of health.
//
// WHICH DOCUMENTS NEED AN IRN. B2B only — a supply to a registered person.
// A patient's own bill is B2C and needs no IRN at any turnover, so listing
// every hospital bill as "missing its IRN" would be both wrong and alarming.
// The credit and debit notes raised against a B2B invoice DO need one, which
// is why they are folded in beside the invoices rather than left out.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { r2 } from '../../shared/gst';
import { gstAppliesOn, type GstProfile } from '../../shared/gst-profile';
import { logger } from '../../config/logger';
import { fullName } from '../../shared/person-name';
import { istDayNumber } from '../../shared/date.utils';

const n = (v: unknown) => r2(Number(v ?? 0));

function dateRange(query: { from?: string; to?: string }) {
  return {
    from: query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined,
    to: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined,
  };
}

export interface EInvoiceQuery {
  from?: string;
  to?: string;
  /** 'registered' | 'failed' | 'not_sent' | 'cancelled'. Omit for all. */
  status?: string;
}

/**
 * Whether the hospital is inside the e-invoicing regime at all, in the words
 * correction 14 asked for.
 *
 * Never states a turnover figure. It reports the hospital's own setting and
 * says who decides it, because the hospital's CA decides it and the software's
 * job is to record the answer rather than to compute it from a threshold that
 * has already moved twice.
 */
function applicabilityOf(profile: GstProfile, kind: 'e-invoice' | 'e-way bill') {
  const on = kind === 'e-invoice' ? profile.eInvoiceApplicable : profile.eWayBillApplicable;
  return {
    applicable: on,
    /** The exact wording of correction 14. */
    statement: `Applicable where ${kind} requirements apply to the hospital for the relevant period.`,
    note: on
      ? `The hospital's GST settings record that ${kind} requirements apply. Turn it off there if that changes.`
      : `The hospital's GST settings record that ${kind} requirements do not currently apply, so nothing below is due. ` +
        'Turn it on in Settings → GST when the hospital\'s accountant says it does.',
    settingsPath: '/hospital/settings/gst',
  };
}

/**
 * How many days are left to register a document, against the hospital's own
 * window. 0 means it is due today with the rest of today still there to do it
 * in; -1 means one day late.
 *
 * CALENDAR DAYS IN IST, ending at the close of the day. The window is a count
 * of days from the document's date, not a stopwatch started at the minute the
 * invoice was raised: an invoice dated the 1st with a 30-day window is due by
 * the END of the 31st, whatever o'clock it was cut at. Measuring exact 24-hour
 * spans instead made a document read as overdue from its own time of day — an
 * invoice raised at 09:00 turned red at 09:00 on its last day, while the
 * hospital still had the working day to file it.
 *
 * The day is the hospital's day, so it is counted in IST. Document dates are
 * stored as UTC instants and a bill raised between midnight and 05:30 IST sits
 * on the PREVIOUS UTC date, so doing this arithmetic in UTC put every early
 * morning bill a day out.
 *
 * Comparing day numbers is the same thing as comparing against 23:59:59.999
 * IST on the deadline's day, and unlike subtracting two instants it cannot
 * drift by a millisecond.
 */
function daysLeft(documentDate: Date, uploadDays: number, todayIST: number): number {
  return istDayNumber(documentDate) + uploadDays - todayIST;
}

/**
 * The status of one document, as a single word.
 *
 * 'not_sent' is deliberately distinct from 'failed'. A document nobody has
 * tried to register and one the portal refused are different problems with
 * different fixes, and D-2's entire reason for existing is to keep them apart.
 */
function statusOf(row: { irn: string | null; irnStatus: string | null }): string {
  if (row.irnStatus) return row.irnStatus;
  return row.irn ? 'registered' : 'not_sent';
}

interface IrnRow {
  id: string;
  kind: 'invoice' | 'credit_note' | 'debit_note';
  documentNumber: string;
  documentDate: Date;
  recipientName: string | null;
  recipientGstin: string | null;
  taxableValue: number;
  taxAmount: number;
  totalAmount: number;
  irn: string | null;
  ackNo: string | null;
  ackDate: Date | null;
  status: string;
  error: string | null;
  attemptedAt: Date | null;
  cancelledAt: Date | null;
  daysToDeadline: number | null;
}

/**
 * Everything that needs an IRN in the period, registered or not.
 *
 * Reads bills and credit notes in one pass so D-1 and D-2 fold the SAME set —
 * a failure report built off a different query from the register it belongs to
 * is a failure report that eventually disagrees with it.
 */
async function loadIrnRows(
  tenantId: string,
  profile: GstProfile,
  query: EInvoiceQuery,
): Promise<IrnRow[]> {
  const { from, to } = dateRange(query);
  const window = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;
  // TODAY, never the end of the period asked for. "How long have I got" is a
  // question about now: measuring against the range's end made a July invoice
  // read as 230 days overdue simply because the accountant had asked for the
  // whole financial year, and made a document dated next week look comfortable
  // for a year. The deadline does not move because of how the report was run.
  //
  // Read once, for the whole report: every row is then measured against the
  // same today — rows that disagreed about what day it is would be a strange
  // thing to hand an accountant — and the IST day is worked out once rather
  // than per row.
  const todayIST = istDayNumber(new Date());
  const uploadDays = profile.eInvoiceUploadDays;

  const [bills, notes] = await Promise.all([
    prisma.bill.findMany({
      where: {
        tenantId,
        // Issued documents only. A draft has no number and is not a supply yet.
        invoiceNumber: { not: null },
        // B2B only — see the file header. A patient's bill needs no IRN.
        recipientGstin: { not: null },
        ...(window ? { billDate: window } : {}),
      },
      orderBy: { billDate: 'asc' },
      select: {
        id: true, invoiceNumber: true, billDate: true, cancelledAt: true,
        recipientGstin: true, taxableValue: true, taxAmount: true, totalAmount: true,
        irn: true, irnAckNo: true, irnAckDate: true, irnStatus: true,
        irnError: true, irnAttemptedAt: true, irnCancelledAt: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.creditNote.findMany({
      where: {
        tenantId,
        recipientGstin: { not: null },
        ...(window ? { issueDate: window } : {}),
      },
      orderBy: { issueDate: 'asc' },
      select: {
        id: true, creditNoteNumber: true, issueDate: true, noteType: true,
        recipientGstin: true, taxableValue: true, taxAmount: true, totalAmount: true,
        irn: true, irnAckNo: true, irnAckDate: true, irnStatus: true,
        irnError: true, irnAttemptedAt: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    }),
  ]);

  // The shared join, never `${firstName} ${lastName}` — a TEMP patient has no
  // surname by design and the naive form prints "null" on the register.
  const name = (p: { firstName?: string | null; lastName?: string | null } | null) =>
    fullName(p) || null;

  const rows: IrnRow[] = [
    ...bills
      // Before the cut-over the hospital was not charging GST through this
      // system at all, so those documents are not its e-invoices to register.
      .filter((b) => gstAppliesOn(profile, b.billDate))
      .map((b) => ({
        id: b.id,
        kind: 'invoice' as const,
        documentNumber: b.invoiceNumber!,
        documentDate: b.billDate,
        recipientName: name(b.patient),
        recipientGstin: b.recipientGstin,
        taxableValue: n(b.taxableValue),
        taxAmount: n(b.taxAmount),
        totalAmount: n(b.totalAmount),
        irn: b.irn,
        ackNo: b.irnAckNo,
        ackDate: b.irnAckDate,
        status: b.irnCancelledAt ? 'cancelled' : statusOf(b),
        error: b.irnError,
        attemptedAt: b.irnAttemptedAt,
        cancelledAt: b.cancelledAt,
        daysToDeadline: b.irn ? null : daysLeft(b.billDate, uploadDays, todayIST),
      })),
    ...notes
      .filter((c) => gstAppliesOn(profile, c.issueDate))
      .map((c) => ({
        id: c.id,
        kind: (c.noteType === 'debit' ? 'debit_note' : 'credit_note') as IrnRow['kind'],
        documentNumber: c.creditNoteNumber,
        documentDate: c.issueDate,
        recipientName: name(c.patient),
        recipientGstin: c.recipientGstin,
        taxableValue: n(c.taxableValue),
        taxAmount: n(c.taxAmount),
        totalAmount: n(c.totalAmount),
        irn: c.irn,
        ackNo: c.irnAckNo,
        ackDate: c.irnAckDate,
        status: statusOf(c),
        error: c.irnError,
        attemptedAt: c.irnAttemptedAt,
        cancelledAt: null,
        daysToDeadline: c.irn ? null : daysLeft(c.issueDate, uploadDays, todayIST),
      })),
  ].sort((a, b) => a.documentDate.getTime() - b.documentDate.getTime());

  return query.status ? rows.filter((r) => r.status === query.status) : rows;
}

/**
 * D-1 — the e-invoice (IRN) register.
 *
 * Every document that needed registering in the period, with what the portal
 * gave back. The counts matter more than the rows: an accountant scanning this
 * wants to know how many are outstanding before they read a single line.
 */
export async function getEInvoiceRegister(tenantId: string, query: EInvoiceQuery = {}) {
  const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
  const profile = await getGstProfile(tenantId);
  const applicability = applicabilityOf(profile, 'e-invoice');
  const rows = await loadIrnRows(tenantId, profile, query);

  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const summary = {
    required: rows.length,
    registered: count('registered'),
    pending: count('pending'),
    failed: count('failed'),
    notSent: count('not_sent'),
    cancelled: count('cancelled'),
    // Magnitudes, not a net. This is a coverage register — how much document
    // value still has no IRN — and a credit note is one more document to
    // register, not a deduction from the work outstanding. Turnover ties back
    // in A-1 and A-2, which is where the signs belong.
    totalValue: r2(rows.reduce((t, r) => t + Math.abs(r.totalAmount), 0)),
    totalTax: r2(rows.reduce((t, r) => t + Math.abs(r.taxAmount), 0)),
  };

  // Said in words, because an empty table means two opposite things and the
  // reader cannot tell which from the table alone.
  const note = !applicability.applicable
    ? applicability.note
    : rows.length === 0
      ? 'No B2B document was issued in this period, so nothing needed registering. ' +
        'Only supplies to a registered recipient — an insurer, a TPA or a corporate — need an IRN; ' +
        "a patient's own bill never does."
      : summary.registered === 0
        ? `${rows.length} document(s) needed an IRN and none has been registered. This system is not ` +
          'connected to an Invoice Registration Portal, so the IRNs must be obtained through the ' +
          "hospital's e-invoicing provider and recorded here."
        : `${summary.registered} of ${rows.length} registered.`;

  return { applicability, summary, rows, note };
}

/**
 * D-2 — the failed IRN report.
 *
 * Two populations, not one. The portal REFUSED some documents and gave a
 * reason; others were never sent at all. Both have the same deadline and the
 * same consequence if it passes, and a report that showed only the refusals
 * would be silent about the larger problem — a hospital that never wired up
 * its provider has no failures and no e-invoices either.
 *
 * Sorted by how little time is left, because that is the order they have to be
 * dealt with in.
 */
export async function getFailedIrnReport(tenantId: string, query: EInvoiceQuery = {}) {
  const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
  const profile = await getGstProfile(tenantId);
  const applicability = applicabilityOf(profile, 'e-invoice');
  const all = await loadIrnRows(tenantId, profile, { from: query.from, to: query.to });

  const rows = all
    .filter((r) => r.status === 'failed' || r.status === 'not_sent' || r.status === 'pending')
    .map((r) => ({
      ...r,
      /** Past the window the hospital set. Negative days is overdue by that many. */
      overdue: r.daysToDeadline != null && r.daysToDeadline < 0,
      // The portal's own words where it gave any. Never paraphrased: an
      // accountant fixing a rejection needs the error the portal will accept a
      // correction against, not this system's summary of it.
      reason:
        r.error ??
        (r.status === 'not_sent'
          ? 'Never sent to the portal'
          : r.status === 'pending'
            ? 'Sent and awaiting the portal\'s answer'
            : 'Rejected without a reason recorded'),
    }))
    .sort((a, b) => (a.daysToDeadline ?? 0) - (b.daysToDeadline ?? 0));

  const summary = {
    outstanding: rows.length,
    rejected: rows.filter((r) => r.status === 'failed').length,
    neverSent: rows.filter((r) => r.status === 'not_sent').length,
    awaiting: rows.filter((r) => r.status === 'pending').length,
    overdue: rows.filter((r) => r.overdue).length,
    /** Exposure does not cancel: an unregistered credit note is not negative risk. */
    valueAtRisk: r2(rows.reduce((t, r) => t + Math.abs(r.totalAmount), 0)),
  };

  return {
    applicability,
    /** The window the deadline is measured against, from the hospital's settings. */
    uploadDays: profile.eInvoiceUploadDays,
    summary,
    rows,
    note: !applicability.applicable
      ? applicability.note
      : rows.length === 0
        ? 'Nothing is outstanding: every B2B document issued in this period carries an IRN.'
        : `${summary.outstanding} document(s) still need an IRN, ${summary.overdue} of them past the ` +
          `${profile.eInvoiceUploadDays}-day window recorded in the hospital's GST settings.`,
  };
}

/**
 * D-3 — the e-way bill register.
 *
 * Almost nothing a hospital does moves goods on a public road. A ward transfer
 * and a pharmacy issue stay inside the building; a patient carries their own
 * medicines out. The one movement that genuinely leaves is stock going BACK to
 * a supplier, so that is what this register covers.
 *
 * Movements are listed against the hospital's own consignment threshold rather
 * than a number written into this file, for the same reason as everything else
 * in Group D.
 */
export async function getEwayBillRegister(tenantId: string, query: EInvoiceQuery = {}) {
  const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
  const profile = await getGstProfile(tenantId);
  const applicability = applicabilityOf(profile, 'e-way bill');
  const { from, to } = dateRange(query);
  const window = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;

  const returns = await prisma.drugReturn
    .findMany({
      where: {
        tenantId,
        returnType: 'vendor_return',
        ...(window ? { createdAt: window } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, createdAt: true, quantity: true, returnNumber: true, status: true,
        creditNoteNumber: true, creditAmount: true,
        ewayBillNumber: true, ewayBillDate: true,
        drug: { select: { drugName: true, hsnCode: true } },
        supplier: { select: { name: true, gstNumber: true, address: true } },
        drugBatch: { select: { purchasePrice: true } },
      },
    })
    .catch((err: unknown) => {
      logger.warn({ err, tenantId }, 'Could not read vendor returns for the e-way bill register');
      return [];
    });

  const threshold = profile.eWayBillThreshold;
  const all = returns.map((row) => {
    // The credited value where the supplier stated one, otherwise what the
    // stock was bought for. Never a sale price — nothing is being sold here.
    const value =
      row.creditAmount != null
        ? n(row.creditAmount)
        : row.drugBatch?.purchasePrice != null
          ? r2(Number(row.drugBatch.purchasePrice) * row.quantity)
          : 0;
    return {
      returnId: row.id,
      date: row.createdAt,
      documentNumber: row.returnNumber ?? row.creditNoteNumber ?? '',
      status: String(row.status),
      itemName: row.drug?.drugName ?? '',
      hsnCode: row.drug?.hsnCode ?? null,
      quantity: row.quantity,
      consignmentValue: value,
      supplierName: row.supplier?.name ?? null,
      supplierGstin: row.supplier?.gstNumber ?? null,
      destination: row.supplier?.address ?? null,
      ewayBillNumber: row.ewayBillNumber,
      ewayBillDate: row.ewayBillDate,
      /** Above the hospital's own consignment threshold. */
      billRequired: value > threshold,
    };
  });

  const rows = all.filter((r) => r.billRequired);
  const missing = rows.filter((r) => !r.ewayBillNumber);

  return {
    applicability,
    threshold,
    summary: {
      movements: all.length,
      aboveThreshold: rows.length,
      withBill: rows.length - missing.length,
      missingBill: missing.length,
      totalValue: r2(rows.reduce((t, r) => t + r.consignmentValue, 0)),
    },
    rows,
    note: !applicability.applicable
      ? applicability.note
      : all.length === 0
        ? 'No stock went back to a supplier in this period. Nothing else a hospital does moves goods ' +
          'on a public road: ward transfers and pharmacy issues stay inside the building.'
        : rows.length === 0
          ? `${all.length} vendor return(s), none above the ₹${threshold.toLocaleString('en-IN')} ` +
            "consignment threshold in the hospital's GST settings, so none needs an e-way bill."
          : `${rows.length} movement(s) above the threshold, ${missing.length} without an e-way bill number recorded.`,
  };
}
