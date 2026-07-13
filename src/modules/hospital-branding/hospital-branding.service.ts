import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { getFileUrl } from '../../services/upload.service';
import { DEFAULT_ACCENT, DEFAULT_SHOW, type BrandingVisibility, type HospitalBranding } from '../../services/pdf-branding';

// Per-hospital PDF/print branding. Stored as: the identity fields on the Tenant
// row (so the rest of the app stays consistent) + the PDF-only extras in
// Tenant.themeConfig.pdf (no schema change). getHospitalBranding is the single
// source every PDF/print reads from.

const TENANT_SELECT = {
  name: true, logoUrl: true, address: true, city: true, state: true, country: true,
  phone: true, email: true, website: true, licenseNumber: true, accreditationInfo: true,
  themeConfig: true,
} as const;

type PdfExtras = Partial<HospitalBranding>;

function readExtras(themeConfig: unknown): PdfExtras {
  if (themeConfig && typeof themeConfig === 'object' && 'pdf' in themeConfig) {
    const pdf = (themeConfig as { pdf?: unknown }).pdf;
    if (pdf && typeof pdf === 'object') return pdf as PdfExtras;
  }
  return {};
}

export async function getHospitalBranding(tenantId: string): Promise<HospitalBranding> {
  const t = await prisma.tenant.findFirst({ where: { id: tenantId }, select: TENANT_SELECT });
  if (!t) throw AppError.notFound('Hospital not found');
  const x = readExtras(t.themeConfig);

  // Tenant columns are the fallback; the PDF-builder extras override + extend them.
  return {
    name: x.name ?? t.name ?? 'Hospital',
    tagline: x.tagline ?? null,
    logoUrl: x.logoUrl ?? t.logoUrl ?? null,
    showLogo: x.showLogo ?? true,
    headerStyle: x.headerStyle === 'left' ? 'left' : 'centered',
    addressLine1: x.addressLine1 ?? t.address ?? null,
    addressLine2: x.addressLine2 ?? null,
    city: x.city ?? t.city ?? null,
    state: x.state ?? t.state ?? null,
    pincode: x.pincode ?? null,
    country: x.country ?? t.country ?? null,
    phone: x.phone ?? t.phone ?? null,
    altPhone: x.altPhone ?? null,
    email: x.email ?? t.email ?? null,
    website: x.website ?? t.website ?? null,
    registrationNo: x.registrationNo ?? t.licenseNumber ?? null,
    gstin: x.gstin ?? null,
    accreditation: x.accreditation ?? t.accreditationInfo ?? null,
    footerText: x.footerText ?? null,
    accentColor: x.accentColor && /^#[0-9a-fA-F]{6}$/.test(x.accentColor) ? x.accentColor : DEFAULT_ACCENT,
    show: { ...DEFAULT_SHOW, ...((x.show as Partial<BrandingVisibility>) ?? {}) },
  };
}

export interface UpdateBrandingInput extends Partial<Omit<HospitalBranding, 'logoUrl'>> {}

export async function updateHospitalBranding(tenantId: string, data: UpdateBrandingInput): Promise<HospitalBranding> {
  const current = await getHospitalBranding(tenantId);
  const t = await prisma.tenant.findFirst({ where: { id: tenantId }, select: { themeConfig: true } });
  const merged: HospitalBranding = {
    ...current,
    ...data,
    // keep the existing logo (changed only via the logo-upload endpoint)
    logoUrl: current.logoUrl,
    headerStyle: data.headerStyle === 'left' ? 'left' : 'centered',
    accentColor: data.accentColor && /^#[0-9a-fA-F]{6}$/.test(data.accentColor) ? data.accentColor : current.accentColor,
    showLogo: data.showLogo ?? current.showLogo,
    name: (data.name ?? current.name)?.trim() || 'Hospital',
    // Merge the visibility toggles (partial updates keep the untouched ones).
    show: { ...current.show, ...(data.show ?? {}) },
  };

  const existingTheme = (t?.themeConfig && typeof t.themeConfig === 'object') ? (t.themeConfig as Record<string, unknown>) : {};
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      // Sync identity fields back to the Tenant row.
      name: merged.name,
      address: [merged.addressLine1, merged.addressLine2].filter(Boolean).join(', ') || null,
      city: merged.city,
      state: merged.state,
      country: merged.country,
      phone: merged.phone,
      email: merged.email,
      website: merged.website,
      licenseNumber: merged.registrationNo,
      accreditationInfo: merged.accreditation,
      themeConfig: { ...existingTheme, pdf: merged } as object,
    },
  });
  return merged;
}

export async function setBrandingLogo(tenantId: string, filename: string): Promise<HospitalBranding> {
  const url = getFileUrl(filename);
  const t = await prisma.tenant.findFirst({ where: { id: tenantId }, select: { themeConfig: true } });
  const current = await getHospitalBranding(tenantId);
  const existingTheme = (t?.themeConfig && typeof t.themeConfig === 'object') ? (t.themeConfig as Record<string, unknown>) : {};
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      logoUrl: url,
      themeConfig: { ...existingTheme, pdf: { ...current, logoUrl: url } } as object,
    },
  });
  return { ...current, logoUrl: url };
}

export async function removeBrandingLogo(tenantId: string): Promise<HospitalBranding> {
  const t = await prisma.tenant.findFirst({ where: { id: tenantId }, select: { themeConfig: true } });
  const current = await getHospitalBranding(tenantId);
  const existingTheme = (t?.themeConfig && typeof t.themeConfig === 'object') ? (t.themeConfig as Record<string, unknown>) : {};
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      logoUrl: null,
      themeConfig: { ...existingTheme, pdf: { ...current, logoUrl: null } } as object,
    },
  });
  return { ...current, logoUrl: null };
}
