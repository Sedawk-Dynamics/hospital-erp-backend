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
  mergeGstProfile,
  type GstProfile,
} from '../../shared/gst-profile';

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

export async function getGstProfile(tenantId: string): Promise<GstProfile> {
  try {
    const cfg = await readThemeConfig(tenantId);
    return mergeGstProfile(DEFAULT_GST_PROFILE, cfg.gst);
  } catch {
    // Billing must never fail because a settings read did — and an unregistered
    // profile is the safe fallback: no tax charged, bill of supply issued.
    // Charging tax the hospital may not owe is the one outcome to avoid.
    return DEFAULT_GST_PROFILE;
  }
}

export async function updateGstProfile(tenantId: string, patch: unknown): Promise<GstProfile> {
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
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { themeConfig: { ...cfg, gst: merged } as object },
  });
  return merged;
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
      // Was the fee already taken? Found by reference, so a renamed label or a
      // changed amount cannot make it look uncharged.
      prisma.billItem.findFirst({
        where: {
          referenceType: REGISTRATION_FEE_REFERENCE_TYPE,
          bill: { tenantId, patientId, status: { not: 'cancelled' } },
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
