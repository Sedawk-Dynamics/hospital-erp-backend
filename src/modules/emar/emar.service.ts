import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import {
  ensureMasters,
  generateForPrescription,
  cancelFutureSchedules,
} from './emar.scheduler-engine';
import type {
  CreateTimeSlotInput,
  UpdateTimeSlotInput,
  CreateFrequencyInput,
  UpdateFrequencyInput,
  UpdateSettingsInput,
  ListSchedulesQuery,
  HoldRefuseDoseInput,
  AmendDoseInput,
  GiveDoseInput,
  TriggerPrnInput,
} from './emar.validation';
import type { EmarDoseStatus, EmarSchedule, MedicationRoute } from '@prisma/client';

// ============================================================
// Time Slot Master
// ============================================================

export async function listTimeSlots(tenantId: string) {
  await ensureMasters(tenantId);
  return prisma.emarTimeSlot.findMany({
    where: { tenantId },
    orderBy: [{ sortOrder: 'asc' }, { time: 'asc' }],
  });
}

export async function createTimeSlot(tenantId: string, data: CreateTimeSlotInput) {
  return prisma.emarTimeSlot.create({
    data: { ...data, tenantId },
  });
}

export async function updateTimeSlot(tenantId: string, id: string, data: UpdateTimeSlotInput) {
  const slot = await prisma.emarTimeSlot.findFirst({ where: { id, tenantId } });
  if (!slot) throw AppError.notFound('Time slot not found');
  return prisma.emarTimeSlot.update({ where: { id }, data });
}

export async function deleteTimeSlot(tenantId: string, id: string) {
  const slot = await prisma.emarTimeSlot.findFirst({ where: { id, tenantId } });
  if (!slot) throw AppError.notFound('Time slot not found');
  await prisma.emarTimeSlot.delete({ where: { id } });
  return { id, deleted: true };
}

// ============================================================
// Frequency Master
// ============================================================

export async function listFrequencies(tenantId: string) {
  await ensureMasters(tenantId);
  return prisma.emarFrequency.findMany({
    where: { tenantId },
    orderBy: [{ type: 'asc' }, { code: 'asc' }],
  });
}

export async function createFrequency(tenantId: string, data: CreateFrequencyInput) {
  return prisma.emarFrequency.create({
    data: {
      tenantId,
      code: data.code,
      label: data.label,
      type: data.type,
      slotCodes: data.slotCodes ?? [],
      intervalHours: data.intervalHours ?? null,
      minPrnIntervalMinutes: data.minPrnIntervalMinutes ?? null,
      isActive: data.isActive ?? true,
    },
  });
}

export async function updateFrequency(tenantId: string, id: string, data: UpdateFrequencyInput) {
  const freq = await prisma.emarFrequency.findFirst({ where: { id, tenantId } });
  if (!freq) throw AppError.notFound('Frequency not found');
  return prisma.emarFrequency.update({
    where: { id },
    data: {
      code: data.code ?? undefined,
      label: data.label ?? undefined,
      type: data.type ?? undefined,
      slotCodes: data.slotCodes ?? undefined,
      intervalHours: data.intervalHours === undefined ? undefined : data.intervalHours,
      minPrnIntervalMinutes:
        data.minPrnIntervalMinutes === undefined ? undefined : data.minPrnIntervalMinutes,
      isActive: data.isActive ?? undefined,
    },
  });
}

export async function deleteFrequency(tenantId: string, id: string) {
  const freq = await prisma.emarFrequency.findFirst({ where: { id, tenantId } });
  if (!freq) throw AppError.notFound('Frequency not found');
  await prisma.emarFrequency.delete({ where: { id } });
  return { id, deleted: true };
}

// ============================================================
// Settings
// ============================================================

export async function getSettings(tenantId: string) {
  await ensureMasters(tenantId);
  return prisma.emarSettings.findUnique({ where: { tenantId } });
}

export async function updateSettings(tenantId: string, data: UpdateSettingsInput) {
  return prisma.emarSettings.upsert({
    where: { tenantId },
    create: { tenantId, ...data },
    update: data,
  });
}

// ============================================================
// Schedule listing
// ============================================================

/**
 * Resolve a wardId filter to the set of active admissionIds in that ward
 * before querying schedules. Keeps queries selective.
 */
async function resolveWardAdmissionIds(tenantId: string, wardId: string): Promise<string[]> {
  const admissions = await prisma.admission.findMany({
    where: { tenantId, wardId, status: 'admitted' },
    select: { id: true },
  });
  return admissions.map((a) => a.id);
}

export async function listSchedules(tenantId: string, query: ListSchedulesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.admissionId) where.admissionId = query.admissionId;

  if (query.wardId && !query.admissionId) {
    const ids = await resolveWardAdmissionIds(tenantId, query.wardId);
    where.admissionId = { in: ids.length > 0 ? ids : ['__none__'] };
  }

  if (query.fromDate || query.toDate) {
    where.scheduledAt = {};
    if (query.fromDate) where.scheduledAt.gte = new Date(query.fromDate);
    if (query.toDate) where.scheduledAt.lte = new Date(query.toDate);
  }

  if (query.status) {
    where.status = Array.isArray(query.status) ? { in: query.status } : query.status;
  }

  if (query.includePrn === false) {
    where.isPrn = false;
  }

  const [items, total] = await Promise.all([
    prisma.emarSchedule.findMany({
      where,
      skip,
      take,
      orderBy: [{ scheduledAt: 'asc' }, { drugName: 'asc' }],
      include: {
        prescriptionItem: {
          select: { id: true, drugName: true, dosage: true, frequency: true, route: true, instructions: true, isPrn: true },
        },
        prescription: { select: { id: true, doctorId: true, prescriptionType: true, status: true } },
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        admission: { select: { id: true, wardId: true, bedId: true } },
        givenBy: { select: { id: true, firstName: true, lastName: true } },
        amendedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
    prisma.emarSchedule.count({ where }),
  ]);

  return { items, total, page, limit };
}

export async function getScheduleById(tenantId: string, id: string) {
  const s = await prisma.emarSchedule.findFirst({
    where: { id, tenantId },
    include: {
      prescriptionItem: true,
      prescription: { select: { id: true, doctorId: true, prescriptionType: true, status: true } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      givenBy: { select: { id: true, firstName: true, lastName: true } },
      amendedBy: { select: { id: true, firstName: true, lastName: true } },
      auditLogs: {
        orderBy: { performedAt: 'desc' },
        include: { performedBy: { select: { id: true, firstName: true, lastName: true } } },
      },
    },
  });
  if (!s) throw AppError.notFound('Schedule row not found');
  return s;
}

// ============================================================
// Status lifecycle helpers
// ============================================================

/// A row is "actionable" only while in pending/due/overdue.
const ACTIONABLE_STATUSES: EmarDoseStatus[] = ['pending', 'due', 'overdue'];

async function loadActionable(tenantId: string, id: string): Promise<EmarSchedule> {
  const s = await prisma.emarSchedule.findFirst({ where: { id, tenantId } });
  if (!s) throw AppError.notFound('Schedule row not found');
  if (s.status === 'cancelled') throw AppError.badRequest('This dose has been cancelled');
  return s;
}

async function getGracePeriod(tenantId: string): Promise<number> {
  const settings = await prisma.emarSettings.findUnique({ where: { tenantId } });
  return settings?.gracePeriodMinutes ?? 120;
}

function diffMinutes(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 60_000);
}

// ============================================================
// Dose actions
// ============================================================

/**
 * Mark a dose as given.
 * If actualGivenTime is later than scheduledAt + grace period, the
 * status becomes `given_late` (with delayMinutes captured) — per spec.
 */
export async function giveDose(
  tenantId: string,
  userId: string,
  id: string,
  data: GiveDoseInput,
) {
  const s = await loadActionable(tenantId, id);
  if (!ACTIONABLE_STATUSES.includes(s.status)) {
    throw AppError.badRequest(`Cannot give a dose in status "${s.status}". Use amend instead.`);
  }

  const grace = await getGracePeriod(tenantId);
  const actualGivenTime = data.actualGivenTime ? new Date(data.actualGivenTime) : new Date();
  const delayMinutes = diffMinutes(actualGivenTime, s.scheduledAt);
  const isLate = delayMinutes > grace;

  const newStatus: EmarDoseStatus = isLate ? 'given_late' : 'given';

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.emarSchedule.update({
      where: { id },
      data: {
        status: newStatus,
        actionedAt: new Date(),
        actualGivenTime,
        givenById: userId,
        delayMinutes: delayMinutes,
        notes: data.notes ?? s.notes,
      },
    });
    await tx.emarAuditLog.create({
      data: {
        tenantId,
        scheduleId: id,
        action: isLate ? 'late' : 'given',
        fromStatus: s.status,
        toStatus: newStatus,
        performedById: userId,
        delayMinutes,
        notes: data.notes,
      },
    });
    return row;
  });

  // Mirror to legacy MedicationAdministration for compatibility
  await prisma.medicationAdministration.create({
    data: {
      prescriptionItemId: updated.prescriptionItemId,
      patientId: updated.patientId,
      administeredBy: userId,
      administeredAt: actualGivenTime,
      doseGiven: updated.dosage,
      status: 'given',
      notes: data.notes ?? null,
    },
  });

  logger.info(
    { tenantId, scheduleId: id, status: newStatus, delayMinutes },
    'eMAR dose given',
  );
  return updated;
}

export async function holdDose(
  tenantId: string,
  userId: string,
  id: string,
  data: HoldRefuseDoseInput,
) {
  const s = await loadActionable(tenantId, id);
  if (!ACTIONABLE_STATUSES.includes(s.status)) {
    throw AppError.badRequest(`Cannot hold a dose in status "${s.status}".`);
  }
  return doStatus(tenantId, userId, s, 'held', data.reason, data.notes);
}

export async function refuseDose(
  tenantId: string,
  userId: string,
  id: string,
  data: HoldRefuseDoseInput,
) {
  const s = await loadActionable(tenantId, id);
  if (!ACTIONABLE_STATUSES.includes(s.status)) {
    throw AppError.badRequest(`Cannot refuse a dose in status "${s.status}".`);
  }
  return doStatus(tenantId, userId, s, 'refused', data.reason, data.notes);
}

export async function markMissed(
  tenantId: string,
  userId: string,
  id: string,
  data: { reason?: string; notes?: string },
) {
  const s = await loadActionable(tenantId, id);
  if (!ACTIONABLE_STATUSES.includes(s.status)) {
    throw AppError.badRequest(`Cannot mark missed when status is "${s.status}".`);
  }
  return doStatus(tenantId, userId, s, 'missed', data.reason, data.notes);
}

async function doStatus(
  tenantId: string,
  userId: string,
  s: EmarSchedule,
  toStatus: EmarDoseStatus,
  reason?: string,
  notes?: string,
) {
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.emarSchedule.update({
      where: { id: s.id },
      data: {
        status: toStatus,
        actionedAt: new Date(),
        givenById: userId,
        reason: reason ?? null,
        notes: notes ?? s.notes,
      },
    });
    await tx.emarAuditLog.create({
      data: {
        tenantId,
        scheduleId: s.id,
        action: toStatus as any,
        fromStatus: s.status,
        toStatus,
        performedById: userId,
        reason,
        notes,
      },
    });
    return row;
  });

  // Mirror to legacy table for held/refused/missed (skip pending → already created at generation)
  if (toStatus === 'held' || toStatus === 'refused' || toStatus === 'missed') {
    await prisma.medicationAdministration.create({
      data: {
        prescriptionItemId: s.prescriptionItemId,
        patientId: s.patientId,
        administeredBy: userId,
        administeredAt: new Date(),
        doseGiven: s.dosage,
        status: toStatus as any,
        notes: [reason, notes].filter(Boolean).join(' — ') || null,
      },
    });
  }

  logger.info({ tenantId, scheduleId: s.id, toStatus }, 'eMAR dose status changed');
  return updated;
}

/**
 * Amend an already-actioned dose. The classic case is missed → given_late
 * (nurse forgot to log on time). delayMinutes is computed from
 * actualGivenTime - scheduledAt so doctors see the real delay, not the
 * log entry time. Per spec rules, the amendment is recorded in the audit
 * log with the original status preserved.
 */
export async function amendDose(
  tenantId: string,
  userId: string,
  id: string,
  data: AmendDoseInput,
) {
  const s = await prisma.emarSchedule.findFirst({ where: { id, tenantId } });
  if (!s) throw AppError.notFound('Schedule row not found');
  if (s.status === 'cancelled') throw AppError.badRequest('Cannot amend a cancelled dose');

  // Reason mandatory for non-given amendments
  if ((data.toStatus === 'held' || data.toStatus === 'refused' || data.toStatus === 'missed') && !data.reason?.trim()) {
    throw AppError.badRequest('Reason is required for held/refused/missed amendments');
  }

  let delayMinutes: number | null = null;
  let actualGivenTime: Date | null = null;
  let finalStatus: EmarDoseStatus = data.toStatus;

  if (data.toStatus === 'given' || data.toStatus === 'given_late') {
    actualGivenTime = data.actualGivenTime ? new Date(data.actualGivenTime) : new Date();
    delayMinutes = diffMinutes(actualGivenTime, s.scheduledAt);
    const grace = await getGracePeriod(tenantId);
    // If marked given but actually late, normalize to given_late
    if (delayMinutes > grace) finalStatus = 'given_late';
    // If marked given_late but within grace, normalize to given
    if (data.toStatus === 'given_late' && delayMinutes <= grace) finalStatus = 'given';
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.emarSchedule.update({
      where: { id },
      data: {
        status: finalStatus,
        previousStatus: s.status,
        amendedAt: new Date(),
        amendedById: userId,
        actionedAt: new Date(),
        actualGivenTime: actualGivenTime ?? s.actualGivenTime,
        givenById: actualGivenTime ? userId : s.givenById,
        delayMinutes: delayMinutes !== null ? delayMinutes : s.delayMinutes,
        reason: data.reason ?? s.reason,
        notes: data.notes ?? s.notes,
      },
    });
    await tx.emarAuditLog.create({
      data: {
        tenantId,
        scheduleId: id,
        action: 'amended',
        fromStatus: s.status,
        toStatus: finalStatus,
        performedById: userId,
        delayMinutes,
        reason: data.reason,
        notes: data.notes,
        metadata: {
          actualGivenTime: actualGivenTime?.toISOString(),
          originalStatus: s.status,
          originalActualGivenTime: s.actualGivenTime?.toISOString() ?? null,
        },
      },
    });
    return row;
  });

  // Mirror to legacy table only for actual given outcomes
  if ((finalStatus === 'given' || finalStatus === 'given_late') && actualGivenTime) {
    await prisma.medicationAdministration.create({
      data: {
        prescriptionItemId: s.prescriptionItemId,
        patientId: s.patientId,
        administeredBy: userId,
        administeredAt: actualGivenTime,
        doseGiven: s.dosage,
        status: 'given',
        notes: ['amended', data.reason, data.notes].filter(Boolean).join(' — '),
      },
    });
  }

  logger.info(
    { tenantId, scheduleId: id, fromStatus: s.status, toStatus: finalStatus, delayMinutes },
    'eMAR dose amended',
  );
  return updated;
}

// ============================================================
// PRN trigger
// ============================================================

export async function triggerPrn(
  tenantId: string,
  userId: string,
  prescriptionItemId: string,
  data: TriggerPrnInput,
) {
  const item = await prisma.prescriptionItem.findFirst({
    where: {
      id: prescriptionItemId,
      prescription: { tenantId },
    },
    include: {
      prescription: { select: { id: true, status: true, patientId: true, visitId: true } },
    },
  });
  if (!item) throw AppError.notFound('Prescription item not found');
  if (item.prescription.status === 'cancelled') {
    throw AppError.badRequest('Prescription has been cancelled');
  }
  if (!item.isPrn) {
    throw AppError.badRequest('This is not a PRN order');
  }

  const settings = await prisma.emarSettings.findUnique({ where: { tenantId } });
  const minIntervalMinutes = settings?.defaultPrnMinIntervalMinutes ?? 240;

  // Enforce minimum interval since the last PRN administration of this item
  const lastPrn = await prisma.emarSchedule.findFirst({
    where: {
      tenantId,
      prescriptionItemId,
      isPrn: true,
      status: { in: ['given', 'given_late'] },
    },
    orderBy: { actualGivenTime: 'desc' },
  });
  if (lastPrn && lastPrn.actualGivenTime) {
    const elapsed = Math.round((Date.now() - lastPrn.actualGivenTime.getTime()) / 60_000);
    if (elapsed < minIntervalMinutes) {
      throw AppError.badRequest(
        `PRN dose blocked — minimum interval is ${minIntervalMinutes} minutes; ${minIntervalMinutes - elapsed} minutes remaining.`,
      );
    }
  }

  // Look up admissionId via the prescription's visit
  const visit = await prisma.visit.findUnique({
    where: { id: item.prescription.visitId },
    select: { admission: { select: { id: true } } },
  });
  const admissionId = visit?.admission?.id ?? null;

  const actualGivenTime = data.actualGivenTime ? new Date(data.actualGivenTime) : new Date();

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.emarSchedule.create({
      data: {
        tenantId,
        prescriptionId: item.prescriptionId,
        prescriptionItemId: item.id,
        patientId: item.prescription.patientId,
        admissionId,
        drugName: item.drugName,
        dosage: item.dosage,
        route: (item.route ?? 'oral') as MedicationRoute,
        frequencyCode: 'PRN',
        slotCode: null,
        scheduledAt: actualGivenTime,
        isPrn: true,
        status: 'given',
        actionedAt: new Date(),
        actualGivenTime,
        givenById: userId,
        delayMinutes: 0,
        notes: data.notes ?? null,
      },
    });
    await tx.emarAuditLog.create({
      data: {
        tenantId,
        scheduleId: row.id,
        action: 'prn',
        fromStatus: null,
        toStatus: 'given',
        performedById: userId,
        notes: data.notes,
      },
    });
    return row;
  });

  await prisma.medicationAdministration.create({
    data: {
      prescriptionItemId: item.id,
      patientId: item.prescription.patientId,
      administeredBy: userId,
      administeredAt: actualGivenTime,
      doseGiven: item.dosage,
      status: 'given',
      notes: data.notes ?? null,
    },
  });

  logger.info({ tenantId, prescriptionItemId, scheduleId: created.id }, 'eMAR PRN dose given');
  return created;
}

// ============================================================
// Regenerate / cancel future schedules
// ============================================================

export async function regenerate(tenantId: string, prescriptionId: string) {
  const rx = await prisma.prescription.findFirst({ where: { id: prescriptionId, tenantId } });
  if (!rx) throw AppError.notFound('Prescription not found');
  const created = await generateForPrescription(prescriptionId);
  return { prescriptionId, rowsCreated: created };
}

export async function cancelFuture(tenantId: string, prescriptionId: string, reason?: string) {
  const rx = await prisma.prescription.findFirst({ where: { id: prescriptionId, tenantId } });
  if (!rx) throw AppError.notFound('Prescription not found');
  const cancelled = await cancelFutureSchedules(prescriptionId, reason);
  return { prescriptionId, rowsCancelled: cancelled };
}

// ============================================================
// Audit
// ============================================================

export async function getAudit(tenantId: string, scheduleId: string) {
  const s = await prisma.emarSchedule.findFirst({ where: { id: scheduleId, tenantId } });
  if (!s) throw AppError.notFound('Schedule row not found');
  return prisma.emarAuditLog.findMany({
    where: { tenantId, scheduleId },
    orderBy: { performedAt: 'desc' },
    include: { performedBy: { select: { id: true, firstName: true, lastName: true } } },
  });
}

// ============================================================
// Lifecycle tick (Pending → Due → Overdue → Missed)
// ============================================================

/**
 * Server-side tick that flips dose statuses based on time.
 *  - pending → due       when scheduledAt is within the next ~30 min, OR has just elapsed
 *  - due → overdue       when scheduledAt has passed but still within grace
 *  - overdue → missed    when grace period has elapsed without action
 *
 * Idempotent and safe to run on a short cadence (e.g. every minute).
 */
export async function tickLifecycle(tenantId?: string): Promise<{
  toDue: number;
  toOverdue: number;
  toMissed: number;
}> {
  const now = new Date();

  // Determine grace per tenant — load defaults if a single tenant is targeted
  const defaultGrace = 120;

  const baseFilter: any = tenantId ? { tenantId } : {};

  // pending → due (within ±15 min of scheduled)
  const dueWindowStart = new Date(now.getTime() - 15 * 60_000);
  const dueWindowEnd = new Date(now.getTime() + 15 * 60_000);
  const toDueBatch = await prisma.emarSchedule.findMany({
    where: { ...baseFilter, status: 'pending', isPrn: false, scheduledAt: { gte: dueWindowStart, lte: dueWindowEnd } },
    select: { id: true, tenantId: true, status: true },
    take: 1000,
  });
  if (toDueBatch.length) {
    await prisma.$transaction([
      prisma.emarSchedule.updateMany({
        where: { id: { in: toDueBatch.map((r) => r.id) } },
        data: { status: 'due' },
      }),
      prisma.emarAuditLog.createMany({
        data: toDueBatch.map((r) => ({
          tenantId: r.tenantId,
          scheduleId: r.id,
          action: 'status' as const,
          fromStatus: r.status,
          toStatus: 'due' as const,
          notes: 'Auto-transition: pending → due',
        })),
      }),
    ]);
  }

  // due → overdue (past scheduledAt but still inside grace)
  // We approximate grace by the default; per-tenant grace is handled in the missed step.
  const overdueCutoff = new Date(now.getTime() - 1 * 60_000);
  const toOverdueBatch = await prisma.emarSchedule.findMany({
    where: { ...baseFilter, status: 'due', isPrn: false, scheduledAt: { lt: overdueCutoff } },
    select: { id: true, tenantId: true, status: true },
    take: 1000,
  });
  if (toOverdueBatch.length) {
    await prisma.$transaction([
      prisma.emarSchedule.updateMany({
        where: { id: { in: toOverdueBatch.map((r) => r.id) } },
        data: { status: 'overdue' },
      }),
      prisma.emarAuditLog.createMany({
        data: toOverdueBatch.map((r) => ({
          tenantId: r.tenantId,
          scheduleId: r.id,
          action: 'status' as const,
          fromStatus: r.status,
          toStatus: 'overdue' as const,
          notes: 'Auto-transition: due → overdue',
        })),
      }),
    ]);
  }

  // overdue → missed (past scheduledAt + grace)
  // Pull tenant grace settings in one go so the cutoff per row is correct.
  const tenants = await prisma.emarSettings.findMany({
    where: tenantId ? { tenantId } : {},
    select: { tenantId: true, gracePeriodMinutes: true },
  });
  const graceByTenant = new Map(tenants.map((t) => [t.tenantId, t.gracePeriodMinutes ?? defaultGrace]));

  // Find candidates with the most permissive cutoff, then filter per-tenant grace below.
  const broadCutoff = new Date(now.getTime() - defaultGrace * 60_000);
  const candidates = await prisma.emarSchedule.findMany({
    where: {
      ...baseFilter,
      status: { in: ['pending', 'due', 'overdue'] },
      isPrn: false,
      scheduledAt: { lt: broadCutoff },
    },
    select: { id: true, tenantId: true, status: true, scheduledAt: true },
    take: 1000,
  });

  const toMissedIds: { id: string; tenantId: string; from: any }[] = [];
  for (const c of candidates) {
    const grace = graceByTenant.get(c.tenantId) ?? defaultGrace;
    if (c.scheduledAt.getTime() + grace * 60_000 < now.getTime()) {
      toMissedIds.push({ id: c.id, tenantId: c.tenantId, from: c.status });
    }
  }
  if (toMissedIds.length) {
    await prisma.$transaction([
      prisma.emarSchedule.updateMany({
        where: { id: { in: toMissedIds.map((r) => r.id) } },
        data: { status: 'missed', actionedAt: now },
      }),
      prisma.emarAuditLog.createMany({
        data: toMissedIds.map((r) => ({
          tenantId: r.tenantId,
          scheduleId: r.id,
          action: 'missed' as const,
          fromStatus: r.from,
          toStatus: 'missed' as const,
          notes: 'Auto-transition: grace period elapsed without administration',
        })),
      }),
    ]);
  }

  return {
    toDue: toDueBatch.length,
    toOverdue: toOverdueBatch.length,
    toMissed: toMissedIds.length,
  };
}
