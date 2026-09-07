import { Response } from 'express';
import { type HospitalBranding } from '../../services/pdf-branding';
import {
  createBrandedDocument,
  finalizeBrandedDocument,
  drawKeyValueCard,
  drawSectionHeading,
  drawTable,
  ensureSpace,
} from '../../services/pdf-doc';
import type { PdfTemplate } from '../../services/pdf-template';
import { fullName } from '../../shared/person-name';
import {
  buildGstBlock,
  drawGstTaxSummary,
  gstChargeCells,
  gstChargeColumns,
  gstIdentityFields,
  treatmentLabelFor,
  type GstLine,
} from './billing.gst-layout';

// The itemised OP / counter bill.
//
// Its content already existed — but only inside the payment receipt, which is
// generated per PAYMENT. A bill nobody has paid yet therefore had no printable
// form at all, so a patient leaving with a pending or partly-paid bill could
// not be handed a copy of what they owe.
//
// It used to be deliberately NOT called a tax invoice, because healthcare is
// exempt under Notification 12/2017-Central Tax (Rate) and for most hospitals
// this is a bill of supply. That reasoning was right and the guess is no longer
// needed: finalising a bill now decides what it is from the lines on it and
// allots a number for it, so the paper states the answer rather than avoiding
// the question. An unregistered hospital keeps the title it always had.
//
// The columns come from `billing.gst-layout`, the same module the IP bill
// draws from, so the two documents cannot disagree about what kind of paper
// they are. Change one, change the other.

interface OpBillLike {
  id: string;
  billNumber: string;
  billDate: Date;
  status: string;
  subtotal: number | string;
  discountAmount: number | string;
  taxAmount: number | string;
  totalAmount: number | string;
  amountPaid: number | string;
  balanceDue: number | string;
  cancellationReason?: string | null;
  gstDocumentType?: string | null;
  invoiceNumber?: string | null;
  financialYear?: string | null;
  supplierGstin?: string | null;
  supplierStateCode?: string | null;
  recipientGstin?: string | null;
  placeOfSupplyStateCode?: string | null;
  isInterState?: boolean | null;
  patient: {
    firstName: string;
    lastName?: string | null;
    mrn?: string | null;
    phone?: string | null;
  };
  billItems: Array<{
    description: string;
    quantity: number;
    unitPrice: number | string;
    discountAmount: number | string;
    taxPercent: number | string;
    totalAmount: number | string;
    hsnSacCode?: string | null;
    gstTreatment?: string | null;
    taxableValue?: number | string | null;
    taxAmount?: number | string | null;
    cgstRate?: number | string | null;
    cgstAmount?: number | string | null;
    sgstRate?: number | string | null;
    sgstAmount?: number | string | null;
    igstRate?: number | string | null;
    igstAmount?: number | string | null;
    cessAmount?: number | string | null;
  }>;
  payments: Array<{
    amount: number | string;
    paymentMethod: string;
    paymentType: string;
    status: string;
    paymentDate: Date;
    transactionId?: string | null;
  }>;
}

// Two decimals always. The charge table beside this summary prints them, and
// "Subtotal ₹5,500" under a column of "₹5,000.00" reads as a different kind of
// number rather than the same one.
const fmt = (n: number | string | null | undefined) =>
  `₹${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const num = (n: number | string | null | undefined) => Number(n ?? 0);

export function streamOpBillPdf(
  res: Response,
  bill: OpBillLike,
  branding: HospitalBranding,
  template?: PdfTemplate,
  /** Whether this hospital charges GST at all. Absent means it does not. */
  profile: { registered: boolean; gstin?: string | null; stateCode?: string | null } = {
    registered: false,
  },
) {
  const isCancelled = bill.status === 'cancelled';

  const lines: GstLine[] = bill.billItems.map((i) => ({
    description: i.description,
    quantity: i.quantity,
    unitPrice: num(i.unitPrice),
    totalAmount: num(i.totalAmount),
    hsnSac: i.hsnSacCode ?? null,
    gstTreatment: i.gstTreatment ?? null,
    treatmentLabel: treatmentLabelFor(i.gstTreatment),
    taxRatePercent: num(i.taxPercent),
    // A line raised before any of this existed has no taxable value stored;
    // its own amount stands in, so the columns still add up.
    taxableValue: i.taxableValue == null ? num(i.totalAmount) : num(i.taxableValue),
    taxAmount: num(i.taxAmount),
    cgstRate: num(i.cgstRate), cgstAmount: num(i.cgstAmount),
    sgstRate: num(i.sgstRate), sgstAmount: num(i.sgstAmount),
    igstRate: num(i.igstRate), igstAmount: num(i.igstAmount),
    cessAmount: num(i.cessAmount),
  }));
  const gst = buildGstBlock(profile, [bill], lines);
  const anyTax = gst.hasTax || num(bill.taxAmount) > 0;

  const { pdf, theme } = createBrandedDocument({
    res,
    branding,
    template,
    // A cancelled bill says so on its face. Otherwise the issued document's own
    // name — a numbered Tax Invoice cannot print titled "Bill". A hospital that
    // is not registered issues no GST document and keeps the old default, and
    // the `op_bill` template's titleOverride still beats both.
    title: isCancelled ? 'Cancelled Bill' : (gst.documentLabel ?? 'Bill'),
    // The allotted number identifies this paper; the bill number is the
    // internal reference, and it stays on the card below.
    subtitle: gst.invoiceNumbers.length
      ? gst.invoiceNumbers.join(', ')
      : `Bill ${bill.billNumber}`,
    meta: [
      { label: 'Bill', value: bill.billNumber },
      {
        label: 'Date',
        value: new Date(bill.billDate).toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        }),
      },
    ],
    filename: `bill-${bill.billNumber}.pdf`,
  });

  drawKeyValueCard(pdf, theme, [
    ['Bill No', bill.billNumber],
    ['Date', new Date(bill.billDate).toLocaleString('en-IN')],
    ['Status', bill.status.replace(/_/g, ' ').toUpperCase()],
    // Never `first + ' ' + last`: a patient with no surname prints "null".
    ['Patient', fullName(bill.patient)],
    ['MRN', bill.patient.mrn ?? '—'],
    ['Phone', bill.patient.phone ?? '—'],
    ...gstIdentityFields(gst),
  ]);

  drawSectionHeading(pdf, theme, 'Charges');
  if (bill.billItems.length === 0) {
    pdf
      .font(theme.font.italic)
      .fontSize(theme.size.small)
      .fillColor(theme.muted)
      .text('No charges on this bill.', theme.margin, pdf.y, { width: theme.contentWidth });
    pdf.moveDown(0.6);
  } else {
    drawTable(
      pdf,
      theme,
      gstChargeColumns(gst, 'Description'),
      lines.map((l) => gstChargeCells(gst, l)),
    );
  }

  // The rate-wise summary, where there is tax to summarise.
  drawGstTaxSummary(pdf, theme, gst);

  // Summary, right-aligned against the content edge.
  const sumX = theme.margin + theme.contentWidth * 0.5;
  const sumW = theme.contentWidth * 0.5;
  const sumRow = (label: string, value: string, bold?: boolean) => {
    ensureSpace(pdf, theme, theme.size.body + 6);
    const y = pdf.y;
    pdf
      .font(bold ? theme.font.bold : theme.font.regular)
      .fontSize(theme.size.body)
      .fillColor(bold ? theme.ink : theme.muted)
      .text(label, sumX, y, { width: sumW * 0.55, lineBreak: false });
    pdf
      .font(bold ? theme.font.bold : theme.font.regular)
      .fillColor(theme.ink)
      .text(value, sumX + sumW * 0.55, y, { width: sumW * 0.45, align: 'right', lineBreak: false });
    pdf.y = y + theme.size.body + 5;
  };

  pdf.moveDown(0.4);
  sumRow('Subtotal', fmt(bill.subtotal));
  if (num(bill.discountAmount) > 0) sumRow('Discount', `− ${fmt(bill.discountAmount)}`);
  if (anyTax) sumRow('GST', fmt(bill.taxAmount));
  pdf
    .moveTo(sumX, pdf.y + 1)
    .lineTo(theme.margin + theme.contentWidth, pdf.y + 1)
    .strokeColor(theme.hairline)
    .lineWidth(0.5)
    .stroke();
  pdf.moveDown(0.2);
  sumRow('Total', fmt(bill.totalAmount), true);
  sumRow('Paid', fmt(bill.amountPaid));
  sumRow('Balance due', fmt(bill.balanceDue), true);
  pdf.moveDown(0.6);

  // What has been collected against it so far — the reason this document is
  // useful before the bill is settled as well as after.
  const settled = bill.payments.filter((p) => p.status === 'completed');
  if (settled.length > 0) {
    drawSectionHeading(pdf, theme, 'Payments received');
    drawTable(
      pdf,
      theme,
      [
        { header: 'Date', width: 0.28 },
        { header: 'Method', width: 0.24 },
        { header: 'Reference', width: 0.26 },
        { header: 'Amount', width: 0.22, align: 'right' },
      ],
      settled.map((p) => [
        new Date(p.paymentDate).toLocaleString('en-IN'),
        p.paymentMethod.replace(/_/g, ' ').toUpperCase() +
          (p.paymentType === 'refund' ? ' (refund)' : ''),
        p.transactionId ?? '—',
        `${p.paymentType === 'refund' ? '− ' : ''}${fmt(p.amount)}`,
      ]),
    );
  }

  if (isCancelled && bill.cancellationReason) {
    drawSectionHeading(pdf, theme, 'Cancellation reason');
    pdf
      .font(theme.font.regular)
      .fontSize(theme.size.body)
      .fillColor(theme.ink)
      .text(bill.cancellationReason, theme.margin, pdf.y, {
        width: theme.contentWidth,
        lineGap: theme.lineGap,
      });
    pdf.moveDown(0.5);
  }

  // Exempt supplies must not masquerade as taxed ones. Saying so plainly is
  // what a bill of supply is for. A taxed bill has already carried its notes
  // under the tax summary, so this is only for the untaxed case.
  if (!anyTax) {
    pdf
      .font(theme.font.italic)
      .fontSize(theme.size.small)
      .fillColor(theme.muted)
      .text(
        'Healthcare services are exempt from GST under Notification 12/2017-Central Tax (Rate).',
        theme.margin,
        pdf.y,
        { width: theme.contentWidth },
      );
  }

  finalizeBrandedDocument({ pdf, branding, theme });
}
