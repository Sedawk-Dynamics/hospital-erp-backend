import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
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
} from './prescriptions.validation';

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

  // Verify doctor belongs to tenant
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: data.doctorId, tenantId },
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
      doctorId: data.doctorId,
      visitId: data.visitId,
      prescriptionType: data.prescriptionType,
      notes: data.notes,
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
                quantity: item.quantity,
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
    { tenantId, prescriptionId: prescription.id, doctorId: data.doctorId, patientId: data.patientId },
    'Prescription created',
  );

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
  if (query.status) where.status = query.status;
  if (query.prescriptionType) where.prescriptionType = query.prescriptionType;

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
          select: { id: true, visitDate: true, visitType: true },
        },
        prescriptionItems: true,
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

  const updateData: any = {};
  if (data.status !== undefined) updateData.status = data.status;
  if (data.notes !== undefined) updateData.notes = data.notes;

  const updated = await prisma.prescription.update({
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

  logger.info({ tenantId, prescriptionId: id, status: data.status }, 'Prescription updated');
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
  await getActivePrescription(tenantId, prescriptionId);

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
      quantity: data.quantity,
      isPrn: data.isPrn,
    },
  });

  logger.info(
    { tenantId, prescriptionId, itemId: item.id },
    'Prescription item added',
  );

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
  await getActivePrescription(tenantId, prescriptionId);

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
  if (data.quantity !== undefined) updateData.quantity = data.quantity;
  if (data.isPrn !== undefined) updateData.isPrn = data.isPrn;

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
  await getActivePrescription(tenantId, prescriptionId);

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
                    gte: new Date(new Date(date).setHours(0, 0, 0, 0)),
                    lte: new Date(new Date(date).setHours(23, 59, 59, 999)),
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
    date: date || new Date().toISOString().split('T')[0],
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

  const drugs = await prisma.drugFormulary.findMany({
    where: {
      tenantId,
      isActive: true,
      isRecalled: false,
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
    },
    take: 20,
    orderBy: { drugName: 'asc' },
  });

  return drugs;
}
