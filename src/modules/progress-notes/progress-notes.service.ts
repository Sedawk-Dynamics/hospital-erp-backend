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
  CreateProgressNoteTemplateInput,
  UpdateProgressNoteTemplateInput,
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
      impressions: data.impressions ?? null,
      discussions: data.discussions ?? null,
      conclusions: data.conclusions ?? null,
      customFields: (data.customFields as any) ?? undefined,
      weightKgAtEntry: data.weightKgAtEntry ?? null,
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
  } else if (!query.includeArchived) {
    // By default hide archived (auto-moved) notes unless explicitly requested
    where.status = { in: ['active', 'finalized'] };
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
  if (existing.status === 'archived') {
    throw AppError.badRequest('Cannot update an archived progress note');
  }

  const updateData: any = {};
  if (data.noteType !== undefined) updateData.noteType = data.noteType;
  if (data.content !== undefined) updateData.content = data.content;
  if (data.impressions !== undefined) updateData.impressions = data.impressions;
  if (data.discussions !== undefined) updateData.discussions = data.discussions;
  if (data.conclusions !== undefined) updateData.conclusions = data.conclusions;
  if (data.customFields !== undefined) updateData.customFields = data.customFields as any;
  if (data.weightKgAtEntry !== undefined) updateData.weightKgAtEntry = data.weightKgAtEntry;
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
  if (data.visitId) {
    await verifyVisitTenant(data.visitId, tenantId);
  }

  const noteData: any = {
    patientId: data.patientId,
    nurseId: userId,
    noteType: data.noteType as any,
    content: data.content,
  };
  if (data.visitId) noteData.visitId = data.visitId;
  if ((data as any).admissionId) noteData.admissionId = (data as any).admissionId;
  if ((data as any).metadata) noteData.metadata = (data as any).metadata;

  const note = await prisma.nursingNote.create({
    data: noteData,
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

  const where: any = {};

  // Filter by tenant — support notes with or without a visit
  if (query.visitId) {
    where.visitId = query.visitId;
    where.visit = { tenantId };
  } else {
    where.patient = { tenantId };
  }

  if (query.patientId) {
    where.patientId = query.patientId;
  }

  if ((query as any).admissionId) {
    where.admissionId = (query as any).admissionId;
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

// ============================================================
// Progress Note Templates (per-doctor custom field templates)
// ============================================================

async function resolveDoctorProfile(tenantId: string, userId: string) {
  const doctor = await prisma.doctorProfile.findFirst({
    where: { userId, tenantId },
    select: { id: true },
  });
  if (!doctor) throw AppError.badRequest('No doctor profile found for the current user');
  return doctor;
}

export async function listProgressNoteTemplates(tenantId: string, userId: string) {
  const doctor = await resolveDoctorProfile(tenantId, userId);
  return prisma.progressNoteTemplate.findMany({
    where: { tenantId, doctorId: doctor.id },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
  });
}

export async function createProgressNoteTemplate(
  tenantId: string,
  userId: string,
  data: CreateProgressNoteTemplateInput,
) {
  const doctor = await resolveDoctorProfile(tenantId, userId);
  if (data.isDefault) {
    await prisma.progressNoteTemplate.updateMany({
      where: { tenantId, doctorId: doctor.id, isDefault: true },
      data: { isDefault: false },
    });
  }
  const template = await prisma.progressNoteTemplate.create({
    data: {
      tenantId,
      doctorId: doctor.id,
      name: data.name,
      fields: data.fields as any,
      isDefault: data.isDefault ?? false,
    },
  });
  logger.info({ tenantId, templateId: template.id }, 'Progress note template created');
  return template;
}

export async function updateProgressNoteTemplate(
  tenantId: string,
  userId: string,
  id: string,
  data: UpdateProgressNoteTemplateInput,
) {
  const doctor = await resolveDoctorProfile(tenantId, userId);
  const existing = await prisma.progressNoteTemplate.findFirst({
    where: { id, tenantId, doctorId: doctor.id },
  });
  if (!existing) throw AppError.notFound('Template not found');

  if (data.isDefault) {
    await prisma.progressNoteTemplate.updateMany({
      where: { tenantId, doctorId: doctor.id, isDefault: true, NOT: { id } },
      data: { isDefault: false },
    });
  }

  const updateData: any = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.fields !== undefined) updateData.fields = data.fields as any;
  if (data.isDefault !== undefined) updateData.isDefault = data.isDefault;

  const template = await prisma.progressNoteTemplate.update({
    where: { id },
    data: updateData,
  });
  return template;
}

export async function deleteProgressNoteTemplate(tenantId: string, userId: string, id: string) {
  const doctor = await resolveDoctorProfile(tenantId, userId);
  const existing = await prisma.progressNoteTemplate.findFirst({
    where: { id, tenantId, doctorId: doctor.id },
  });
  if (!existing) throw AppError.notFound('Template not found');
  await prisma.progressNoteTemplate.delete({ where: { id } });
}

// ============================================================
// OP 24-hour auto-archive job
// ============================================================
// Any active progress note attached to an OP visit older than 24 hours
// is flipped to 'archived'. IP notes remain editable until discharge.
// Notes unlocked by a doctor ("unlocked:<iso>:<userId>") are respected
// until their unlock window expires.

function parseUnlockExpiry(reason: string | null): Date | null {
  if (!reason || !reason.startsWith('unlocked:')) return null;
  const parts = reason.split(':');
  if (parts.length < 2) return null;
  const iso = parts[1];
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export async function archiveStaleOpProgressNotes() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const now = new Date();
  const stale = await prisma.progressNote.findMany({
    where: {
      status: 'active',
      createdAt: { lt: cutoff },
      visit: { visitType: 'op' },
    },
    select: { id: true, archiveReason: true },
  });

  // Respect unlock windows: skip notes unlocked and still within their window.
  const toArchive = stale.filter((n) => {
    const until = parseUnlockExpiry(n.archiveReason);
    return !until || until.getTime() <= now.getTime();
  });

  if (toArchive.length === 0) return { archived: 0 };

  const result = await prisma.progressNote.updateMany({
    where: { id: { in: toArchive.map((s) => s.id) } },
    data: {
      status: 'archived',
      archivedAt: now,
      archiveReason: 'op_auto_24h',
    },
  });
  logger.info({ count: result.count }, 'Archived stale OP progress notes');
  return { archived: result.count };
}

// ============================================================
// Unlock a finalized / archived note for further edits
// ============================================================
// Flips status back to 'active' and records an unlock window via
// `archiveReason` = "unlocked:<ISO-expiry>:<userId>". When the window
// expires, archiveStaleOpProgressNotes will re-archive the note.

const DEFAULT_UNLOCK_HOURS = 4;
const MAX_UNLOCK_HOURS = 24;

export async function unlockProgressNote(
  tenantId: string,
  id: string,
  userId: string,
  hoursRequested?: number,
) {
  const existing = await prisma.progressNote.findFirst({
    where: { id, visit: { tenantId } },
  });
  if (!existing) throw AppError.notFound('Progress note not found');

  if (existing.status === 'active') {
    const pending = parseUnlockExpiry(existing.archiveReason);
    if (pending && pending.getTime() > Date.now()) {
      // Already unlocked; extend the window instead of erroring.
    } else {
      throw AppError.badRequest('Progress note is already active / editable');
    }
  }

  const hours = Math.min(
    MAX_UNLOCK_HOURS,
    Math.max(1, Math.floor(hoursRequested ?? DEFAULT_UNLOCK_HOURS)),
  );
  const until = new Date(Date.now() + hours * 60 * 60 * 1000);

  const note = await prisma.progressNote.update({
    where: { id },
    data: {
      status: 'active',
      archivedAt: null,
      archiveReason: `unlocked:${until.toISOString()}:${userId}`,
    },
    include: {
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      visit: { select: { id: true, visitType: true, visitDate: true } },
    },
  });
  logger.info({ tenantId, noteId: id, userId, hours }, 'Progress note unlocked');
  return { note, unlockedUntil: until.toISOString() };
}

/**
 * Re-lock a previously unlocked note (ends the unlock window early).
 */
export async function relockProgressNote(tenantId: string, id: string, userId: string) {
  const existing = await prisma.progressNote.findFirst({
    where: { id, visit: { tenantId } },
  });
  if (!existing) throw AppError.notFound('Progress note not found');

  const until = parseUnlockExpiry(existing.archiveReason);
  if (!until) throw AppError.badRequest('Progress note is not currently unlocked');

  const note = await prisma.progressNote.update({
    where: { id },
    data: {
      status: 'finalized',
      archivedAt: null,
      archiveReason: null,
    },
    include: {
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
    },
  });
  logger.info({ tenantId, noteId: id, userId }, 'Progress note re-locked');
  return note;
}

/**
 * List progress notes currently unlocked (status=active + archiveReason starts with "unlocked:").
 * Optionally filter to the caller's own notes (by DoctorProfile.id).
 */
export async function listUnlockedProgressNotes(
  tenantId: string,
  opts: { doctorId?: string } = {},
) {
  const now = new Date();
  // Use a raw substring match since Prisma can't parse the ISO out of the string.
  const notes = await prisma.progressNote.findMany({
    where: {
      status: 'active',
      archiveReason: { startsWith: 'unlocked:' },
      visit: { tenantId },
      ...(opts.doctorId ? { doctorId: opts.doctorId } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    include: {
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      visit: { select: { id: true, visitType: true, visitDate: true } },
    },
  });

  return notes
    .map((n) => {
      const until = parseUnlockExpiry(n.archiveReason);
      return { note: n, unlockedUntil: until };
    })
    .filter((x) => x.unlockedUntil && x.unlockedUntil.getTime() > now.getTime())
    .map((x) => ({
      ...x.note,
      unlockedUntil: x.unlockedUntil!.toISOString(),
    }));
}
