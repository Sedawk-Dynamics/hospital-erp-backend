// ---------------------------------------------------------------------------
// The GSTR-1 offline-utility JSON.
//
// A-8 shows the return on screen; this is the file the accountant uploads. The
// shape is the government's, not ours — abbreviated keys, values as numbers,
// dates as dd-mm-yyyy — so it is built here rather than being bent out of the
// report shape at the last moment.
//
// Two rules that are not obvious and cost a rejected upload each:
//
//   - `gstin` and `fp` (the return period, MMYYYY) identify the file. A file
//     with the wrong period uploads cleanly into the wrong month.
//   - EXEMPT supplies do not belong in b2b or b2cs. They go in `nil`, and a
//     hospital's return is mostly `nil` — putting exempt turnover in b2cs
//     would declare tax on it.
//
// Only the sections this system can fill are emitted. An empty section is
// omitted rather than sent as an empty array: the utility treats a present-but-
// empty section as "I am declaring nothing here", which is a different
// statement from not having reached that section yet.
// ---------------------------------------------------------------------------

import { r2 } from '../../shared/gst';
import { getSalesRegister, getHsnSummary, type SalesReportQuery, type SalesLine } from './gst-reports.sales';
import { getCreditNoteRegister } from './gst-reports.returns';

/** The government's date format inside the JSON. */
const gstDate = (d: Date) => {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
};

/** The return period the file declares itself for: MMYYYY. */
export function returnPeriod(from: string | undefined, to: string | undefined): string {
  const d = from ? new Date(`${from}T00:00:00Z`) : new Date();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${mm}${d.getUTCFullYear()}`;
}

const sum = (lines: SalesLine[], pick: (l: SalesLine) => number) =>
  r2(lines.reduce((t, l) => t + pick(l), 0));

/** Group the register's lines into the invoices the return reports. */
function invoicesOf(lines: SalesLine[]) {
  const byBill = new Map<string, SalesLine[]>();
  for (const l of lines) {
    const list = byBill.get(l.billId) ?? [];
    list.push(l);
    byBill.set(l.billId, list);
  }
  return [...byBill.values()];
}

/** One invoice's line items, grouped by rate as the utility expects. */
function itemsOf(lines: SalesLine[]) {
  const byRate = new Map<number, SalesLine[]>();
  for (const l of lines) {
    const list = byRate.get(l.taxRatePercent) ?? [];
    list.push(l);
    byRate.set(l.taxRatePercent, list);
  }
  return [...byRate.entries()].map(([rt, ls], i) => ({
    num: i + 1,
    itm_det: {
      rt,
      txval: sum(ls, (l) => l.taxableValue),
      iamt: sum(ls, (l) => l.igstAmount),
      camt: sum(ls, (l) => l.cgstAmount),
      samt: sum(ls, (l) => l.sgstAmount),
      csamt: sum(ls, (l) => l.cessAmount),
    },
  }));
}

/**
 * Build the GSTR-1 JSON for a period.
 *
 * `gstin` is the hospital's own registration — the file is rejected without it,
 * so an unregistered hospital gets a clear refusal rather than a file that
 * cannot be uploaded.
 */
export async function buildGstr1Json(
  tenantId: string,
  query: SalesReportQuery & { sixDigit?: boolean } = {},
) {
  const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
  const { getAdvancesReport } = await import('./gst-reports.service');
  const [profile, register, notes, hsn, advances] = await Promise.all([
    getGstProfile(tenantId),
    getSalesRegister(tenantId, query),
    getCreditNoteRegister(tenantId, query),
    getHsnSummary(tenantId, query),
    // Table 11A. The summary has surfaced advances since it was written; the
    // file had no `at` block at all.
    getAdvancesReport(tenantId, query),
  ]);

  const taxable = register.rows.filter((l) => l.gstTreatment === 'taxable');
  const exemptLines = register.rows.filter(
    (l) => !!l.gstTreatment && l.gstTreatment !== 'taxable' && l.gstTreatment !== 'zero_rated',
  );

  // ── 4. B2B — one entry per recipient GSTIN, with their invoices under it ──
  const b2bByGstin = new Map<string, SalesLine[][]>();
  for (const inv of invoicesOf(taxable.filter((l) => !!l.recipientGstin))) {
    const gstin = inv[0].recipientGstin!;
    const list = b2bByGstin.get(gstin) ?? [];
    list.push(inv);
    b2bByGstin.set(gstin, list);
  }
  const b2b = [...b2bByGstin.entries()].map(([ctin, invoices]) => ({
    ctin,
    inv: invoices.map((inv) => {
      const f = inv[0];
      return {
        // The ALLOTTED number, never the internal bill number: it is what the
        // recipient will match their credit against.
        inum: f.invoiceNumber ?? f.billNumber,
        idt: gstDate(f.billDate),
        val: sum(inv, (l) => l.totalAmount),
        pos: f.placeOfSupplyStateCode ?? profile.stateCode ?? '',
        rchrg: 'N',
        inv_typ: 'R',
        itms: itemsOf(inv),
      };
    }),
  }));

  // ── 5 and 7. B2C ──
  const b2cLines = taxable.filter((l) => !l.recipientGstin);
  const B2CL_THRESHOLD = 250000;
  const b2clInvoices = invoicesOf(b2cLines).filter(
    (inv) => inv[0].isInterState && sum(inv, (l) => l.totalAmount) > B2CL_THRESHOLD,
  );
  const b2clIds = new Set(b2clInvoices.map((inv) => inv[0].billId));

  const b2cl = [...new Set(b2clInvoices.map((inv) => inv[0].placeOfSupplyStateCode ?? ''))].map((pos) => ({
    pos,
    inv: b2clInvoices
      .filter((inv) => (inv[0].placeOfSupplyStateCode ?? '') === pos)
      .map((inv) => ({
        inum: inv[0].invoiceNumber ?? inv[0].billNumber,
        idt: gstDate(inv[0].billDate),
        val: sum(inv, (l) => l.totalAmount),
        itms: itemsOf(inv),
      })),
  }));

  const small = b2cLines.filter((l) => !b2clIds.has(l.billId));
  const b2csMap = new Map<string, SalesLine[]>();
  for (const l of small) {
    const key = `${l.isInterState ? 'INTER' : 'INTRA'}:${l.placeOfSupplyStateCode ?? ''}:${l.taxRatePercent}`;
    const list = b2csMap.get(key) ?? [];
    list.push(l);
    b2csMap.set(key, list);
  }
  const b2cs = [...b2csMap.values()].map((ls) => ({
    sply_ty: ls[0].isInterState ? 'INTER' : 'INTRA',
    pos: ls[0].placeOfSupplyStateCode ?? profile.stateCode ?? '',
    typ: 'OE',
    rt: ls[0].taxRatePercent,
    txval: sum(ls, (l) => l.taxableValue),
    iamt: sum(ls, (l) => l.igstAmount),
    camt: sum(ls, (l) => l.cgstAmount),
    samt: sum(ls, (l) => l.sgstAmount),
    csamt: sum(ls, (l) => l.cessAmount),
  }));

  // ── 8. Nil-rated, exempt and non-GST. Most of a hospital's return. ──
  const nilRow = (predicate: (l: SalesLine) => boolean, sply_ty: string) => ({
    sply_ty,
    expt_amt: sum(exemptLines.filter((l) => predicate(l) && l.gstTreatment === 'exempt'), (l) => l.taxableValue),
    nil_amt: sum(exemptLines.filter((l) => predicate(l) && l.gstTreatment === 'nil_rated'), (l) => l.taxableValue),
    ngsup_amt: sum(exemptLines.filter((l) => predicate(l) && l.gstTreatment === 'non_gst'), (l) => l.taxableValue),
  });
  const nilRows = [
    nilRow((l) => !l.isInterState && !l.recipientGstin, 'INTRAB2C'),
    nilRow((l) => !l.isInterState && !!l.recipientGstin, 'INTRAB2B'),
    nilRow((l) => l.isInterState && !l.recipientGstin, 'INTERB2C'),
    nilRow((l) => l.isInterState && !!l.recipientGstin, 'INTERB2B'),
  ].filter((r) => r.expt_amt > 0 || r.nil_amt > 0 || r.ngsup_amt > 0);

  // ── 9B. Credit and debit notes. Only ones against a numbered invoice can
  //        be filed: Table 9B keys on the ORIGINAL document. ──
  const filable = notes.rows.filter((c) => c.reportable);

  /**
   * A note's items grouped by rate, one `itm_det` per rate.
   *
   * The rate used to be the literal `0` on every note — a declared rate of 0%
   * carrying Rs 12.97 of tax, which is a file the portal will not accept. The
   * rate was available all along: `CreditNoteItem.taxPercent` is a column, and
   * the register loaded the items and read only their count.
   */
  const noteItems = (c: (typeof notes.rows)[number]) => {
    const byRate = new Map<
      number,
      { txval: number; iamt: number; camt: number; samt: number; csamt: number }
    >();
    for (const it of c.items ?? []) {
      const rt = Number(it.taxPercent ?? 0);
      const cur = byRate.get(rt) ?? { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      cur.txval = r2(cur.txval + Number(it.taxableValue ?? 0));
      cur.iamt = r2(cur.iamt + Number(it.igstAmount ?? 0));
      cur.camt = r2(cur.camt + Number(it.cgstAmount ?? 0));
      cur.samt = r2(cur.samt + Number(it.sgstAmount ?? 0));
      cur.csamt = r2(cur.csamt + Number(it.cessAmount ?? 0));
      byRate.set(rt, cur);
    }
    // A legacy note with no line detail still has to appear, at its own header
    // figures — leaving it out of the return would be worse than reporting it
    // under a single rate.
    if (byRate.size === 0) {
      byRate.set(0, {
        txval: c.taxableValue,
        iamt: c.igstAmount,
        camt: c.cgstAmount,
        samt: c.sgstAmount,
        csamt: c.cessAmount,
      });
    }
    return [...byRate.entries()].map(([rt, v], i) => ({ num: i + 1, itm_det: { rt, ...v } }));
  };

  const noteHeader = (c: (typeof notes.rows)[number]) => ({
    // 'C' for a credit note, 'D' for a debit note. It was hardcoded to 'C',
    // which was true only because no debit note could be raised.
    ntty: c.noteType === 'debit' ? 'D' : 'C',
    nt_num: c.creditNoteNumber,
    nt_dt: gstDate(c.issueDate),
    inum: c.againstInvoiceNumber!,
    idt: c.againstBillDate ? gstDate(c.againstBillDate) : undefined,
    val: c.totalAmount,
    pos: c.placeOfSupplyStateCode ?? profile.stateCode ?? '',
    itms: noteItems(c),
  });

  const cdnur = filable.filter((c) => !c.recipientGstin).map(noteHeader);

  /**
   * Table 9B for REGISTERED recipients, keyed by their GSTIN.
   *
   * A note against a registered recipient used to be dropped on the floor: the
   * builder mapped only the unregistered ones into `cdnur` and had no `cdnr`
   * section at all, so a credit note to an insurer or a corporate simply
   * vanished from the return.
   */
  const cdnrByGstin = new Map<string, Array<ReturnType<typeof noteHeader>>>();
  for (const c of filable) {
    if (!c.recipientGstin) continue;
    const list = cdnrByGstin.get(c.recipientGstin) ?? [];
    list.push(noteHeader(c));
    cdnrByGstin.set(c.recipientGstin, list);
  }
  const cdnr = [...cdnrByGstin.entries()].map(([ctin, nt]) => ({ ctin, nt }));

  // ── 11A. Advances received on which tax is due. ──
  const posCode = profile.stateCode ?? '';
  const due = advances.summary.taxDueOnAdvances;
  const at =
    due.taxableValue > 0
      ? [
          {
            pos: posCode,
            sply_ty: 'INTRA',
            itms: [
              {
                rt: r2((due.taxAmount / due.taxableValue) * 100),
                ad_amt: due.taxableValue,
                iamt: due.igstAmount,
                camt: due.cgstAmount,
                samt: due.sgstAmount,
                csamt: 0,
              },
            ],
          },
        ]
      : [];

  // 11B (txpd) is deliberately NOT emitted. An advance adjusted against an
  // invoice is recorded as an AMOUNT with no tax split of its own, and
  // inventing one by apportioning the period's average rate would put a figure
  // in a return that nothing here actually computed. The warning says so.

  // ── 12. HSN summary ──
  const hsnRows = hsn.byCode.map((c) => ({
    hsn_sc: c.hsnSac,
    desc: c.description.slice(0, 30),
    uqc: 'OTH',
    qty: c.quantity,
    rt: c.ratePercent,
    txval: c.taxableValue,
    iamt: c.igstAmount,
    camt: c.cgstAmount,
    samt: c.sgstAmount,
    csamt: c.cessAmount,
  }));

  const json: Record<string, unknown> = {
    gstin: profile.gstin ?? '',
    fp: returnPeriod(query.from, query.to),
    // The offline utility's own version marker. Kept as data, not a guess at
    // runtime: the file is read by a tool that checks it.
    version: 'GST3.0.4',
    hash: 'hash',
  };
  if (b2b.length) json.b2b = b2b;
  if (b2cl.length) json.b2cl = b2cl;
  if (b2cs.length) json.b2cs = b2cs;
  if (nilRows.length) json.nil = { inv: nilRows };
  if (cdnur.length) json.cdnur = cdnur;
  if (cdnr.length) json.cdnr = cdnr;
  // 11A — advances received on which tax is due. The summary has shown this on
  // screen since it was written and the file left it out entirely, so the one
  // figure the portal charges tax on before an invoice exists was declared
  // nowhere.
  if (at.length) json.at = at;
  if (hsnRows.length) json.hsn = { data: hsnRows };

  return {
    json,
    /** What the file does not contain, and why. Shown before it is downloaded. */
    warnings: [
      ...(profile.registered ? [] : ['This hospital is not registered under GST — the file has no GSTIN and cannot be uploaded.']),
      ...(notes.rows.length > filable.length
        ? [`${notes.rows.length - filable.length} credit note(s) are against a bill that was never issued a number and cannot be reported.`]
        : []),
      ...(hsn.unclassified.count > 0
        ? [`${hsn.unclassified.count} line(s) have no HSN or SAC and are missing from table 12. See the unmapped items report.`]
        : []),
      ...(register.rows.some((l) => !l.gstTreatment)
        ? ['Some lines have no tax treatment at all and are in no table. See the unmapped items report.']
        : []),
      // The one that gets a file REJECTED rather than merely queried. The
      // portal validates the rate against the slabs in force, so a line at 2%,
      // 10% or a post-2025 12% fails the upload — and the builder was emitting
      // them without a word.
      ...(() => {
        const bad = register.rows.filter((l) => l.illegalRate);
        if (bad.length === 0) return [];
        const rates = [...new Set(bad.map((l) => l.taxRatePercent))].sort((a, b) => a - b);
        return [
          `${bad.length} line(s) carry a rate that was not a legal slab on the bill's own date ` +
            `(${rates.map((r) => `${r}%`).join(', ')}, ` +
            `\u20B9${r2(bad.reduce((t, l) => t + l.taxAmount, 0))} of tax). ` +
            'The portal will reject the file. Correct them with a credit note and a fresh invoice ' +
            'at the right rate.',
        ];
      })(),
      ...(advances.summary.adjustedAgainstInvoices.amount > 0
        ? [
            `Table 11B (advances adjusted, \u20B9${advances.summary.adjustedAgainstInvoices.amount}) is not in the file: ` +
              'an adjustment is recorded as an amount with no tax split of its own. Enter it on the portal by hand.',
          ]
        : []),
    ],
  };
}
