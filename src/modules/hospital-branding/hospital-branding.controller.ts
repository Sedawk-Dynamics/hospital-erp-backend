import { Response, NextFunction } from 'express';
import PDFDocument from 'pdfkit';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import { AppError } from '../../shared/appError';
import * as service from './hospital-branding.service';
import { drawBrandedHeader, drawBrandedFooters, type HospitalBranding, DEFAULT_ACCENT } from '../../services/pdf-branding';

export async function getBranding(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getHospitalBranding(req.user!.tenantId);
    sendResponse({ res, message: 'Hospital PDF branding', data });
  } catch (err) {
    next(err);
  }
}

export async function updateBranding(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateHospitalBranding(req.user!.tenantId, req.body ?? {});
    sendResponse({ res, message: 'Branding saved — it now appears on every PDF and print.', data });
  } catch (err) {
    next(err);
  }
}

export async function uploadLogo(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) throw AppError.badRequest('No image uploaded. Attach a PNG, JPG or WebP file.');
    const data = await service.setBrandingLogo(req.user!.tenantId, file.filename);
    sendResponse({ res, statusCode: 201, message: 'Logo updated', data });
  } catch (err) {
    next(err);
  }
}

export async function removeLogo(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.removeBrandingLogo(req.user!.tenantId);
    sendResponse({ res, message: 'Logo removed', data });
  } catch (err) {
    next(err);
  }
}

// Merge posted (possibly-unsaved) form values over the saved branding so the
// preview shows exactly what the admin is editing right now.
function coerce(body: Record<string, unknown>, base: HospitalBranding): HospitalBranding {
  const s = (k: string): string | null => (typeof body[k] === 'string' ? (body[k] as string) : (base as never)[k as never] ?? null);
  return {
    name: (typeof body.name === 'string' && body.name.trim()) || base.name,
    tagline: s('tagline'),
    logoUrl: base.logoUrl,
    showLogo: typeof body.showLogo === 'boolean' ? body.showLogo : base.showLogo,
    headerStyle: body.headerStyle === 'left' ? 'left' : 'centered',
    addressLine1: s('addressLine1'),
    addressLine2: s('addressLine2'),
    city: s('city'),
    state: s('state'),
    pincode: s('pincode'),
    country: s('country'),
    phone: s('phone'),
    altPhone: s('altPhone'),
    email: s('email'),
    website: s('website'),
    registrationNo: s('registrationNo'),
    gstin: s('gstin'),
    accreditation: s('accreditation'),
    footerText: s('footerText'),
    accentColor: typeof body.accentColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.accentColor) ? body.accentColor : base.accentColor || DEFAULT_ACCENT,
    show: { ...base.show, ...(body.show && typeof body.show === 'object' ? (body.show as Partial<HospitalBranding['show']>) : {}) },
  };
}

// The preview can mimic any of the real document types so the admin sees the
// letterhead in context, not just an abstract sample.
type PreviewType = 'prescription' | 'discharge' | 'receipt';
const PREVIEW_DOCS: Record<PreviewType, { title: string; subtitle: string; meta: Array<{ label: string; value: string }> }> = {
  prescription: { title: 'Prescription', subtitle: 'Outpatient (OP)', meta: [{ label: 'Date', value: '' }, { label: 'Rx No', value: 'RX-8A31C2' }] },
  discharge: { title: 'Discharge Summary', subtitle: 'Inpatient (IP)', meta: [{ label: 'MRN', value: 'MRN-000000' }, { label: 'Doc No', value: 'DS-4F19AB' }] },
  receipt: { title: 'Payment Receipt', subtitle: 'Bill INV-000123', meta: [{ label: 'Receipt', value: 'RCP-000045' }, { label: 'Date', value: '' }] },
};

// A live sample PDF so the admin sees their letterhead exactly as it will print.
export async function previewPdf(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const saved = await service.getHospitalBranding(req.user!.tenantId);
    const b = coerce(body, saved);
    const type: PreviewType = (['prescription', 'discharge', 'receipt'] as const).includes(body.previewType as PreviewType)
      ? (body.previewType as PreviewType)
      : 'prescription';
    const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const docDef = PREVIEW_DOCS[type];
    const meta = docDef.meta.map((m) => ({ label: m.label, value: m.value || today }));

    const margin = 42;
    const pdf = new PDFDocument({ size: 'A4', margin, bufferPages: true });
    const contentWidth = pdf.page.width - margin * 2;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="branding-preview.pdf"');
    pdf.pipe(res);

    drawBrandedHeader(pdf, b, { title: docDef.title, subtitle: docDef.subtitle, meta, margin, contentWidth });

    const left = margin;
    const accent = b.accentColor;
    // Mock patient / info card.
    const info: Array<[string, string]> = type === 'receipt'
      ? [['Patient Name', 'Sample Patient'], ['MRN / UHID', 'MRN-000000'], ['Bill No', 'INV-000123'], ['Date', today]]
      : [['Patient Name', 'Sample Patient'], ['MRN / UHID', 'MRN-000000'], ['Age / Gender', '42 / Male'], ['Doctor', 'Dr. A. Sharma']];
    const colW = contentWidth / 2, rowH = 26, rows = Math.ceil(info.length / 2);
    const top = pdf.y;
    pdf.rect(left, top, contentWidth, rows * rowH).fillAndStroke('#eef2f5', '#c9ced6');
    info.forEach(([k, v], i) => {
      const x = left + (i % 2) * colW + 8, y = top + Math.floor(i / 2) * rowH + 5;
      pdf.font('Helvetica-Bold').fontSize(7).fillColor('#5b6472').text(k.toUpperCase(), x, y, { width: colW - 16 });
      pdf.font('Helvetica').fontSize(9).fillColor('#1a2332').text(v, x, y + 9, { width: colW - 16 });
    });
    pdf.y = top + rows * rowH + 12;

    const heading = (t: string) => {
      const y = pdf.y;
      pdf.rect(left, y, 3, 12).fill(accent);
      pdf.font('Helvetica-Bold').fontSize(10.5).fillColor('#1a2332').text(t.toUpperCase(), left + 8, y, { width: contentWidth - 8 });
      pdf.moveDown(0.4);
    };

    // A representative body per document type.
    const th = type === 'receipt' ? ['Item', 'Qty', 'Amount'] : ['Medication', 'Dosage', 'Frequency'];
    const tr = type === 'receipt'
      ? [['Consultation — General OPD', '1', '₹500.00'], ['Investigation — CBC', '1', '₹350.00']]
      : [['Paracetamol 650mg (Acetaminophen)', '1 tab', '1-1-1 · 5 days'], ['Pantoprazole 40mg', '1 tab', '1-0-0 · 5 days']];
    heading(type === 'receipt' ? 'Bill items' : type === 'discharge' ? 'Medications on discharge' : '℞  Medications');
    const widths = type === 'receipt' ? [contentWidth * 0.6, contentWidth * 0.15, contentWidth * 0.25] : [contentWidth * 0.5, contentWidth * 0.2, contentWidth * 0.3];
    let hy = pdf.y;
    pdf.rect(left, hy, contentWidth, 16).fill(accent);
    let hx = left;
    th.forEach((h, i) => { pdf.font('Helvetica-Bold').fontSize(8).fillColor('#fff').text(h.toUpperCase(), hx + 4, hy + 4.5, { width: widths[i] - 8 }); hx += widths[i]; });
    pdf.y = hy + 16;
    tr.forEach((r, idx) => {
      const ry = pdf.y;
      if (idx % 2) pdf.rect(left, ry, contentWidth, 16).fill('#eef2f5');
      let rx = left;
      r.forEach((c, i) => { pdf.font('Helvetica').fontSize(8).fillColor('#1a2332').text(c, rx + 4, ry + 4, { width: widths[i] - 8 }); rx += widths[i]; });
      pdf.y = ry + 16;
    });
    pdf.moveDown(0.8);

    heading('About this preview');
    pdf.font('Helvetica').fontSize(9).fillColor('#2a3240').text(
      'This letterhead and footer appear on every PDF and print the system produces — discharge summaries, prescriptions, bills, receipts, salary slips, lab & radiology reports and more. Switch the preview above to see different documents. Edit the fields on the left and this updates live. Nothing here is a real record.',
      left, pdf.y, { width: contentWidth, lineGap: 2 },
    );

    drawBrandedFooters(pdf, b, { margin, contentWidth });
    pdf.end();
  } catch (err) {
    next(err);
  }
}
