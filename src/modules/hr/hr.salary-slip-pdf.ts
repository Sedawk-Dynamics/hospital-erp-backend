import { Response } from 'express';
import { type HospitalBranding } from '../../services/pdf-branding';
import {
  createBrandedDocument,
  finalizeBrandedDocument,
  drawKeyValueCard,
  drawSectionHeading,
  drawTable,
} from '../../services/pdf-doc';
import type { PdfTemplate } from '../../services/pdf-template';

// Salary slip PDF — page setup, letterhead, fonts, colours, watermark and footer
// come from the `salary_slip` template in the PDF Builder; this file owns the
// slip meta card, the earnings + deductions table and the net-pay highlight.
// The signing lines are the template's signature block, so a hospital that wants
// three signatories (or none) sets that in the builder.

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

export function streamSalarySlipPdf(
  res: Response,
  branding: HospitalBranding,
  slip: SalarySlipLike,
  template?: PdfTemplate,
) {
  const staff = slip.payroll.staff;
  const { pdf, theme } = createBrandedDocument({
    res,
    branding,
    template,
    title: 'Salary Slip',
    subtitle: monthLabel(slip.payroll.payPeriodStart, slip.payroll.payPeriodEnd),
    meta: [
      { label: 'Slip', value: slip.slipNumber },
      { label: 'Status', value: slip.payroll.status.toUpperCase() },
    ],
    filename: `salary-slip-${slip.slipNumber}.pdf`,
  });

  const d = (v: Date | string | null | undefined) =>
    v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

  drawKeyValueCard(pdf, theme, [
    ['Employee', `${staff.user.firstName} ${staff.user.lastName ?? ''}`.trim()],
    ['Employee ID', staff.employeeId ?? '—'],
    ['Designation', staff.position ?? '—'],
    ['Department', staff.department?.name ?? '—'],
    ['Date of joining', d(staff.dateOfJoining)],
    ['Pay period', `${d(slip.payroll.payPeriodStart)} – ${d(slip.payroll.payPeriodEnd)}`],
    ['Status', slip.payroll.status.toUpperCase()],
    ['Paid on', slip.payroll.paidAt ? d(slip.payroll.paidAt) : 'Not paid yet'],
  ]);

  const totalDed = Number(slip.payroll.deductions ?? 0) + Number(slip.payroll.taxDeduction ?? 0);

  drawSectionHeading(pdf, theme, 'Earnings & deductions');
  drawTable(
    pdf,
    theme,
    [
      { header: 'Component', width: 0.5 },
      { header: 'Earnings', width: 0.25, align: 'right' },
      { header: 'Deductions', width: 0.25, align: 'right' },
    ],
    [
      ['Basic salary', fmt(slip.payroll.basicSalary), '—'],
      ['Allowances', fmt(slip.payroll.allowances), '—'],
      ['Overtime pay', fmt(slip.payroll.overtimePay), '—'],
      ['General deductions', '—', fmt(slip.payroll.deductions)],
      ['Tax (TDS)', '—', fmt(slip.payroll.taxDeduction)],
      ['Total', fmt(slip.payroll.grossSalary), fmt(totalDed)],
    ],
  );

  // Net pay highlight — the one number the employee looks for.
  const boxH = theme.size.body + 26;
  const boxY = pdf.y;
  pdf.rect(theme.margin, boxY, theme.contentWidth, boxH).fillAndStroke('#f1f8f4', '#86c79c');
  pdf
    .font(theme.font.bold)
    .fontSize(theme.size.heading + 1)
    .fillColor('#0f5132')
    .text('NET PAY', theme.margin + 14, boxY + (boxH - theme.size.heading) / 2 - 1, {
      width: theme.contentWidth * 0.5,
      lineBreak: false,
    });
  pdf
    .font(theme.font.bold)
    .fontSize(theme.size.heading + 4)
    .fillColor('#0f5132')
    .text(fmt(slip.payroll.netSalary), theme.margin + theme.contentWidth * 0.5, boxY + (boxH - theme.size.heading - 4) / 2 - 1, {
      width: theme.contentWidth * 0.5 - 14,
      align: 'right',
      lineBreak: false,
    });
  pdf.y = boxY + boxH + 6;

  finalizeBrandedDocument({ pdf, branding, theme });
}
