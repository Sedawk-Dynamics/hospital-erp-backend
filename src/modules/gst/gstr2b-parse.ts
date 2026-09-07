// ---------------------------------------------------------------------------
// Reading a GSTR-2B statement.
//
// The shape is the government's, not ours: abbreviated keys, dates as
// dd-mm-yyyy, and a nesting that groups every document under the supplier who
// filed it. Parsing lives here on its own so the reconciliation never has to
// know any of that.
//
// What is read, and what is deliberately not:
//
//   b2b    — the ordinary supplier invoice. This is nearly all of it.
//   cdnr   — the supplier's own credit and debit notes. A credit note REDUCES
//            the credit available, so leaving it out would overstate what the
//            hospital may claim, which is the expensive direction to be wrong.
//   b2ba /
//   cdnra  — amendments. Read, and they REPLACE the document they amend: an
//            amended invoice is the same invoice with different figures, and
//            counting both would double the credit.
//
// Everything else in the file — imports, ISD, reverse charge — is either not
// something a hospital pharmacy sees or is not input credit against a purchase
// invoice, and inventing a match for it would be worse than leaving it out.
// The parser says what it skipped rather than dropping it silently.
// ---------------------------------------------------------------------------

import { AppError } from '../../shared/appError';

export interface Parsed2bDocument {
  supplierGstin: string;
  supplierName: string | null;
  documentType: 'invoice' | 'credit_note' | 'debit_note';
  documentNumber: string;
  matchKey: string;
  documentDate: Date | null;
  documentValue: number;
  taxableValue: number;
  igstAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  cessAmount: number;
  taxAmount: number;
  placeOfSupply: string | null;
  itcAvailable: boolean;
  itcBlockedReason: string | null;
  supplierFiledOn: Date | null;
  /** True for a row that amends an earlier one — it replaces, never adds. */
  isAmendment: boolean;
}

export interface Parsed2b {
  returnPeriod: string;
  gstin: string | null;
  generatedAt: Date | null;
  version: string | null;
  documents: Parsed2bDocument[];
  /** Sections present in the file that this parser does not read. */
  skippedSections: string[];
}

const r2 = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;

/**
 * Suppliers write the same invoice as "SUP/001", "SUP-001" and "sup 001".
 *
 * Matching on the raw string leaves a hospital chasing credit it already has,
 * so the key is uppercased with everything but letters and digits removed. The
 * risk is the other way — two genuinely different invoices that differ only in
 * punctuation would collide — and that is rare enough, and visible enough in
 * the mismatch bucket, to be the better trade.
 */
export function matchKeyFor(documentNumber: string): string {
  return String(documentNumber ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 60);
}

/** The portal writes dates as dd-mm-yyyy. `new Date()` reads that as NaN. */
function gstDate(v: unknown): Date | null {
  const s = String(v ?? '').trim();
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Sum the rate-wise item block the portal nests under every document. */
function totalsOf(items: unknown): {
  taxableValue: number; igst: number; cgst: number; sgst: number; cess: number;
} {
  const list = Array.isArray(items) ? items : [];
  const acc = { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const raw of list) {
    // An invoice nests its figures under `itm_det`; a note carries them flat.
    const it = (raw as Record<string, unknown>)?.itm_det ?? raw;
    const d = it as Record<string, unknown>;
    acc.taxableValue = r2(acc.taxableValue + Number(d?.txval ?? 0));
    acc.igst = r2(acc.igst + Number(d?.igst ?? 0));
    acc.cgst = r2(acc.cgst + Number(d?.cgst ?? 0));
    acc.sgst = r2(acc.sgst + Number(d?.sgst ?? 0));
    acc.cess = r2(acc.cess + Number(d?.cess ?? 0));
  }
  return acc;
}

const KNOWN_SECTIONS = new Set(['b2b', 'b2ba', 'cdnr', 'cdnra']);

/**
 * Read a downloaded GSTR-2B.
 *
 * Rejects rather than guesses when the file is not a 2B: an accountant who
 * uploads the wrong download and gets a clean "0 invoices" would take that as
 * "no supplier has filed", which is the opposite of what it means.
 */
export function parseGstr2b(raw: unknown): Parsed2b {
  const root = raw as Record<string, any>;
  const data = (root?.data ?? root) as Record<string, any>;
  if (!data || typeof data !== 'object') {
    throw AppError.badRequest('That file is not a GSTR-2B download.');
  }
  const docdata = data.docdata as Record<string, any> | undefined;
  if (!docdata || typeof docdata !== 'object') {
    throw AppError.badRequest(
      'That file has no `docdata` section, so it is not a GSTR-2B download. Download the JSON for the period from the portal.',
    );
  }
  const returnPeriod = String(data.rtnprd ?? '').trim();
  if (!/^\d{6}$/.test(returnPeriod)) {
    throw AppError.badRequest('That GSTR-2B has no return period (`rtnprd`) on it.');
  }

  const documents: Parsed2bDocument[] = [];

  const pushInvoices = (section: unknown, isAmendment: boolean) => {
    for (const supplier of Array.isArray(section) ? section : []) {
      const s = supplier as Record<string, any>;
      const gstin = String(s?.ctin ?? '').trim().toUpperCase();
      const filedOn = gstDate(s?.supfileddt);
      for (const inv of Array.isArray(s?.inv) ? s.inv : []) {
        const i = inv as Record<string, any>;
        const t = totalsOf(i?.items);
        const number = String(i?.inum ?? '').trim();
        if (!gstin || !number) continue;
        documents.push({
          supplierGstin: gstin,
          supplierName: s?.trdnm ? String(s.trdnm) : null,
          documentType: 'invoice',
          documentNumber: number,
          matchKey: matchKeyFor(number),
          documentDate: gstDate(i?.dt),
          documentValue: r2(i?.val),
          taxableValue: t.taxableValue,
          igstAmount: t.igst,
          cgstAmount: t.cgst,
          sgstAmount: t.sgst,
          cessAmount: t.cess,
          taxAmount: r2(t.igst + t.cgst + t.sgst + t.cess),
          placeOfSupply: i?.pos ? String(i.pos) : null,
          // The portal's own verdict. 'N' means the credit is blocked whatever
          // our books say, and no amount of matching changes that.
          itcAvailable: String(i?.itcavl ?? 'Y').toUpperCase() !== 'N',
          itcBlockedReason: i?.rsn ? String(i.rsn) : null,
          supplierFiledOn: filedOn,
          isAmendment,
        });
      }
    }
  };

  const pushNotes = (section: unknown, isAmendment: boolean) => {
    for (const supplier of Array.isArray(section) ? section : []) {
      const s = supplier as Record<string, any>;
      const gstin = String(s?.ctin ?? '').trim().toUpperCase();
      const filedOn = gstDate(s?.supfileddt);
      for (const note of Array.isArray(s?.nt) ? s.nt : []) {
        const n = note as Record<string, any>;
        const t = totalsOf(n?.items);
        const number = String(n?.ntnum ?? '').trim();
        if (!gstin || !number) continue;
        documents.push({
          supplierGstin: gstin,
          supplierName: s?.trdnm ? String(s.trdnm) : null,
          // 'C' is a credit note — it REDUCES the credit available. 'D' is a
          // debit note and adds to it.
          documentType: String(n?.typ ?? 'C').toUpperCase() === 'D' ? 'debit_note' : 'credit_note',
          documentNumber: number,
          matchKey: matchKeyFor(number),
          documentDate: gstDate(n?.dt),
          documentValue: r2(n?.val),
          taxableValue: t.taxableValue,
          igstAmount: t.igst,
          cgstAmount: t.cgst,
          sgstAmount: t.sgst,
          cessAmount: t.cess,
          taxAmount: r2(t.igst + t.cgst + t.sgst + t.cess),
          placeOfSupply: n?.pos ? String(n.pos) : null,
          itcAvailable: String(n?.itcavl ?? 'Y').toUpperCase() !== 'N',
          itcBlockedReason: n?.rsn ? String(n.rsn) : null,
          supplierFiledOn: filedOn,
          isAmendment,
        });
      }
    }
  };

  pushInvoices(docdata.b2b, false);
  pushInvoices(docdata.b2ba, true);
  pushNotes(docdata.cdnr, false);
  pushNotes(docdata.cdnra, true);

  // An amendment REPLACES the document it amends. Both in the list would claim
  // the credit twice — the same invoice, once at each set of figures.
  const byKey = new Map<string, Parsed2bDocument>();
  for (const d of documents) {
    const key = `${d.supplierGstin}:${d.documentType}:${d.matchKey}`;
    const existing = byKey.get(key);
    if (!existing || d.isAmendment) byKey.set(key, d);
  }

  const skippedSections = Object.keys(docdata).filter(
    (k) => !KNOWN_SECTIONS.has(k) && Array.isArray(docdata[k]) && docdata[k].length > 0,
  );

  return {
    returnPeriod,
    gstin: data.gstin ? String(data.gstin).trim().toUpperCase() : null,
    generatedAt: gstDate(data.gendt),
    version: data.version ? String(data.version) : null,
    documents: [...byKey.values()],
    skippedSections,
  };
}
