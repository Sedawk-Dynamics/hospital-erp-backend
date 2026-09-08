// ---------------------------------------------------------------------------
// Issuing the document — what a finalised bill is CALLED, and its number.
//
// Two things the law asks for that this system has never had.
//
// A NAME. Every bill prints the word "Bill", which is not one of the documents
// GST recognises. What it should say follows from the lines: all exempt is a
// Bill of Supply, all taxable is a Tax Invoice, and the mixture — which is the
// ordinary hospital bill, a taxable room beside an exempt surgery — is an
// Invoice-cum-Bill of Supply under Rule 46A. Nobody chooses this; it is read
// off the bill.
//
// A NUMBER that is unique and CONSECUTIVE for the financial year, per hospital,
// per document type. The five series already here reset daily and are shared
// across tenants, so neither property holds. This adds a separate number that
// does, and leaves `billNumber` alone as the internal reference staff search by.
//
// Allotted at FINALISE, never at draft: an abandoned draft would otherwise burn
// a number and leave a hole, and a hole is the first thing an auditor asks
// about.
// ---------------------------------------------------------------------------

import { logger } from '../../config/logger';
import {
  resolveDocumentType,
  type GstDocumentType,
  DOCUMENT_TYPE_LABELS,
} from '../../shared/gst';

/**
 * Default prefixes, QUALIFIED BY THE HOSPITAL.
 *
 * `Bill.invoiceNumber` and `CreditNote.creditNoteNumber` are `@unique` —
 * GLOBALLY, not per tenant — while the counter that feeds them is scoped
 * `@@unique([tenantId, documentType, financialYear])`. Every hospital therefore
 * allotted `TI/2026-27/000001` for its first tax invoice, and the second
 * hospital to issue one hit the unique index. A P2002 inside a transaction
 * aborts the whole transaction, so the bill it belonged to rolls back and the
 * counter takes the desk down.
 *
 * The fix is NOT to make the counter global — each hospital's series has to be
 * continuous in its own right, which is the whole point of Rule 46(b). It is to
 * put the hospital in the number, which is what the GST report's own example
 * does: `GC/TI/26-27/000123`. Different hospitals, different strings, each
 * series unbroken.
 *
 * Existing series rows keep the prefix they were created with — their numbers
 * are already issued and a series does not get rewritten underneath a filed
 * return. Only a NEW series row is qualified, and since a series restarts every
 * financial year the changeover lands on the one boundary where it is clean.
 */
const DEFAULT_PREFIX: Record<string, string> = {
  tax_invoice: 'TI',
  bill_of_supply: 'BOS',
  invoice_cum_bill_of_supply: 'INV',
  credit_note: 'CN',
  debit_note: 'DN',
  receipt_voucher: 'RV',
  refund_voucher: 'RFV',
};

/** Zero-padded so lexicographic order is numeric order, as elsewhere here. */
const SEQ_WIDTH = 6;

/**
 * The Indian financial year a date falls in, as "2026-27".
 *
 * April to March, and the series restarts with it — that is the window the
 * uniqueness requirement is scoped to. Computed in IST, because a bill raised
 * at 02:00 on 1 April belongs to the new year and a server in UTC would still
 * be calling it 31 March.
 */
export function financialYearFor(date: Date): string {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth(); // 0 = January
  const startYear = month >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export interface DocumentDecision {
  documentType: GstDocumentType;
  label: string;
  requiresSeparateBillOfSupply: boolean;
}

/**
 * What this bill is, from what is on it.
 *
 * A line counts as taxable only when tax was actually charged. A `taxable` line
 * at a nil rate — a life-saving drug, say — belongs on the exempt side of this
 * decision, because the document type follows what the patient was charged and
 * not how the item is classified in the abstract.
 */
export function decideDocument(
  lines: Array<{ taxAmount: unknown; gstTreatment?: string | null }>,
  opts: { recipientGstin?: string | null } = {},
): DocumentDecision {
  let hasTaxable = false;
  let hasExempt = false;
  for (const l of lines) {
    if (Number(l.taxAmount ?? 0) > 0) hasTaxable = true;
    else hasExempt = true;
  }
  const r = resolveDocumentType({
    hasTaxable,
    hasExempt,
    recipientIsRegistered: !!opts.recipientGstin,
  });
  return {
    documentType: r.documentType,
    label: DOCUMENT_TYPE_LABELS[r.documentType],
    requiresSeparateBillOfSupply: r.requiresSeparateBillOfSupply,
  };
}

/**
 * Take the next number in a series, atomically.
 *
 * The counter row IS the sequence, and `increment` makes the read-modify-write
 * one statement under a row lock. Deriving the next number from a MAX() over
 * issued documents cannot be made safe: two counters finalising at the same
 * instant both read the same maximum, and one of them then fails a unique
 * index — or worse, does not, because the index is on a column that was left
 * nullable.
 *
 * Must run inside the caller's transaction so the number and the document it
 * belongs to commit together. A number handed out to a bill that then rolls
 * back is a permanent gap.
 */
/**
 * The prefix a NEW series row for this hospital should carry.
 *
 * `<HOSPITAL CODE>/<TYPE>` where the hospital has a code, else the bare type —
 * which is what every existing row already holds, so nothing already issued
 * moves. Uppercased and stripped of anything that would make the number awkward
 * to read back off a printed invoice.
 */
async function seriesPrefixFor(
  tx: any,
  tenantId: string,
  documentType: GstDocumentType,
): Promise<string> {
  const base = DEFAULT_PREFIX[documentType] ?? 'DOC';
  try {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { hospitalCode: true },
    });
    const code = String(tenant?.hospitalCode ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 6);
    return code ? `${code}/${base}` : base;
  } catch (err) {
    // A number must still be issued. An unqualified prefix is the behaviour
    // that has always been in place, and it is only a collision risk on a
    // platform with more than one registered hospital.
    logger.warn({ err, tenantId }, 'Could not read the hospital code for an invoice series prefix');
    return base;
  }
}

export async function allotDocumentNumber(
  tx: any,
  tenantId: string,
  documentType: GstDocumentType,
  on: Date,
): Promise<{ invoiceNumber: string; financialYear: string }> {
  const financialYear = financialYearFor(on);
  const prefix = await seriesPrefixFor(tx, tenantId, documentType);

  const series = await tx.gstDocumentSeries.upsert({
    where: {
      tenantId_documentType_financialYear: { tenantId, documentType, financialYear },
    },
    create: { tenantId, documentType, financialYear, prefix, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
    select: { prefix: true, lastNumber: true },
  });

  const invoiceNumber = `${series.prefix}/${financialYear}/${String(series.lastNumber).padStart(SEQ_WIDTH, '0')}`;
  return { invoiceNumber, financialYear };
}

/**
 * Name and number a bill as it is finalised.
 *
 * Best effort in one specific sense: a hospital that is not GST registered gets
 * no invoice number at all, and that is correct rather than a failure. It has no
 * series to draw from and nothing to file.
 */
export async function issueDocumentForBill(
  tx: any,
  tenantId: string,
  bill: {
    id: string;
    billDate: Date;
    recipientGstin?: string | null;
    invoiceNumber?: string | null;
  },
  lines: Array<{ taxAmount: unknown; gstTreatment?: string | null }>,
  opts: { registered: boolean },
): Promise<{ documentType: GstDocumentType; invoiceNumber: string | null } | null> {
  // Already issued. Re-finalising must never mint a second number for the same
  // document — that is how a series grows a duplicate.
  if (bill.invoiceNumber) return null;

  const decision = decideDocument(lines, { recipientGstin: bill.recipientGstin });

  if (!opts.registered) {
    // Unregistered: the document is still named, because a patient's bill
    // should say what it is, but there is no series and no number.
    await tx.bill.update({
      where: { id: bill.id },
      data: { gstDocumentType: decision.documentType, gstFrozenAt: new Date() },
    });
    return { documentType: decision.documentType, invoiceNumber: null };
  }

  const { invoiceNumber, financialYear } = await allotDocumentNumber(
    tx,
    tenantId,
    decision.documentType,
    bill.billDate ?? new Date(),
  );

  await tx.bill.update({
    where: { id: bill.id },
    data: {
      gstDocumentType: decision.documentType,
      invoiceNumber,
      financialYear,
      gstFrozenAt: new Date(),
    },
  });

  if (decision.requiresSeparateBillOfSupply) {
    // Rule 46A allows one combined document only for an UNREGISTERED recipient.
    // A registered one with both kinds of line is strictly owed two documents.
    // Logged rather than blocked: refusing to bill a corporate patient over a
    // paperwork split would be worse than issuing one document and saying so.
    logger.warn(
      { tenantId, billId: bill.id, invoiceNumber },
      'Mixed bill for a GST-registered recipient — a separate bill of supply is strictly required',
    );
  }

  return { documentType: decision.documentType, invoiceNumber };
}
