import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import {
  DEFAULT_REGISTRATION_FEE,
  REGISTRATION_FEE_REFERENCE_TYPE,
  mergeRegistrationFee,
  type RegistrationFeeSettings,
} from '../../shared/registration-fee';
import {
  DEFAULT_CONTROLLED_DRUG_SETTINGS,
  mergeControlledDrugSettings,
  DEFAULT_DRUG_LICENCE,
  mergeDrugLicence,
  type ControlledDrugSettings,
  type DrugLicenceSettings,
} from '../../shared/controlled-drug';
import {
  DEFAULT_GST_PROFILE,
  GstProfileError,
  applyGstinVerification,
  mergeGstProfile,
  type GstProfile,
  type GstinVerificationRecord,
} from '../../shared/gst-profile';
import { logger } from '../../config/logger';
import { writeAudit } from '../../shared/audit';
import {
  getGstinProviderInfo,
  verifyGstin,
  type GstinProviderInfo,
  type GstinVerifyResult,
} from '../../services/gstin-verification';
import { getPortalReadiness } from '../gst/gst-portal.credentials';

// ---------------------------------------------------------------------------
// Per-hospital operational settings that are one value, not a catalog.
//
// Right now that is the registration fee. Stored in `Tenant.themeConfig`, the
// same migration-free JSON column the PDF letterhead and templates use — each
// writer touches its own key and preserves the rest.
// ---------------------------------------------------------------------------

async function readThemeConfig(tenantId: string): Promise<Record<string, unknown>> {
  const t = await prisma.tenant.findFirst({ where: { id: tenantId }, select: { themeConfig: true } });
  if (!t) throw AppError.notFound('Hospital not found');
  return t.themeConfig && typeof t.themeConfig === 'object'
    ? (t.themeConfig as Record<string, unknown>)
    : {};
}

export async function getRegistrationFeeSettings(
  tenantId: string,
): Promise<RegistrationFeeSettings> {
  try {
    const cfg = await readThemeConfig(tenantId);
    return mergeRegistrationFee(DEFAULT_REGISTRATION_FEE, cfg.registrationFee);
  } catch {
    // Billing must never fail because a settings read did. Off = charge nothing.
    return DEFAULT_REGISTRATION_FEE;
  }
}

export async function updateRegistrationFeeSettings(
  tenantId: string,
  patch: unknown,
): Promise<RegistrationFeeSettings> {
  const cfg = await readThemeConfig(tenantId);
  const merged = mergeRegistrationFee(
    mergeRegistrationFee(DEFAULT_REGISTRATION_FEE, cfg.registrationFee),
    patch,
  );
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { themeConfig: { ...cfg, registrationFee: merged } as object },
  });
  return merged;
}

// ── Controlled-drug dispensing policy ──────────────────────────────────────

export async function getControlledDrugSettings(
  tenantId: string,
): Promise<ControlledDrugSettings> {
  try {
    const cfg = await readThemeConfig(tenantId);
    return mergeControlledDrugSettings(DEFAULT_CONTROLLED_DRUG_SETTINGS, cfg.controlledDrugs);
  } catch {
    // A settings read must never decide a dispense by accident. Falling back to
    // the default keeps today's hard block, which is the safe direction: it
    // refuses a controlled dispense rather than waving one through.
    return DEFAULT_CONTROLLED_DRUG_SETTINGS;
  }
}

export async function updateControlledDrugSettings(
  tenantId: string,
  patch: unknown,
): Promise<ControlledDrugSettings> {
  const cfg = await readThemeConfig(tenantId);
  const merged = mergeControlledDrugSettings(
    mergeControlledDrugSettings(DEFAULT_CONTROLLED_DRUG_SETTINGS, cfg.controlledDrugs),
    patch,
  );
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { themeConfig: { ...cfg, controlledDrugs: merged } as object },
  });
  return merged;
}

// ── Statutory drug licences (printed on every register and Form) ───────────

export async function getDrugLicenceSettings(tenantId: string): Promise<DrugLicenceSettings> {
  try {
    const cfg = await readThemeConfig(tenantId);
    return mergeDrugLicence(DEFAULT_DRUG_LICENCE, cfg.drugLicence);
  } catch {
    // A blank licence block prints an obviously-empty header, which is the
    // honest failure — far better than a report that silently omits it.
    return DEFAULT_DRUG_LICENCE;
  }
}

export async function updateDrugLicenceSettings(
  tenantId: string,
  patch: unknown,
): Promise<DrugLicenceSettings> {
  const cfg = await readThemeConfig(tenantId);
  const merged = mergeDrugLicence(
    mergeDrugLicence(DEFAULT_DRUG_LICENCE, cfg.drugLicence),
    patch,
  );
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { themeConfig: { ...cfg, drugLicence: merged } as object },
  });
  return merged;
}

// ── GST registration ───────────────────────────────────────────────────────
//
// The hospital's own tax identity. Read on every billing write path to decide
// whether tax applies at all, what the place of supply is, and therefore
// whether a line carries CGST+SGST or IGST.

/**
 * The stored provider lookup for this hospital (gap #311). `undefined` when it
 * cannot be read — e.g. before the table exists — which the overlay turns into
 * "unverified", never into a failed profile read: a missing verification must
 * not make a registered hospital look unregistered.
 */
async function readGstinVerification(tenantId: string): Promise<GstinVerificationRecord | null | undefined> {
  try {
    return (await prisma.gstinVerification.findUnique({ where: { tenantId } })) ?? null;
  } catch (err) {
    logger.warn({ err, tenantId }, 'Could not read the GSTIN verification record');
    return undefined;
  }
}

export async function getGstProfile(tenantId: string): Promise<GstProfile> {
  let profile: GstProfile;
  try {
    const cfg = await readThemeConfig(tenantId);
    profile = mergeGstProfile(DEFAULT_GST_PROFILE, cfg.gst);
  } catch {
    // Billing must never fail because a settings read did — and an unregistered
    // profile is the safe fallback: no tax charged, bill of supply issued.
    // Charging tax the hospital may not owe is the one outcome to avoid.
    return DEFAULT_GST_PROFILE;
  }
  if (!profile.gstin) return applyGstinVerification(profile, null);
  return applyGstinVerification(profile, await readGstinVerification(tenantId));
}

export async function updateGstProfile(
  tenantId: string,
  patch: unknown,
  /** The acting user, for the GSTIN-change audit row (gap #311). */
  userId?: string,
): Promise<GstProfile> {
  const cfg = await readThemeConfig(tenantId);
  const current = mergeGstProfile(DEFAULT_GST_PROFILE, cfg.gst);
  let merged: GstProfile;
  try {
    merged = mergeGstProfile(current, patch);
  } catch (err) {
    // A rejected GSTIN is the admin's typo, not a server fault.
    if (err instanceof GstProfileError) throw AppError.badRequest(err.message);
    throw err;
  }
  // Gap item 311: on SAVE, a GSTIN whose PAN part is not the hospital's PAN is
  // refused — format, state code and check digit are already checked above.
  if (merged.gstin && merged.gstinChecks?.panMatches === false) {
    throw AppError.badRequest(
      `The GSTIN's PAN part (${merged.gstin.slice(2, 12)}) does not match the hospital PAN (${merged.pan}).`,
    );
  }
  // G-5 (gap #266): the e-invoice / e-way switches cannot be turned ON until
  // that integration is ready (provider configured + portal login saved). A
  // switch reading "on" while nothing can generate an IRN is the bug. A value
  // that is already on is left alone, so an unrelated save never fails on it.
  await assertPortalSwitchAllowed(tenantId, current, merged);
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { themeConfig: { ...cfg, gst: merged } as object },
  });

  const gstinChanged = (current.gstin ?? null) !== (merged.gstin ?? null);
  if (gstinChanged) {
    // Gap #311: a verification belongs to the number it checked. Cleared AFTER
    // the save so a failed save cannot cost a valid verification; and even if
    // this delete fails, the overlay compares numbers, so the old result can
    // never verify the new GSTIN.
    try {
      await prisma.gstinVerification.deleteMany({ where: { tenantId } });
    } catch (err) {
      logger.warn({ err, tenantId }, 'Could not clear the GSTIN verification after a GSTIN change');
    }
    await writeAudit({
      tenantId,
      userId,
      action: 'update',
      entityType: GST_AUDIT_ENTITY,
      entityId: tenantId,
      description: `Hospital GSTIN changed from ${current.gstin ?? '(none)'} to ${merged.gstin ?? '(none)'}; GSTIN verification cleared`,
      oldValues: { gstin: current.gstin, gstinVerified: false },
      newValues: { gstin: merged.gstin, gstinVerified: false },
    });
    return applyGstinVerification(merged, null);
  }
  return applyGstinVerification(merged, merged.gstin ? await readGstinVerification(tenantId) : null);
}

/** G-5 (gap #266): refuse to switch e-invoice / e-way ON while that integration is not ready. */
async function assertPortalSwitchAllowed(tenantId: string, current: GstProfile, merged: GstProfile): Promise<void> {
  const switches = [
    { on: merged.eInvoiceApplicable && !current.eInvoiceApplicable, portal: 'einvoice' as const, label: 'E-invoicing' },
    { on: merged.eWayBillApplicable && !current.eWayBillApplicable, portal: 'eway' as const, label: 'E-way bills' },
  ];
  for (const s of switches) {
    if (!s.on) continue;
    const readiness = await getPortalReadiness(tenantId, s.portal);
    if (!readiness.ready) {
      throw AppError.conflict(
        `${s.label} cannot be switched on — not available: ${readiness.reason}`,
        'EINVOICE_NOT_AVAILABLE',
        { portal: s.portal, reason: readiness.reason },
      );
    }
  }
}

// ── GSTIN verification through the GST service provider (gap #311) ─────────

/** The audit-log entity for the hospital's GST registration and its verification. */
export const GST_AUDIT_ENTITY = 'gst_registration';

/** What the settings screen needs to know before anyone clicks Verify. */
export function getGstinVerificationProvider(): GstinProviderInfo {
  return getGstinProviderInfo();
}

export interface GstinVerifyOutcome {
  profile: GstProfile;
  result: {
    status: GstinVerifyResult['status'];
    gstin: string;
    legalName: string | null;
    tradeName: string | null;
    registrationStatus: string | null;
    provider: string;
    sandbox: boolean;
    checkedAt: string;
    error: string | null;
  };
}

/**
 * Check the hospital's SAVED GSTIN with the configured provider and store the
 * answer against that exact number.
 *
 * - `expectedGstin`, when given, must be the saved one: the screen can only
 *   ask about the number it is showing, never verify one and display another.
 * - The local checks still gate it — a number the system would refuse to save
 *   is not sent anywhere.
 * - Every attempt is audited. Not-configured is refused with a 503 and stores
 *   nothing, so removing a provider cannot erase a real result.
 * - Any other non-verified outcome overwrites the stored row, so a failed or
 *   unmatched re-check leaves the GSTIN explicitly unverified.
 */
export async function verifyHospitalGstin(
  tenantId: string,
  userId: string,
  expectedGstin?: string | null,
): Promise<GstinVerifyOutcome> {
  const before = await getGstProfile(tenantId);
  const gstin = before.gstin;
  if (!gstin) throw AppError.badRequest('Save a GSTIN before verifying it.');
  if (expectedGstin && expectedGstin.trim().toUpperCase() !== gstin) {
    throw AppError.conflict(
      'The GSTIN on screen is not the saved one. Save it first, then verify.',
      'GSTIN_NOT_SAVED',
    );
  }
  const checks = before.gstinChecks;
  if (!checks?.format || !checks.checkDigit || !checks.stateCode) {
    throw AppError.badRequest('The saved GSTIN fails the local checks; correct it before verifying.');
  }
  if (checks.panMatches === false) {
    throw AppError.badRequest("The GSTIN's PAN part does not match the hospital PAN; correct it before verifying.");
  }

  const result = await verifyGstin(gstin);

  const auditBase = {
    tenantId,
    userId,
    action: 'update' as const,
    entityType: GST_AUDIT_ENTITY,
    entityId: tenantId,
  };
  const auditValues = {
    gstin,
    status: result.status,
    provider: result.provider,
    sandbox: result.sandbox,
    legalName: result.legalName,
    registrationStatus: result.registrationStatus,
    error: result.error,
  };

  if (result.status === 'not_configured') {
    await writeAudit({
      ...auditBase,
      description: `GSTIN verification attempted for ${gstin}: provider not configured — remains unverified`,
      newValues: auditValues,
    });
    throw new AppError(
      result.error ?? 'GSTIN verification provider not configured',
      503,
      'GSTIN_VERIFY_NOT_CONFIGURED',
    );
  }

  // The number may have been changed while the provider was answering. The
  // answer is about the OLD number, so it is not stored against the new one.
  const now = mergeGstProfile(DEFAULT_GST_PROFILE, (await readThemeConfig(tenantId)).gst);
  if (now.gstin !== gstin) {
    await writeAudit({
      ...auditBase,
      description: `GSTIN verification for ${gstin} discarded: the GSTIN was changed to ${now.gstin ?? '(none)'} during the lookup`,
      newValues: auditValues,
    });
    throw AppError.conflict('The GSTIN was changed while it was being verified. Verify again.', 'GSTIN_CHANGED');
  }

  const verified = result.status === 'verified';
  const data = {
    checkedGstin: gstin,
    verifiedGstin: verified ? gstin : null,
    resultStatus: result.status,
    provider: result.provider.slice(0, 60),
    sandbox: result.sandbox,
    legalName: result.legalName?.slice(0, 300) ?? null,
    tradeName: result.tradeName?.slice(0, 300) ?? null,
    registrationStatus: result.registrationStatus?.slice(0, 60) ?? null,
    providerStateCode: result.stateCode?.slice(0, 2) ?? null,
    lastError: result.error?.slice(0, 500) ?? null,
    lastCheckedAt: result.checkedAt,
    verifiedAt: verified ? result.checkedAt : null,
    checkedBy: userId,
  };
  await prisma.gstinVerification.upsert({
    where: { tenantId },
    create: { tenantId, ...data },
    update: data,
  });

  await writeAudit({
    ...auditBase,
    description: `GSTIN verification for ${gstin} via ${result.provider}${result.sandbox ? ' (SANDBOX — not a real government check)' : ''}: ${result.status}`,
    oldValues: { gstin, gstinVerified: before.gstinVerified },
    newValues: { ...auditValues, gstinVerified: verified },
  });

  return {
    profile: await getGstProfile(tenantId),
    result: {
      status: result.status,
      gstin,
      legalName: result.legalName,
      tradeName: result.tradeName,
      registrationStatus: result.registrationStatus,
      provider: result.provider,
      sandbox: result.sandbox,
      checkedAt: result.checkedAt.toISOString(),
      error: result.error,
    },
  };
}

// ── "Has this patient been here before?" ───────────────────────────────────

export interface PatientVisitStatus {
  patientId: string;
  /** No prior encounter of any kind AT THIS HOSPITAL. */
  isFirstVisit: boolean;
  /** The most recent encounter here that has ALREADY HAPPENED, or null. */
  lastVisitAt: string | null;
  lastVisitKind: 'appointment' | 'visit' | 'admission' | null;
  /**
   * Times this patient has actually been here — DISTINCT encounters, not rows.
   *
   * One attendance leaves up to three rows: an Appointment, the Visit the front
   * desk opens from it, and for an inpatient an Admission (whose `visitId` is
   * unique, so it always has one). Adding the three counts said 15 for a patient
   * who had been in ten times.
   */
  priorEncounters: number;
  /** The registration fee has already been taken from this patient here. */
  registrationFeeCharged: boolean;
  registrationFeeChargedAt: string | null;
  settings: RegistrationFeeSettings;
  /** What the booking screen should pre-tick. */
  suggestCharge: boolean;
}

/**
 * Whether this patient has been to THIS hospital before, and whether the
 * registration fee has already been taken from them here.
 *
 * Deliberately scoped to the tenant and to the Patient ROW, not to the person:
 * a patient row exists per hospital, so someone who is a regular at another
 * hospital on the same platform — or who registered on the portal without ever
 * attending — is still opening a new file here. That is exactly what the
 * registration fee is for.
 *
 * A cancelled appointment does not count as having attended.
 */
export async function getPatientVisitStatus(
  tenantId: string,
  patientId: string,
  options: { excludeAppointmentId?: string } = {},
): Promise<PatientVisitStatus> {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
    select: { id: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');

  const [
    appointments,
    appointmentCount,
    visits,
    visitCount,
    unvisitedAppointmentCount,
    admissions,
    admissionCount,
    feeItem,
  ] =
    await Promise.all([
      // Only appointments that have already happened can be a LAST VISIT. Left
      // unbounded, a booking made for next month became "Last visit 14/09/2026"
      // — a date in the future, on a line that says the patient was last here.
      prisma.appointment.findMany({
        where: {
          tenantId,
          patientId,
          status: { notIn: ['cancelled', 'no_show'] },
          appointmentDate: { lte: new Date() },
          ...(options.excludeAppointmentId ? { id: { not: options.excludeAppointmentId } } : {}),
        },
        orderBy: { appointmentDate: 'desc' },
        take: 1,
        select: { appointmentDate: true },
      }),
      prisma.appointment.count({
        where: {
          tenantId,
          patientId,
          status: { notIn: ['cancelled', 'no_show'] },
          ...(options.excludeAppointmentId ? { id: { not: options.excludeAppointmentId } } : {}),
        },
      }),
      prisma.visit.findMany({
        where: { tenantId, patientId },
        orderBy: { visitDate: 'desc' },
        take: 1,
        select: { visitDate: true },
      }),
      prisma.visit.count({ where: { tenantId, patientId } }),
      // Appointments that never became a Visit — booked and not yet attended,
      // or attended without the desk opening one. These are the only encounters
      // a Visit row does not already account for, so distinct attendance is
      // `visits + these` and nothing is counted twice.
      prisma.appointment.count({
        where: {
          tenantId,
          patientId,
          status: { notIn: ['cancelled', 'no_show'] },
          visits: { none: {} },
          ...(options.excludeAppointmentId ? { id: { not: options.excludeAppointmentId } } : {}),
        },
      }),
      prisma.admission.findMany({
        where: { tenantId, patientId },
        orderBy: { admissionDate: 'desc' },
        take: 1,
        select: { admissionDate: true },
      }),
      prisma.admission.count({ where: { tenantId, patientId } }),
      prisma.billItem.findFirst({
        where: {
          referenceType: REGISTRATION_FEE_REFERENCE_TYPE,
          bill: { tenantId, patientId, status: { notIn: ['cancelled', 'refunded'] } },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

  const candidates: Array<{ at: Date; kind: PatientVisitStatus['lastVisitKind'] }> = [];
  if (appointments[0]) candidates.push({ at: appointments[0].appointmentDate, kind: 'appointment' });
  if (visits[0]) candidates.push({ at: visits[0].visitDate, kind: 'visit' });
  if (admissions[0]) candidates.push({ at: admissions[0].admissionDate, kind: 'admission' });
  candidates.sort((a, b) => b.at.getTime() - a.at.getTime());
  const last = candidates[0] ?? null;

  // Distinct attendance. An Admission always has a Visit (`Admission.visitId`
  // is unique) and a kept appointment usually becomes one, so a Visit row is
  // the encounter; only appointments that produced none are additional.
  const priorEncounters = visitCount + unvisitedAppointmentCount;
  // Deliberately NOT derived from the count above. "First visit here" gates the
  // registration fee, so it stays the broadest possible reading — any row of
  // any kind means they are not new — rather than anything that could newly
  // read a returning patient as first-time and charge them again.
  const isFirstVisit = appointmentCount + visitCount + admissionCount === 0;
  const settings = await getRegistrationFeeSettings(tenantId);
  const registrationFeeCharged = !!feeItem;

  return {
    patientId,
    isFirstVisit,
    lastVisitAt: last ? last.at.toISOString() : null,
    lastVisitKind: last?.kind ?? null,
    priorEncounters,
    registrationFeeCharged,
    registrationFeeChargedAt: feeItem ? feeItem.createdAt.toISOString() : null,
    settings,
    // Pre-tick the box only when it would actually be taken.
    suggestCharge:
      settings.enabled &&
      settings.amount > 0 &&
      isFirstVisit &&
      !(settings.oncePerPatient && registrationFeeCharged),
  };
}

// ── HR settings (gap 313) ──────────────────────────────────────────────────
//
// The duty roster hard-coded Sunday as the first day of the week. The week
// start is a hospital decision (many run Monday–Sunday rosters), so it lives
// here with the other one-value tenant settings, under `themeConfig.hrSettings`
// — no schema change. Default Sunday keeps every existing roster as it was.

export interface HrSettings {
  /** First day of a roster week: 0 = Sunday … 6 = Saturday (JS getDay()). */
  rosterWeekStartDay: number;
}

export const DEFAULT_HR_SETTINGS: HrSettings = { rosterWeekStartDay: 0 };

const isWeekday = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 6;

/** Stored value over the defaults; anything malformed falls back silently. */
export function mergeHrSettings(base: HrSettings, stored: unknown): HrSettings {
  const s = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  return { rosterWeekStartDay: isWeekday(s.rosterWeekStartDay) ? s.rosterWeekStartDay : base.rosterWeekStartDay };
}

export async function getHrSettings(tenantId: string): Promise<HrSettings> {
  try {
    const cfg = await readThemeConfig(tenantId);
    return mergeHrSettings(DEFAULT_HR_SETTINGS, cfg.hrSettings);
  } catch {
    // A roster screen must never fail because a settings read did.
    return DEFAULT_HR_SETTINGS;
  }
}

export async function updateHrSettings(tenantId: string, patch: unknown): Promise<HrSettings> {
  const p = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
  if (p.rosterWeekStartDay !== undefined && !isWeekday(p.rosterWeekStartDay)) {
    throw AppError.badRequest('Roster week start day must be 0 (Sunday) to 6 (Saturday)');
  }
  const cfg = await readThemeConfig(tenantId);
  const merged = mergeHrSettings(mergeHrSettings(DEFAULT_HR_SETTINGS, cfg.hrSettings), p);
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { themeConfig: { ...cfg, hrSettings: merged } as object },
  });
  return merged;
}

/** Local midnight of the roster week containing `d`, for a week starting on `startDay`. */
export function rosterWeekStart(d: Date, startDay: number): Date {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const back = (date.getDay() - (isWeekday(startDay) ? startDay : 0) + 7) % 7;
  date.setDate(date.getDate() - back);
  return date;
}
