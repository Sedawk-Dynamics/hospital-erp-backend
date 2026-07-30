import bcrypt from 'bcryptjs';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { TEMP_MRN_PREFIX } from '../../shared/temporary-patient';
import {
  AUTO_ACCOUNT_EMAIL_DOMAIN,
  normalizeAccountPhone,
  placeholderAccountEmail,
} from '../../shared/account-holder';
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
export async function generateMRN(tenantId: string): Promise<string> {
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
 * Phone is the account-holder key. Every registered patient belongs to an
 * account (a User) identified by their phone number:
 *   - if a User already owns that number, this profile is added under them
 *     (as a family member — e.g. the account holder's son);
 *   - if no User owns it, a fresh account holder is auto-created for the number.
 *
 * The account holder lives on the platform tenant (like a patient self-signup)
 * so it can later be claimed/logged into. A random password is set and, since
 * the desk rarely has an email, a synthetic phone-based email fills the
 * required-but-tenant-unique `email` column. OTP verification of the number is
 * a later hardening step; for now the linkage is created directly.
 *
 * Returns the resolved/created User id to link the patient to.
 */
async function resolveOrCreateAccountHolder(input: {
  phone: string;
  firstName?: string;
  lastName?: string | null;
  email?: string;
}): Promise<string> {
  const normalized = normalizeAccountPhone(input.phone);
  if (!normalized) throw AppError.badRequest('A phone number is required to register a patient');

  // Match an existing account holder by number (normalised or raw). Prefer the
  // platform-tenant copy — that is the one a patient can actually log into.
  const candidates = await prisma.user.findMany({
    where: { phone: { in: [normalized, input.phone] }, isActive: true },
    select: { id: true, tenant: { select: { slug: true } } },
    orderBy: { createdAt: 'asc' },
  });
  if (candidates.length > 0) {
    const platform = candidates.find((u) => u.tenant?.slug === '__platform__');
    return (platform ?? candidates[0]).id;
  }

  // No account holder yet → create one on the platform tenant.
  const tenant = await prisma.tenant.findFirst({ where: { slug: '__platform__' } });
  if (!tenant) throw AppError.internal('Platform tenant not found');

  // Find or lazily create the tenant's "patient" role (mirrors self-signup).
  let patientRole = await prisma.role.findFirst({
    where: { tenantId: tenant.id, name: 'patient' },
  });
  if (!patientRole) {
    patientRole = await prisma.role.create({
      data: {
        name: 'patient',
        description: 'Patient user with access to patient portal',
        tenantId: tenant.id,
        isSystemRole: true,
      },
    });
  }

  // Random password (unusable until the owner claims the account by signing up)
  // + synthetic unique email. We deliberately do NOT use a real email here even
  // if one was given: the synthetic address marks the account as an unclaimed
  // placeholder, and keeps a real email free for the owner's own signup.
  const randomSecret = `${normalized}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const passwordHash = await bcrypt.hash(randomSecret, env.BCRYPT_SALT_ROUNDS);
  const synthEmail = placeholderAccountEmail(normalized);

  // Guard the tenant-unique email — if that synthetic email is somehow taken,
  // fall back to a guaranteed-unique variant.
  const digits = normalized.replace(/\D/g, '') || 'unknown';
  const emailClash = await prisma.user.findFirst({
    where: { tenantId: tenant.id, email: synthEmail },
    select: { id: true },
  });
  const email = emailClash
    ? `phone-${digits}-${Date.now()}@${AUTO_ACCOUNT_EMAIL_DOMAIN}`
    : synthEmail;

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName: input.firstName?.trim() || 'Patient',
      lastName: input.lastName?.trim() || null,
      phone: normalized,
      tenantId: tenant.id,
      isActive: true,
      userRoles: { create: { roleId: patientRole.id } },
    },
    select: { id: true },
  });

  logger.info({ userId: user.id, phone: normalized }, 'Auto-created patient account holder');
  return user.id;
}

/**
 * Create a new patient record.
 *
 * Every patient belongs to a phone-keyed account holder (a User): the number is
 * looked up and, if it already belongs to someone, this profile is added under
 * that account (as a family member with `relationship`); otherwise an account
 * holder is auto-created for the number. Callers may instead pass an explicit
 * `userId` to link under a known account, which skips the phone resolution.
 *
 * Phone/email duplicate checks are scoped to OTHER account-holders' patients
 * only — a user's own family members may legitimately share a phone or email.
 */
export async function create(tenantId: string, data: CreatePatientInput) {
  const mrn = await generateMRN(tenantId);

  // Phone-driven account holder: resolve or auto-create unless the caller has
  // already pinned an explicit account (e.g. portal family-profile creation).
  if (!data.userId && data.phone) {
    data.userId = await resolveOrCreateAccountHolder({
      phone: data.phone,
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email || undefined,
    });
  }

  // If linking to a user, verify the user exists
  if (data.userId) {
    const user = await prisma.user.findUnique({ where: { id: data.userId } });
    if (!user) throw AppError.notFound('User not found');
  }

  // Decide relationship + isSelf. First profile linked to a user defaults to 'self'.
  let relationship = data.relationship;
  let isSelf = data.isSelf;
  if (data.userId) {
    if (!relationship) {
      const existingForUser = await prisma.patient.count({ where: { userId: data.userId } });
      relationship = existingForUser === 0 ? 'self' : 'other';
    }
    if (isSelf === undefined) isSelf = relationship === 'self';
  } else {
    relationship = relationship ?? 'self';
    isSelf = isSelf ?? false;
  }

  // Duplicate check: same phone/email within the tenant, but exclude the account-holder's
  // own family profiles (they may legitimately share a phone/email).
  const exclusionFilter = data.userId
    ? { NOT: { userId: data.userId } }
    : {};

  if (data.phone) {
    const existingByPhone = await prisma.patient.findFirst({
      where: { tenantId, phone: data.phone, ...exclusionFilter },
    });
    if (existingByPhone) {
      throw AppError.conflict('A patient with this phone number already exists');
    }
  }

  if (data.email) {
    const existingByEmail = await prisma.patient.findFirst({
      where: { tenantId, email: data.email, ...exclusionFilter },
    });
    if (existingByEmail) {
      throw AppError.conflict('A patient with this email already exists');
    }
  }

  const patient = await prisma.patient.create({
    data: {
      mrn,
      tenantId,
      userId: data.userId,
      relationship: relationship as any,
      isSelf,
      firstName: data.firstName,
      lastName: data.lastName,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
      gender: mapGender(data.gender) as any,
      bloodGroup: data.bloodGroup,
      phone: data.phone,
      email: data.email || undefined,
      addressLine1: data.address,
      city: data.city,
      state: data.state,
      country: data.country,
      postalCode: data.zipCode,
      maritalStatus: data.maritalStatus,
      nationality: data.nationality,
      occupation: data.occupation,
      religion: data.religion,
      preferredLanguage: data.preferredLanguage,
      referredBy: data.referredBy,
      notes: data.notes,
      abhaNumber: data.abhaNumber || undefined,
      idProofNumber: data.nationalId,
      isActive: true,
    },
  });

  logger.info(
    { tenantId, patientId: patient.id, mrn, userId: data.userId, relationship },
    'Patient created',
  );
  return patient;
}

/**
 * List all patient profiles linked to a given user account.
 * Optionally scope to a single tenant.
 */
export async function findByUser(userId: string, tenantId?: string) {
  return prisma.patient.findMany({
    where: { userId, ...(tenantId ? { tenantId } : {}) },
    select: {
      id: true,
      mrn: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      gender: true,
      phone: true,
      email: true,
      relationship: true,
      isSelf: true,
      tenantId: true,
      tenant: { select: { id: true, name: true, slug: true } },
      createdAt: true,
    },
    orderBy: [{ isSelf: 'desc' }, { createdAt: 'asc' }],
  });
}

/**
 * Find patient ids in a tenant whose phone matches a run of digits, comparing on
 * the DIGITS ONLY (any stored formatting/country-code punctuation is stripped).
 * So "9999999945" matches "+91 99999-99945" and "+919999999945", and — being a
 * substring match on the national digits — surfaces every country-code variant
 * of the same 10-digit number. A longer query that includes the country code
 * (e.g. "9199…") narrows to that country.
 */
async function patientIdsByPhoneDigits(tenantId: string, digits: string): Promise<string[]> {
  if (digits.length < 3) return [];
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM patients
    WHERE tenant_id = ${tenantId}
      AND regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') LIKE ${'%' + digits + '%'}
    LIMIT 500
  `;
  return rows.map((r) => r.id);
}

/**
 * Build the search OR-conditions for patients: name, MRN, email as text, plus a
 * digits-normalised phone match (ids resolved separately). One global search
 * that handles name / MRN / phone in every format.
 */
async function buildPatientSearchOr(tenantId: string, rawSearch: string) {
  const search = rawSearch.trim();
  const or: any[] = [
    { firstName: { contains: search, mode: 'insensitive' } },
    { lastName: { contains: search, mode: 'insensitive' } },
    { mrn: { contains: search, mode: 'insensitive' } },
    { email: { contains: search, mode: 'insensitive' } },
  ];
  // Full-name search ("john doe") — split across first/last name.
  const parts = search.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    or.push({
      AND: [
        { firstName: { contains: parts[0], mode: 'insensitive' } },
        { lastName: { contains: parts.slice(1).join(' '), mode: 'insensitive' } },
      ],
    });
  }
  const digits = search.replace(/\D/g, '');
  if (digits.length >= 3) {
    const ids = await patientIdsByPhoneDigits(tenantId, digits);
    if (ids.length) or.push({ id: { in: ids } });
  } else {
    or.push({ phone: { contains: search } });
  }
  return or;
}

/**
 * Get paginated list of patients for a tenant.
 */
export async function findAll(tenantId: string, query: SearchPatientsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.search) {
    where.OR = await buildPatientSearchOr(tenantId, query.search);
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

  // Front Desk directory tabs. A temporary patient is an ACTIVE row whose MRN
  // still has the TEMP- prefix; once registered-in-place it gets a permanent MRN,
  // and once merged it is retired (inactive, MRN suffixed -MERGED) — both drop
  // out of this tab automatically. A registered patient is anything non-TEMP.
  if ((query as any).category === 'temporary') {
    where.mrn = { startsWith: TEMP_MRN_PREFIX, not: { endsWith: '-MERGED' } };
    if (where.isActive === undefined) where.isActive = true;
  } else if ((query as any).category === 'registered') {
    where.NOT = [...(where.NOT ?? []), { mrn: { startsWith: TEMP_MRN_PREFIX } }];
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
  if (data.address !== undefined) updateData.addressLine1 = data.address;
  if (data.city !== undefined) updateData.city = data.city;
  if (data.state !== undefined) updateData.state = data.state;
  if (data.country !== undefined) updateData.country = data.country;
  if (data.zipCode !== undefined) updateData.postalCode = data.zipCode;
  if (data.maritalStatus !== undefined) updateData.maritalStatus = data.maritalStatus;
  if (data.nationality !== undefined) updateData.nationality = data.nationality;
  if (data.occupation !== undefined) updateData.occupation = data.occupation;
  if (data.religion !== undefined) updateData.religion = data.religion;
  if (data.preferredLanguage !== undefined) updateData.preferredLanguage = data.preferredLanguage;
  if (data.referredBy !== undefined) updateData.referredBy = data.referredBy;
  if (data.notes !== undefined) updateData.notes = data.notes;
  if (data.abhaNumber !== undefined) updateData.abhaNumber = data.abhaNumber || null;
  if (data.nationalId !== undefined) updateData.idProofNumber = data.nationalId;
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
      OR: await buildPatientSearchOr(tenantId, searchTerm),
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
 * GLOBAL patient lookup — across EVERY hospital on the ERP (NOT tenant-scoped).
 * A patient is one person: they can walk into any hospital and we just mint a
 * new per-hospital MRN, never re-register their identity. Front desk calls this
 * by phone (+ ABHA) BEFORE registering; if the person already exists anywhere,
 * their demographics are pre-filled and the new record links to the same
 * account holder (`userId`). Returns identity/demographic fields only — no
 * clinical data — plus the hospitals where they're already registered.
 */
export async function globalLookup(params: { phone?: string; abha?: string }) {
  const phone = params.phone?.trim();
  const abha = params.abha?.trim();
  if (!phone && !abha) return { found: false, patient: null, hospitals: [], count: 0 };

  const or: any[] = [];
  if (phone) {
    const norm = normalizeAccountPhone(phone);
    const variants = Array.from(new Set([phone, norm].filter(Boolean))) as string[];
    or.push({ phone: { in: variants } });
    // Also match via the shared account-holder User's phone (the global anchor).
    or.push({ user: { phone: { in: variants } } });
  }
  if (abha) or.push({ abhaNumber: abha });

  const rows = await prisma.patient.findMany({
    where: { isActive: true, OR: or },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: {
      id: true, tenantId: true, userId: true, isSelf: true, relationship: true,
      firstName: true, lastName: true, dateOfBirth: true, gender: true, bloodGroup: true,
      phone: true, email: true, addressLine1: true, city: true, state: true, country: true,
      postalCode: true, maritalStatus: true, nationality: true, occupation: true,
      abhaNumber: true, abhaAddress: true, idProofNumber: true,
      tenant: { select: { id: true, name: true } },
    },
  });
  if (!rows.length) return { found: false, patient: null, hospitals: [], count: 0 };

  // Representative identity: prefer the account holder's own ('self') profile,
  // else the most-recently-updated row.
  const rep = rows.find((r) => r.isSelf) ?? rows[0];
  const hospitals = Array.from(
    new Map(rows.map((r) => [r.tenantId, r.tenant?.name ?? 'Hospital'])).entries(),
  ).map(([id, name]) => ({ tenantId: id, name }));

  return {
    found: true,
    userId: rep.userId,
    patient: {
      firstName: rep.firstName,
      lastName: rep.lastName,
      dateOfBirth: rep.dateOfBirth,
      gender: rep.gender,
      bloodGroup: rep.bloodGroup,
      phone: rep.phone,
      email: rep.email,
      address: rep.addressLine1,
      city: rep.city,
      state: rep.state,
      country: rep.country,
      zipCode: rep.postalCode,
      maritalStatus: rep.maritalStatus,
      nationality: rep.nationality,
      occupation: rep.occupation,
      abhaNumber: rep.abhaNumber,
      abhaAddress: rep.abhaAddress,
      nationalId: rep.idProofNumber,
    },
    hospitals,
    count: rows.length,
  };
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
