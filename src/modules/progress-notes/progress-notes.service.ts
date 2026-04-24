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
  CreateWoundCareInput,
  ListWoundCareQuery,
  CreateIvLineInput,
  ListIvLinesQuery,
  RemoveIvLineInput,
  CreateIntakeOutputInput,
  ListIntakeOutputQuery,
  ListPhysicalObservationsQuery,
  CreatePhysicalObservationInput,
  UpdatePhysicalObservationInput,
} from './progress-notes.validation';

// Fields on ProgressNote that are diffed + audited on every update.
// The key is the request body field; the value is the corresponding
// Prisma model field. JSON fields are serialised with JSON.stringify
// so the audit row carries a deterministic snapshot.
const AUDITED_FIELDS = [
  'noteType',
  'content',
  'impressions',
  'discussions',
  'conclusions',
  'subjective',
  'objective',
  'assessment',
  'plan',
  'customFields',
  'weightKgAtEntry',
  'pinToDischargeSummary',
] as const;

type AuditedField = (typeof AUDITED_FIELDS)[number];

function stringifyForAudit(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function valuesAreEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

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

  // Infer admissionId from the visit when not supplied — needed for IP timeline.
  let admissionId = data.admissionId ?? null;
  if (!admissionId) {
    const admission = await prisma.admission.findFirst({
      where: { visitId: data.visitId, tenantId },
      select: { id: true },
    });
    admissionId = admission?.id ?? null;
  } else {
    // Validate admission belongs to the same visit/tenant when explicitly passed.
    const adm = await prisma.admission.findFirst({
      where: { id: admissionId, tenantId },
      select: { id: true, visitId: true },
    });
    if (!adm) throw AppError.badRequest('Admission not found for this tenant');
    if (adm.visitId !== data.visitId) {
      throw AppError.badRequest('Admission does not belong to the supplied visit');
    }
  }

  const note = await prisma.progressNote.create({
    data: {
      visitId: data.visitId,
      admissionId,
      patientId: data.patientId,
      doctorId: doctorProfile.id,
      noteType: data.noteType as any,
      content: data.content,
      impressions: data.impressions ?? null,
      discussions: data.discussions ?? null,
      conclusions: data.conclusions ?? null,
      subjective: (data.subjective as any) ?? undefined,
      objective: (data.objective as any) ?? undefined,
      assessment: (data.assessment as any) ?? undefined,
      plan: (data.plan as any) ?? undefined,
      customFields: (data.customFields as any) ?? undefined,
      weightKgAtEntry: data.weightKgAtEntry ?? null,
      pinToDischargeSummary: data.pinToDischargeSummary ?? false,
      pins: data.pins && data.pins.length > 0
        ? {
            create: data.pins.map((p) => ({
              dischargeSection: p.dischargeSection as any,
              content: p.content,
            })),
          }
        : undefined,
    },
    include: {
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      },
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      pins: true,
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

  if (query.admissionId) {
    where.admissionId = query.admissionId;
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
        pins: true,
        _count: { select: { amendments: true } },
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
      signer: { select: { id: true, firstName: true, lastName: true } },
      pins: true,
      amendments: {
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { editor: { select: { id: true, firstName: true, lastName: true } } },
      },
    },
  });

  if (!note) {
    throw AppError.notFound('Progress note not found');
  }

  return note;
}

/**
 * Update a progress note. Only active (non-finalized) notes can be updated.
 *
 * Enforces the doctor-in-charge rule: only the doctor who authored the
 * note may edit it. Every changed field is appended as a
 * ProgressNoteAmendment row (append-only audit trail). If the note was
 * ever signed (signedAt present) the caller must supply
 * `amendmentReason` — matches the spec's "no silent overwrites" rule.
 */
export async function updateProgressNote(
  tenantId: string,
  userId: string,
  id: string,
  data: UpdateProgressNoteInput,
) {
  const existing = await prisma.progressNote.findFirst({
    where: {
      id,
      visit: { tenantId },
    },
    include: {
      pins: true,
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

  // Doctor-in-charge guard: only the authoring doctor may edit.
  const doctorProfile = await prisma.doctorProfile.findFirst({
    where: { userId, tenantId },
    select: { id: true },
  });
  if (!doctorProfile || doctorProfile.id !== existing.doctorId) {
    throw AppError.forbidden('Only the assigned doctor can edit this progress note');
  }

  // If the note has been signed before (and later unlocked), an amendment
  // reason is mandatory. For truly-fresh active notes we still record the
  // diff but the reason is optional.
  const wasSigned = !!existing.signedAt;
  if (wasSigned && !data.amendmentReason) {
    throw AppError.badRequest('Amendment reason is required when editing a signed note');
  }

  // Compute the diff so we can emit ProgressNoteAmendment rows for every
  // changed audited field. Pins are tracked as a single "pins" diff.
  const amendments: Array<{
    fieldName: string;
    previousValue: string | null;
    newValue: string | null;
  }> = [];

  const updateData: any = {};
  for (const field of AUDITED_FIELDS) {
    if ((data as Record<string, unknown>)[field] === undefined) continue;
    const nextRaw = (data as Record<string, unknown>)[field as AuditedField];
    const prevRaw = (existing as unknown as Record<string, unknown>)[field as AuditedField];
    if (valuesAreEqual(prevRaw, nextRaw)) continue;
    updateData[field] = nextRaw as any;
    amendments.push({
      fieldName: field,
      previousValue: stringifyForAudit(prevRaw),
      newValue: stringifyForAudit(nextRaw),
    });
  }

  const pinsChanged =
    data.pins !== undefined &&
    !valuesAreEqual(
      existing.pins.map((p) => ({ dischargeSection: p.dischargeSection, content: p.content })),
      data.pins ?? [],
    );

  if (amendments.length === 0 && !pinsChanged) {
    // Nothing changed — return as-is with relations the client expects.
    return prisma.progressNote.findUnique({
      where: { id },
      include: {
        doctor: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
        patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
        pins: true,
      },
    });
  }

  const note = await prisma.$transaction(async (tx) => {
    // Pin replacement — delete-all + recreate (simplest; handful of rows max).
    if (pinsChanged) {
      await tx.progressNotePin.deleteMany({ where: { noteId: id } });
      if (data.pins && data.pins.length > 0) {
        await tx.progressNotePin.createMany({
          data: data.pins.map((p) => ({
            noteId: id,
            dischargeSection: p.dischargeSection as any,
            content: p.content,
          })),
        });
      }
      amendments.push({
        fieldName: 'pins',
        previousValue: stringifyForAudit(
          existing.pins.map((p) => ({ dischargeSection: p.dischargeSection, content: p.content })),
        ),
        newValue: stringifyForAudit(data.pins ?? []),
      });
    }

    if (amendments.length > 0) {
      await tx.progressNoteAmendment.createMany({
        data: amendments.map((a) => ({
          noteId: id,
          editorId: userId,
          fieldName: a.fieldName,
          previousValue: a.previousValue,
          newValue: a.newValue,
          reason: data.amendmentReason ?? null,
        })),
      });
    }

    return tx.progressNote.update({
      where: { id },
      data: updateData,
      include: {
        doctor: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
        patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
        pins: true,
      },
    });
  });

  logger.info(
    { tenantId, noteId: id, amendmentCount: amendments.length, wasSigned },
    'Progress note updated',
  );
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
 * Sign (finalize) a progress note. Sets status=finalized and stamps
 * signedAt/signedById/lockedAt. Only the authoring doctor may sign.
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

  const doctorProfile = await prisma.doctorProfile.findFirst({
    where: { userId, tenantId },
    select: { id: true },
  });
  if (!doctorProfile || doctorProfile.id !== existing.doctorId) {
    throw AppError.forbidden('Only the assigned doctor can sign this progress note');
  }

  const now = new Date();
  const note = await prisma.progressNote.update({
    where: { id },
    data: {
      status: 'finalized',
      signedAt: now,
      signedById: userId,
      lockedAt: now,
    },
    include: {
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      },
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      signer: { select: { id: true, firstName: true, lastName: true } },
      pins: true,
    },
  });

  logger.info({ tenantId, noteId: id, signedBy: userId }, 'Progress note signed/finalized');
  return note;
}

// ============================================================
// Amendments (audit trail for every field change)
// ============================================================

export async function listProgressNoteAmendments(tenantId: string, noteId: string) {
  // Verify tenant ownership of the note first.
  const note = await prisma.progressNote.findFirst({
    where: { id: noteId, visit: { tenantId } },
    select: { id: true },
  });
  if (!note) throw AppError.notFound('Progress note not found');

  return prisma.progressNoteAmendment.findMany({
    where: { noteId },
    orderBy: { createdAt: 'desc' },
    include: {
      editor: { select: { id: true, firstName: true, lastName: true } },
    },
  });
}

// ============================================================
// Physical Observation Catalog
// ============================================================

export async function listPhysicalObservations(
  tenantId: string,
  query: ListPhysicalObservationsQuery,
) {
  const where: any = {
    // Union of tenant-specific entries and global entries.
    OR: [{ tenantId }, { tenantId: null, isGlobal: true }],
  };
  if (!query.includeInactive) where.isActive = true;
  if (query.system) where.system = query.system;
  if (query.search) where.name = { contains: query.search, mode: 'insensitive' };

  return prisma.physicalObservationCatalog.findMany({
    where,
    orderBy: [{ system: 'asc' }, { name: 'asc' }],
  });
}

export async function createPhysicalObservation(
  tenantId: string,
  data: CreatePhysicalObservationInput,
) {
  return prisma.physicalObservationCatalog.create({
    data: {
      tenantId,
      system: data.system as any,
      name: data.name,
      description: data.description ?? null,
      isGlobal: false,
      isActive: true,
    },
  });
}

export async function updatePhysicalObservation(
  tenantId: string,
  id: string,
  data: UpdatePhysicalObservationInput,
) {
  const existing = await prisma.physicalObservationCatalog.findFirst({
    where: { id, tenantId },
  });
  if (!existing) {
    // Prevent hospitals from editing global entries they don't own.
    throw AppError.notFound('Physical observation entry not found');
  }
  const update: any = {};
  if (data.system !== undefined) update.system = data.system;
  if (data.name !== undefined) update.name = data.name;
  if (data.description !== undefined) update.description = data.description;
  if (data.isActive !== undefined) update.isActive = data.isActive;

  return prisma.physicalObservationCatalog.update({
    where: { id },
    data: update,
  });
}

export async function deletePhysicalObservation(tenantId: string, id: string) {
  const existing = await prisma.physicalObservationCatalog.findFirst({
    where: { id, tenantId },
  });
  if (!existing) throw AppError.notFound('Physical observation entry not found');
  await prisma.physicalObservationCatalog.delete({ where: { id } });
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

// ============================================================
// Structured nursing records — Wound Care / IV Line / Intake-Output
// ============================================================

/**
 * Resolve the visitId bound to a given admission for this tenant.
 * Nurses work in admission context; we transparently walk to the visit.
 */
async function resolveVisitFromAdmission(admissionId: string, tenantId: string) {
  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    select: { visitId: true, patientId: true },
  });
  if (!admission) {
    throw AppError.notFound('Admission not found');
  }
  return admission;
}

/**
 * Validate patient ownership + resolve visitId. Accepts either explicit visitId
 * or derives it from admissionId. Throws if tenant boundary is violated.
 */
async function resolveVisitIdForEntry(
  tenantId: string,
  data: { visitId?: string; admissionId?: string; patientId: string },
) {
  if (data.visitId) {
    await verifyVisitTenant(data.visitId, tenantId);
    return data.visitId;
  }
  if (data.admissionId) {
    const adm = await resolveVisitFromAdmission(data.admissionId, tenantId);
    if (adm.patientId !== data.patientId) {
      throw AppError.badRequest('patientId does not match admission');
    }
    return adm.visitId;
  }
  throw AppError.badRequest('Either visitId or admissionId is required');
}

// ── Wound Care ────────────────────────────────────────────

export async function createWoundCare(
  tenantId: string,
  userId: string,
  data: CreateWoundCareInput,
) {
  const visitId = await resolveVisitIdForEntry(tenantId, data);

  const record = await prisma.woundCareRecord.create({
    data: {
      visitId,
      patientId: data.patientId,
      nurseId: userId,
      woundLocation: data.woundLocation,
      woundType: data.woundType as any,
      woundStage: data.woundStage as any,
      lengthCm: data.lengthCm as any,
      widthCm: data.widthCm as any,
      depthCm: data.depthCm as any,
      exudateType: data.exudateType as any,
      exudateAmount: data.exudateAmount as any,
      dressingApplied: data.dressingApplied,
      treatmentNotes: data.treatmentNotes,
      photoUrl: data.photoUrl,
      assessedAt: data.assessedAt ? new Date(data.assessedAt) : new Date(),
      nextAssessmentDue: data.nextAssessmentDue ? new Date(data.nextAssessmentDue) : null,
      status: (data.status as any) ?? 'active',
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      nurse: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, recordId: record.id }, 'Wound care record created');
  return record;
}

export async function listWoundCare(tenantId: string, query: ListWoundCareQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { visit: { tenantId } };
  if (query.patientId) where.patientId = query.patientId;
  if (query.visitId) where.visitId = query.visitId;
  if (query.status) where.status = query.status;

  // admissionId → visitId lookup
  if ((query as any).admissionId) {
    const adm = await resolveVisitFromAdmission((query as any).admissionId, tenantId);
    where.visitId = adm.visitId;
  }

  const [records, total] = await Promise.all([
    prisma.woundCareRecord.findMany({
      where,
      skip,
      take,
      orderBy: { assessedAt: 'desc' },
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
        nurse: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
    prisma.woundCareRecord.count({ where }),
  ]);

  return { records, total, page, limit };
}

// ── IV Line ───────────────────────────────────────────────

export async function createIvLine(
  tenantId: string,
  userId: string,
  data: CreateIvLineInput,
) {
  const visitId = await resolveVisitIdForEntry(tenantId, data);

  // Resolve admissionId (if caller passed visitId only, look it up for convenience)
  let admissionId: string | null = data.admissionId ?? null;
  if (!admissionId) {
    const adm = await prisma.admission.findFirst({
      where: { visitId, tenantId },
      select: { id: true },
    });
    admissionId = adm?.id ?? null;
  }

  const record = await prisma.iVLineRecord.create({
    data: {
      visitId,
      patientId: data.patientId,
      admissionId,
      lineType: data.lineType as any,
      catheterGauge: data.catheterGauge,
      insertionSite: data.insertionSite,
      insertedAt: data.insertedAt ? new Date(data.insertedAt) : new Date(),
      insertedBy: userId,
      dressingChangeFrequencyHours: data.dressingChangeFrequencyHours ?? 72,
      lastDressingChangeAt: data.lastDressingChangeAt ? new Date(data.lastDressingChangeAt) : null,
      lastFlushedAt: data.lastFlushedAt ? new Date(data.lastFlushedAt) : null,
      fluidType: data.fluidType,
      flowRateMlPerHr: data.flowRateMlPerHr,
      status: 'active',
      complications: data.complications,
      notes: data.notes,
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      inserter: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, recordId: record.id }, 'IV line record created');
  return record;
}

export async function listIvLines(tenantId: string, query: ListIvLinesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { visit: { tenantId } };
  if (query.patientId) where.patientId = query.patientId;
  if (query.visitId) where.visitId = query.visitId;
  if ((query as any).admissionId) where.admissionId = (query as any).admissionId;
  if (query.status) where.status = query.status;

  const [records, total] = await Promise.all([
    prisma.iVLineRecord.findMany({
      where,
      skip,
      take,
      orderBy: { insertedAt: 'desc' },
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
        inserter: { select: { id: true, firstName: true, lastName: true } },
        remover: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
    prisma.iVLineRecord.count({ where }),
  ]);

  return { records, total, page, limit };
}

export async function removeIvLine(
  tenantId: string,
  userId: string,
  id: string,
  data: RemoveIvLineInput,
) {
  const existing = await prisma.iVLineRecord.findFirst({
    where: { id, visit: { tenantId } },
    select: { id: true, status: true },
  });
  if (!existing) {
    throw AppError.notFound('IV line record not found');
  }
  if (existing.status !== 'active') {
    throw AppError.badRequest('IV line is not active');
  }

  const record = await prisma.iVLineRecord.update({
    where: { id },
    data: {
      removedAt: data.removedAt ? new Date(data.removedAt) : new Date(),
      removedBy: userId,
      removalReason: data.removalReason as any,
      status: (data.status as any) ?? 'removed',
      notes: data.notes,
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      inserter: { select: { id: true, firstName: true, lastName: true } },
      remover: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, recordId: record.id }, 'IV line removed');
  return record;
}

// ── Intake / Output ───────────────────────────────────────

export async function createIntakeOutput(
  tenantId: string,
  userId: string,
  data: CreateIntakeOutputInput,
) {
  const visitId = await resolveVisitIdForEntry(tenantId, data);

  // If ivLineId supplied, verify it belongs to the same tenant/visit
  if (data.ivLineId) {
    const iv = await prisma.iVLineRecord.findFirst({
      where: { id: data.ivLineId, visit: { tenantId } },
      select: { id: true, patientId: true },
    });
    if (!iv) throw AppError.badRequest('Invalid IV line reference');
    if (iv.patientId !== data.patientId) {
      throw AppError.badRequest('IV line does not belong to this patient');
    }
  }

  const record = await prisma.intakeOutputRecord.create({
    data: {
      visitId,
      patientId: data.patientId,
      nurseId: userId,
      recordDatetime: data.recordDatetime ? new Date(data.recordDatetime) : new Date(),
      entryType: data.entryType as any,
      category: data.category as any,
      volumeMl: data.volumeMl,
      fluidDescription: data.fluidDescription,
      ivLineId: data.ivLineId,
      notes: data.notes,
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      nurse: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, recordId: record.id }, 'Intake/output record created');
  return record;
}

export async function listIntakeOutput(tenantId: string, query: ListIntakeOutputQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { visit: { tenantId } };
  if (query.patientId) where.patientId = query.patientId;
  if (query.visitId) where.visitId = query.visitId;
  if (query.entryType) where.entryType = query.entryType;
  if (query.category) where.category = query.category;

  if (query.fromDate || query.toDate) {
    where.recordDatetime = {};
    if (query.fromDate) where.recordDatetime.gte = new Date(query.fromDate);
    if (query.toDate) where.recordDatetime.lte = new Date(query.toDate);
  }

  // admissionId → visitId lookup
  if ((query as any).admissionId) {
    const adm = await resolveVisitFromAdmission((query as any).admissionId, tenantId);
    where.visitId = adm.visitId;
  }

  const [records, total] = await Promise.all([
    prisma.intakeOutputRecord.findMany({
      where,
      skip,
      take,
      orderBy: { recordDatetime: 'desc' },
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
        nurse: { select: { id: true, firstName: true, lastName: true } },
        ivLine: { select: { id: true, insertionSite: true, lineType: true } },
      },
    }),
    prisma.intakeOutputRecord.count({ where }),
  ]);

  // Compute 24h intake/output totals + balance for the patient window in this result set.
  // Summarises across ALL matching records (not just the current page).
  const summary = await prisma.intakeOutputRecord.groupBy({
    by: ['entryType'],
    where,
    _sum: { volumeMl: true },
  });
  const intakeTotal = summary.find((s) => s.entryType === 'intake')?._sum.volumeMl ?? 0;
  const outputTotal = summary.find((s) => s.entryType === 'output')?._sum.volumeMl ?? 0;

  return {
    records,
    total,
    page,
    limit,
    summary: {
      intakeMl: intakeTotal,
      outputMl: outputTotal,
      balanceMl: intakeTotal - outputTotal,
    },
  };
}
