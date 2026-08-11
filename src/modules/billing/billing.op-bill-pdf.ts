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

// The itemised OP / counter bill.
//
// Its content already existed — but only inside the payment receipt, which is
// generated per PAYMENT. A bill nobody has paid yet therefore had no printable
// form at all, so a patient leaving with a pending or partly-paid bill could
// not be handed a copy of what they owe.
//
// Deliberately NOT called a tax invoice. Healthcare services in India are
// GST-exempt under Notification 12/2017-Central Tax (Rate), so for most
// hospitals this is a bill of supply; the title comes from the `op_bill`
// template so an admin can name it whatever their auditor expects. The tax
// column and the tax row only appear when something on the bill is actually
// taxed — printing "Tax ₹0" on every exempt line is noise.

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

const fmt = (n: number | string | null | undefined) =>
  `₹${Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const num = (n: number | string | null | undefined) => Number(n ?? 0);

export function streamOpBillPdf(
  res: Response,
  bill: OpBillLike,
  branding: HospitalBranding,
  template?: PdfTemplate,
) {
  const isCancelled = bill.status === 'cancelled';
  const anyTax = bill.billItems.some((i) => num(i.taxPercent) > 0) || num(bill.taxAmount) > 0;

  const { pdf, theme } = createBrandedDocument({
    res,
    branding,
    template,
    // A cancelled bill says so on its face. Otherwise this is the default, and
    // the `op_bill` template's own titleOverride replaces it — so an admin can
    // call it "Bill of Supply", or whatever their auditor expects, without code.
    title: isCancelled ? 'Cancelled Bill' : 'Bill',
    subtitle: `Bill ${bill.billNumber}`,
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
    ['Patient', `${bill.patient.firstName} ${bill.patient.lastName ?? ''}`.trim()],
    ['MRN', bill.patient.mrn ?? '—'],
    ['Phone', bill.patient.phone ?? '—'],
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
    // The tax column earns its place only when something is taxed.
    const columns = anyTax
      ? [
          { header: 'Description', width: 0.42 },
          { header: 'Qty', width: 0.08, align: 'right' as const },
          { header: 'Rate', width: 0.15, align: 'right' as const },
          { header: 'GST', width: 0.14, align: 'right' as const },
          { header: 'Amount', width: 0.21, align: 'right' as const },
        ]
      : [
          { header: 'Description', width: 0.52 },
          { header: 'Qty', width: 0.1, align: 'right' as const },
          { header: 'Rate', width: 0.17, align: 'right' as const },
          { header: 'Amount', width: 0.21, align: 'right' as const },
        ];

    drawTable(
      pdf,
      theme,
      columns,
      bill.billItems.map((item) => {
        const base = [item.description, String(item.quantity), fmt(item.unitPrice)];
        const tax = num(item.taxPercent) > 0 ? `${num(item.taxPercent)}%` : '—';
        return anyTax
          ? [...base, tax, fmt(item.totalAmount)]
          : [...base, fmt(item.totalAmount)];
      }),
    );
  }

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
  // what a bill of supply is for.
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
