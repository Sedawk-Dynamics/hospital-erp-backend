// ---------------------------------------------------------------------------
// A-13 — GSTR-1 amendments. Tables 9A, 9C and 10.
//
// WHAT AN AMENDMENT IS. Once a return has gone in, a mistake on an invoice is
// not fixed by editing the invoice. It is declared again, in a LATER return,
// under the amendment tables — table 9A for a B2B invoice, 9C for a credit or
// debit note, 10 for the aggregate B2C figures — carrying the ORIGINAL number
// and the ORIGINAL period so the portal knows which row it replaces.
//
// WHY THIS EXISTS AT ALL. Section 6.10's design is that a finalised bill's tax
// figures are read-only and any change goes through a credit note, which is the
// right rule and removes most of the need for amendments. It does not remove
// all of it. The archive's own header says so:
//
//   "What this deliberately does NOT do is lock the period ... with the lines
//    still free to move, the snapshot is the only record of what actually went
//    in."
//
// A period that is filed but not locked can still move: a bill cancelled after
// filing, a late document allotted a number inside a closed month, a
// classification corrected on the auditor's advice. Every one of those makes
// today's register disagree with what was filed, and the hospital owes the
// government an amendment for the difference. Nothing was comparing the two.
//
// HOW IT IS FOUND. Not from an edit log — there isn't one, and a log records
// intentions rather than outcomes. It is found by DIFFING: the filed snapshot
// holds the document-level sections exactly as they went into the return, and
// this rebuilds the same sections from today's data for the same period. Every
// document whose figures moved is an amendment; every document that has
// appeared since is a late addition; every one that has gone is a cancellation.
//
// A hospital that has filed nothing has no amendments — not zero amendments,
// but no basis for the question — and this says which of those it is.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { r2 } from '../../shared/gst';
import { logger } from '../../config/logger';
import { buildGstr1Json } from './gst-reports.gstr1-json';

/** One B2B invoice, as the return reports it. Mirrors the JSON's `inv` entry. */
interface JsonInvoice {
  inum: string;
  idt: string;
  val: number;
  pos?: string;
  itms?: Array<{ num?: number; itm_det?: Record<string, number> }>;
}

interface JsonB2b {
  ctin: string;
  inv: JsonInvoice[];
}

interface JsonB2cs {
  sply_ty?: string;
  pos: string;
  typ?: string;
  rt: number;
  txval: number;
  iamt?: number;
  camt?: number;
  samt?: number;
  csamt?: number;
}

interface JsonNote {
  ctin?: string;
  nt: Array<{ nt_num: string; nt_dt: string; val: number; ntty?: string; pos?: string }>;
}

/** The sections of a return that can be amended, flattened for comparison. */
interface FiledSections {
  b2b: JsonB2b[];
  b2cs: JsonB2cs[];
  cdnr: JsonNote[];
}

const n = (v: unknown) => r2(Number(v ?? 0));

/**
 * The tax on one invoice, from the item blocks the file carries.
 *
 * Read out of the JSON rather than recomputed, because the comparison has to be
 * against WHAT WAS FILED. If the two ever disagree it is the filed figure that
 * the government holds, and a diff that quietly recalculated it would report no
 * amendment in exactly the case that needs one.
 */
function taxOfInvoice(inv: JsonInvoice): number {
  let total = 0;
  for (const it of inv.itms ?? []) {
    const d = it.itm_det ?? {};
    total += n(d.iamt) + n(d.camt) + n(d.samt) + n(d.csamt);
  }
  return r2(total);
}

/** Pull the comparable sections out of a snapshot, whatever vintage it is. */
function sectionsOf(snapshot: unknown): FiledSections | null {
  const s = snapshot as Record<string, unknown> | null;
  const json = s?.gstr1Json as Record<string, unknown> | undefined;
  // A period filed before the snapshot carried the document sections cannot be
  // diffed. Said out loud rather than reported as "no amendments" — the
  // difference between "nothing changed" and "nothing to compare against" is
  // the whole value of this report.
  if (!json) return null;
  return {
    b2b: (json.b2b as JsonB2b[]) ?? [],
    b2cs: (json.b2cs as JsonB2cs[]) ?? [],
    cdnr: (json.cdnr as JsonNote[]) ?? [],
  };
}

/** MMYYYY, as the portal writes a return period. */
function monthOf(period: string): string {
  return period;
}

export interface AmendmentRow {
  table: '9A' | '9C' | '10';
  /** 'amended' | 'added' | 'removed'. */
  change: string;
  /** The original document, which is what the portal matches on. */
  originalNumber: string;
  originalDate: string | null;
  originalPeriod: string;
  recipientGstin: string | null;
  placeOfSupply: string | null;
  filedValue: number | null;
  currentValue: number | null;
  filedTax: number | null;
  currentTax: number | null;
  difference: number;
  reason: string;
}

/**
 * Everything that has moved since a period was filed.
 *
 * Given no period, every filed period is checked — which is what an accountant
 * preparing this month's return actually wants, because an amendment is
 * declared in the CURRENT return no matter which month it corrects.
 */
export async function getGstr1Amendments(
  tenantId: string,
  query: { returnPeriod?: string } = {},
) {
  const filed = await prisma.gstFiledPeriod.findMany({
    where: {
      tenantId,
      ...(query.returnPeriod ? { returnPeriod: query.returnPeriod } : {}),
    },
    orderBy: { periodFrom: 'asc' },
    select: {
      id: true, returnPeriod: true, periodFrom: true, periodTo: true,
      filedAt: true, lockedAt: true, snapshot: true,
    },
  });

  const rows: AmendmentRow[] = [];
  const periods: Array<{
    returnPeriod: string;
    filedAt: Date;
    locked: boolean;
    comparable: boolean;
    amendments: number;
    note: string;
  }> = [];

  for (const p of filed) {
    const was = sectionsOf(p.snapshot);
    if (!was) {
      periods.push({
        returnPeriod: p.returnPeriod,
        filedAt: p.filedAt,
        locked: !!p.lockedAt,
        comparable: false,
        amendments: 0,
        note:
          'Filed before the snapshot recorded document-level detail, so there is nothing to ' +
          'compare against. Re-file the period to capture it — that replaces the snapshot with ' +
          "today's figures and makes future changes visible.",
      });
      continue;
    }

    let now: FiledSections;
    try {
      const built = await buildGstr1Json(tenantId, {
        from: p.periodFrom.toISOString().slice(0, 10),
        to: p.periodTo.toISOString().slice(0, 10),
      });
      const j = built.json as Record<string, unknown>;
      now = {
        b2b: (j.b2b as JsonB2b[]) ?? [],
        b2cs: (j.b2cs as JsonB2cs[]) ?? [],
        cdnr: (j.cdnr as JsonNote[]) ?? [],
      };
    } catch (err) {
      logger.warn({ err, tenantId, period: p.returnPeriod }, 'Could not rebuild a filed period for comparison');
      periods.push({
        returnPeriod: p.returnPeriod,
        filedAt: p.filedAt,
        locked: !!p.lockedAt,
        comparable: false,
        amendments: 0,
        note: 'The period could not be rebuilt for comparison.',
      });
      continue;
    }

    const before = rows.length;

    // ── Table 9A — B2B invoices ────────────────────────────────────────────
    const flat = (sec: JsonB2b[]) => {
      const out = new Map<string, { ctin: string; inv: JsonInvoice }>();
      for (const g of sec) for (const inv of g.inv ?? []) out.set(inv.inum, { ctin: g.ctin, inv });
      return out;
    };
    const wasB2b = flat(was.b2b);
    const nowB2b = flat(now.b2b);

    for (const [inum, a] of wasB2b) {
      const b = nowB2b.get(inum);
      if (!b) {
        rows.push({
          table: '9A',
          change: 'removed',
          originalNumber: inum,
          originalDate: a.inv.idt,
          originalPeriod: monthOf(p.returnPeriod),
          recipientGstin: a.ctin,
          placeOfSupply: a.inv.pos ?? null,
          filedValue: n(a.inv.val),
          currentValue: null,
          filedTax: taxOfInvoice(a.inv),
          currentTax: null,
          difference: r2(-n(a.inv.val)),
          reason:
            'Filed in this period and no longer in it — cancelled, or its number was withdrawn. ' +
            'Table 9A carries it as an amendment to nil.',
        });
        continue;
      }
      const dv = r2(n(b.inv.val) - n(a.inv.val));
      const dt = r2(taxOfInvoice(b.inv) - taxOfInvoice(a.inv));
      if (dv !== 0 || dt !== 0 || (b.ctin !== a.ctin) || ((b.inv.pos ?? '') !== (a.inv.pos ?? ''))) {
        rows.push({
          table: '9A',
          change: 'amended',
          originalNumber: inum,
          originalDate: a.inv.idt,
          originalPeriod: monthOf(p.returnPeriod),
          recipientGstin: b.ctin,
          placeOfSupply: b.inv.pos ?? null,
          filedValue: n(a.inv.val),
          currentValue: n(b.inv.val),
          filedTax: taxOfInvoice(a.inv),
          currentTax: taxOfInvoice(b.inv),
          difference: dv,
          reason:
            b.ctin !== a.ctin
              ? `The recipient GSTIN changed from ${a.ctin} to ${b.ctin}.`
              : (b.inv.pos ?? '') !== (a.inv.pos ?? '')
                ? `The place of supply changed from ${a.inv.pos ?? '—'} to ${b.inv.pos ?? '—'}.`
                : 'The invoice value or its tax has changed since the return went in.',
        });
      }
    }
    for (const [inum, b] of nowB2b) {
      if (wasB2b.has(inum)) continue;
      rows.push({
        table: '9A',
        change: 'added',
        originalNumber: inum,
        originalDate: b.inv.idt,
        originalPeriod: monthOf(p.returnPeriod),
        recipientGstin: b.ctin,
        placeOfSupply: b.inv.pos ?? null,
        filedValue: null,
        currentValue: n(b.inv.val),
        filedTax: null,
        currentTax: taxOfInvoice(b.inv),
        difference: n(b.inv.val),
        reason:
          'Dated inside a period already filed but not in the return that went in. It is a ' +
          'missing invoice rather than an amendment: report it in the current return.',
      });
    }

    // ── Table 9C — credit and debit notes ──────────────────────────────────
    const flatNotes = (sec: JsonNote[]) => {
      const out = new Map<string, { ctin: string | null; nt: JsonNote['nt'][number] }>();
      for (const g of sec) for (const nt of g.nt ?? []) out.set(nt.nt_num, { ctin: g.ctin ?? null, nt });
      return out;
    };
    const wasN = flatNotes(was.cdnr);
    const nowN = flatNotes(now.cdnr);
    for (const [num, a] of wasN) {
      const b = nowN.get(num);
      const dv = b ? r2(n(b.nt.val) - n(a.nt.val)) : r2(-n(a.nt.val));
      if (!b || dv !== 0) {
        rows.push({
          table: '9C',
          change: b ? 'amended' : 'removed',
          originalNumber: num,
          originalDate: a.nt.nt_dt,
          originalPeriod: monthOf(p.returnPeriod),
          recipientGstin: a.ctin,
          placeOfSupply: a.nt.pos ?? null,
          filedValue: n(a.nt.val),
          currentValue: b ? n(b.nt.val) : null,
          filedTax: null,
          currentTax: null,
          difference: dv,
          reason: b
            ? 'The note’s value has changed since the return went in.'
            : 'Filed in this period and no longer in it.',
        });
      }
    }
    for (const [num, b] of nowN) {
      if (wasN.has(num)) continue;
      rows.push({
        table: '9C',
        change: 'added',
        originalNumber: num,
        originalDate: b.nt.nt_dt,
        originalPeriod: monthOf(p.returnPeriod),
        recipientGstin: b.ctin,
        placeOfSupply: b.nt.pos ?? null,
        filedValue: null,
        currentValue: n(b.nt.val),
        filedTax: null,
        currentTax: null,
        difference: n(b.nt.val),
        reason: 'Raised against a period already filed and not in the return that went in.',
      });
    }

    // ── Table 10 — B2C, which is amended in aggregate rather than per bill ──
    //
    // The portal does not want the individual B2C bills back; it wants the
    // corrected TOTAL for the state and rate, against the month it belongs to.
    // So the key is place of supply plus rate, exactly as table 7 reports it.
    const keyOf = (r: JsonB2cs) => `${r.pos}|${r.rt}`;
    const wasB2c = new Map(was.b2cs.map((r) => [keyOf(r), r]));
    const nowB2c = new Map(now.b2cs.map((r) => [keyOf(r), r]));
    for (const key of new Set([...wasB2c.keys(), ...nowB2c.keys()])) {
      const a = wasB2c.get(key);
      const b = nowB2c.get(key);
      const av = n(a?.txval);
      const bv = n(b?.txval);
      if (r2(bv - av) === 0) continue;
      const [pos, rt] = key.split('|');
      rows.push({
        table: '10',
        change: !a ? 'added' : !b ? 'removed' : 'amended',
        // Table 10 has no document number — the row IS the state and rate.
        originalNumber: `${pos} @ ${rt}%`,
        originalDate: null,
        originalPeriod: monthOf(p.returnPeriod),
        recipientGstin: null,
        placeOfSupply: pos,
        filedValue: a ? av : null,
        currentValue: b ? bv : null,
        filedTax: a ? r2(n(a.iamt) + n(a.camt) + n(a.samt) + n(a.csamt)) : null,
        currentTax: b ? r2(n(b.iamt) + n(b.camt) + n(b.samt) + n(b.csamt)) : null,
        difference: r2(bv - av),
        reason:
          'The B2C total for this state and rate no longer matches what was filed. Table 10 ' +
          'carries the corrected total for the month, not the individual bills.',
      });
    }

    const found = rows.length - before;
    periods.push({
      returnPeriod: p.returnPeriod,
      filedAt: p.filedAt,
      locked: !!p.lockedAt,
      comparable: true,
      amendments: found,
      note:
        found === 0
          ? 'Today’s figures still match what was filed.'
          : `${found} document(s) no longer match the return that went in.`,
    });
  }

  const byTable = (t: string) => rows.filter((r) => r.table === t).length;
  const summary = {
    filedPeriods: filed.length,
    comparablePeriods: periods.filter((p) => p.comparable).length,
    amendments: rows.length,
    table9A: byTable('9A'),
    table9C: byTable('9C'),
    table10: byTable('10'),
    /** What the amendments move, net. Signed: this one IS a net figure. */
    netValueChange: r2(rows.reduce((t, r) => t + r.difference, 0)),
  };

  return {
    summary,
    periods,
    rows: rows.sort((a, b) => a.originalPeriod.localeCompare(b.originalPeriod)),
    note:
      filed.length === 0
        ? 'No period has been filed yet, so there is nothing to amend. An amendment is a change ' +
          'to a return that has already gone in; until one has, corrections are simply edits.'
        : summary.comparablePeriods === 0
          ? 'Every filed period predates the document-level snapshot, so none can be compared. ' +
            'Re-file a period to capture it.'
          : rows.length === 0
            ? 'Every filed period still matches what went in. Nothing needs amending.'
            : `${rows.length} document(s) across ${
                periods.filter((p) => p.amendments > 0).length
              } filed period(s) no longer match the return. Report them in the current return ` +
              'under tables 9A, 9C and 10 — never by editing the original.',
  };
}
