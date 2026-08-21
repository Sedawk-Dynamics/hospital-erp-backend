import bcrypt from 'bcryptjs';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { TEMP_MRN_PREFIX } from '../../shared/temporary-patient';
import { resolvePersonPatientIds, isSameNamedPerson } from '../../shared/patient-identity';
import {
  AUTO_ACCOUNT_EMAIL_DOMAIN,
  normalizeAccountPhone,
  phoneLast10,
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
export async function generateMRN(_tenantId?: string): Promise<string> {
  const today = new Date();
  const dateStr =
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, '0') +
    today.getDate().toString().padStart(2, '0');

  const prefix = `MRN-${dateStr}-`;

  // A patient is ONE person across the whole ERP → the MRN is GLOBAL. Count over
  // every hospital (no tenant filter) so the number is unique platform-wide and
  // the same person carries it wherever they go. (tenantId kept for call-site
  // compatibility but no longer scopes the sequence.)
  const latestPatient = await prisma.patient.findFirst({
    where: { mrn: { startsWith: prefix } },
    orderBy: { mrn: 'desc' },
    select: { mrn: true },
  });

  let nextNumber = 1;
  if (latestPatient?.mrn) {
    const lastNumber = parseInt(latestPatient.mrn.split('-').pop() || '0', 10);
    nextNumber = lastNumber + 1;
  }

  const mrn = `${prefix}${nextNumber.toString().padStart(4, '0')}`;

  // Verify global uniqueness (race-condition safety).
  const existing = await prisma.patient.findFirst({ where: { mrn }, select: { id: true } });
  if (existing) return generateMRN();

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
/**
 * Find the account holder who owns this phone number, WITHOUT creating one.
 *
 * `resolveOrCreateAccountHolder` mints a portal account when no match is found,
 * which is right when a patient is registering themselves. It is wrong for a
 * temporary record: the number on the form usually belongs to whoever brought
 * the patient in, and an unidentified patient must not have a login account
 * created in their name off the back of a relative's phone.
 *
 * Returns null when nobody owns the number — the caller then simply records no
 * linkage, which is the honest answer.
 */
export async function findAccountHolderByPhone(phone?: string | null): Promise<string | null> {
  if (!phone?.trim()) return null;
  const normalized = normalizeAccountPhone(phone);
  if (!normalized) return null;

  const candidates = await prisma.user.findMany({
    where: { phone: { in: [normalized, phone] }, isActive: true },
    select: { id: true, tenant: { select: { slug: true } } },
    orderBy: { createdAt: 'asc' },
  });
  if (candidates.length === 0) return null;
  // Prefer the platform-tenant copy — the one a patient can actually log into.
  const platform = candidates.find((u) => u.tenant?.slug === '__platform__');
  return (platform ?? candidates[0]).id;
}

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
/**
 * The person's existing GLOBAL MRN, if they're already on the ERP anywhere —
 * matched by account holder (userId), ABHA, or phone (last 10 digits). Returns
 * their earliest real (non-TEMP) MRN so every hospital shares one number.
 */
async function resolveExistingGlobalMrn(p: {
  userId?: string | null;
  phone?: string | null;
  abhaNumber?: string | null;
}): Promise<string | null> {
  const or: any[] = [];
  if (p.userId) or.push({ userId: p.userId });
  if (p.abhaNumber) or.push({ abhaNumber: p.abhaNumber });
  if (p.phone) {
    const last10 = phoneLast10(p.phone);
    if (last10.length >= 7) {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM patients WHERE is_active = true
          AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = ${last10}
        LIMIT 50`;
      if (rows.length) or.push({ id: { in: rows.map((r) => r.id) } });
    }
  }
  if (!or.length) return null;
  const existing = await prisma.patient.findFirst({
    where: { OR: or, NOT: { mrn: { startsWith: TEMP_MRN_PREFIX } } },
    orderBy: { createdAt: 'asc' },
    select: { mrn: true },
  });
  return existing?.mrn ?? null;
}

/** The columns the phone-collision query reads back. */
interface PhoneMatchRow {
  id: string;
  user_id: string | null;
  mrn: string;
  first_name: string | null;
  last_name: string | null;
  date_of_birth: Date | null;
}

/**
 * Whether an existing row is the same human as the one being registered.
 * One rule, defined in `shared/patient-identity.ts`, so registration refuses
 * exactly the duplicates the rest of the ERP would later try to merge.
 * `allowDuplicate` is the way past it when two people genuinely do match.
 */
function isSamePerson(row: PhoneMatchRow, data: CreatePatientInput): boolean {
  return isSameNamedPerson(
    { firstName: row.first_name, lastName: row.last_name, dateOfBirth: row.date_of_birth },
    data,
  );
}

export async function create(tenantId: string, data: CreatePatientInput) {
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

  // ONE global MRN per person: if this human is already on the ERP (by account
  // holder / ABHA / phone-last10), reuse their existing MRN so every hospital
  // shows the same number; otherwise mint a new global MRN. Existing patients
  // keep whatever MRN they already have — nothing is rewritten here.
  let mrn = await resolveExistingGlobalMrn({
    userId: data.userId,
    phone: data.phone,
    abhaNumber: (data as any).abhaNumber,
  });
  // Guard the per-tenant unique index: a LEGACY per-tenant MRN could already
  // belong to a different patient in THIS hospital — if so, mint a fresh global
  // number instead of colliding.
  if (mrn) {
    const clash = await prisma.patient.findFirst({ where: { tenantId, mrn }, select: { id: true } });
    if (clash) mrn = null;
  }
  if (!mrn) mrn = await generateMRN();

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
    // Compare on the last 10 digits so +91XXXXXXXXXX and XXXXXXXXXX collide as
    // one number; still allow the account holder's own family to share a phone.
    const last10 = phoneLast10(data.phone);
    const rows = await prisma.$queryRaw<PhoneMatchRow[]>`
      SELECT id, user_id, mrn, first_name, last_name, date_of_birth FROM patients
      WHERE tenant_id = ${tenantId}
        AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = ${last10}
      LIMIT 10
    `;
    const clash = rows.find((r) => !data.userId || r.user_id !== data.userId);
    if (clash) {
      throw AppError.conflict('A patient with this phone number already exists');
    }
    // Whatever is left belongs to this account holder's own family, who may
    // legitimately share the number — a mother booked on her son's phone. What
    // they may NOT be is the same person registered a second time, which is how
    // one human ends up with several profiles, several MRNs, and a portal that
    // offers them a choice between themselves.
    if (!data.allowDuplicate) {
      const twin = rows.find((r) => isSamePerson(r, data));
      if (twin) {
        throw AppError.conflict(
          `${data.firstName} ${data.lastName} is already registered at this hospital as ${twin.mrn}. ` +
            'Open that record instead of creating a new one.',
        );
      }
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
  // Two matchers, so +91XXXXXXXXXX and XXXXXXXXXX (and 0-prefixed) are the SAME
  // number regardless of which side carries the country code:
  //   • substring on the normalised digits (partial typing), AND
  //   • last-10-digit equality once a full mobile number is entered.
  const last10 = digits.slice(-10);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM patients
    WHERE tenant_id = ${tenantId}
      AND (
        regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') LIKE ${'%' + digits + '%'}
        OR (${digits.length >= 10} AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = ${last10})
      )
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
    // Match on the LAST 10 DIGITS so +91XXXXXXXXXX and XXXXXXXXXX are the same
    // number — on the patient's own phone OR the linked account-holder's phone.
    const last10 = phoneLast10(phone);
    if (last10.length >= 7) {
      const idRows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM patients p
        LEFT JOIN users u ON u.id = p.user_id
        WHERE p.is_active = true
          AND (
            right(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g'), 10) = ${last10}
            OR right(regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g'), 10) = ${last10}
          )
        LIMIT 200
      `;
      const ids = idRows.map((r) => r.id);
      if (ids.length) or.push({ id: { in: ids } });
    }
  }
  if (abha) or.push({ abhaNumber: abha });
  if (!or.length) return { found: false, patient: null, hospitals: [], count: 0 };

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
 * GLOBAL patient search for the pickers (new appointment / admit / etc.). A
 * patient is one person across the whole ERP, so this searches EVERY hospital by
 * name / phone(last-10) / MRN / ABHA, then dedupes to one row PER PERSON. Each
 * result says whether the person already has a record IN THE CALLER'S hospital
 * (`localPatientId`), or exists only elsewhere (`isLocal:false`) — in which case
 * the picker provisions a local MRN on selection. No re-registration.
 */
export async function globalPatientSearch(tenantId: string, rawSearch: string) {
  const q = rawSearch?.trim();
  if (!q || q.length < 2) return [];

  const or: any[] = [
    { firstName: { contains: q, mode: 'insensitive' } },
    { lastName: { contains: q, mode: 'insensitive' } },
    { mrn: { contains: q, mode: 'insensitive' } },
    { abhaNumber: { contains: q } },
  ];
  const parts = q.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    or.push({
      AND: [
        { firstName: { contains: parts[0], mode: 'insensitive' } },
        { lastName: { contains: parts.slice(1).join(' '), mode: 'insensitive' } },
      ],
    });
  }
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 7) {
    const last10 = digits.slice(-10);
    const idRows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM patients p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.is_active = true AND (
        right(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g'), 10) = ${last10}
        OR right(regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g'), 10) = ${last10}
      ) LIMIT 200`;
    if (idRows.length) or.push({ id: { in: idRows.map((r) => r.id) } });
  }

  const rows = await prisma.patient.findMany({
    where: { isActive: true, OR: or },
    orderBy: { updatedAt: 'desc' },
    take: 80,
    select: {
      id: true, tenantId: true, userId: true, mrn: true, firstName: true, lastName: true,
      dateOfBirth: true, gender: true, phone: true, abhaNumber: true,
      tenant: { select: { name: true } },
    },
  });

  // One entry per PERSON: userId > ABHA > phone-last10 > row id.
  const personKey = (r: (typeof rows)[number]) =>
    r.userId ? `u:${r.userId}` : r.abhaNumber ? `a:${r.abhaNumber}` : r.phone ? `p:${phoneLast10(r.phone)}` : `id:${r.id}`;

  const localByPerson = new Map<string, string>();
  for (const r of rows) if (r.tenantId === tenantId) localByPerson.set(personKey(r), r.id);

  const seen = new Set<string>();
  const out: any[] = [];
  for (const r of rows) {
    const k = personKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    const localId = localByPerson.get(k) ?? null;
    out.push({
      sourcePatientId: r.id,
      localPatientId: localId,
      isLocal: !!localId,
      firstName: r.firstName,
      lastName: r.lastName,
      dateOfBirth: r.dateOfBirth,
      gender: r.gender,
      phone: r.phone,
      mrn: localId ? localByPerson.get(k) : r.mrn,
      hospital: r.tenant?.name ?? 'Hospital',
    });
    if (out.length >= 25) break;
  }
  return out;
}

/**
 * Provision a LOCAL patient record (new MRN in the caller's hospital) for a
 * person who exists elsewhere on the ERP — copying their identity and linking to
 * the same account holder. Idempotent: if they already have a local record, it's
 * returned instead of creating a duplicate. This is what the appointment/admit
 * pickers call when the desk selects a cross-hospital patient.
 */
export async function provisionLocalPatient(tenantId: string, sourcePatientId: string) {
  const src = await prisma.patient.findUnique({
    where: { id: sourcePatientId },
    select: {
      id: true, tenantId: true, userId: true, firstName: true, lastName: true,
      dateOfBirth: true, gender: true, bloodGroup: true, phone: true, email: true,
      addressLine1: true, city: true, state: true, country: true, postalCode: true,
      maritalStatus: true, nationality: true, occupation: true,
      abhaNumber: true, idProofNumber: true,
    },
  });
  if (!src) throw AppError.notFound('Source patient not found');

  // Already registered here? Return the existing local row (match by account
  // holder / ABHA / phone-last10) — never create a duplicate.
  const orExisting: any[] = [];
  if (src.userId) orExisting.push({ userId: src.userId });
  if (src.abhaNumber) orExisting.push({ abhaNumber: src.abhaNumber });
  if (orExisting.length || src.phone) {
    if (src.phone) {
      const last10 = phoneLast10(src.phone);
      const idRows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM patients WHERE tenant_id = ${tenantId} AND is_active = true
          AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = ${last10}
        LIMIT 5`;
      if (idRows.length) orExisting.push({ id: { in: idRows.map((r) => r.id) } });
    }
    if (orExisting.length) {
      const existing = await prisma.patient.findFirst({ where: { tenantId, isActive: true, OR: orExisting } });
      if (existing) return existing;
    }
  }

  // Otherwise create a fresh local record (new MRN), linked to the same account
  // holder (userId carries over → shared identity), no re-entry needed.
  return create(tenantId, {
    userId: src.userId ?? undefined,
    firstName: src.firstName,
    lastName: src.lastName ?? undefined,
    dateOfBirth: src.dateOfBirth ? src.dateOfBirth.toISOString() : undefined,
    gender: (src.gender as string) ?? undefined,
    bloodGroup: src.bloodGroup ?? undefined,
    phone: src.phone ?? undefined,
    email: src.email ?? undefined,
    address: src.addressLine1 ?? undefined,
    city: src.city ?? undefined,
    state: src.state ?? undefined,
    country: src.country ?? undefined,
    zipCode: src.postalCode ?? undefined,
    maritalStatus: src.maritalStatus ?? undefined,
    nationality: src.nationality ?? undefined,
    occupation: src.occupation ?? undefined,
    abhaNumber: src.abhaNumber ?? undefined,
    nationalId: src.idProofNumber ?? undefined,
    // This path did its own dedup above; keep its behaviour unchanged.
    allowDuplicate: true,
  } as CreatePatientInput);
}

/**
 * UNIFIED cross-hospital patient history. A patient is one person across the
 * whole ERP; this aggregates their records from EVERY hospital they've visited
 * (same person = linked by account-holder userId / phone-last10 / ABHA) into one
 * read-only timeline, each row tagged with the hospital it came from. This is a
 * deliberate cross-tenant READ (writes stay tenant-scoped). The caller must hold
 * the patient in their own tenant + patients:read to reach it.
 */
export async function getGlobalPatientHistory(tenantId: string, patientId: string) {
  const base = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
    select: {
      id: true, userId: true, phone: true, abhaNumber: true,
      firstName: true, lastName: true, dateOfBirth: true, gender: true,
    },
  });
  if (!base) throw AppError.notFound('Patient not found');

  // Resolve every linked Patient row across ALL hospitals (the same human).
  const orConds: any[] = [];
  if (base.userId) orConds.push({ userId: base.userId });
  if (base.abhaNumber) orConds.push({ abhaNumber: base.abhaNumber });
  if (base.phone) {
    const last10 = phoneLast10(base.phone);
    if (last10.length >= 7) {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM patients p LEFT JOIN users u ON u.id = p.user_id
        WHERE p.is_active = true AND (
          right(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g'), 10) = ${last10}
          OR right(regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g'), 10) = ${last10}
        ) LIMIT 200`;
      const ids = rows.map((r) => r.id);
      if (ids.length) orConds.push({ id: { in: ids } });
    }
  }
  const linked = await prisma.patient.findMany({
    where: orConds.length ? { OR: [{ id: patientId }, ...orConds] } : { id: patientId },
    select: { id: true, tenantId: true, mrn: true, tenant: { select: { name: true } } },
  });
  const idList = linked.map((l) => l.id);
  const byId = new Map(linked.map((l) => [l.id, l]));
  const hosp = (pid: string) => byId.get(pid)?.tenant?.name ?? 'Hospital';
  const docName = (d: any) =>
    d?.user ? `Dr. ${d.user.firstName ?? ''} ${d.user.lastName ?? ''}`.trim() : null;

  const [visits, admissions, prescriptions, labOrders, imaging, bills] = await Promise.all([
    prisma.visit.findMany({
      where: { patientId: { in: idList } },
      include: { doctor: { include: { user: { select: { firstName: true, lastName: true } } } } },
      orderBy: { visitDate: 'desc' }, take: 40,
    }),
    prisma.admission.findMany({
      where: { patientId: { in: idList } },
      include: {
        ward: { select: { name: true } }, bed: { select: { bedNumber: true } },
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      },
      orderBy: { admissionDate: 'desc' }, take: 40,
    }),
    prisma.prescription.findMany({
      where: { patientId: { in: idList } },
      include: {
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
        _count: { select: { prescriptionItems: true } },
      },
      orderBy: { createdAt: 'desc' }, take: 40,
    }),
    prisma.labOrder.findMany({
      where: { patientId: { in: idList } },
      include: { labOrderItems: { include: { test: { select: { testName: true } } } } },
      orderBy: { createdAt: 'desc' }, take: 40,
    }),
    prisma.imagingRequest.findMany({
      where: { patientId: { in: idList } },
      orderBy: { createdAt: 'desc' }, take: 40,
    }),
    prisma.bill.findMany({
      where: { patientId: { in: idList }, status: { not: 'cancelled' } },
      orderBy: { createdAt: 'desc' }, take: 60,
    }),
  ]);

  return {
    person: {
      firstName: base.firstName, lastName: base.lastName,
      dateOfBirth: base.dateOfBirth, gender: base.gender,
    },
    hospitals: linked.map((l) => ({
      tenantId: l.tenantId, name: l.tenant?.name ?? 'Hospital', mrn: l.mrn,
      isCurrent: l.tenantId === tenantId,
    })),
    visits: visits.map((v) => ({
      hospital: hosp(v.patientId), date: v.visitDate, type: v.visitType,
      status: v.status, chiefComplaint: v.chiefComplaint, doctor: docName((v as any).doctor),
    })),
    admissions: admissions.map((a) => ({
      hospital: hosp(a.patientId), admittedAt: a.admissionDate, dischargedAt: a.dischargeDate,
      status: a.status, ward: (a as any).ward?.name ?? null, bed: (a as any).bed?.bedNumber ?? null,
      doctor: docName((a as any).doctor),
    })),
    prescriptions: prescriptions.map((p) => ({
      hospital: hosp(p.patientId), date: p.createdAt, status: p.status,
      doctor: docName((p as any).doctor), items: (p as any)._count?.prescriptionItems ?? 0,
    })),
    labOrders: labOrders.map((o) => ({
      hospital: hosp(o.patientId), date: o.createdAt, status: o.status,
      tests: (o as any).labOrderItems.map((i: any) => i.test?.testName).filter(Boolean),
    })),
    imaging: imaging.map((r) => ({
      hospital: hosp(r.patientId), date: r.createdAt,
      modality: (r as any).imagingType, bodyPart: (r as any).bodyPart, status: r.status,
    })),
    bills: bills.map((b) => ({
      hospital: hosp(b.patientId), billNumber: b.billNumber, date: (b as any).billDate ?? b.createdAt,
      status: b.status, total: Number(b.totalAmount), paid: Number(b.amountPaid), balance: Number(b.balanceDue),
    })),
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
 * Every document on file for this PERSON — what the patient uploaded from the
 * portal ("My Documents") plus anything staff attached to the record.
 *
 * There was no read side at all: `POST /patients/:id/documents` existed and the
 * portal wrote rows happily, but nothing could list them, so a patient's
 * uploaded referral letter or outside scan was invisible to the clinician it
 * was uploaded for.
 *
 * Person-scoped, not patient-row-scoped. One human has a separate Patient row
 * per hospital, and a document they uploaded once belongs to them, not to the
 * row it happened to land on.
 */
export async function getDocuments(tenantId: string, patientId: string) {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
    select: { id: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');

  const personIds = await resolvePersonPatientIds(patientId);

  const [documents, personRows] = await Promise.all([
    prisma.patientDocument.findMany({
      where: { patientId: { in: personIds } },
      orderBy: { createdAt: 'desc' },
      include: {
        uploader: { select: { id: true, firstName: true, lastName: true } },
        patient: { select: { id: true, tenantId: true, tenant: { select: { name: true } } } },
      },
    }),
    prisma.patient.findMany({
      where: { id: { in: personIds } },
      select: { userId: true },
    }),
  ]);

  // The portal writes uploadedBy = the patient's own user id, staff uploads
  // write a staff user id. A clinician reads an outside document the patient
  // brought differently from one the hospital produced, so flag which is which.
  const patientUserIds = new Set(
    personRows.map((p) => p.userId).filter((id): id is string => !!id),
  );

  return documents.map((d) => ({
    id: d.id,
    documentType: d.documentType,
    title: d.title,
    fileUrl: d.fileUrl,
    mimeType: d.mimeType,
    fileSizeBytes: d.fileSizeBytes,
    notes: d.notes,
    isVerified: d.isVerified,
    createdAt: d.createdAt,
    uploader: d.uploader ? `${d.uploader.firstName} ${d.uploader.lastName ?? ''}`.trim() : null,
    uploadedByPatient: !!d.uploadedBy && patientUserIds.has(d.uploadedBy),
    /** Which hospital's record it was filed against — null when it's this one. */
    sourceHospital: d.patient.tenantId === tenantId ? null : (d.patient.tenant?.name ?? null),
  }));
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
