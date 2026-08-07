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

// Receipt PDF — page setup, letterhead, table style, watermark and footer all
// come from the `payment_receipt` template in the PDF Builder; this file owns
// only the body: meta blocks, the bill line-item table, a bill summary, and the
// current receipt's payment details.

interface ReceiptLike {
  id: string;
  receiptNumber: string;
  receiptDate: Date;
  amount: number | string;
  payment: {
    id: string;
    amount: number | string;
    paymentMethod: string;
    paymentSource?: string | null;
    paymentType: string;
    transactionId?: string | null;
    notes?: string | null;
    paymentDate: Date;
    status: string;
    bill: {
      id: string;
      billNumber: string;
      totalAmount: number | string;
      amountPaid?: number | string;
      balanceDue?: number | string;
      subtotal?: number | string;
      discountAmount?: number | string;
      taxAmount?: number | string;
      status?: string;
      cancellationReason?: string | null;
      patient: {
        firstName: string;
        lastName: string;
        mrn?: string | null;
        phone?: string | null;
      };
      billItems?: Array<{
        description: string;
        quantity: number;
        unitPrice: number | string;
        totalAmount: number | string;
      }>;
    };
  };
  tenant?: {
    name?: string | null;
    address?: string | null;
    city?: string | null;
    phone?: string | null;
    email?: string | null;
    licenseNumber?: string | null;
  } | null;
}

const fmt = (n: number | string | null | undefined) =>
  `₹${Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export function streamReceiptPdf(
  res: Response,
  receipt: ReceiptLike,
  branding: HospitalBranding,
  template?: PdfTemplate,
) {
  const isCancellation = Number(receipt.amount) === 0 && receipt.payment.status === 'reversed';
  const isReversed = receipt.payment.status === 'reversed' && Number(receipt.amount) > 0;

  // Receipt title as the branded header's document title.
  let title = 'Payment Receipt';
  if (isCancellation) title = 'Bill Cancellation Receipt';
  else if (isReversed) title = 'Reversal Receipt';

  const { pdf, theme } = createBrandedDocument({
    res,
    branding,
    template,
    title,
    subtitle: `Bill ${receipt.payment.bill.billNumber}`,
    meta: [
      { label: 'Receipt', value: receipt.receiptNumber },
      { label: 'Date', value: new Date(receipt.receiptDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) },
    ],
    filename: `receipt-${receipt.receiptNumber}.pdf`,
  });
  // Who / what this receipt is for.
  drawKeyValueCard(pdf, theme, [
    ['Receipt No', receipt.receiptNumber],
    ['Bill No', receipt.payment.bill.billNumber],
    ['Date', new Date(receipt.receiptDate).toLocaleString('en-IN')],
    ['Txn Ref', receipt.payment.transactionId ?? '—'],
    ['Patient', `${receipt.payment.bill.patient.firstName} ${receipt.payment.bill.patient.lastName ?? ''}`.trim()],
    ['MRN', receipt.payment.bill.patient.mrn ?? '—'],
  ]);

  if (receipt.payment.bill.billItems && receipt.payment.bill.billItems.length > 0) {
    drawSectionHeading(pdf, theme, 'Bill items');
    drawTable(
      pdf,
      theme,
      [
        { header: 'Description', width: 0.52 },
        { header: 'Qty', width: 0.1, align: 'right' },
        { header: 'Unit', width: 0.17, align: 'right' },
        { header: 'Total', width: 0.21, align: 'right' },
      ],
      receipt.payment.bill.billItems.slice(0, 30).map((item) => [
        item.description,
        String(item.quantity),
        fmt(item.unitPrice),
        fmt(item.totalAmount),
      ]),
    );
  }

  // Bill summary, right-aligned against the content edge.
  drawSectionHeading(pdf, theme, 'Bill summary');
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
  sumRow('Subtotal', fmt(receipt.payment.bill.subtotal));
  sumRow('Discount', `− ${fmt(receipt.payment.bill.discountAmount)}`);
  sumRow('Tax', fmt(receipt.payment.bill.taxAmount));
  pdf
    .moveTo(sumX, pdf.y + 1)
    .lineTo(theme.margin + theme.contentWidth, pdf.y + 1)
    .strokeColor(theme.hairline)
    .lineWidth(0.5)
    .stroke();
  pdf.moveDown(0.2);
  sumRow('Total', fmt(receipt.payment.bill.totalAmount), true);
  sumRow('Paid', fmt(receipt.payment.bill.amountPaid));
  sumRow('Balance due', fmt(receipt.payment.bill.balanceDue), true);
  pdf.moveDown(0.6);

  drawSectionHeading(pdf, theme, 'This receipt');
  drawKeyValueCard(
    pdf,
    theme,
    [
      ['Amount', fmt(receipt.amount)],
      ['Method', receipt.payment.paymentMethod.replace('_', ' ').toUpperCase()],
      ['Type', receipt.payment.paymentType.toUpperCase()],
    ],
    3,
  );
  if (receipt.payment.notes) {
    pdf
      .font(theme.font.italic)
      .fontSize(theme.size.small)
      .fillColor(theme.muted)
      .text(`Notes: ${receipt.payment.notes}`, theme.margin, pdf.y, { width: theme.contentWidth });
    pdf.moveDown(0.5);
  }

  if (isCancellation && receipt.payment.bill.cancellationReason) {
    drawSectionHeading(pdf, theme, 'Cancellation reason');
    pdf
      .font(theme.font.regular)
      .fontSize(theme.size.body)
      .fillColor(theme.ink)
      .text(receipt.payment.bill.cancellationReason, theme.margin, pdf.y, {
        width: theme.contentWidth,
        lineGap: theme.lineGap,
      });
  }

  finalizeBrandedDocument({ pdf, branding, theme });
}
