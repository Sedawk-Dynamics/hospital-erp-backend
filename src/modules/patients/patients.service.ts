import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreatePatientInput,
  UpdatePatientInput,
  SearchPatientsQuery,
  AddEmergencyContactInput,
  AddAllergyInput,
  AddDocumentInput,
  AddFamilyHistoryInput,
} from './patients.validation';

/**
 * Generate a unique MRN (Medical Record Number) for a tenant.
 * Format: MRN-YYYYMMDD-XXXX (e.g., MRN-20260307-0001)
 */
async function generateMRN(tenantId: string): Promise<string> {
  const today = new Date();
  const dateStr =
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, '0') +
    today.getDate().toString().padStart(2, '0');

  const prefix = `MRN-${dateStr}-`;

  // Find the latest MRN created today for this tenant
  const latestPatient = await prisma.patient.findFirst({
    where: {
      tenantId,
      mrn: { startsWith: prefix },
    },
    orderBy: { mrn: 'desc' },
    select: { mrn: true },
  });

  let nextNumber = 1;
  if (latestPatient?.mrn) {
    const lastNumber = parseInt(latestPatient.mrn.split('-').pop() || '0', 10);
    nextNumber = lastNumber + 1;
  }

  const mrn = `${prefix}${nextNumber.toString().padStart(4, '0')}`;

  // Verify uniqueness (race condition safety)
  const existing = await prisma.patient.findFirst({
    where: { tenantId, mrn },
  });

  if (existing) {
    // Recurse to get next available number
    return generateMRN(tenantId);
  }

  return mrn;
}

/**
 * Map validation gender to schema gender enum.
 * Schema only has: male, female, other
 */
function mapGender(gender: string | undefined): string | undefined {
  if (!gender) return undefined;
  if (gender === 'prefer_not_to_say') return 'other';
  return gender;
}

/**
 * Map validation document type to schema DocumentType enum.
 */
function mapDocumentType(type: string): string {
  const mapping: Record<string, string> = {
    lab_report: 'external_report',
    prescription: 'other',
    discharge_summary: 'other',
    imaging: 'external_report',
    insurance: 'insurance_card',
    consent: 'consent_form',
    identification: 'id_proof',
    other: 'other',
  };
  return mapping[type] ?? 'other';
}

/**
 * Create a new patient record.
 */
export async function create(tenantId: string, data: CreatePatientInput) {
  const mrn = await generateMRN(tenantId);

  // Check for duplicate based on phone within the same tenant
  if (data.phone) {
    const existingByPhone = await prisma.patient.findFirst({
      where: { tenantId, phone: data.phone },
    });
    if (existingByPhone) {
      throw AppError.conflict('A patient with this phone number already exists');
    }
  }

  // Check for duplicate email within the same tenant
  if (data.email) {
    const existingByEmail = await prisma.patient.findFirst({
      where: { tenantId, email: data.email },
    });
    if (existingByEmail) {
      throw AppError.conflict('A patient with this email already exists');
    }
  }

  const patient = await prisma.patient.create({
    data: {
      mrn,
      tenantId,
      firstName: data.firstName,
      lastName: data.lastName,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
      gender: mapGender(data.gender) as any,
      bloodGroup: data.bloodGroup,
      phone: data.phone,
      email: data.email || undefined,
      city: data.city,
      state: data.state,
      country: data.country,
      postalCode: data.zipCode,
      isActive: true,
    },
  });

  logger.info({ tenantId, patientId: patient.id, mrn }, 'Patient created');
  return patient;
}

/**
 * Get paginated list of patients for a tenant.
 */
export async function findAll(tenantId: string, query: SearchPatientsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.search) {
    const search = query.search.trim();
    where.OR = [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { mrn: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }

  if (query.gender) {
    where.gender = mapGender(query.gender);
  }

  if (query.bloodGroup) {
    where.bloodGroup = query.bloodGroup;
  }

  if (query.isActive !== undefined) {
    where.isActive = query.isActive;
  }

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  }

  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
  }

  const orderBy: any = {};
  if (query.sortBy) {
    orderBy[query.sortBy] = query.sortOrder || 'desc';
  } else {
    orderBy.createdAt = 'desc';
  }

  const [patients, total] = await Promise.all([
    prisma.patient.findMany({
      where,
      skip,
      take,
      orderBy,
      select: {
        id: true,
        mrn: true,
        firstName: true,
        lastName: true,
        dateOfBirth: true,
        gender: true,
        bloodGroup: true,
        phone: true,
        email: true,
        city: true,
        isActive: true,
        createdAt: true,
      },
    }),
    prisma.patient.count({ where }),
  ]);

  return { patients, total, page, limit };
}

/**
 * Find a patient by ID with all related data.
 */
export async function findById(tenantId: string, id: string) {
  const patient = await prisma.patient.findFirst({
    where: { id, tenantId },
    include: {
      emergencyContacts: {
        orderBy: { isPrimary: 'desc' },
      },
      allergies: {
        orderBy: { createdAt: 'desc' },
      },
      familyHistory: {
        orderBy: { createdAt: 'desc' },
      },
      documents: {
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
    },
  });

  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  return patient;
}

/**
 * Update a patient record.
 */
export async function update(tenantId: string, id: string, data: UpdatePatientInput) {
  const existing = await prisma.patient.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Patient not found');
  }

  // Check for duplicate phone if phone is being updated
  if (data.phone && data.phone !== existing.phone) {
    const existingByPhone = await prisma.patient.findFirst({
      where: { tenantId, phone: data.phone, id: { not: id } },
    });
    if (existingByPhone) {
      throw AppError.conflict('A patient with this phone number already exists');
    }
  }

  // Check for duplicate email if email is being updated
  if (data.email && data.email !== existing.email) {
    const existingByEmail = await prisma.patient.findFirst({
      where: { tenantId, email: data.email, id: { not: id } },
    });
    if (existingByEmail) {
      throw AppError.conflict('A patient with this email already exists');
    }
  }

  const updateData: any = {};
  if (data.firstName !== undefined) updateData.firstName = data.firstName;
  if (data.lastName !== undefined) updateData.lastName = data.lastName;
  if (data.dateOfBirth !== undefined) updateData.dateOfBirth = new Date(data.dateOfBirth);
  if (data.gender !== undefined) updateData.gender = mapGender(data.gender);
  if (data.bloodGroup !== undefined) updateData.bloodGroup = data.bloodGroup;
  if (data.phone !== undefined) updateData.phone = data.phone;
  if (data.email !== undefined) updateData.email = data.email || null;
  if (data.city !== undefined) updateData.city = data.city;
  if (data.state !== undefined) updateData.state = data.state;
  if (data.country !== undefined) updateData.country = data.country;
  if (data.zipCode !== undefined) updateData.postalCode = data.zipCode;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;

  const patient = await prisma.patient.update({
    where: { id },
    data: updateData,
  });

  logger.info({ tenantId, patientId: id }, 'Patient updated');
  return patient;
}

/**
 * Quick search for patients by name, MRN, or phone.
 */
export async function search(tenantId: string, query: SearchPatientsQuery) {
  const searchTerm = query.search?.trim();
  if (!searchTerm) {
    return [];
  }

  const patients = await prisma.patient.findMany({
    where: {
      tenantId,
      isActive: true,
      OR: [
        { firstName: { contains: searchTerm, mode: 'insensitive' } },
        { lastName: { contains: searchTerm, mode: 'insensitive' } },
        { mrn: { contains: searchTerm, mode: 'insensitive' } },
        { phone: { contains: searchTerm } },
      ],
    },
    select: {
      id: true,
      mrn: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      gender: true,
      phone: true,
      email: true,
    },
    take: 20,
    orderBy: { firstName: 'asc' },
  });

  return patients;
}

/**
 * Add an emergency contact to a patient.
 */
export async function addEmergencyContact(patientId: string, data: AddEmergencyContactInput) {
  // Verify patient exists
  const patient = await prisma.patient.findUnique({ where: { id: patientId } });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // If this is primary, unset existing primary contacts
  if (data.isPrimary) {
    await prisma.patientEmergencyContact.updateMany({
      where: { patientId, isPrimary: true },
      data: { isPrimary: false },
    });
  }

  const contact = await prisma.patientEmergencyContact.create({
    data: {
      patientId,
      name: data.name,
      relationship: data.relationship,
      phone: data.phone,
      email: data.email || undefined,
      isPrimary: data.isPrimary ?? false,
    },
  });

  logger.info({ patientId, contactId: contact.id }, 'Emergency contact added');
  return contact;
}

/**
 * Add an allergy record to a patient.
 */
export async function addAllergy(patientId: string, data: AddAllergyInput) {
  const patient = await prisma.patient.findUnique({ where: { id: patientId } });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Check for duplicate allergen
  const existing = await prisma.patientAllergy.findFirst({
    where: {
      patientId,
      allergen: { equals: data.allergen, mode: 'insensitive' },
    },
  });

  if (existing) {
    throw AppError.conflict('This allergy is already recorded for the patient');
  }

  const allergy = await prisma.patientAllergy.create({
    data: {
      patientId,
      allergen: data.allergen,
      allergyType: data.type as any,
      severity: data.severity as any,
      reaction: data.reaction,
    },
  });

  logger.info({ patientId, allergyId: allergy.id }, 'Allergy added');
  return allergy;
}

/**
 * Add family history to a patient.
 */
export async function addFamilyHistory(patientId: string, data: AddFamilyHistoryInput) {
  const patient = await prisma.patient.findUnique({ where: { id: patientId } });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const history = await prisma.patientFamilyHistory.create({
    data: {
      patientId,
      conditionName: data.condition,
      relationSide: 'maternal' as any,
      relationship: data.relationship,
      notes: data.notes,
    },
  });

  logger.info({ patientId, historyId: history.id }, 'Family history added');
  return history;
}

/**
 * Add a document to a patient record.
 */
export async function addDocument(patientId: string, data: AddDocumentInput) {
  const patient = await prisma.patient.findUnique({ where: { id: patientId } });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const document = await prisma.patientDocument.create({
    data: {
      patientId,
      documentType: mapDocumentType(data.type) as any,
      title: data.title,
      fileUrl: data.fileUrl,
      mimeType: data.mimeType,
      uploadedBy: data.uploadedBy,
    },
  });

  logger.info({ patientId, documentId: document.id }, 'Document added');
  return document;
}

/**
 * Get visit history for a patient.
 */
export async function getVisitHistory(tenantId: string, patientId: string) {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
  });

  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const visits = await prisma.visit.findMany({
    where: { patientId, tenantId },
    include: {
      doctor: {
        include: {
          user: {
            select: {
              firstName: true,
              lastName: true,
            },
          },
          department: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return visits;
}
