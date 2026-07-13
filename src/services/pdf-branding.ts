import type PDFKit from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { UPLOAD_DIR } from './upload.service';

// ---------------------------------------------------------------------------
// Per-hospital PDF branding — the letterhead/footer identity that every PDF and
// print in the app inherits. Configured by the hospital admin in the PDF Builder
// and stored per-tenant (see hospital-branding.service). This module is the
// single renderer so a change in the builder shows up everywhere consistently.
// ---------------------------------------------------------------------------

// Which optional bits appear on the document. Toggled by the hospital admin in
// the PDF Builder; the renderer + print view honour them.
export interface BrandingVisibility {
  tagline: boolean;
  address: boolean;
  phone: boolean;
  email: boolean;
  website: boolean;
  registrationNo: boolean;
  gstin: boolean;
  accreditation: boolean;
  footer: boolean;
}

export const DEFAULT_SHOW: BrandingVisibility = {
  tagline: true, address: true, phone: true, email: true, website: true,
  registrationNo: true, gstin: true, accreditation: true, footer: true,
};

export interface HospitalBranding {
  name: string;
  tagline: string | null;
  logoUrl: string | null; // e.g. /uploads/logo-123.png
  showLogo: boolean;
  headerStyle: 'centered' | 'left';
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  country: string | null;
  phone: string | null;
  altPhone: string | null;
  email: string | null;
  website: string | null;
  registrationNo: string | null;
  gstin: string | null;
  accreditation: string | null;
  footerText: string | null;
  accentColor: string; // hex
  show: BrandingVisibility;
}

export const DEFAULT_ACCENT = '#0f766e';

const INK = '#1a2332';
const MUTED = '#5b6472';

/** Absolute path to an uploaded logo, or null when missing/unset. */
export function resolveLogoPath(logoUrl?: string | null): string | null {
  if (!logoUrl) return null;
  const filename = logoUrl.replace(/^\/?uploads\//, '');
  const p = path.join(UPLOAD_DIR, filename);
  try {
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** The single-line address assembled from the parts. */
export function brandingAddressLine(b: HospitalBranding): string | null {
  const line = [b.addressLine1, b.addressLine2, [b.city, b.state].filter(Boolean).join(', '), b.pincode, b.country]
    .filter(Boolean)
    .join(', ');
  return line || null;
}

interface HeaderOpts {
  title: string;
  margin: number;
  contentWidth: number;
}

/**
 * Draw the hospital letterhead (logo + name + contact + reg lines + accent title
 * bar) at the top of the current page. Advances doc.y to just below the title.
 */
export function drawBrandedHeader(pdf: PDFKit.PDFDocument, b: HospitalBranding, opts: HeaderOpts) {
  const { title, margin, contentWidth } = opts;
  const accent = /^#[0-9a-fA-F]{6}$/.test(b.accentColor) ? b.accentColor : DEFAULT_ACCENT;
  const s = b.show ?? DEFAULT_SHOW;
  const left = margin;
  const logoPath = b.showLogo ? resolveLogoPath(b.logoUrl) : null;
  const showTagline = !!b.tagline && s.tagline;
  const addr = s.address ? brandingAddressLine(b) : null;
  const contact = [
    s.phone ? b.phone : null,
    s.phone ? b.altPhone : null,
    s.email ? b.email : null,
    s.website ? b.website : null,
  ]
    .filter(Boolean)
    .join('  •  ');
  const reg = [
    s.registrationNo && b.registrationNo ? `Reg. No: ${b.registrationNo}` : '',
    s.gstin && b.gstin ? `GSTIN: ${b.gstin}` : '',
    s.accreditation ? b.accreditation || '' : '',
  ]
    .filter(Boolean)
    .join('  •  ');

  const topY = margin;

  if (b.headerStyle === 'left' && logoPath) {
    // Logo on the left, hospital details to its right.
    try { pdf.image(logoPath, left, topY, { fit: [64, 64] }); } catch { /* ignore bad image */ }
    const tx = left + 76;
    const tw = contentWidth - 76;
    pdf.font('Helvetica-Bold').fontSize(17).fillColor(INK).text(b.name, tx, topY, { width: tw });
    if (showTagline) pdf.font('Helvetica-Oblique').fontSize(9).fillColor(accent).text(b.tagline ?? "", tx, pdf.y, { width: tw });
    pdf.font('Helvetica').fontSize(8.5).fillColor(MUTED);
    if (addr) pdf.text(addr, tx, pdf.y + 1, { width: tw });
    if (contact) pdf.text(contact, tx, pdf.y, { width: tw });
    if (reg) pdf.text(reg, tx, pdf.y, { width: tw });
    pdf.y = Math.max(pdf.y, topY + 64);
  } else {
    // Centered letterhead (logo centered above the name).
    if (logoPath) {
      try {
        pdf.image(logoPath, (pdf.page.width - 56) / 2, topY, { fit: [56, 56] });
        pdf.y = topY + 60;
      } catch { pdf.y = topY; }
    } else {
      pdf.y = topY;
    }
    pdf.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(b.name, left, pdf.y, { width: contentWidth, align: 'center' });
    if (showTagline) pdf.font('Helvetica-Oblique').fontSize(9).fillColor(accent).text(b.tagline ?? "", { width: contentWidth, align: 'center' });
    pdf.font('Helvetica').fontSize(8.5).fillColor(MUTED);
    if (addr) pdf.text(addr, { width: contentWidth, align: 'center' });
    if (contact) pdf.text(contact, { width: contentWidth, align: 'center' });
    if (reg) pdf.text(reg, { width: contentWidth, align: 'center' });
  }

  pdf.moveDown(0.5);
  // Accent title bar.
  const barY = pdf.y;
  pdf.rect(left, barY, contentWidth, 20).fill(accent);
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text(title.toUpperCase(), left, barY + 5.5, { width: contentWidth, align: 'center' });
  pdf.y = barY + 20;
  pdf.moveDown(0.55);
  pdf.fillColor(INK);
}

/**
 * Draw the footer (hospital name • page X of Y, and the branded disclaimer on
 * the last page) on every buffered page. Call right before doc.end().
 */
export function drawBrandedFooters(pdf: PDFKit.PDFDocument, b: HospitalBranding, opts: { margin: number; contentWidth: number }) {
  const { margin, contentWidth } = opts;
  const left = margin;
  const range = pdf.bufferedPageRange();
  const footer = b.footerText || 'This is a computer-generated document.';
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(range.start + i);
    // Writing into the bottom margin makes PDFKit auto-append a blank page (one
    // per write) — that's the "extra pages" bug. Drop the bottom margin for the
    // footer writes (and disable line-breaking) so no pages are added, then
    // restore it.
    const savedBottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    const fy = pdf.page.height - margin + 6;
    pdf.font('Helvetica').fontSize(7).fillColor(MUTED);
    pdf.text(b.name, left, fy, { width: contentWidth / 2, align: 'left', lineBreak: false });
    pdf.text(`Page ${i + 1} of ${range.count}`, left + contentWidth / 2, fy, { width: contentWidth / 2, align: 'right', lineBreak: false });
    if (i === range.count - 1 && (b.show?.footer ?? true)) {
      pdf.fillColor(MUTED).fontSize(6.8).text(footer, left, fy + 9, { width: contentWidth, align: 'center', lineBreak: false });
    }
    pdf.page.margins.bottom = savedBottom;
  }
}
