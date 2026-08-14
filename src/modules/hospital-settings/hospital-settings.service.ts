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
  type ControlledDrugSettings,
} from '../../shared/controlled-drug';

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

// ── "Has this patient been here before?" ───────────────────────────────────

export interface PatientVisitStatus {
  patientId: string;
  /** No prior encounter of any kind AT THIS HOSPITAL. */
  isFirstVisit: boolean;
  /** The most recent prior encounter here, or null. */
  lastVisitAt: string | null;
  lastVisitKind: 'appointment' | 'visit' | 'admission' | null;
  /** Encounters here, capped at what we counted. */
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

  const [appointments, appointmentCount, visits, visitCount, admissions, admissionCount, feeItem] =
    await Promise.all([
      prisma.appointment.findMany({
        where: {
          tenantId,
          patientId,
          status: { notIn: ['cancelled', 'no_show'] },
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

  const priorEncounters = appointmentCount + visitCount + admissionCount;
  const isFirstVisit = priorEncounters === 0;
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
