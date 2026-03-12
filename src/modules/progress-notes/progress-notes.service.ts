import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateProgressNoteInput,
  UpdateProgressNoteInput,
  ListProgressNotesQuery,
  CreateNursingNoteInput,
  UpdateNursingNoteInput,
  ListNursingNotesQuery,
} from './progress-notes.validation';

// ============================================================
// Progress Notes
// ============================================================

/**
 * Verify that a visit belongs to the given tenant.
 */
async function verifyVisitTenant(visitId: string, tenantId: string) {
  const visit = await prisma.visit.findFirst({
    where: { id: visitId, tenantId },
    select: { id: true },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }
  return visit;
}

/**
 * Create a new progress note.
 */
export async function createProgressNote(
  tenantId: string,
  userId: string,
  data: CreateProgressNoteInput,
) {
  await verifyVisitTenant(data.visitId, tenantId);

  // Look up the doctor profile for the authenticated user
  const doctorProfile = await prisma.doctorProfile.findFirst({
    where: { userId, tenantId },
    select: { id: true },
  });

  if (!doctorProfile) {
    throw AppError.badRequest('No doctor profile found for the current user');
  }

  const note = await prisma.progressNote.create({
    data: {
      visitId: data.visitId,
      patientId: data.patientId,
      doctorId: doctorProfile.id,
      noteType: data.noteType as any,
      content: data.content,
      pinToDischargeSummary: data.pinToDischargeSummary ?? false,
    },
    include: {
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      },
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
    },
  });

  logger.info({ tenantId, noteId: note.id, visitId: data.visitId }, 'Progress note created');
  return note;
}

/**
 * List progress notes with pagination, filtered by tenant.
 */
export async function getProgressNotes(tenantId: string, query: ListProgressNotesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = {
    visit: { tenantId },
  };

  if (query.visitId) {
    where.visitId = query.visitId;
  }

  if (query.patientId) {
    where.patientId = query.patientId;
  }

  if (query.noteType) {
    where.noteType = query.noteType;
  }

  if (query.status) {
    where.status = query.status;
  }

  if (query.search) {
    where.content = { contains: query.search, mode: 'insensitive' };
  }

  const orderBy: any = {};
  if (query.sortBy) {
    orderBy[query.sortBy] = query.sortOrder || 'desc';
  } else {
    orderBy.createdAt = 'desc';
  }

  const [notes, total] = await Promise.all([
    prisma.progressNote.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        doctor: {
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        },
        patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      },
    }),
    prisma.progressNote.count({ where }),
  ]);

  return { notes, total, page, limit };
}

/**
 * Get a single progress note by ID, scoped to tenant.
 */
export async function getProgressNoteById(tenantId: string, id: string) {
  const note = await prisma.progressNote.findFirst({
    where: {
      id,
      visit: { tenantId },
    },
    include: {
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      },
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      visit: { select: { id: true, visitType: true, visitDate: true, status: true } },
    },
  });

  if (!note) {
    throw AppError.notFound('Progress note not found');
  }

  return note;
}

/**
 * Update a progress note. Only active (non-finalized) notes can be updated.
 */
export async function updateProgressNote(
  tenantId: string,
  id: string,
  data: UpdateProgressNoteInput,
) {
  const existing = await prisma.progressNote.findFirst({
    where: {
      id,
      visit: { tenantId },
    },
  });

  if (!existing) {
    throw AppError.notFound('Progress note not found');
  }

  if (existing.status === 'finalized') {
    throw AppError.badRequest('Cannot update a finalized progress note');
  }

  const updateData: any = {};
  if (data.noteType !== undefined) updateData.noteType = data.noteType;
  if (data.content !== undefined) updateData.content = data.content;
  if (data.pinToDischargeSummary !== undefined)
    updateData.pinToDischargeSummary = data.pinToDischargeSummary;

  const note = await prisma.progressNote.update({
    where: { id },
    data: updateData,
    include: {
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      },
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
    },
  });

  logger.info({ tenantId, noteId: id }, 'Progress note updated');
  return note;
}

/**
 * Delete (soft-delete by setting status to finalized, or hard-delete) a progress note.
 */
export async function deleteProgressNote(tenantId: string, id: string) {
  const existing = await prisma.progressNote.findFirst({
    where: {
      id,
      visit: { tenantId },
    },
  });

  if (!existing) {
    throw AppError.notFound('Progress note not found');
  }

  await prisma.progressNote.delete({
    where: { id },
  });

  logger.info({ tenantId, noteId: id }, 'Progress note deleted');
}

/**
 * Sign (finalize) a progress note. Sets status to finalized.
 */
export async function signProgressNote(tenantId: string, id: string, userId: string) {
  const existing = await prisma.progressNote.findFirst({
    where: {
      id,
      visit: { tenantId },
    },
  });

  if (!existing) {
    throw AppError.notFound('Progress note not found');
  }

  if (existing.status === 'finalized') {
    throw AppError.badRequest('Progress note is already finalized');
  }

  const note = await prisma.progressNote.update({
    where: { id },
    data: {
      status: 'finalized',
    },
    include: {
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      },
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
    },
  });

  logger.info({ tenantId, noteId: id, signedBy: userId }, 'Progress note signed/finalized');
  return note;
}

// ============================================================
// Nursing Notes
// ============================================================

/**
 * Create a new nursing note.
 */
export async function createNursingNote(
  tenantId: string,
  userId: string,
  data: CreateNursingNoteInput,
) {
  await verifyVisitTenant(data.visitId, tenantId);

  const note = await prisma.nursingNote.create({
    data: {
      visitId: data.visitId,
      patientId: data.patientId,
      nurseId: userId,
      noteType: data.noteType as any,
      content: data.content,
    },
    include: {
      nurse: { select: { id: true, firstName: true, lastName: true } },
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
    },
  });

  logger.info({ tenantId, noteId: note.id, visitId: data.visitId }, 'Nursing note created');
  return note;
}

/**
 * List nursing notes with pagination, filtered by tenant.
 */
export async function getNursingNotes(tenantId: string, query: ListNursingNotesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = {
    visit: { tenantId },
  };

  if (query.visitId) {
    where.visitId = query.visitId;
  }

  if (query.patientId) {
    where.patientId = query.patientId;
  }

  if (query.noteType) {
    where.noteType = query.noteType;
  }

  if (query.search) {
    where.content = { contains: query.search, mode: 'insensitive' };
  }

  const orderBy: any = {};
  if (query.sortBy) {
    orderBy[query.sortBy] = query.sortOrder || 'desc';
  } else {
    orderBy.createdAt = 'desc';
  }

  const [notes, total] = await Promise.all([
    prisma.nursingNote.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        nurse: { select: { id: true, firstName: true, lastName: true } },
        patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      },
    }),
    prisma.nursingNote.count({ where }),
  ]);

  return { notes, total, page, limit };
}

/**
 * Get a single nursing note by ID, scoped to tenant.
 */
export async function getNursingNoteById(tenantId: string, id: string) {
  const note = await prisma.nursingNote.findFirst({
    where: {
      id,
      visit: { tenantId },
    },
    include: {
      nurse: { select: { id: true, firstName: true, lastName: true } },
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      visit: { select: { id: true, visitType: true, visitDate: true, status: true } },
    },
  });

  if (!note) {
    throw AppError.notFound('Nursing note not found');
  }

  return note;
}

/**
 * Update a nursing note.
 */
export async function updateNursingNote(
  tenantId: string,
  id: string,
  data: UpdateNursingNoteInput,
) {
  const existing = await prisma.nursingNote.findFirst({
    where: {
      id,
      visit: { tenantId },
    },
  });

  if (!existing) {
    throw AppError.notFound('Nursing note not found');
  }

  const updateData: any = {};
  if (data.noteType !== undefined) updateData.noteType = data.noteType;
  if (data.content !== undefined) updateData.content = data.content;

  const note = await prisma.nursingNote.update({
    where: { id },
    data: updateData,
    include: {
      nurse: { select: { id: true, firstName: true, lastName: true } },
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
    },
  });

  logger.info({ tenantId, noteId: id }, 'Nursing note updated');
  return note;
}

/**
 * Delete a nursing note.
 */
export async function deleteNursingNote(tenantId: string, id: string) {
  const existing = await prisma.nursingNote.findFirst({
    where: {
      id,
      visit: { tenantId },
    },
  });

  if (!existing) {
    throw AppError.notFound('Nursing note not found');
  }

  await prisma.nursingNote.delete({
    where: { id },
  });

  logger.info({ tenantId, noteId: id }, 'Nursing note deleted');
}
