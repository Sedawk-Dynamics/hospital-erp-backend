import PDFDocument from 'pdfkit';
import { Response } from 'express';
import { drawBrandedHeader, drawBrandedFooters, type HospitalBranding } from '../../services/pdf-branding';

// Receipt PDF — uses the hospital admin's PDF Builder letterhead/footer (same
// look as every other document), then the receipt body: meta blocks, the bill
// line-item table, a bill summary, and the current receipt's payment details.

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

export function streamReceiptPdf(res: Response, receipt: ReceiptLike, branding: HospitalBranding) {
  const MARGIN = 42;
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
  const contentWidth = doc.page.width - MARGIN * 2;
  const filename = `receipt-${receipt.receiptNumber}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);

  const isCancellation = Number(receipt.amount) === 0 && receipt.payment.status === 'reversed';
  const isReversed = receipt.payment.status === 'reversed' && Number(receipt.amount) > 0;

  // Receipt title as the branded header's document title.
  let title = 'Payment Receipt';
  if (isCancellation) title = 'Bill Cancellation Receipt';
  else if (isReversed) title = 'Reversal Receipt';

  // Branded letterhead + title bar + meta strip (Receipt no + Date).
  drawBrandedHeader(doc, branding, {
    title,
    margin: MARGIN,
    contentWidth,
    subtitle: `Bill ${receipt.payment.bill.billNumber}`,
    meta: [
      { label: 'Receipt', value: receipt.receiptNumber },
      { label: 'Date', value: new Date(receipt.receiptDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) },
    ],
  });

  // Meta — left/right blocks
  const startY = doc.y;
  doc.font('Helvetica').fontSize(10).fillColor('#333');
  doc.text(`Receipt #: ${receipt.receiptNumber}`, 40, startY);
  doc.text(`Bill #: ${receipt.payment.bill.billNumber}`, 40, doc.y);
  doc.text(`Date: ${new Date(receipt.receiptDate).toLocaleString('en-IN')}`, 40, doc.y);
  if (receipt.payment.transactionId) {
    doc.text(`Txn Ref: ${receipt.payment.transactionId}`, 40, doc.y);
  }

  doc.text(`Patient: ${receipt.payment.bill.patient.firstName} ${receipt.payment.bill.patient.lastName}`, 320, startY);
  doc.text(`MRN: ${receipt.payment.bill.patient.mrn ?? '-'}`, 320, doc.y);
  if (receipt.payment.bill.patient.phone) {
    doc.text(`Phone: ${receipt.payment.bill.patient.phone}`, 320, doc.y);
  }
  doc.moveDown(1);

  // Bill items
  if (receipt.payment.bill.billItems && receipt.payment.bill.billItems.length > 0) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('Bill Items');
    doc.moveDown(0.2);
    const tableTop = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555');
    doc.text('Description', 40, tableTop, { width: 260 });
    doc.text('Qty', 320, tableTop, { width: 40, align: 'right' });
    doc.text('Unit', 370, tableTop, { width: 70, align: 'right' });
    doc.text('Total', 460, tableTop, { width: 85, align: 'right' });
    doc.moveTo(40, doc.y + 2).lineTo(555, doc.y + 2).strokeColor('#ddd').stroke();
    doc.moveDown(0.4);

    doc.font('Helvetica').fontSize(9).fillColor('#333');
    for (const item of receipt.payment.bill.billItems.slice(0, 30)) {
      const y = doc.y;
      doc.text(item.description, 40, y, { width: 260 });
      doc.text(String(item.quantity), 320, y, { width: 40, align: 'right' });
      doc.text(fmt(item.unitPrice), 370, y, { width: 70, align: 'right' });
      doc.text(fmt(item.totalAmount), 460, y, { width: 85, align: 'right' });
      doc.moveDown(0.4);
    }
    doc.moveDown(0.4);
  }

  // Bill summary on the right
  const sumX = 320;
  const valX = 480;
  const sumStart = doc.y;
  doc.font('Helvetica').fontSize(10).fillColor('#444');
  const sumRow = (label: string, value: string, bold?: boolean) => {
    if (bold) doc.font('Helvetica-Bold');
    else doc.font('Helvetica');
    const y = doc.y;
    doc.text(label, sumX, y);
    doc.text(value, valX, y, { width: 75, align: 'right' });
  };
  sumRow('Subtotal', fmt(receipt.payment.bill.subtotal));
  sumRow('Discount', `− ${fmt(receipt.payment.bill.discountAmount)}`);
  sumRow('Tax', fmt(receipt.payment.bill.taxAmount));
  doc.moveTo(sumX, doc.y + 2).lineTo(555, doc.y + 2).strokeColor('#ddd').stroke();
  doc.moveDown(0.2);
  sumRow('Total', fmt(receipt.payment.bill.totalAmount), true);
  sumRow('Paid', fmt(receipt.payment.bill.amountPaid));
  sumRow('Balance Due', fmt(receipt.payment.bill.balanceDue), true);
  doc.moveDown(0.6);

  // This receipt block
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('This Receipt');
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(10).fillColor('#333');
  const r = doc.y;
  doc.text(`Amount: ${fmt(receipt.amount)}`, 40, r);
  doc.text(`Method: ${receipt.payment.paymentMethod.replace('_', ' ').toUpperCase()}`, 220, r);
  doc.text(`Type: ${receipt.payment.paymentType.toUpperCase()}`, 400, r);
  doc.moveDown(0.4);
  if (receipt.payment.notes) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#555').text(`Notes: ${receipt.payment.notes}`);
  }

  if (isCancellation && receipt.payment.bill.cancellationReason) {
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#b00').text('Cancellation Reason:');
    doc.font('Helvetica').fontSize(10).fillColor('#444').text(receipt.payment.bill.cancellationReason);
  }

  // Branded footer (hospital name • generated • page X of Y • disclaimer).
  drawBrandedFooters(doc, branding, { margin: MARGIN, contentWidth });
  doc.end();
}
