import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { writeAudit } from '../../shared/audit';
import { istDayRange } from '../../shared/date.utils';
import type {
  CounsellingFilter,
  CounsellingStatus,
  CreateCounsellingSessionInput,
  ListCounsellingSessionsQuery,
  UpdateCounsellingSessionInput,
  UpdateCounsellingStatusInput,
} from './counselling.validation';

// ============================================================
// Counselling sessions & referrals — service (gap #200 / #298)
// ============================================================
// Counsellor Home reads ONLY these rows. It used to read OP visits, so a
// doctor's follow-up showed up as a counselling session with the doctor as the
// counsellor (gap #200), and New Session booked a doctor appointment (#298).

/** Roles whose holders may be assigned a counselling session. */
export const COUNSELLOR_ROLE_NAMES = ['counsellor', 'admin'] as const;

const ENTITY = 'counselling_session';

const personSelect = { id: true, firstName: true, lastName: true } as const;

const sessionInclude = {
  patient: {
    select: { id: true, firstName: true, lastName: true, mrn: true, phone: true, gender: true, dateOfBirth: true },
  },
  counsellor: { select: personSelect },
  createdBy: { select: personSelect },
  referredBy: { select: personSelect },
} satisfies Prisma.CounsellingSessionInclude;

/**
 * Which statuses each status may move to. Terminal states stay terminal: a
 * completed session reopened by accident would be counted twice in a day's
 * tiles, and a cancellation keeps its reason.
 */
const TRANSITIONS: Record<CounsellingStatus, CounsellingStatus[]> = {
  pending: ['in_progress', 'cancelled', 'no_show'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
};

/** A 400 the New Session dialog can pin to the field it is about. */
function fieldError(field: string, message: string): AppError {
  return new AppError(message, 400, 'INVALID_FIELD', { field });
}

/**
 * The one `where` both the list and the stats use, so the tiles always count
 * exactly the rows the table can page through (gap #200).
 */
export function buildCounsellingWhere(
  tenantId: string,
  filter: CounsellingFilter,
): Prisma.CounsellingSessionWhereInput {
  const where: Prisma.CounsellingSessionWhereInput = { tenantId };

  // Day boundaries are the hospital's (IST) day, not the server's.
  if (filter.date) {
    const { start, end } = istDayRange(filter.date);
    where.scheduledAt = { gte: start, lte: end };
  } else if (filter.fromDate || filter.toDate) {
    where.scheduledAt = {
      ...(filter.fromDate && { gte: istDayRange(filter.fromDate).start }),
      ...(filter.toDate && { lte: istDayRange(filter.toDate).end }),
    };
  }

  if (filter.status) where.status = filter.status;
  if (filter.kind) where.kind = filter.kind;
  if (filter.counsellorId) where.counsellorId = filter.counsellorId;
  if (filter.patientId) where.patientId = filter.patientId;

  // Every word must match the patient's first name, last name or MRN, so
  // "ravi kumar" finds Ravi Kumar and not every Ravi and every Kumar.
  const tokens = (filter.search ?? '').split(/\s+/).filter(Boolean).slice(0, 5);
  if (tokens.length) {
    where.AND = tokens.map((t) => ({
      patient: {
        OR: [
          { firstName: { contains: t, mode: 'insensitive' as const } },
          { lastName: { contains: t, mode: 'insensitive' as const } },
          { mrn: { contains: t, mode: 'insensitive' as const } },
        ],
      },
    }));
  }

  return where;
}

export async function listSessions(tenantId: string, query: ListCounsellingSessionsQuery) {
  const { page, limit, ...filter } = query;
  const where = buildCounsellingWhere(tenantId, filter);
  const [data, total] = await Promise.all([
    prisma.counsellingSession.findMany({
      where,
      include: sessionInclude,
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.counsellingSession.count({ where }),
  ]);
  return { data, total, page, limit };
}

export interface CounsellingStats {
  total: number;
  pending: number;
  in_progress: number;
  completed: number;
  cancelled: number;
  no_show: number;
}

export async function getStats(tenantId: string, filter: CounsellingFilter): Promise<CounsellingStats> {
  const where = buildCounsellingWhere(tenantId, filter);
  const groups = await prisma.counsellingSession.groupBy({
    by: ['status'],
    where,
    _count: { _all: true },
  });
  const stats: CounsellingStats = { total: 0, pending: 0, in_progress: 0, completed: 0, cancelled: 0, no_show: 0 };
  for (const g of groups as Array<{ status: CounsellingStatus; _count: { _all: number } }>) {
    const n = g._count?._all ?? 0;
    stats[g.status] = n;
    // Total is the sum of the same groups, never a separate query that could
    // drift from them.
    stats.total += n;
  }
  return stats;
}

export async function getSession(tenantId: string, id: string) {
  const session = await prisma.counsellingSession.findFirst({ where: { id, tenantId }, include: sessionInclude });
  if (!session) throw AppError.notFound('Counselling session not found');
  return session;
}

/**
 * Users who can be assigned a session: active holders of the counsellor or
 * admin role in this hospital, plus the hospital's owner-admins (they sign in
 * on the platform tenant and work here via X-Tenant-Id, so their own User row
 * carries a different tenantId).
 */
function counsellorWhere(tenantId: string): Prisma.UserWhereInput {
  return {
    isActive: true,
    OR: [
      {
        tenantId,
        userRoles: { some: { role: { tenantId, name: { in: [...COUNSELLOR_ROLE_NAMES] } } } },
      },
      { tenantOwners: { some: { tenantId } } },
    ],
  };
}

export async function listCounsellors(tenantId: string) {
  const users = await prisma.user.findMany({
    where: counsellorWhere(tenantId),
    select: {
      ...personSelect,
      email: true,
      userRoles: { select: { role: { select: { name: true, tenantId: true } } } },
    },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  });
  return users.map((u) => {
    const roles = (u.userRoles ?? []).map((ur) => ur.role?.name).filter(Boolean) as string[];
    return {
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      // Lets the picker list real counsellors first and mark admins as such.
      isCounsellor: roles.includes('counsellor'),
    };
  });
}

async function assertEligibleCounsellor(tenantId: string, counsellorId: string) {
  const user = await prisma.user.findFirst({
    where: { AND: [{ id: counsellorId }, counsellorWhere(tenantId)] },
    select: { id: true },
  });
  if (!user) {
    throw fieldError('counsellorId', 'Pick an active counsellor of this hospital');
  }
}

export async function createSession(tenantId: string, userId: string, input: CreateCounsellingSessionInput) {
  const patient = await prisma.patient.findFirst({
    where: { id: input.patientId, tenantId, isActive: true },
    select: { id: true, firstName: true, lastName: true, mrn: true },
  });
  if (!patient) throw fieldError('patientId', 'Patient not found in this hospital');

  await assertEligibleCounsellor(tenantId, input.counsellorId);

  const isReferral = input.kind === 'referral';
  if (isReferral && input.referredById) {
    const referrer = await prisma.user.findFirst({
      where: {
        id: input.referredById,
        isActive: true,
        OR: [{ tenantId }, { tenantOwners: { some: { tenantId } } }],
      },
      select: { id: true },
    });
    if (!referrer) throw fieldError('referredById', 'Referring user not found in this hospital');
  }
  // A linked visit/appointment must be this patient's, in this hospital.
  if (isReferral && input.visitId) {
    const visit = await prisma.visit.findFirst({
      where: { id: input.visitId, tenantId, patientId: patient.id },
      select: { id: true },
    });
    if (!visit) throw fieldError('visitId', 'Visit not found for this patient');
  }
  if (isReferral && input.appointmentId) {
    const appt = await prisma.appointment.findFirst({
      where: { id: input.appointmentId, tenantId, patientId: patient.id },
      select: { id: true },
    });
    if (!appt) throw fieldError('appointmentId', 'Appointment not found for this patient');
  }

  const session = await prisma.counsellingSession.create({
    data: {
      tenantId,
      patientId: patient.id,
      counsellorId: input.counsellorId,
      createdById: userId,
      kind: input.kind,
      sessionType: input.sessionType,
      scheduledAt: new Date(input.scheduledAt),
      notes: input.notes?.trim() || null,
      // Explicit, not left to the column default: every new session or
      // referral starts in the queue as Pending.
      status: 'pending',
      referralSource: isReferral ? input.referralSource?.trim() || null : null,
      referredById: isReferral ? input.referredById ?? null : null,
      visitId: isReferral ? input.visitId ?? null : null,
      appointmentId: isReferral ? input.appointmentId ?? null : null,
    },
    include: sessionInclude,
  });

  void writeAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: ENTITY,
    entityId: session.id,
    description: `Counselling ${isReferral ? 'referral' : 'session'} (${input.sessionType}) booked for ${[patient.firstName, patient.lastName].filter(Boolean).join(' ')} (${patient.mrn})`,
    newValues: {
      kind: session.kind,
      sessionType: session.sessionType,
      counsellorId: session.counsellorId,
      scheduledAt: session.scheduledAt,
      status: session.status,
    },
  });

  return session;
}

export async function updateStatus(
  tenantId: string,
  userId: string,
  id: string,
  input: UpdateCounsellingStatusInput,
) {
  const current = await prisma.counsellingSession.findFirst({
    where: { id, tenantId },
    select: { id: true, status: true },
  });
  if (!current) throw AppError.notFound('Counselling session not found');

  const from = current.status as CounsellingStatus;
  const to = input.status as CounsellingStatus;
  if (!TRANSITIONS[from].includes(to)) {
    throw AppError.conflict(`A ${from.replace('_', ' ')} session cannot be marked ${to.replace('_', ' ')}`, 'INVALID_TRANSITION');
  }

  const now = new Date();
  const data: Prisma.CounsellingSessionUpdateManyMutationInput = { status: to };
  if (to === 'in_progress') data.startedAt = now;
  if (to === 'completed') data.completedAt = now;
  if (to === 'cancelled') {
    data.cancelledAt = now;
    data.cancelledReason = input.reason?.trim();
  }
  if (input.notes !== undefined) data.notes = input.notes.trim() || null;

  // Guarded on the status we read, so two people pressing Start/Cancel at once
  // cannot both win and leave the counts disagreeing with the row.
  const result = await prisma.counsellingSession.updateMany({
    where: { id, tenantId, status: from },
    data,
  });
  if (result.count === 0) {
    throw AppError.conflict('This session was changed by someone else — refresh and try again', 'STALE_STATUS');
  }

  void writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: ENTITY,
    entityId: id,
    description: `Counselling session ${from} → ${to}`,
    reason: to === 'cancelled' ? input.reason : undefined,
    oldValues: { status: from },
    newValues: { status: to },
  });

  return getSession(tenantId, id);
}

export async function updateSession(
  tenantId: string,
  userId: string,
  id: string,
  input: UpdateCounsellingSessionInput,
) {
  const current = await prisma.counsellingSession.findFirst({
    where: { id, tenantId },
    select: { id: true, status: true, scheduledAt: true, notes: true, counsellorId: true, sessionType: true },
  });
  if (!current) throw AppError.notFound('Counselling session not found');

  const reschedules =
    input.scheduledAt !== undefined || input.counsellorId !== undefined || input.sessionType !== undefined;
  // Moving or reassigning only makes sense before the session has started.
  if (reschedules && current.status !== 'pending') {
    throw AppError.conflict('Only a pending session can be rescheduled or reassigned', 'NOT_PENDING');
  }
  if (current.status === 'cancelled') {
    throw AppError.conflict('A cancelled session cannot be edited', 'CANCELLED');
  }
  if (input.counsellorId) await assertEligibleCounsellor(tenantId, input.counsellorId);

  const data: Prisma.CounsellingSessionUpdateInput = {};
  if (input.scheduledAt !== undefined) data.scheduledAt = new Date(input.scheduledAt);
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
  if (input.counsellorId !== undefined) data.counsellor = { connect: { id: input.counsellorId } };
  if (input.sessionType !== undefined) data.sessionType = input.sessionType;

  await prisma.counsellingSession.update({ where: { id: current.id }, data });

  void writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: ENTITY,
    entityId: id,
    description: input.scheduledAt ? 'Counselling session rescheduled' : 'Counselling session updated',
    oldValues: {
      scheduledAt: current.scheduledAt,
      notes: current.notes,
      counsellorId: current.counsellorId,
      sessionType: current.sessionType,
    },
    newValues: input,
  });

  return getSession(tenantId, id);
}
