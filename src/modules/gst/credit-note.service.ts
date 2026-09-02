// ---------------------------------------------------------------------------
// Issuing a credit note.
//
// Money goes back to a patient in eighteen different ways in this system and
// until now only one of them reversed the tax that went back with it. Output
// tax stayed declared on a supply that had been undone, so the hospital kept
// owing the department money on a sale it had already reversed.
//
// The rule this file exists to enforce: a credit note MIRRORS the lines it
// reverses. It copies their codes, their rates and their CGST/SGST split,
// scales them by how much actually came back, and negates them. It does not
// recompute anything from the masters — a rate that moved between the sale and
// the return would then produce a credit that does not equal its debit, and the
// difference would sit on the books with nothing to explain it.
//
// That mirroring is why a partial credit needs `billItemId`: it is the only way
// to know what proportion of which line came back. A refund recorded as an
// arbitrary rupee amount, which is what this system has today, cannot have its
// tax worked out at all.
// ---------------------------------------------------------------------------

import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { r2 } from '../../shared/gst';
import { allotDocumentNumber, financialYearFor } from './gst-document.service';

/** Why the money went back. Reported on the credit note register. */
export type CreditNoteReason =
  | 'sales_return'
  | 'cancellation'
  | 'post_supply_discount'
  | 'reversal'
  | 'correction';

/**
 * How much of a line is coming back.
 *
 * `share` is a proportion of the original line: 1 for the whole thing, 0.5 for
 * half. Given instead of an amount because the tax has to be scaled the same
 * way as the money, and a proportion is the only thing that guarantees they
 * stay consistent.
 */
export interface CreditLineInput {
  billItemId: string;
  share?: number;
}

export interface IssueCreditNoteInput {
  billId: string;
  reason: CreditNoteReason;
  reasonNote?: string | null;
  /** Omit to credit the WHOLE bill — a cancellation or a full refund. */
  lines?: CreditLineInput[];
  refundId?: string | null;
  drugReturnId?: string | null;
  issuedBy?: string | null;
  /** Defaults to now. Pass the document's own date when reversing an old one. */
  on?: Date;
}

/**
 * Can this note still reduce the hospital's tax liability?
 *
 * The deadline is 30 November following the end of the financial year the
 * original supply fell in. After it the money can still go back to the patient;
 * the tax simply cannot be recovered, and the accountant needs to see that
 * rather than discover it at filing time.
 */
export function isWithinCreditNoteTimeLimit(supplyDate: Date, issueDate: Date): boolean {
  const fy = financialYearFor(supplyDate);
  const startYear = Number(fy.slice(0, 4));
  // 30 November of the year AFTER the one the financial year started in.
  const deadline = new Date(Date.UTC(startYear + 1, 10, 30, 18, 29, 59, 999));
  return issueDate.getTime() <= deadline.getTime();
}

const r = (v: unknown, share: number) => r2(Number(v ?? 0) * share);

/**
 * Issue a credit note against a bill.
 *
 * Runs inside the caller's transaction so the note, its number and the money
 * movement it documents all commit together — a number handed to a note that
 * then rolls back is a permanent gap in the series.
 *
 * Returns null when there is nothing to credit, which is not a failure: a bill
 * with no lines, or a fully-credited one, simply has nothing left to reverse.
 */
export async function issueCreditNote(
  tx: any,
  tenantId: string,
  input: IssueCreditNoteInput,
): Promise<{ id: string; creditNoteNumber: string; totalAmount: number } | null> {
  const bill = await tx.bill.findFirst({
    where: { id: input.billId, tenantId },
    select: {
      id: true,
      patientId: true,
      billDate: true,
      supplierGstin: true,
      recipientGstin: true,
      placeOfSupplyStateCode: true,
    },
  });
  if (!bill) throw AppError.notFound('Bill not found');

  const wanted = new Map<string, number>();
  if (input.lines?.length) {
    for (const l of input.lines) {
      wanted.set(l.billItemId, Math.min(1, Math.max(0, l.share ?? 1)));
    }
  }

  const items = await tx.billItem.findMany({
    where: input.lines?.length
      ? { billId: bill.id, id: { in: [...wanted.keys()] } }
      : { billId: bill.id },
  });
  if (!items.length) return null;

  const on = input.on ?? new Date();
  // When specific lines are named, ONLY those are credited. Defaulting an
  // unnamed line to a full credit would turn a partial return into a total one
  // the moment the query returned a row that was not asked for.
  const named = wanted.size > 0;
  const rows = items
    .map((it: any) => {
      if (named && !wanted.has(it.id)) return null;
      const share = named ? (wanted.get(it.id) ?? 0) : 1;
      if (share <= 0) return null;
      return {
        billItemId: it.id,
        description: it.description,
        hsnSacCode: it.hsnSacCode ?? null,
        gstTreatment: it.gstTreatment ?? null,
        // Negative throughout: a credit note records what is coming OFF the
        // supply, and the register sums it against the invoices directly.
        quantity: r(it.quantity, -share),
        unitPrice: Number(it.unitPrice ?? 0),
        taxableValue: r(it.taxableValue, -share),
        taxPercent: Number(it.taxPercent ?? 0),
        taxAmount: r(it.taxAmount, -share),
        cgstAmount: r(it.cgstAmount, -share),
        sgstAmount: r(it.sgstAmount, -share),
        igstAmount: r(it.igstAmount, -share),
        cessAmount: r(it.cessAmount, -share),
        totalAmount: r(it.totalAmount, -share),
      };
    })
    .filter(Boolean) as Array<Record<string, any>>;

  if (!rows.length) return null;

  const sum = (k: string) => r2(rows.reduce((s, x) => s + Number(x[k] ?? 0), 0));
  const totalAmount = sum('totalAmount');
  // Nothing came back. A zero-value note is noise in the register.
  if (totalAmount === 0) return null;

  const { invoiceNumber, financialYear } = await allotDocumentNumber(
    tx,
    tenantId,
    'credit_note',
    on,
  );

  const withinTimeLimit = isWithinCreditNoteTimeLimit(bill.billDate ?? on, on);

  const note = await tx.creditNote.create({
    data: {
      tenantId,
      creditNoteNumber: invoiceNumber,
      billId: bill.id,
      patientId: bill.patientId ?? null,
      issueDate: on,
      financialYear,
      reason: input.reason,
      reasonNote: input.reasonNote ?? null,
      refundId: input.refundId ?? null,
      drugReturnId: input.drugReturnId ?? null,
      taxableValue: sum('taxableValue'),
      cgstAmount: sum('cgstAmount'),
      sgstAmount: sum('sgstAmount'),
      igstAmount: sum('igstAmount'),
      cessAmount: sum('cessAmount'),
      taxAmount: sum('taxAmount'),
      totalAmount,
      supplierGstin: bill.supplierGstin ?? null,
      placeOfSupplyStateCode: bill.placeOfSupplyStateCode ?? null,
      recipientGstin: bill.recipientGstin ?? null,
      withinTimeLimit,
      issuedBy: input.issuedBy ?? null,
      items: { create: rows },
    },
    select: { id: true, creditNoteNumber: true, totalAmount: true },
  });

  if (!withinTimeLimit) {
    // Not an error — the refund is legitimate and must go ahead. But the tax on
    // it is no longer recoverable, and that has to be visible rather than
    // discovered when the return does not balance.
    logger.warn(
      { tenantId, billId: bill.id, creditNoteNumber: note.creditNoteNumber },
      'Credit note raised after the 30 November deadline — the money goes back but the tax cannot be recovered',
    );
  }

  logger.info(
    {
      tenantId,
      billId: bill.id,
      creditNoteNumber: note.creditNoteNumber,
      reason: input.reason,
      totalAmount: Number(note.totalAmount),
    },
    'Credit note issued',
  );

  return {
    id: note.id,
    creditNoteNumber: note.creditNoteNumber,
    totalAmount: Number(note.totalAmount),
  };
}

/**
 * Issue a credit note without failing the money movement it documents.
 *
 * The refund or cancellation has already happened by the time this runs, and
 * refusing to hand a patient their money back because a document could not be
 * written would be the wrong trade. The gap is logged loudly instead, and the
 * credit-note register is what surfaces it.
 */
export async function issueCreditNoteBestEffort(
  tx: any,
  tenantId: string,
  input: IssueCreditNoteInput,
): Promise<void> {
  try {
    await issueCreditNote(tx, tenantId, input);
  } catch (err) {
    logger.error(
      { err, tenantId, billId: input.billId, reason: input.reason },
      'Could not issue a credit note for a reversal — the tax on it stays declared',
    );
  }
}
