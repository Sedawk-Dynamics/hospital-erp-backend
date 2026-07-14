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
const HAIRLINE = '#d3d8de';

/** A slim key/value shown in the header meta strip (e.g. Date, Document No). */
export interface PdfMetaItem {
  label: string;
  value: string;
}

/** Lighten a hex colour toward white by `amount` (0..1) — for soft accent fills. */
export function tintHex(hex: string, amount: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const to2 = (c: number) => c.toString(16).padStart(2, '0');
  return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`;
}

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
  /** Optional right-hand meta shown in a slim strip under the title bar. */
  meta?: PdfMetaItem[];
  /** Optional small subtitle shown at the left of the meta strip. */
  subtitle?: string;
}

/**
 * Draw the hospital letterhead (logo + name + contact + reg lines + accent title
 * bar + optional meta strip) at the top of the current page. Advances doc.y to
 * just below the header block.
 */
export function drawBrandedHeader(pdf: PDFKit.PDFDocument, b: HospitalBranding, opts: HeaderOpts) {
  const { title, margin, contentWidth, meta, subtitle } = opts;
  const accent = /^#[0-9a-fA-F]{6}$/.test(b.accentColor) ? b.accentColor : DEFAULT_ACCENT;
  const s = b.show ?? DEFAULT_SHOW;
  const left = margin;
  const right = left + contentWidth;
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

  // A slim accent rule across the very top of the page — a subtle letterhead cue.
  pdf.rect(left, margin - 14, contentWidth, 3).fill(accent);

  const topY = margin;

  if (b.headerStyle === 'left' && logoPath) {
    // Logo on the left, hospital details to its right.
    try { pdf.image(logoPath, left, topY, { fit: [66, 66] }); } catch { /* ignore bad image */ }
    const tx = left + 80;
    const tw = contentWidth - 80;
    pdf.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(b.name, tx, topY, { width: tw });
    if (showTagline) pdf.font('Helvetica-Oblique').fontSize(9).fillColor(accent).text(b.tagline ?? "", tx, pdf.y, { width: tw });
    pdf.font('Helvetica').fontSize(8.5).fillColor(MUTED);
    if (addr) pdf.text(addr, tx, pdf.y + 1, { width: tw });
    if (contact) pdf.text(contact, tx, pdf.y, { width: tw });
    if (reg) pdf.text(reg, tx, pdf.y, { width: tw });
    pdf.y = Math.max(pdf.y, topY + 66);
  } else {
    // Centered letterhead (logo centered above the name).
    if (logoPath) {
      try {
        pdf.image(logoPath, (pdf.page.width - 58) / 2, topY, { fit: [58, 58] });
        pdf.y = topY + 62;
      } catch { pdf.y = topY; }
    } else {
      pdf.y = topY;
    }
    pdf.font('Helvetica-Bold').fontSize(19).fillColor(INK).text(b.name, left, pdf.y, { width: contentWidth, align: 'center' });
    if (showTagline) pdf.font('Helvetica-Oblique').fontSize(9).fillColor(accent).text(b.tagline ?? "", { width: contentWidth, align: 'center' });
    pdf.font('Helvetica').fontSize(8.5).fillColor(MUTED);
    if (addr) pdf.text(addr, { width: contentWidth, align: 'center' });
    if (contact) pdf.text(contact, { width: contentWidth, align: 'center' });
    if (reg) pdf.text(reg, { width: contentWidth, align: 'center' });
  }

  // Hairline divider under the letterhead.
  pdf.moveDown(0.45);
  pdf.moveTo(left, pdf.y).lineTo(right, pdf.y).strokeColor(HAIRLINE).lineWidth(0.6).stroke();
  pdf.moveDown(0.5);

  // Accent title bar with rounded corners.
  const barY = pdf.y;
  const barH = 22;
  pdf.roundedRect(left, barY, contentWidth, barH, 3).fill(accent);
  pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11.5).text(title.toUpperCase(), left + 10, barY + 6, { width: contentWidth - 20, align: 'center', characterSpacing: 0.8 });
  pdf.y = barY + barH;

  // Optional meta strip (light band): subtitle on the left, key/values on the right.
  if ((meta && meta.length) || subtitle) {
    const stripY = pdf.y;
    const stripH = 16;
    pdf.rect(left, stripY, contentWidth, stripH).fill(tintHex(accent, 0.9));
    pdf.rect(left, stripY, contentWidth, stripH).lineWidth(0.4).strokeColor(tintHex(accent, 0.6)).stroke();
    if (subtitle) {
      pdf.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(subtitle, left + 8, stripY + 4.5, { width: contentWidth * 0.45, lineBreak: false });
    }
    if (meta && meta.length) {
      const metaText = meta.map((m) => `${m.label}: ${m.value}`).join('    •    ');
      pdf.font('Helvetica').fontSize(8).fillColor(MUTED).text(metaText, left + contentWidth * 0.35 - 8, stripY + 4.5, { width: contentWidth * 0.65, align: 'right', lineBreak: false });
    }
    pdf.y = stripY + stripH;
  }

  pdf.moveDown(0.6);
  pdf.fillColor(INK);
}

/**
 * Draw the footer (hospital name • page X of Y, and the branded disclaimer on
 * the last page) on every buffered page. Call right before doc.end().
 */
export function drawBrandedFooters(
  pdf: PDFKit.PDFDocument,
  b: HospitalBranding,
  opts: { margin: number; contentWidth: number; generatedAt?: Date },
) {
  const { margin, contentWidth } = opts;
  const left = margin;
  const accent = /^#[0-9a-fA-F]{6}$/.test(b.accentColor) ? b.accentColor : DEFAULT_ACCENT;
  const range = pdf.bufferedPageRange();
  const footer = b.footerText || 'This is a computer-generated document.';
  const gen = opts.generatedAt ?? new Date();
  const genStr = gen.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(range.start + i);
    // Writing into the bottom margin makes PDFKit auto-append a blank page (one
    // per write) — that's the "extra pages" bug. Drop the bottom margin for the
    // footer writes (and disable line-breaking) so no pages are added, then
    // restore it.
    const savedBottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    const fy = pdf.page.height - margin + 4;
    // Thin accent rule above the footer.
    pdf.moveTo(left, fy - 4).lineTo(left + contentWidth, fy - 4).strokeColor(tintHex(accent, 0.55)).lineWidth(0.6).stroke();
    pdf.font('Helvetica').fontSize(7).fillColor(MUTED);
    pdf.text(`${b.name}  ·  Generated ${genStr}`, left, fy, { width: contentWidth * 0.7, align: 'left', lineBreak: false });
    pdf.text(`Page ${i + 1} of ${range.count}`, left + contentWidth * 0.7, fy, { width: contentWidth * 0.3, align: 'right', lineBreak: false });
    if (i === range.count - 1 && (b.show?.footer ?? true)) {
      pdf.fillColor(MUTED).fontSize(6.8).text(footer, left, fy + 9, { width: contentWidth, align: 'center', lineBreak: false });
    }
    pdf.page.margins.bottom = savedBottom;
  }
}
