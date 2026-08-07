import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import { AppError } from '../../shared/appError';
import * as service from './hospital-branding.service';
import { type HospitalBranding, DEFAULT_ACCENT } from '../../services/pdf-branding';
import {
  ALL_DOCUMENTS_KEY,
  DEFAULT_TEMPLATE,
  PDF_DOCUMENT_REGISTRY,
  PDF_DOCUMENT_TYPES,
  isPdfDocumentType,
  mergeTemplate,
  type PdfDocumentType,
} from '../../services/pdf-template';
import {
  createBrandedDocument,
  finalizeBrandedDocument,
  drawKeyValueCard,
  drawSectionHeading,
  drawTable,
} from '../../services/pdf-doc';
import { previewDoc } from './pdf-preview-samples';

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

// ── Templates ──────────────────────────────────────────────────────────────

function templateKey(raw: unknown): PdfDocumentType | typeof ALL_DOCUMENTS_KEY {
  if (raw === ALL_DOCUMENTS_KEY) return ALL_DOCUMENTS_KEY;
  if (isPdfDocumentType(raw)) return raw;
  throw AppError.badRequest('Unknown document type');
}

export async function listTemplates(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getAllPdfTemplates(req.user!.tenantId, PDF_DOCUMENT_TYPES);
    sendResponse({
      res,
      message: 'PDF templates',
      data: { ...data, registry: PDF_DOCUMENT_REGISTRY, defaults: DEFAULT_TEMPLATE },
    });
  } catch (err) {
    next(err);
  }
}

export async function getTemplate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const key = templateKey(req.params.documentType);
    const data = await service.getPdfTemplate(req.user!.tenantId, key);
    sendResponse({ res, message: 'PDF template', data });
  } catch (err) {
    next(err);
  }
}

export async function saveTemplate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const key = templateKey(req.params.documentType);
    const data = await service.savePdfTemplate(req.user!.tenantId, key, req.body ?? {});
    sendResponse({
      res,
      message:
        key === ALL_DOCUMENTS_KEY
          ? 'Saved — this now applies to every document that has no override of its own.'
          : 'Template saved — it applies to this document from the next print.',
      data,
    });
  } catch (err) {
    next(err);
  }
}

export async function resetTemplate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const key = templateKey(req.params.documentType);
    const data = await service.resetPdfTemplate(req.user!.tenantId, key);
    sendResponse({ res, message: 'Reset to the inherited defaults', data });
  } catch (err) {
    next(err);
  }
}

// ── Live preview ───────────────────────────────────────────────────────────

// A live sample PDF so the admin sees the letterhead AND the template exactly as
// they will print — real page size, fonts, watermark, table style and footer,
// with body content shaped like the document type they picked.
export async function previewPdf(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const tenantId = req.user!.tenantId;

    const saved = await service.getHospitalBranding(tenantId);
    const branding = coerce(body, saved);

    const type: PdfDocumentType = isPdfDocumentType(body.documentType)
      ? body.documentType
      : 'prescription';

    // Unsaved template edits are merged over what is stored, so the preview
    // tracks the form rather than the database.
    const storedTemplate = await service.getPdfTemplate(tenantId, type);
    const template = body.template ? mergeTemplate(storedTemplate, body.template) : storedTemplate;

    const doc = previewDoc(type);
    const { pdf, theme } = createBrandedDocument({
      res,
      branding,
      template,
      title: doc.title,
      subtitle: doc.subtitle,
      meta: doc.meta,
      filename: `pdf-preview-${type}.pdf`,
    });

    drawKeyValueCard(pdf, theme, doc.header);

    for (const section of doc.sections) {
      drawSectionHeading(pdf, theme, section.heading);
      if (section.paragraph) {
        pdf
          .font(theme.font.regular)
          .fontSize(theme.size.body)
          .fillColor(theme.ink)
          .text(section.paragraph, theme.margin, pdf.y, {
            width: theme.contentWidth,
            lineGap: theme.lineGap,
          });
        pdf.moveDown(0.7);
      }
      if (section.columns && section.rows) {
        drawTable(pdf, theme, section.columns, section.rows);
      }
      if (section.card) {
        drawKeyValueCard(pdf, theme, section.card);
      }
    }

    drawSectionHeading(pdf, theme, 'About this preview');
    pdf
      .font(theme.font.regular)
      .fontSize(theme.size.small)
      .fillColor(theme.muted)
      .text(
        'Nothing on this page is a real record. It shows the page size, margins, fonts, colours, table style, watermark, signature block and footer this document type will print with. Switch the document above to check another one — each type can be styled on its own, or all of them together.',
        theme.margin,
        pdf.y,
        { width: theme.contentWidth, lineGap: theme.lineGap },
      );

    finalizeBrandedDocument({ pdf, branding, theme });
  } catch (err) {
    next(err);
  }
}
