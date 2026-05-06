import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateNurseAssignmentInput,
  GetNurseAssignmentsQuery,
  UpdateNurseAssignmentInput,
  EndNurseAssignmentInput,
  HandoverNurseAssignmentInput,
  BulkHandoverInput,
} from './nurse-assignments.validation';

const assignmentInclude = {
  nurse: { select: { id: true, firstName: true, lastName: true, email: true } },
  assigner: { select: { id: true, firstName: true, lastName: true } },
  handedOverTo: { select: { id: true, firstName: true, lastName: true } },
  ward: { select: { id: true, name: true } },
  bed: { select: { id: true, bedNumber: true } },
  admission: {
    select: {
      id: true,
      status: true,
      bedId: true,
      wardId: true,
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
    },
  },
} as const;

/**
 * Create a patient-to-nurse assignment for a shift.
 * Rejects OPD (non-admitted) patients and collides with an active assignment for
 * the same admission / shift-date / shift-type (enforced at DB level by a partial
 * unique index; we do the check here too for a clean error message).
 */
export async function createNurseAssignment(
  tenantId: string,
  assignerUserId: string,
  data: CreateNurseAssignmentInput,
) {
  const admission = await prisma.admission.findFirst({
    where: { id: data.admissionId, tenantId },
    select: { id: true, status: true, wardId: true, bedId: true },
  });
  if (!admission) throw AppError.notFound('Admission not found');
  if (admission.status !== 'admitted') {
    throw AppError.badRequest('Nurse assignments are only allowed for currently admitted (IPD) patients');
  }

  const nurse = await prisma.user.findFirst({
    where: { id: data.nurseId, tenantId, isActive: true },
    select: { id: true },
  });
  if (!nurse) throw AppError.notFound('Nurse user not found or inactive');

  const existingActive = await prisma.nurseAssignment.findFirst({
    where: {
      admissionId: data.admissionId,
      shiftDate: new Date(data.shiftDate),
      shiftType: data.shiftType as any,
      status: 'active',
    },
  });
  if (existingActive) {
    throw AppError.conflict(
      'An active nurse assignment already exists for this admission on this shift',
    );
  }

  const assignment = await prisma.nurseAssignment.create({
    data: {
      tenantId,
      admissionId: data.admissionId,
      nurseId: data.nurseId,
      wardId: admission.wardId,
      bedId: data.bedId ?? admission.bedId,
      shiftDate: new Date(data.shiftDate),
      shiftType: data.shiftType as any,
      assignedById: assignerUserId,
      notes: data.notes ?? null,
    },
    include: assignmentInclude,
  });

  logger.info(
    { tenantId, assignmentId: assignment.id, admissionId: data.admissionId },
    'Nurse assignment created',
  );
  return assignment;
}

export async function listNurseAssignments(
  tenantId: string,
  query: GetNurseAssignmentsQuery,
) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };
  if (query.wardId) where.wardId = query.wardId;
  if (query.admissionId) where.admissionId = query.admissionId;
  if (query.nurseId) where.nurseId = query.nurseId;
  if (query.shiftType) where.shiftType = query.shiftType;
  if (query.status) where.status = query.status;
  if (query.shiftDate) where.shiftDate = new Date(query.shiftDate);

  const [rows, total] = await Promise.all([
    prisma.nurseAssignment.findMany({
      where,
      skip,
      take,
      orderBy: [{ shiftDate: 'desc' }, { assignedAt: 'desc' }],
      include: assignmentInclude,
    }),
    prisma.nurseAssignment.count({ where }),
  ]);

  return { rows, total, page, limit };
}

export async function getNurseAssignmentById(tenantId: string, id: string) {
  const row = await prisma.nurseAssignment.findFirst({
    where: { id, tenantId },
    include: assignmentInclude,
  });
  if (!row) throw AppError.notFound('Nurse assignment not found');
  return row;
}

export async function updateNurseAssignment(
  tenantId: string,
  id: string,
  data: UpdateNurseAssignmentInput,
) {
  const existing = await prisma.nurseAssignment.findFirst({
    where: { id, tenantId },
    select: { id: true, status: true },
  });
  if (!existing) throw AppError.notFound('Nurse assignment not found');
  if (existing.status !== 'active') {
    throw AppError.badRequest('Only active assignments can be modified');
  }

  const updateData: any = {};
  if (data.nurseId !== undefined) updateData.nurseId = data.nurseId;
  if (data.bedId !== undefined) updateData.bedId = data.bedId;
  if (data.notes !== undefined) updateData.notes = data.notes;

  const row = await prisma.nurseAssignment.update({
    where: { id },
    data: updateData,
    include: assignmentInclude,
  });
  logger.info({ tenantId, assignmentId: id }, 'Nurse assignment updated');
  return row;
}

export async function endNurseAssignment(
  tenantId: string,
  id: string,
  data: EndNurseAssignmentInput,
) {
  const existing = await prisma.nurseAssignment.findFirst({
    where: { id, tenantId },
    select: { id: true, status: true },
  });
  if (!existing) throw AppError.notFound('Nurse assignment not found');
  if (existing.status !== 'active') {
    throw AppError.badRequest('Only active assignments can be ended');
  }

  const row = await prisma.nurseAssignment.update({
    where: { id },
    data: {
      status: 'ended',
      endedAt: new Date(),
      endedReason: data.reason ?? null,
    },
    include: assignmentInclude,
  });
  logger.info({ tenantId, assignmentId: id }, 'Nurse assignment ended');
  return row;
}

/**
 * Hand over a single assignment to the next-shift nurse. Marks the source row
 * handed_over and creates a new active row for the recipient in one txn.
 */
export async function handoverNurseAssignment(
  tenantId: string,
  assignerUserId: string,
  id: string,
  data: HandoverNurseAssignmentInput,
) {
  const existing = await prisma.nurseAssignment.findFirst({
    where: { id, tenantId },
  });
  if (!existing) throw AppError.notFound('Nurse assignment not found');
  if (existing.status !== 'active') {
    throw AppError.badRequest('Only active assignments can be handed over');
  }

  const newShiftDate = data.toShiftDate ? new Date(data.toShiftDate) : existing.shiftDate;

  const { prev, next } = await prisma.$transaction(async (tx) => {
    const prev = await tx.nurseAssignment.update({
      where: { id },
      data: {
        status: 'handed_over',
        handedOverToId: data.toNurseId,
        handedOverAt: new Date(),
        handoverNoteId: data.handoverNoteId ?? null,
      },
    });

    const next = await tx.nurseAssignment.create({
      data: {
        tenantId,
        admissionId: existing.admissionId,
        nurseId: data.toNurseId,
        wardId: existing.wardId,
        bedId: existing.bedId,
        shiftDate: newShiftDate,
        shiftType: data.toShiftType as any,
        assignedById: assignerUserId,
        notes: data.notes ?? null,
        handoverNoteId: data.handoverNoteId ?? null,
      },
    });

    return { prev, next };
  });

  logger.info(
    { tenantId, prevId: prev.id, newId: next.id },
    'Nurse assignment handed over',
  );
  return { handedOver: prev, current: next };
}

/**
 * Bulk handover: for a given ward + shift, map every active assignment's current
 * nurse to a target nurse and transfer them all atomically.
 */
export async function bulkHandoverAssignments(
  tenantId: string,
  assignerUserId: string,
  data: BulkHandoverInput,
) {
  const active = await prisma.nurseAssignment.findMany({
    where: {
      tenantId,
      wardId: data.wardId,
      shiftDate: new Date(data.shiftDate),
      shiftType: data.fromShiftType as any,
      status: 'active',
    },
  });

  const mapping = new Map(data.mapping.map((m) => [m.fromNurseId, m.toNurseId]));
  const newShiftDate = data.toShiftDate ? new Date(data.toShiftDate) : new Date(data.shiftDate);

  const transferred: Array<{ prev: string; next: string }> = [];
  const unassigned: Array<{ assignmentId: string; reason: string }> = [];

  await prisma.$transaction(async (tx) => {
    for (const src of active) {
      const toNurseId = mapping.get(src.nurseId);
      if (!toNurseId) {
        unassigned.push({ assignmentId: src.id, reason: 'no mapping for source nurse' });
        continue;
      }

      const prev = await tx.nurseAssignment.update({
        where: { id: src.id },
        data: {
          status: 'handed_over',
          handedOverToId: toNurseId,
          handedOverAt: new Date(),
          handoverNoteId: data.handoverNoteId ?? null,
        },
      });

      const next = await tx.nurseAssignment.create({
        data: {
          tenantId,
          admissionId: src.admissionId,
          nurseId: toNurseId,
          wardId: src.wardId,
          bedId: src.bedId,
          shiftDate: newShiftDate,
          shiftType: data.toShiftType as any,
          assignedById: assignerUserId,
          handoverNoteId: data.handoverNoteId ?? null,
        },
      });

      transferred.push({ prev: prev.id, next: next.id });
    }
  });

  logger.info(
    { tenantId, transferred: transferred.length, unassigned: unassigned.length },
    'Bulk handover complete',
  );
  return { transferred, unassigned };
}

/**
 * Utility to fetch the current active nurse for an admission (null if none).
 * Useful for patient-detail and order-ack views.
 */
export async function getActiveAssignmentForAdmission(tenantId: string, admissionId: string) {
  return prisma.nurseAssignment.findFirst({
    where: { tenantId, admissionId, status: 'active' },
    orderBy: { assignedAt: 'desc' },
    include: assignmentInclude,
  });
}

/**
 * Per-nurse "what nurse_admin set up for me" feed.
 *
 * `incoming`: every active assignment that was created from a handover
 *  pointing at this nurse. Each row carries the prior nurse so the bedside
 *  view can say "you're taking over from Nurse X".
 *
 * `outgoing`: every handed_over assignment where this nurse was the source.
 *  Carries the recipient so the outgoing nurse can see "you handed over to
 *  Nurse Y at HH:mm".
 *
 * No schema additions — lineage is reconstructed by matching admissionId +
 * handoverNoteId between the source and successor rows. The handover note
 * narrative is included so the nurse sees the ward-level context inline.
 */
export async function getHandoverFeedForNurse(
  tenantId: string,
  nurseUserId: string,
  query: { shiftDate?: string; shiftType?: string; lookbackHours?: number },
) {
  const lookbackHours = query.lookbackHours ?? 24;
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  // Outgoing: rows where I was the source nurse and admin marked them handed_over.
  const outgoingRows = await prisma.nurseAssignment.findMany({
    where: {
      tenantId,
      nurseId: nurseUserId,
      status: 'handed_over',
      handedOverAt: { gte: since },
      ...(query.shiftDate ? { shiftDate: new Date(query.shiftDate) } : {}),
      ...(query.shiftType ? { shiftType: query.shiftType as any } : {}),
    },
    orderBy: { handedOverAt: 'desc' },
    include: {
      ...assignmentInclude,
      handoverNote: {
        select: { id: true, content: true, shiftDate: true, shiftType: true },
      },
    },
  });

  // Incoming: rows where I was the handover *recipient*. Source row's
  // handedOverToId == me; the successor active row is created in the same
  // transaction with the same admission + handoverNoteId.
  const incomingSourceRows = await prisma.nurseAssignment.findMany({
    where: {
      tenantId,
      handedOverToId: nurseUserId,
      status: 'handed_over',
      handedOverAt: { gte: since },
    },
    orderBy: { handedOverAt: 'desc' },
    include: {
      ...assignmentInclude,
      handoverNote: {
        select: { id: true, content: true, shiftDate: true, shiftType: true },
      },
    },
  });

  // For each incoming source row, locate the matching active successor that
  // was created for this nurse. A nurse can technically have two handovers
  // for the same admission (rare) so we pick the latest active row by
  // assignedAt; that's the one bedside care should follow.
  const successors = await prisma.nurseAssignment.findMany({
    where: {
      tenantId,
      nurseId: nurseUserId,
      status: 'active',
      admissionId: { in: incomingSourceRows.map((r) => r.admissionId) },
    },
    orderBy: { assignedAt: 'desc' },
    include: assignmentInclude,
  });
  const successorByAdmission = new Map<string, (typeof successors)[number]>();
  for (const s of successors) {
    if (!successorByAdmission.has(s.admissionId)) {
      successorByAdmission.set(s.admissionId, s);
    }
  }

  const incoming = incomingSourceRows.map((src) => {
    const successor = successorByAdmission.get(src.admissionId) ?? null;
    return {
      sourceAssignmentId: src.id,
      handedOverAt: src.handedOverAt,
      fromShiftDate: src.shiftDate,
      fromShiftType: src.shiftType,
      fromNurse: src.nurse,
      ward: src.ward,
      bed: src.bed,
      admission: src.admission,
      note: src.handoverNote ?? null,
      successor: successor
        ? {
            id: successor.id,
            shiftDate: successor.shiftDate,
            shiftType: successor.shiftType,
            assignedAt: successor.assignedAt,
            ward: successor.ward,
            bed: successor.bed,
          }
        : null,
    };
  });

  const outgoing = outgoingRows.map((row) => ({
    sourceAssignmentId: row.id,
    handedOverAt: row.handedOverAt,
    shiftDate: row.shiftDate,
    shiftType: row.shiftType,
    toNurse: row.handedOverTo,
    ward: row.ward,
    bed: row.bed,
    admission: row.admission,
    note: row.handoverNote ?? null,
  }));

  return {
    nurseId: nurseUserId,
    incoming,
    outgoing,
    counts: { incoming: incoming.length, outgoing: outgoing.length },
  };
}
