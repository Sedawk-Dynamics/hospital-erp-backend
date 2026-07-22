import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';

/**
 * Parse a free-text duration like "5 days", "2 weeks", "1 month" → milliseconds.
 * Returns null if unparseable.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a course with no usable duration is assumed to run. Deliberately
 * short: guessing "still taking it" for too long is what makes drug history
 * read as noise.
 */
const UNKNOWN_DURATION_MS = 30 * DAY_MS;

function parseDurationMs(raw?: string | null): number | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  const match = text.match(
    /(\d+(?:\.\d+)?)\s*(days?|d|weeks?|wks?|w|months?|mos?|m|years?|yrs?|y)\b/,
  );
  if (match) {
    const value = parseFloat(match[1]);
    const unit = match[2];
    if (/^d(ays?)?$/.test(unit)) return value * DAY_MS;
    if (/^w(k?s?|eeks?)?$/.test(unit)) return value * 7 * DAY_MS;
    if (/^m(o?s?|onths?)?$/.test(unit)) return value * 30 * DAY_MS;
    if (/^y(rs?|ears?)?$/.test(unit)) return value * 365 * DAY_MS;
    return null;
  }

  // A bare number is written on paper scripts all the time and means days.
  const bare = text.match(/^(\d+(?:\.\d+)?)$/);
  if (bare) return parseFloat(bare[1]) * DAY_MS;

  return null;
}

/** When a course started/ends, or null if it can't be pinned down. */
function courseEnd(prescribedAt: Date, itemDuration?: string | null): number | null {
  const durMs = parseDurationMs(itemDuration);
  if (durMs === null) return null;
  return new Date(prescribedAt).getTime() + durMs;
}

/**
 * Determine if a prescription item is "current" — the patient is still on it.
 *
 * Only `cancelled` rules a drug out on status alone. It previously required
 * status === 'active', which meant the moment the pharmacy dispensed a script
 * (status → dispensed / partially_dispensed) the drug the patient had just
 * been handed dropped into "past medication" — the exact inversion QA reported.
 * Whether a course is still running is a function of its duration, not of
 * whether the pharmacy has handed it over.
 */
function isItemCurrent(
  prescription: { status: string; createdAt: Date },
  itemDuration?: string | null,
): boolean {
  if (prescription.status === 'cancelled') return false;

  const now = Date.now();
  const end = courseEnd(prescription.createdAt, itemDuration);
  if (end !== null) return end > now;

  // No usable duration (PRN, "as directed", blank) — assume a standard course.
  return now - new Date(prescription.createdAt).getTime() < UNKNOWN_DURATION_MS;
}

/** Normalised key for "the same drug" across prescriptions. */
function drugKey(item: { drugId?: string | null; drugName: string }): string {
  return item.drugId ?? item.drugName.trim().toLowerCase();
}

interface DrugHistoryOptions {
  patientIds: string[];
  tenantId?: string;
  limit?: number;
}

export async function buildDrugHistory({ patientIds, tenantId, limit = 100 }: DrugHistoryOptions) {
  if (patientIds.length === 0) return { current: [], past: [] };

  const where: any = { patientId: { in: patientIds } };
  if (tenantId) where.tenantId = tenantId;

  const prescriptions = await prisma.prescription.findMany({
    where,
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: {
      prescriptionItems: {
        include: {
          drug: { select: { id: true, drugName: true, genericName: true, strength: true } },
        },
      },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      patient: { select: { id: true, mrn: true, tenant: { select: { id: true, name: true } } } },
      visit: { select: { id: true, visitType: true, visitDate: true } },
    },
  });

  const current: any[] = [];
  const past: any[] = [];

  // Re-prescribing a drug replaces the earlier course. Without this the same
  // drug shows up twice under "current" (once per script), which is a large
  // part of why the drug history read as inaccurate. `prescriptions` is
  // newest-first, so the first sighting of a drug is its live course.
  const seenDrugs = new Set<string>();

  for (const rx of prescriptions) {
    const doctorName = rx.doctor?.user ? `Dr. ${rx.doctor.user.firstName} ${rx.doctor.user.lastName}` : 'Doctor';
    for (const item of rx.prescriptionItems) {
      const entry = {
        itemId: item.id,
        prescriptionId: rx.id,
        prescriptionType: rx.prescriptionType,
        prescriptionStatus: rx.status,
        drugId: item.drugId,
        drugName: item.drugName,
        dosage: item.dosage,
        frequency: item.frequency,
        duration: item.duration,
        route: item.route,
        instructions: item.instructions,
        quantity: item.quantity,
        isPrn: item.isPrn,
        prescribedAt: rx.createdAt,
        doctorName,
        visitType: rx.visit?.visitType,
        visitDate: rx.visit?.visitDate,
        tenantId: rx.patient?.tenant?.id,
        tenantName: rx.patient?.tenant?.name,
      };
      const key = drugKey(item);
      const superseded = seenDrugs.has(key);
      seenDrugs.add(key);

      if (!superseded && isItemCurrent(rx, item.duration)) {
        current.push(entry);
      } else {
        past.push({ ...entry, supersededByNewerScript: superseded });
      }
    }
  }

  return { current, past };
}

/**
 * Doctor-side: drug history for a specific patient within the doctor's tenant.
 */
export async function getDrugHistoryForDoctor(tenantId: string, patientId: string) {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
    select: { id: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');
  return buildDrugHistory({ patientIds: [patientId], tenantId, limit: 200 });
}
