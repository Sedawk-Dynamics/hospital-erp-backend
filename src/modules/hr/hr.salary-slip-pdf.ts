import PDFDocument from 'pdfkit';
import { Response } from 'express';
import { drawBrandedHeader, drawBrandedFooters, type HospitalBranding } from '../../services/pdf-branding';

// Salary slip PDF — the hospital admin's PDF Builder letterhead/footer, then the
// slip meta block, earnings + deductions two-column table, net-pay highlight and
// a signature block.

interface SalarySlipLike {
  slipNumber: string;
  generatedAt: Date;
  payroll: {
    id: string;
    payPeriodStart: Date;
    payPeriodEnd: Date;
    basicSalary: number | string | null;
    allowances: number | string;
    overtimePay: number | string;
    deductions: number | string;
    taxDeduction: number | string;
    grossSalary: number | string | null;
    netSalary: number | string | null;
    status: string;
    paidAt?: Date | null;
    staff: {
      employeeId?: string | null;
      position?: string | null;
      dateOfJoining?: Date | null;
      user: { firstName: string; lastName?: string | null; email?: string | null };
      department?: { name: string } | null;
    };
  };
  tenant?: {
    name?: string | null;
    address?: string | null;
    city?: string | null;
    phone?: string | null;
    email?: string | null;
  } | null;
}

const fmt = (n: number | string | null | undefined) =>
  `₹${Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const monthLabel = (start: Date, end: Date) => {
  const s = new Date(start);
  const e = new Date(end);
  const sm = s.toLocaleString('en-IN', { month: 'short', year: 'numeric' });
  const em = e.toLocaleString('en-IN', { month: 'short', year: 'numeric' });
  return sm === em ? sm : `${sm} – ${em}`;
};

export function streamSalarySlipPdf(res: Response, branding: HospitalBranding, slip: SalarySlipLike) {
  const MARGIN = 42;
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
  const contentWidth = doc.page.width - MARGIN * 2;
  const filename = `salary-slip-${slip.slipNumber}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);

  // Branded letterhead + title + meta strip.
  drawBrandedHeader(doc, branding, {
    title: 'Salary Slip',
    margin: MARGIN,
    contentWidth,
    subtitle: monthLabel(slip.payroll.payPeriodStart, slip.payroll.payPeriodEnd),
    meta: [
      { label: 'Slip', value: slip.slipNumber },
      { label: 'Status', value: slip.payroll.status.toUpperCase() },
    ],
  });

  // Meta block (left = staff, right = pay period)
  const staff = slip.payroll.staff;
  const startY = doc.y;
  doc.font('Helvetica').fontSize(10).fillColor('#333');
  doc.text(`Name: ${staff.user.firstName} ${staff.user.lastName ?? ''}`.trim(), 40, startY);
  if (staff.employeeId) doc.text(`Emp ID: ${staff.employeeId}`, 40, doc.y);
  if (staff.position) doc.text(`Position: ${staff.position}`, 40, doc.y);
  if (staff.department?.name) doc.text(`Department: ${staff.department.name}`, 40, doc.y);
  if (staff.dateOfJoining) {
    doc.text(`Date of Joining: ${new Date(staff.dateOfJoining).toLocaleDateString('en-IN')}`, 40, doc.y);
  }

  doc.text(`Slip #: ${slip.slipNumber}`, 320, startY);
  doc.text(`Period: ${new Date(slip.payroll.payPeriodStart).toLocaleDateString('en-IN')} – ${new Date(slip.payroll.payPeriodEnd).toLocaleDateString('en-IN')}`, 320, doc.y);
  doc.text(`Status: ${slip.payroll.status.toUpperCase()}`, 320, doc.y);
  if (slip.payroll.paidAt) {
    doc.text(`Paid On: ${new Date(slip.payroll.paidAt).toLocaleDateString('en-IN')}`, 320, doc.y);
  }
  doc.text(`Generated: ${new Date(slip.generatedAt).toLocaleString('en-IN')}`, 320, doc.y);
  doc.moveDown(1);

  // Earnings / Deductions side-by-side
  const tableTop = doc.y;
  const leftX = 40;
  const leftValX = 220;
  const rightX = 320;
  const rightValX = 500;

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111');
  doc.text('Earnings', leftX, tableTop);
  doc.text('Deductions', rightX, tableTop);
  doc.moveTo(leftX, tableTop + 16).lineTo(290, tableTop + 16).strokeColor('#ddd').stroke();
  doc.moveTo(rightX, tableTop + 16).lineTo(555, tableTop + 16).strokeColor('#ddd').stroke();

  doc.font('Helvetica').fontSize(10).fillColor('#333');
  let leftY = tableTop + 22;
  let rightY = tableTop + 22;

  const earnRow = (label: string, value: string) => {
    doc.text(label, leftX, leftY);
    doc.text(value, leftValX, leftY, { width: 70, align: 'right' });
    leftY += 16;
  };
  const dedRow = (label: string, value: string) => {
    doc.text(label, rightX, rightY);
    doc.text(value, rightValX, rightY, { width: 55, align: 'right' });
    rightY += 16;
  };

  earnRow('Basic Salary', fmt(slip.payroll.basicSalary));
  earnRow('Allowances', fmt(slip.payroll.allowances));
  earnRow('Overtime Pay', fmt(slip.payroll.overtimePay));

  dedRow('General Deductions', fmt(slip.payroll.deductions));
  dedRow('Tax (TDS)', fmt(slip.payroll.taxDeduction));

  // Totals row
  const tEnd = Math.max(leftY, rightY) + 6;
  doc.moveTo(leftX, tEnd).lineTo(290, tEnd).strokeColor('#bbb').stroke();
  doc.moveTo(rightX, tEnd).lineTo(555, tEnd).strokeColor('#bbb').stroke();

  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111');
  doc.text('Gross', leftX, tEnd + 6);
  doc.text(fmt(slip.payroll.grossSalary), leftValX, tEnd + 6, { width: 70, align: 'right' });

  const totalDed = Number(slip.payroll.deductions ?? 0) + Number(slip.payroll.taxDeduction ?? 0);
  doc.text('Total Deductions', rightX, tEnd + 6);
  doc.text(fmt(totalDed), rightValX, tEnd + 6, { width: 55, align: 'right' });

  doc.y = tEnd + 30;
  doc.moveDown(1);

  // Net Pay highlight
  doc.rect(40, doc.y, 515, 36).fillAndStroke('#f1f8f4', '#86c79c');
  doc.fillColor('#0f5132').font('Helvetica-Bold').fontSize(13)
    .text('NET PAY', 56, doc.y + 12);
  doc.fillColor('#0f5132').font('Helvetica-Bold').fontSize(16)
    .text(fmt(slip.payroll.netSalary), 360, doc.y - 4, { width: 180, align: 'right' });
  doc.y += 28;
  doc.moveDown(2);

  // Signature footer
  doc.font('Helvetica').fontSize(9).fillColor('#666');
  doc.text('_________________________', 40, doc.y);
  doc.text('Employee Signature', 40, doc.y);

  doc.text('_________________________', 380, doc.y - 24);
  doc.text('HR / Authorised Signatory', 380, doc.y);

  // Branded footer (hospital name • generated • page X of Y • disclaimer).
  drawBrandedFooters(doc, branding, { margin: MARGIN, contentWidth });
  doc.end();
}
