import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';

/**
 * Parse a free-text duration like "5 days", "2 weeks", "1 month" → milliseconds.
 * Returns null if unparseable.
 */
function parseDurationMs(raw?: string | null): number | null {
  if (!raw) return null;
  const match = raw.trim().toLowerCase().match(/(\d+(?:\.\d+)?)\s*(day|days|d|week|weeks|wk|w|month|months|mo|year|years|yr|y)/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2];
  const DAY = 24 * 60 * 60 * 1000;
  if (['day', 'days', 'd'].includes(unit)) return value * DAY;
  if (['week', 'weeks', 'wk', 'w'].includes(unit)) return value * 7 * DAY;
  if (['month', 'months', 'mo'].includes(unit)) return value * 30 * DAY;
  if (['year', 'years', 'yr', 'y'].includes(unit)) return value * 365 * DAY;
  return null;
}

/**
 * Determine if a prescription item is "current" — patient is still taking it.
 *
 * Rules:
 *  - Prescription must be status 'active' (not cancelled/dispensed fully).
 *  - If the item has a duration and createdAt + duration > now → current.
 *  - If duration unparseable and prescription is less than 30 days old → current.
 *  - Otherwise → past.
 */
function isItemCurrent(prescription: { status: string; createdAt: Date }, itemDuration?: string | null): boolean {
  if (prescription.status !== 'active') return false;
  const start = new Date(prescription.createdAt).getTime();
  const durMs = parseDurationMs(itemDuration);
  const now = Date.now();
  if (durMs !== null) return start + durMs > now;
  // No parseable duration — assume current for 30 days
  return now - start < 30 * 24 * 60 * 60 * 1000;
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
      if (isItemCurrent(rx, item.duration)) {
        current.push(entry);
      } else {
        past.push(entry);
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
