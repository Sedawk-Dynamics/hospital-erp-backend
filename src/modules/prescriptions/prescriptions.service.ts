import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { formatDateIST } from '../../shared/date.utils';
import { getPaginationParams } from '../../shared/pagination';
import {
  generateForPrescription as emarGenerateForPrescription,
  cancelFutureSchedules as emarCancelFutureSchedules,
} from '../emar/emar.scheduler-engine';
import type {
  CreatePrescriptionInput,
  UpdatePrescriptionInput,
  GetPrescriptionsQuery,
  AddPrescriptionItemInput,
  UpdatePrescriptionItemInput,
  RecordAdministrationInput,
  GetAdministrationRecordsQuery,
  GetAdministrationScheduleQuery,
  AllergyCheckQuery,
  FormularySearchQuery,
  CheckInteractionsInput,
} from './prescriptions.validation';
import {
  INTERACTION_PAIRS,
  drugMatchesAny,
  normalizeDrug,
  type InteractionSeverity,
} from './drug-interactions.data';
import { calcDispenseQuantity } from './dosage-calc';

/**
 * Resolve the quantity to store for a prescription item. The doctor may type an
 * explicit quantity; when they don't, derive it from the dose pattern + duration
 * × per-intake dose (e.g. "1-1-1" for "3 days" with dose 2 → 18) so the pharmacy
 * always has a billable count.
 */
function resolveItemQuantity(item: {
  quantity?: number | null;
  frequency?: string | null;
  duration?: string | null;
  doseQuantity?: number | string | null;
}): number | null {
  if (typeof item.quantity === 'number' && item.quantity > 0) return item.quantity;
  return calcDispenseQuantity(item.frequency, item.duration, item.doseQuantity);
}

// ============================================================
// Prescriptions
// ============================================================

/**
 * Create a new prescription, optionally with items.
 */
export async function createPrescription(
  tenantId: string,
  userId: string,
  data: CreatePrescriptionInput,
) {
  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Verify doctor belongs to tenant. The doctor UI sends the authenticated
  // User.id as doctorId, while other callers may send a DoctorProfile.id —
  // resolve either form (DoctorProfile.userId is @unique) so the stored FK is
  // always a valid DoctorProfile.id.
  const doctor = await prisma.doctorProfile.findFirst({
    where: { tenantId, OR: [{ id: data.doctorId }, { userId: data.doctorId }] },
  });
  if (!doctor) {
    throw AppError.notFound('Doctor not found');
  }

  // Verify visit belongs to tenant and patient
  const visit = await prisma.visit.findFirst({
    where: { id: data.visitId, tenantId, patientId: data.patientId },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  const prescription = await prisma.prescription.create({
    data: {
      tenantId,
      patientId: data.patientId,
      doctorId: doctor.id,
      visitId: data.visitId,
      prescriptionType: data.prescriptionType,
      notes: data.notes,
      followUpDate: data.followUpDate ? new Date(data.followUpDate) : null,
      status: 'active',
      prescriptionItems: data.items
        ? {
            createMany: {
              data: data.items.map((item) => ({
                drugId: item.drugId,
                drugName: item.drugName,
                dosage: item.dosage,
                frequency: item.frequency,
                duration: item.duration,
                route: item.route,
                instructions: item.instructions,
                doseQuantity: item.doseQuantity ?? 1,
                quantity: resolveItemQuantity(item),
                isPrn: item.isPrn,
              })),
            },
          }
        : undefined,
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      },
      visit: {
        select: { id: true, visitDate: true, visitType: true },
      },
      prescriptionItems: true,
    },
  });

  logger.info(
    { tenantId, prescriptionId: prescription.id, doctorId: doctor.id, patientId: data.patientId },
    'Prescription created',
  );

  // Auto-generate eMAR dose schedules for IP prescriptions. We swallow errors
  // so a scheduling glitch never blocks the doctor's prescription write. The IP Rx
  // then flows straight to the pharmacy queue — no indent step; the pharmacist
  // dispenses it there, billing the patient's IP ledger.
  if (prescription.prescriptionType === 'ip') {
    emarGenerateForPrescription(prescription.id).catch((err) => {
      logger.error({ err, prescriptionId: prescription.id }, 'eMAR generation failed (create)');
    });
  }

  return prescription;
}

/**
 * Get paginated list of prescriptions with filters.
 */
export async function getPrescriptions(tenantId: string, query: GetPrescriptionsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.doctorId) where.doctorId = query.doctorId;
  if (query.visitId) where.visitId = query.visitId;
  // Resolve admissionId → visitId (Admission is 1:1 with Visit via admission.visitId)
  if ((query as any).admissionId) {
    const admission = await prisma.admission.findFirst({
      where: { id: (query as any).admissionId, tenantId },
      select: { visitId: true },
    });
    if (!admission) {
      // No matching admission → empty result (prevents cross-tenant leakage).
      return { prescriptions: [], total: 0, page, limit };
    }
    where.visitId = admission.visitId;
  }
  // Pharmacy-queue filters: `status=pending` and/or `dispensed=false`
  // both map to the same incoming-prescription set (active OR
  // partially_dispensed). The two are kept as separate filters so
  // callers can mix them without contradicting each other.
  const pendingStatuses = ['active', 'partially_dispensed'] as const;
  if (query.status === 'pending') {
    where.status = { in: pendingStatuses };
  } else if (query.status) {
    where.status = query.status;
  }
  if (query.dispensed === false) {
    // If a status filter was already set, intersect it with pending.
    where.status =
      where.status && typeof where.status === 'object' && 'in' in where.status
        ? where.status
        : { in: pendingStatuses };
  } else if (query.dispensed === true) {
    where.status = 'dispensed';
  }
  if (query.prescriptionType) where.prescriptionType = query.prescriptionType;
  // G12: filter the pharmacy queue by fulfilment stage (ordered/preparing/…).
  if ((query as any).pharmacyStatus) {
    where.pharmacyStatus =
      (query as any).pharmacyStatus === 'ordered'
        ? { in: ['ordered', null as any] } // null is treated as "ordered"
        : (query as any).pharmacyStatus;
  }

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
      { notes: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [prescriptions, total] = await Promise.all([
    prisma.prescription.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true },
        },
        doctor: {
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        },
        visit: {
          select: {
            id: true,
            visitDate: true,
            visitType: true,
            // G12: IP context for the pharmacy queue — patient billing category
            // (collect payment?) + ward / bed so orders can be grouped by room.
            admission: {
              select: {
                id: true,
                billingCategory: true,
                ward: { select: { id: true, name: true } },
                bed: { select: { id: true, bedNumber: true } },
              },
            },
          },
        },
        // Include the stocked drug's pack/loose config so the pharmacy queue can
        // render the total as tablets + a pack/loose breakdown (packSize base
        // units per strip, looseUnitLabel = the sub-unit name).
        prescriptionItems: {
          include: {
            drug: { select: { packSize: true, looseUnitLabel: true, dosageForm: true, price: true } },
          },
        },
      },
      orderBy: { createdAt: query.sortOrder || 'desc' },
    }),
    prisma.prescription.count({ where }),
  ]);

  return { prescriptions, total, page, limit };
}

/**
 * Get a single prescription by ID with all items.
 */
export async function getPrescriptionById(tenantId: string, id: string) {
  const prescription = await prisma.prescription.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          dateOfBirth: true,
          gender: true,
        },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
          department: { select: { id: true, name: true } },
        },
      },
      visit: {
        select: { id: true, visitDate: true, visitType: true },
      },
      prescriptionItems: {
        include: {
          medicationAdministrations: {
            orderBy: { administeredAt: 'desc' },
            take: 5,
          },
          // Pack/loose config for the POS + queue detail.
          drug: { select: { packSize: true, looseUnitLabel: true, dosageForm: true } },
        },
      },
    },
  });

  if (!prescription) {
    throw AppError.notFound('Prescription not found');
  }

  return prescription;
}

/**
 * Load a prescription with the full clinical context needed to render a
 * detailed OP consultation/prescription document — patient contact + allergies,
 * the visit's chief complaint, diagnoses and latest vitals, and the doctor's
 * credentials. Everything is optional so the document degrades gracefully.
 */
export async function getPrescriptionForDocument(tenantId: string, id: string) {
  const prescription = await prisma.prescription.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: {
          id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true, gender: true,
          bloodGroup: true, phone: true, addressLine1: true, addressLine2: true, city: true, state: true, postalCode: true,
          allergies: { select: { allergen: true, reaction: true, severity: true, allergyType: true } },
        },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
          department: { select: { id: true, name: true } },
        },
      },
      visit: {
        select: {
          id: true, visitDate: true, visitType: true, chiefComplaint: true,
          diagnoses: {
            orderBy: { diagnosedAt: 'asc' },
            select: { diagnosisName: true, diagnosisType: true, icdCode: true, notes: true },
          },
          vitals: {
            where: { isCorrection: false },
            orderBy: { recordedAt: 'desc' },
            take: 1,
            select: {
              bloodPressureSystolic: true, bloodPressureDiastolic: true, pulseRate: true, temperature: true,
              respiratoryRate: true, oxygenSaturation: true, weightKg: true, heightCm: true, bmi: true, bloodSugar: true,
              recordedAt: true,
            },
          },
        },
      },
      prescriptionItems: {
        include: { drug: { select: { genericName: true, dosageForm: true } } },
      },
    },
  });

  if (!prescription) throw AppError.notFound('Prescription not found');
  return prescription;
}

/**
 * Update a prescription (status, notes).
 */
export async function updatePrescription(
  tenantId: string,
  id: string,
  data: UpdatePrescriptionInput,
) {
  const prescription = await prisma.prescription.findFirst({
    where: { id, tenantId },
  });

  if (!prescription) {
    throw AppError.notFound('Prescription not found');
  }

  if (prescription.status === 'cancelled') {
    throw AppError.badRequest('Cannot update a cancelled prescription');
  }

  // 24-hour edit window — prescriptions lock automatically after 24h
  const hoursElapsed = (Date.now() - new Date(prescription.createdAt).getTime()) / (1000 * 60 * 60);
  if (hoursElapsed > 24) {
    throw AppError.badRequest('Prescription edit window has expired (24 hours). This prescription is now locked.');
  }

  const updateData: any = {};
  if (data.status !== undefined) updateData.status = data.status;
  if (data.notes !== undefined) updateData.notes = data.notes;
  if (data.followUpDate !== undefined) {
    updateData.followUpDate = data.followUpDate ? new Date(data.followUpDate) : null;
  }

  // If the caller supplied a full `items` array, wipe + recreate them in
  // the same transaction as the parent update. This lets callers replace
  // the prescription contents with just `prescriptions:update` — no
  // `prescriptions:delete` permission required.
  const replaceItems = data.items !== undefined;
  const updated = await prisma.$transaction(async (tx) => {
    if (replaceItems) {
      await tx.prescriptionItem.deleteMany({ where: { prescriptionId: id } });
      if (data.items && data.items.length > 0) {
        await tx.prescriptionItem.createMany({
          data: data.items.map((it) => ({
            prescriptionId: id,
            drugId: it.drugId ?? null,
            drugName: it.drugName,
            dosage: it.dosage,
            frequency: it.frequency,
            duration: it.duration ?? null,
            route: it.route as any,
            instructions: it.instructions ?? null,
            doseQuantity: it.doseQuantity ?? 1,
            quantity: resolveItemQuantity(it),
            isPrn: it.isPrn ?? false,
          })),
        });
      }
    }

    return tx.prescription.update({
      where: { id },
      data: updateData,
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true },
        },
        doctor: {
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        },
        prescriptionItems: true,
      },
    });
  });

  logger.info(
    { tenantId, prescriptionId: id, status: data.status, replacedItems: replaceItems },
    'Prescription updated',
  );

  // If items were replaced on an active IP prescription, regenerate eMAR rows.
  if (replaceItems && updated.prescriptionType === 'ip' && updated.status !== 'cancelled') {
    emarGenerateForPrescription(updated.id).catch((err) => {
      logger.error({ err, prescriptionId: updated.id }, 'eMAR generation failed (update)');
    });
  }

  return updated;
}

/**
 * Cancel a prescription and all its active items.
 */
export async function cancelPrescription(tenantId: string, id: string) {
  const prescription = await prisma.prescription.findFirst({
    where: { id, tenantId },
  });

  if (!prescription) {
    throw AppError.notFound('Prescription not found');
  }

  if (prescription.status === 'cancelled') {
    throw AppError.badRequest('Prescription is already cancelled');
  }

  const updated = await prisma.prescription.update({
    where: { id },
    data: { status: 'cancelled' },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      },
      prescriptionItems: true,
    },
  });

  logger.info({ tenantId, prescriptionId: id }, 'Prescription cancelled');

  // Cancel future eMAR doses for this prescription
  if (updated.prescriptionType === 'ip') {
    emarCancelFutureSchedules(id, 'Prescription cancelled').catch((err) => {
      logger.error({ err, prescriptionId: id }, 'eMAR future-cancel failed');
    });
  }

  return updated;
}

// ============================================================
// Prescription Items
// ============================================================

/**
 * Helper to verify a prescription exists, belongs to the tenant, and is active.
 */
async function getActivePrescription(tenantId: string, prescriptionId: string) {
  const prescription = await prisma.prescription.findFirst({
    where: { id: prescriptionId, tenantId },
  });

  if (!prescription) {
    throw AppError.notFound('Prescription not found');
  }

  if (prescription.status === 'cancelled') {
    throw AppError.badRequest('Cannot modify items on a cancelled prescription');
  }

  return prescription;
}

/**
 * Add an item to a prescription.
 */
export async function addPrescriptionItem(
  tenantId: string,
  prescriptionId: string,
  data: AddPrescriptionItemInput,
) {
  const prescription = await getActivePrescription(tenantId, prescriptionId);

  // 24-hour edit window
  const hoursElapsed = (Date.now() - new Date(prescription.createdAt).getTime()) / (1000 * 60 * 60);
  if (hoursElapsed > 24) {
    throw AppError.badRequest('Prescription edit window has expired (24 hours). This prescription is now locked.');
  }

  const item = await prisma.prescriptionItem.create({
    data: {
      prescriptionId,
      drugId: data.drugId,
      drugName: data.drugName,
      dosage: data.dosage,
      frequency: data.frequency,
      duration: data.duration,
      route: data.route,
      instructions: data.instructions,
      doseQuantity: data.doseQuantity ?? 1,
      quantity: resolveItemQuantity(data),
      isPrn: data.isPrn,
    },
  });

  logger.info(
    { tenantId, prescriptionId, itemId: item.id },
    'Prescription item added',
  );

  if (prescription.prescriptionType === 'ip') {
    emarGenerateForPrescription(prescriptionId).catch((err) => {
      logger.error({ err, prescriptionId }, 'eMAR generation failed (item add)');
    });
  }

  return item;
}

/**
 * Update an item on a prescription.
 */
export async function updatePrescriptionItem(
  tenantId: string,
  prescriptionId: string,
  itemId: string,
  data: UpdatePrescriptionItemInput,
) {
  const prescription = await getActivePrescription(tenantId, prescriptionId);

  // 24-hour edit window
  const hoursElapsed = (Date.now() - new Date(prescription.createdAt).getTime()) / (1000 * 60 * 60);
  if (hoursElapsed > 24) {
    throw AppError.badRequest('Prescription edit window has expired (24 hours). This prescription is now locked.');
  }

  const item = await prisma.prescriptionItem.findFirst({
    where: { id: itemId, prescriptionId },
  });

  if (!item) {
    throw AppError.notFound('Prescription item not found');
  }

  const updateData: any = {};
  if (data.drugId !== undefined) updateData.drugId = data.drugId;
  if (data.drugName !== undefined) updateData.drugName = data.drugName;
  if (data.dosage !== undefined) updateData.dosage = data.dosage;
  if (data.frequency !== undefined) updateData.frequency = data.frequency;
  if (data.duration !== undefined) updateData.duration = data.duration;
  if (data.route !== undefined) updateData.route = data.route;
  if (data.instructions !== undefined) updateData.instructions = data.instructions;
  if (data.doseQuantity !== undefined) updateData.doseQuantity = data.doseQuantity ?? 1;
  if (data.quantity !== undefined) updateData.quantity = data.quantity;
  if (data.isPrn !== undefined) updateData.isPrn = data.isPrn;

  // When the dose pattern, duration, or per-intake dose is edited without an
  // explicit quantity, re-derive the dispense count from the new effective
  // values so it never goes stale (e.g. doctor bumps "3 days" → "5 days", or
  // the dose 1 → 2).
  if (
    data.quantity === undefined &&
    (data.frequency !== undefined || data.duration !== undefined || data.doseQuantity !== undefined)
  ) {
    const recalculated = calcDispenseQuantity(
      data.frequency ?? item.frequency,
      data.duration ?? item.duration,
      data.doseQuantity ?? (item.doseQuantity != null ? Number(item.doseQuantity) : 1),
    );
    if (recalculated !== null) updateData.quantity = recalculated;
  }

  const updated = await prisma.prescriptionItem.update({
    where: { id: itemId },
    data: updateData,
  });

  logger.info(
    { tenantId, prescriptionId, itemId },
    'Prescription item updated',
  );

  return updated;
}

/**
 * Remove an item from a prescription.
 */
export async function removePrescriptionItem(
  tenantId: string,
  prescriptionId: string,
  itemId: string,
) {
  const prescription = await getActivePrescription(tenantId, prescriptionId);

  // 24-hour edit window
  const hoursElapsed = (Date.now() - new Date(prescription.createdAt).getTime()) / (1000 * 60 * 60);
  if (hoursElapsed > 24) {
    throw AppError.badRequest('Prescription edit window has expired (24 hours). This prescription is now locked.');
  }

  const item = await prisma.prescriptionItem.findFirst({
    where: { id: itemId, prescriptionId },
  });

  if (!item) {
    throw AppError.notFound('Prescription item not found');
  }

  // Check if any administration records exist for this item
  const adminCount = await prisma.medicationAdministration.count({
    where: { prescriptionItemId: itemId },
  });

  if (adminCount > 0) {
    throw AppError.badRequest(
      'Cannot remove item with existing administration records. Consider cancelling the prescription instead.',
    );
  }

  await prisma.prescriptionItem.delete({
    where: { id: itemId },
  });

  logger.info(
    { tenantId, prescriptionId, itemId },
    'Prescription item removed',
  );

  return { id: itemId, deleted: true };
}

// ============================================================
// Medication Administration
// ============================================================

/**
 * Record a medication administration event.
 */
export async function recordAdministration(
  tenantId: string,
  userId: string,
  data: RecordAdministrationInput,
) {
  // Verify the prescription item exists and its prescription belongs to this tenant
  const prescriptionItem = await prisma.prescriptionItem.findFirst({
    where: {
      id: data.prescriptionItemId,
      prescription: { tenantId },
    },
    include: {
      prescription: { select: { id: true, status: true, tenantId: true } },
    },
  });

  if (!prescriptionItem) {
    throw AppError.notFound('Prescription item not found');
  }

  if (prescriptionItem.prescription.status === 'cancelled') {
    throw AppError.badRequest('Cannot administer medication for a cancelled prescription');
  }

  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });

  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const administration = await prisma.medicationAdministration.create({
    data: {
      prescriptionItemId: data.prescriptionItemId,
      patientId: data.patientId,
      administeredBy: userId,
      administeredAt: new Date(data.administeredAt),
      doseGiven: data.doseGiven,
      status: data.status,
      notes: data.notes,
    },
    include: {
      prescriptionItem: {
        select: {
          id: true,
          drugName: true,
          dosage: true,
          frequency: true,
          route: true,
        },
      },
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      administrator: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
  });

  logger.info(
    {
      tenantId,
      administrationId: administration.id,
      prescriptionItemId: data.prescriptionItemId,
      status: data.status,
    },
    'Medication administration recorded',
  );

  return administration;
}

/**
 * Get paginated administration records with filters.
 */
export async function getAdministrationRecords(
  tenantId: string,
  query: GetAdministrationRecordsQuery,
) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = {
    prescriptionItem: {
      prescription: { tenantId },
    },
  };

  if (query.patientId) where.patientId = query.patientId;
  if (query.prescriptionItemId) where.prescriptionItemId = query.prescriptionItemId;
  if (query.status) where.status = query.status;

  if (query.fromDate) {
    where.administeredAt = { ...where.administeredAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.administeredAt = { ...where.administeredAt, lte: new Date(query.toDate) };
  }

  const [records, total] = await Promise.all([
    prisma.medicationAdministration.findMany({
      where,
      skip,
      take,
      include: {
        prescriptionItem: {
          select: {
            id: true,
            drugName: true,
            dosage: true,
            frequency: true,
            route: true,
            prescription: {
              select: { id: true, status: true },
            },
          },
        },
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true },
        },
        administrator: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
      orderBy: { administeredAt: 'desc' },
    }),
    prisma.medicationAdministration.count({ where }),
  ]);

  return { records, total, page, limit };
}

/**
 * Get the medication administration schedule for a patient.
 * Returns all active prescription items and their recent administration history.
 */
export async function getAdministrationSchedule(
  tenantId: string,
  query: GetAdministrationScheduleQuery,
) {
  const { patientId, date } = query;

  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
  });

  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Get all active prescriptions for this patient
  const prescriptions = await prisma.prescription.findMany({
    where: {
      tenantId,
      patientId,
      status: 'active',
    },
    include: {
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      },
      prescriptionItems: {
        include: {
          medicationAdministrations: {
            where: date
              ? {
                  administeredAt: {
                    gte: new Date(new Date(date).setUTCHours(0, 0, 0, 0)),
                    lte: new Date(new Date(date).setUTCHours(23, 59, 59, 999)),
                  },
                }
              : undefined,
            orderBy: { administeredAt: 'desc' },
            include: {
              administrator: {
                select: { id: true, firstName: true, lastName: true },
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return {
    patientId,
    date: date || formatDateIST(new Date()),
    prescriptions,
  };
}

// ============================================================
// Allergy Check
// ============================================================

/**
 * Check if a patient has allergies that match the given drug name or its generic name.
 */
export async function checkAllergy(tenantId: string, query: AllergyCheckQuery) {
  const { patientId, drugName } = query;

  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
  });

  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Find the drug in formulary to get generic name and contraindications
  const drug = await prisma.drugFormulary.findFirst({
    where: {
      tenantId,
      drugName: { equals: drugName, mode: 'insensitive' },
      isActive: true,
    },
    select: {
      drugName: true,
      genericName: true,
      contraindications: true,
    },
  });

  // Get all allergies for the patient
  const allergies = await prisma.patientAllergy.findMany({
    where: {
      patientId,
    },
  });

  const drugNameLower = drugName.toLowerCase();
  const genericNameLower = drug?.genericName?.toLowerCase() || '';

  // Match: allergen contains drugName/genericName OR drugName/genericName contains allergen
  const matchedAllergies = allergies.filter((allergy) => {
    const allergenLower = allergy.allergen.toLowerCase();
    return (
      allergenLower.includes(drugNameLower) ||
      drugNameLower.includes(allergenLower) ||
      (genericNameLower &&
        (allergenLower.includes(genericNameLower) ||
          genericNameLower.includes(allergenLower)))
    );
  });

  logger.info(
    { tenantId, patientId, drugName, matchCount: matchedAllergies.length },
    'Allergy check performed',
  );

  return {
    hasAllergy: matchedAllergies.length > 0,
    matchedAllergies,
    drug: drug
      ? {
          drugName: drug.drugName,
          genericName: drug.genericName,
          contraindications: drug.contraindications,
        }
      : null,
  };
}

// ============================================================
// Formulary Search (for prescription autocomplete)
// ============================================================

/**
 * Lightweight formulary search returning only fields needed for prescriptions.
 */
export async function searchFormulary(tenantId: string, query: FormularySearchQuery) {
  const { search } = query;

  // 1. The hospital's own formulary (drugs it stocks) — these carry an `id`
  //    usable as PrescriptionItem.drugId.
  // Recall is batch-level, so a drug is never hidden here: `availableStock`
  // below already excludes recalled batches, so a fully-recalled drug simply
  // shows as out of stock.
  const formulary = await prisma.drugFormulary.findMany({
    where: {
      tenantId,
      isActive: true,
      OR: [
        { drugName: { contains: search, mode: 'insensitive' } },
        { genericName: { contains: search, mode: 'insensitive' } },
      ],
    },
    select: {
      id: true,
      drugName: true,
      genericName: true,
      dosageForm: true,
      strength: true,
      manufacturer: true,
      price: true,
      drugMasterId: true,
    },
    take: 30,
    orderBy: { drugName: 'asc' },
  });

  // Available pharmacy stock per formulary drug = Σ quantityInStock across the
  // hospital's active (non-expired, non-recalled) batches — so the doctor sees
  // what's actually on hand while prescribing.
  const formularyIds = formulary.map((f) => f.id);
  const stockByDrug = new Map<string, number>();
  if (formularyIds.length) {
    const grouped = await prisma.drugBatch.groupBy({
      by: ['drugId'],
      where: { tenantId, drugId: { in: formularyIds }, isExpired: false, isRecalled: false },
      _sum: { quantityInStock: true },
    });
    for (const g of grouped) stockByDrug.set(g.drugId, g._sum.quantityInStock ?? 0);
  }

  const formularyResults = formulary.map((f) => ({
    ...f,
    source: 'formulary' as const,
    availableStock: stockByDrug.get(f.id) ?? 0,
  }));

  // 2. Fill the remaining slots with platform-catalog matches the hospital has
  //    NOT yet imported, so a doctor can still pick (and later stock) a drug
  //    that isn't in the local formulary. These carry no `id` (drugId stays
  //    null → free-text path) but expose `drugMasterId` for one-click import.
  const remaining = 30 - formularyResults.length;
  let masterResults: Array<{
    id: null;
    drugMasterId: string;
    drugName: string;
    genericName: string | null;
    dosageForm: any;
    strength: string | null;
    manufacturer: string | null;
    price: any;
    source: 'master';
    // Master-catalog drugs the hospital hasn't stocked yet → no local stock.
    availableStock: number;
  }> = [];

  if (remaining > 0) {
    const importedMasterIds = formulary
      .map((f) => f.drugMasterId)
      .filter((v): v is string => Boolean(v));
    const terms = search
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const select = {
      id: true,
      name: true,
      genericName: true,
      dosageForm: true,
      strength: true,
      manufacturer: true,
      mrp: true,
    } as const;
    const baseWhere = {
      isPublished: true,
      isDiscontinued: false,
      ...(importedMasterIds.length ? { id: { notIn: importedMasterIds } } : {}),
    };

    // PASS 1 — brand / generic PREFIX matches first so a half-typed name (e.g.
    // "para") surfaces "Paracetamol…" brands at the top, not a flat A-Z list.
    const prefixMatches = await prisma.drugMaster.findMany({
      where: {
        ...baseWhere,
        OR: [
          { name: { startsWith: search, mode: 'insensitive' as const } },
          { genericName: { startsWith: search, mode: 'insensitive' as const } },
        ],
      },
      select,
      take: remaining,
      orderBy: { name: 'asc' },
    });

    // PASS 2 — fill any remaining slots with broader partial / token matches
    // (handles "para 500", "amox cap", or a term that appears mid-name).
    const seen = new Set(prefixMatches.map((m) => m.id));
    let extra: typeof prefixMatches = [];
    if (prefixMatches.length < remaining) {
      extra = await prisma.drugMaster.findMany({
        where: {
          ...baseWhere,
          id: { notIn: [...importedMasterIds, ...seen] },
          OR: [
            { AND: terms.map((t) => ({ searchTokens: { contains: t, mode: 'insensitive' as const } })) },
            { name: { contains: search, mode: 'insensitive' as const } },
            { genericName: { contains: search, mode: 'insensitive' as const } },
          ],
        },
        select,
        take: remaining - prefixMatches.length,
        orderBy: { name: 'asc' },
      });
    }

    masterResults = [...prefixMatches, ...extra].map((m) => ({
      id: null,
      drugMasterId: m.id,
      drugName: m.name,
      genericName: m.genericName,
      dosageForm: m.dosageForm,
      strength: m.strength,
      manufacturer: m.manufacturer,
      price: m.mrp,
      source: 'master' as const,
      availableStock: 0,
    }));
  }

  return [...formularyResults, ...masterResults];
}

// ============================================================
// Drug-Drug Interaction Check
// ============================================================

export interface InteractionPair {
  drugs: [string, string];
  severity: InteractionSeverity;
  description: string;
}

export interface DrugContraindicationEntry {
  drugName: string;
  matchedFormularyName?: string;
  genericName?: string | null;
  contraindications?: string | null;
}

/**
 * For a given list of drug names:
 *  - Cross-checks every pair against the curated interaction database
 *  - Pulls formulary `contraindications` text per drug (when the tenant has it)
 */
export async function checkInteractions(
  tenantId: string,
  data: CheckInteractionsInput,
) {
  // Deduplicate drug names (case-insensitive)
  const seen = new Set<string>();
  const drugs = data.drugs
    .map((d) => d.trim())
    .filter((d) => {
      const k = d.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  // ── Cross-check all pairs against the curated database ──
  const pairs: InteractionPair[] = [];
  for (let i = 0; i < drugs.length; i++) {
    for (let j = i + 1; j < drugs.length; j++) {
      const left = drugs[i];
      const right = drugs[j];
      for (const def of INTERACTION_PAIRS) {
        const leftHitsA = drugMatchesAny(left, def.a);
        const rightHitsB = drugMatchesAny(right, def.b);
        const leftHitsB = drugMatchesAny(left, def.b);
        const rightHitsA = drugMatchesAny(right, def.a);
        if ((leftHitsA && rightHitsB) || (leftHitsB && rightHitsA)) {
          pairs.push({
            drugs: [left, right],
            severity: def.severity,
            description: def.description,
          });
          break; // Only report the first (most relevant) matching pair per drug-pair
        }
      }
    }
  }

  // ── Pull formulary contraindications (tenant-scoped) ────
  // Match by normalised drugName or genericName substring on the formulary.
  const formularyRows = await prisma.drugFormulary.findMany({
    where: { tenantId, isActive: true },
    select: {
      id: true,
      drugName: true,
      genericName: true,
      contraindications: true,
    },
  });

  const perDrug: DrugContraindicationEntry[] = drugs.map((name) => {
    const normName = normalizeDrug(name);
    const hit = formularyRows.find((f) => {
      const dn = normalizeDrug(f.drugName);
      const gn = f.genericName ? normalizeDrug(f.genericName) : '';
      return (
        normName.includes(dn) ||
        dn.includes(normName) ||
        (gn && (normName.includes(gn) || gn.includes(normName)))
      );
    });
    if (!hit) {
      return { drugName: name };
    }
    return {
      drugName: name,
      matchedFormularyName: hit.drugName,
      genericName: hit.genericName,
      contraindications: hit.contraindications,
    };
  });

  return {
    pairs,
    perDrug,
    // Quick summary — highest severity seen across all pairs
    highestSeverity: pairs.length
      ? (['contraindicated', 'major', 'moderate', 'minor'] as InteractionSeverity[]).find((s) =>
          pairs.some((p) => p.severity === s),
        ) ?? null
      : null,
  };
}
