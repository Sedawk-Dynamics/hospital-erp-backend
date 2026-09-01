import crypto from 'crypto';
import { prisma } from '../../config/database';
import { resolvePersonPatientIds, isSameNamedPerson } from '../../shared/patient-identity';
import { razorpay } from '../../config/razorpay';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { notifyUsers, usersWithRoles, doctorUserIdFromProfile } from '../../shared/notify';
import { nextBillNumberInSeries } from '../../shared/bill-number';
import { formatDateTimeIST } from '../../shared/date.utils';
import { commissionService } from '../commission/commission.service';
import { settleGatewayPayment } from '../billing/billing.service';
import { getAvailableSlots } from '../appointments/appointments.service';
import { fullName } from '../../shared/person-name';

// ────────────────────────────────────────────────────────────
// MRN Generation (mirrors patients.service.ts)
// ────────────────────────────────────────────────────────────

async function generateMRN(_tenantId?: string): Promise<string> {
  const today = new Date();
  const dateStr =
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, '0') +
    today.getDate().toString().padStart(2, '0');

  const prefix = `MRN-${dateStr}-`;

  // MRN is GLOBAL (one person, one number ERP-wide) → count across all hospitals.
  const latestPatient = await prisma.patient.findFirst({
    where: { mrn: { startsWith: prefix } },
    orderBy: { mrn: 'desc' },
    select: { mrn: true },
  });

  let nextNumber = 1;
  if (latestPatient?.mrn) {
    const lastNumber = parseInt(latestPatient.mrn.replace(prefix, ''), 10);
    if (!isNaN(lastNumber)) nextNumber = lastNumber + 1;
  }

  const mrn = `${prefix}${nextNumber.toString().padStart(4, '0')}`;

  const existing = await prisma.patient.findFirst({ where: { mrn }, select: { id: true } });
  if (existing) return generateMRN();

  return mrn;
}

// ────────────────────────────────────────────────────────────
// Connection-based patient lookup
// ────────────────────────────────────────────────────────────

/**
 * List every patient profile this user owns (family members) across all hospitals.
 * Includes Patient records directly linked via userId AND records reachable through
 * an approved PatientHospitalConnection. Results are de-duplicated by patientId.
 *
 * Used by the Patient Portal's profile selector.
 */
export async function listMyProfiles(userId: string, email: string) {
  // A PLATFORM row is a placeholder, not a hospital record.
  //
  // Platform has no doctors, wards or bills, so a Patient row there holds
  // nothing. Two things put rows there: signup used to (it no longer does), and
  // adding a family member still does, because the person has not picked a
  // hospital yet.
  //
  // So the rule cannot be "hide platform rows" — that would make a newly added
  // family member vanish. It is "hide a platform row once the same person has
  // a REAL one", which is the duplicate that was being reported: one human,
  // two entries with the same MRN, the platform one always empty. Applied
  // during grouping below, where the person's rows are known.
  const platformTenant = await prisma.tenant.findFirst({
    where: { slug: '__platform__' },
    select: { id: true },
  });
  const platformId = platformTenant?.id ?? null;

  // 1. Direct Patient records owned by this user.
  const owned = await prisma.patient.findMany({
    where: { userId },
    include: { tenant: { select: { id: true, name: true, slug: true, logoUrl: true } } },
    orderBy: [{ isSelf: 'desc' }, { createdAt: 'asc' }],
  });

  // 2. Patient records reachable through approved connections (legacy link path).
  const connectionPatients = await prisma.patientHospitalConnection.findMany({
    where: { userId, status: 'approved', patientId: { not: null } },
    include: {
      patient: {
        include: { tenant: { select: { id: true, name: true, slug: true, logoUrl: true } } },
      },
    },
  });

  // 3. Fallback email-match for pre-connection patient records.
  const byEmail = email
    ? await prisma.patient.findMany({
        where: { email: { equals: email, mode: 'insensitive' }, userId: null },
        include: { tenant: { select: { id: true, name: true, slug: true, logoUrl: true } } },
      })
    : [];

  const seen = new Set<string>();
  const combined: Array<(typeof owned)[number]> = [];
  for (const p of owned) {
    if (!seen.has(p.id)) { seen.add(p.id); combined.push(p); }
  }
  for (const c of connectionPatients) {
    if (c.patient && !seen.has(c.patient.id)) {
      seen.add(c.patient.id);
      combined.push(c.patient as any);
    }
  }
  for (const p of byEmail) {
    if (!seen.has(p.id)) { seen.add(p.id); combined.push(p); }
  }

  // Collapse the same PERSON into one profile.
  //
  // A row is a hospital's record, so somebody treated at two hospitals has two
  // of them — and the switcher listed each, which reads as two people.
  //
  // Grouped on `resolvePersonPatientIds`, NOT on userId: a parent's account
  // holds their own row and their children's under the same userId, so
  // grouping by account would merge a parent with their child. That helper's
  // identity rule is deliberately strict (ABHA, or name + date of birth
  // alongside the account or phone) and is not loosened here.
  const byId = new Map(combined.map((p) => [p.id, p]));
  const assigned = new Set<string>();
  const profiles: Array<(typeof combined)[number] & { alsoAt?: Array<{ id: string; name: string }> }> = [];

  for (const p of combined) {
    if (assigned.has(p.id)) continue;

    const personIds = await resolvePersonPatientIds(p.id);
    // Only rows this user can already reach — resolving a person must never
    // widen what the account can see.
    const mine = personIds.filter((id) => byId.has(id));
    const group = (mine.length ? mine : [p.id]).map((id) => byId.get(id)!);
    group.forEach((g) => assigned.add(g.id));

    // Once the person has a real hospital row, the platform placeholder is
    // the empty duplicate — drop it. A person who has ONLY a placeholder (a
    // family member added but not yet seen anywhere) keeps it, or they would
    // disappear from their own switcher.
    const real = platformId ? group.filter((g) => g.tenantId !== platformId) : group;
    const effective = real.length ? real : group;

    // The row that represents the person: their own "self" record if there is
    // one, else the oldest — `combined` is already ordered isSelf then created.
    const lead = effective.find((g) => g.isSelf) ?? effective[0];
    profiles.push({
      ...lead,
      // Where else the same person is on file, so one entry can still show
      // that they are known at more than one hospital.
      alsoAt: effective
        .filter((g) => g.id !== lead.id && g.tenant)
        .map((g) => ({ id: g.tenant!.id, name: g.tenant!.name })),
    });
  }

  return profiles;
}

/**
 * Create a new family-member patient profile under the current user.
 * The new profile is registered to the user's own platform tenant by default
 * (behavior mirrors self-signup) unless a specific tenantId is provided.
 */
export async function createMyProfile(
  userId: string,
  data: {
    firstName: string;
    lastName?: string;
    dateOfBirth?: string;
    gender?: 'male' | 'female' | 'other';
    phone?: string;
    email?: string;
    relationship: 'self' | 'spouse' | 'child' | 'parent' | 'sibling' | 'guardian' | 'other';
    bloodGroup?: string;
    tenantId?: string;
    /** Set once the person has been shown the match and still means to add. */
    allowDuplicate?: boolean;
  },
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');

  // Someone already on this account must not be added to it again. Nothing
  // checked before, so tapping Add twice — or re-adding a child who is already
  // listed — minted a second profile and a second MRN for one person, and any
  // booking then landed on whichever row the form happened to carry.
  if (!data.allowDuplicate) {
    const mine = await prisma.patient.findMany({
      where: { userId },
      select: {
        id: true, mrn: true, firstName: true, lastName: true,
        dateOfBirth: true, gender: true, phone: true, relationship: true,
      },
    });
    const twin = mine.find((p) => isSameNamedPerson(p, data));
    if (twin) {
      // The matched profile travels with the error so the portal can show it
      // and let them choose, rather than printing an MRN they cannot act on.
      throw AppError.conflict(
        `${data.firstName}${data.lastName ? ` ${data.lastName}` : ''} is already one of your profiles (${twin.mrn}).`,
        'DUPLICATE_PATIENT',
        { patient: twin },
      );
    }
  }

  const tenantId = data.tenantId || user.tenantId;
  const mrn = await generateMRN(tenantId);

  // If this is the user's first profile AND relationship is self, mark isSelf
  const existingCount = await prisma.patient.count({ where: { userId } });
  const isSelf = data.relationship === 'self' && existingCount === 0;

  return prisma.patient.create({
    data: {
      tenantId,
      userId,
      mrn,
      relationship: data.relationship as any,
      isSelf,
      firstName: data.firstName,
      lastName: data.lastName,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
      gender: data.gender as any,
      phone: data.phone,
      email: data.email || undefined,
      bloodGroup: data.bloodGroup,
      registrationSource: 'self_signup',
      patientType: 'outpatient',
    },
  });
}

async function findConnectedPatients(userId: string, tenantId?: string) {
  const where: Record<string, unknown> = {
    userId,
    status: 'approved',
    patientId: { not: null },
  };
  if (tenantId) where.tenantId = tenantId;

  const connections = await prisma.patientHospitalConnection.findMany({
    where,
    select: { patientId: true, tenantId: true },
  });

  return connections
    .filter((c) => c.patientId !== null)
    .map((c) => ({ id: c.patientId!, tenantId: c.tenantId }));
}

/**
 * Fallback: find patients by email (for backward compat when no connections exist).
 */
async function findPatientsByEmail(email: string) {
  return prisma.patient.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, tenantId: true },
  });
}

/**
 * Resolve patient IDs for the current user, considering every source a patient could
 * be linked through: direct userId link (family profiles), approved connections, and
 * email-match fallback for legacy records. If `profileId` is provided the list is
 * narrowed to that single profile after authorization checks.
 */
async function resolvePatientIds(
  userId: string,
  email: string,
  tenantId?: string,
  profileId?: string,
) {
  // Direct owned profiles (family members).
  const owned = await prisma.patient.findMany({
    where: { userId, ...(tenantId ? { tenantId } : {}) },
    select: { id: true, tenantId: true },
  });

  // Legacy connection-based linkage.
  const connected = await findConnectedPatients(userId, tenantId);

  // Legacy email fallback.
  const byEmail = email ? await findPatientsByEmail(email) : [];
  const emailFiltered = tenantId ? byEmail.filter((p) => p.tenantId === tenantId) : byEmail;

  const ids = new Set<string>();
  for (const p of owned) ids.add(p.id);
  for (const p of connected) ids.add(p.id);
  for (const p of emailFiltered) ids.add(p.id);

  if (profileId) {
    // A profileId that isn't one of this user's own records is stale — the
    // family member was removed, or the id is left over in a store from a
    // previous session. Returning [] made every list on the page render empty
    // with no explanation; falling back to "all my profiles" shows the user
    // their own records instead of a blank portal.
    if (ids.has(profileId)) {
      // One profile can now stand for the same person's rows at several
      // hospitals, so narrow to that PERSON rather than to the single row that
      // happens to represent them — otherwise choosing a profile hides
      // everything recorded for them anywhere else.
      //
      // Intersected with what the account can already reach, so resolving a
      // person can never widen access.
      const personIds = await resolvePersonPatientIds(profileId);
      const mine = personIds.filter((id) => ids.has(id));
      return mine.length ? mine : [profileId];
    }
    logger.warn({ userId, profileId }, 'Portal profileId not owned by user — showing all profiles');
  }
  return Array.from(ids);
}

// ────────────────────────────────────────────────────────────
// Hospital Search & Discovery
// ────────────────────────────────────────────────────────────

/**
 * Look up a hospital by its 6-digit code or by name.
 */
export async function lookupHospital(userId: string, query: { code?: string; search?: string }) {
  const where: Record<string, unknown> = {
    slug: { not: '__platform__' },
    isActive: true,
  };

  // Exact code match takes priority
  if (query.code) {
    where.hospitalCode = { equals: query.code.toUpperCase(), mode: 'insensitive' };
  } else if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { hospitalCode: { equals: query.search.toUpperCase(), mode: 'insensitive' } },
    ];
  } else {
    return { data: [] };
  }

  const hospitals = await prisma.tenant.findMany({
    where,
    take: 10,
    select: {
      id: true,
      name: true,
      slug: true,
      hospitalCode: true,
      logoUrl: true,
      city: true,
      state: true,
      address: true,
      phone: true,
      email: true,
      allowDirectPatientConnection: true,
    },
    orderBy: { name: 'asc' },
  });

  // Get user's existing connections
  const connections = await prisma.patientHospitalConnection.findMany({
    where: { userId, tenantId: { in: hospitals.map((h) => h.id) } },
    select: { tenantId: true, status: true },
  });
  const connectionMap = new Map(connections.map((c) => [c.tenantId, c.status]));

  return {
    data: hospitals.map((h) => ({
      ...h,
      connectionStatus: connectionMap.get(h.id) ?? 'none',
    })),
  };
}

// ────────────────────────────────────────────────────────────
// Connection Management (Patient Side)
// ────────────────────────────────────────────────────────────

export async function requestConnection(
  userId: string,
  email: string,
  tenantId: string,
  message?: string,
) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, slug: true, isActive: true, allowDirectPatientConnection: true },
  });

  if (!tenant || !tenant.isActive || tenant.slug === '__platform__') {
    throw AppError.notFound('Hospital not found');
  }

  // Check for existing connection
  const existing = await prisma.patientHospitalConnection.findUnique({
    where: { userId_tenantId: { userId, tenantId } },
  });

  if (existing) {
    if (existing.status === 'approved') throw AppError.conflict('Already connected to this hospital');
    if (existing.status === 'pending') throw AppError.conflict('Connection request already pending');
    // If rejected, allow re-request
    if (existing.status === 'rejected') {
      const updated = await prisma.patientHospitalConnection.update({
        where: { id: existing.id },
        data: { status: 'pending', requestMessage: message, rejectionReason: null, reviewedBy: null, reviewedAt: null },
        include: { tenant: { select: { id: true, name: true, slug: true, city: true, logoUrl: true } } },
      });
      return updated;
    }
  }

  // If hospital allows direct connection, auto-approve
  if (tenant.allowDirectPatientConnection) {
    const patientId = await createPatientInTenant(userId, email, tenantId);
    const connection = await prisma.patientHospitalConnection.create({
      data: {
        userId,
        tenantId,
        status: 'approved',
        patientId,
        requestMessage: message,
      },
      include: { tenant: { select: { id: true, name: true, slug: true, city: true, logoUrl: true } } },
    });
    return connection;
  }

  // Otherwise create pending request
  const connection = await prisma.patientHospitalConnection.create({
    data: {
      userId,
      tenantId,
      status: 'pending',
      requestMessage: message,
    },
    include: { tenant: { select: { id: true, name: true, slug: true, city: true, logoUrl: true } } },
  });
  return connection;
}

export async function getMyConnections(userId: string) {
  return prisma.patientHospitalConnection.findMany({
    where: { userId },
    include: {
      tenant: {
        select: { id: true, name: true, slug: true, hospitalCode: true, logoUrl: true, city: true, state: true, address: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function cancelConnection(userId: string, connectionId: string) {
  const connection = await prisma.patientHospitalConnection.findFirst({
    where: { id: connectionId, userId },
  });

  if (!connection) throw AppError.notFound('Connection not found');
  if (connection.status !== 'pending') {
    throw AppError.badRequest('Only pending requests can be cancelled');
  }

  await prisma.patientHospitalConnection.delete({ where: { id: connectionId } });
  return { success: true };
}

// ────────────────────────────────────────────────────────────
// Connection Management (Hospital Staff / Admin Side)
// ────────────────────────────────────────────────────────────

export async function listConnectionRequests(
  tenantId: string,
  query: { status?: string; limit?: number; page?: number },
) {
  const limit = query.limit || 30;
  const page = query.page || 1;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { tenantId };
  if (query.status) where.status = query.status;

  const [connections, total] = await Promise.all([
    prisma.patientHospitalConnection.findMany({
      where,
      take: limit,
      skip,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        patient: { select: { id: true, mrn: true } },
        reviewer: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.patientHospitalConnection.count({ where }),
  ]);

  return { data: connections, meta: { total, page, limit } };
}

export async function approveConnection(
  tenantId: string,
  connectionId: string,
  reviewerId: string,
) {
  const connection = await prisma.patientHospitalConnection.findFirst({
    where: { id: connectionId, tenantId, status: 'pending' },
    include: { user: { select: { id: true, email: true } } },
  });

  if (!connection) throw AppError.notFound('Pending connection request not found');

  const patientId = await createPatientInTenant(connection.userId, connection.user.email, tenantId);

  return prisma.patientHospitalConnection.update({
    where: { id: connectionId },
    data: {
      status: 'approved',
      patientId,
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
    },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
      tenant: { select: { id: true, name: true } },
    },
  });
}

export async function rejectConnection(
  tenantId: string,
  connectionId: string,
  reviewerId: string,
  reason?: string,
) {
  const connection = await prisma.patientHospitalConnection.findFirst({
    where: { id: connectionId, tenantId, status: 'pending' },
  });

  if (!connection) throw AppError.notFound('Pending connection request not found');

  return prisma.patientHospitalConnection.update({
    where: { id: connectionId },
    data: {
      status: 'rejected',
      rejectionReason: reason,
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
    },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
      tenant: { select: { id: true, name: true } },
    },
  });
}

// ────────────────────────────────────────────────────────────
// Internal: Create patient record in a hospital tenant
// ────────────────────────────────────────────────────────────

async function createPatientInTenant(userId: string, email: string, tenantId: string): Promise<string> {
  // Check if patient already exists in this tenant by email
  const existingPatient = await prisma.patient.findFirst({
    where: { tenantId, email: { equals: email, mode: 'insensitive' } },
  });
  if (existingPatient) return existingPatient.id;

  // Get user info
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { firstName: true, lastName: true, email: true, phone: true },
  });
  if (!user) throw AppError.notFound('User not found');

  // ONE global MRN per person: reuse this user's existing MRN (any hospital) so
  // the number is the same everywhere; only mint a new one for a brand-new
  // person. Guard the per-tenant unique index against a legacy MRN collision.
  const existingMrn = await prisma.patient.findFirst({
    where: {
      OR: [{ userId }, ...(user.phone ? [{ phone: user.phone }] : [])],
      NOT: { mrn: { startsWith: 'TEMP-' } },
    },
    orderBy: { createdAt: 'asc' },
    select: { mrn: true },
  });
  let mrn = existingMrn?.mrn ?? null;
  if (mrn) {
    const clash = await prisma.patient.findFirst({ where: { tenantId, mrn }, select: { id: true } });
    if (clash) mrn = null;
  }
  if (!mrn) mrn = await generateMRN(tenantId);

  // Carry the person's details across, not just the account's.
  //
  // A User has no date of birth or gender, so a row built from the account
  // alone came out with dateOfBirth NULL — and the identity rule that decides
  // "these two rows are the same human" requires a date of birth on both. The
  // person therefore could not be recognised as themselves across hospitals:
  // two rows, same MRN, two entries in their switcher, and no way to merge
  // them. Copying from a row they already have is what makes the new one
  // recognisably the same person.
  const source = await prisma.patient.findFirst({
    where: { userId, NOT: { mrn: { startsWith: 'TEMP-' } } },
    orderBy: { createdAt: 'asc' },
    select: { dateOfBirth: true, gender: true, bloodGroup: true },
  });

  const patient = await prisma.patient.create({
    data: {
      tenantId,
      mrn,
      userId,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      dateOfBirth: source?.dateOfBirth ?? undefined,
      gender: source?.gender ?? undefined,
      bloodGroup: source?.bloodGroup ?? undefined,
      registrationSource: 'self_signup',
      patientType: 'outpatient',
    },
  });

  return patient.id;
}

// ────────────────────────────────────────────────────────────
// Patient Portal Data Queries (updated to use connections)
// ────────────────────────────────────────────────────────────

export async function getPatientProfile(userId: string, email: string) {
  const patients = await prisma.patient.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    include: {
      emergencyContacts: true,
      allergies: true,
      tenant: { select: { id: true, name: true, slug: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (patients.length === 0) return null;
  return patients[0];
}

export async function getPatientAppointments(
  userId: string,
  email: string,
  query: {
    status?: string;
    limit?: number;
    sortOrder?: 'asc' | 'desc';
    tenantId?: string;
    profileId?: string;
    /** Only appointments still to come — see the filter below. */
    upcoming?: boolean;
  },
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId, query.profileId);
  if (patientIds.length === 0) return { data: [] };

  const limit = query.limit || 50;
  const where: Record<string, unknown> = { patientId: { in: patientIds } };
  if (query.status) where.status = query.status;

  // "Upcoming" has to be resolved HERE, not by sorting and taking the first N.
  //
  // The portal dashboard asked for sortOrder=asc with limit=5, which returns
  // the five OLDEST appointments on record — so a patient with any history saw
  // visits from months ago under "Upcoming", and an appointment they had just
  // booked was nowhere, because it sorts last. There was no date filter to make
  // the sort mean what the caller intended.
  //
  // Cancelled / completed / no-show are excluded even when the date is still
  // ahead: a cancelled appointment next Tuesday is not something to turn up for.
  // Same rule the appointments LIST page applies, so the two agree.
  if (query.upcoming) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    where.appointmentDate = { gte: startOfToday };
    where.status = { notIn: ['completed', 'cancelled', 'no_show'] };
  }

  const appointments = await prisma.appointment.findMany({
    where,
    take: limit,
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, tenant: { select: { id: true, name: true } } } },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { appointmentDate: query.sortOrder || 'desc' },
  });

  return { data: appointments };
}

export async function getPatientLabReports(
  userId: string,
  email: string,
  query: { limit?: number; tenantId?: string; profileId?: string },
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId, query.profileId);
  if (patientIds.length === 0) return { data: [] };

  // Patients see published reports plus any corrected versions — the new
  // upload flow republishes immediately on correction (no re-sign step), so
  // "corrected" is the patient-visible "amended" state, not a draft.
  const reports = await prisma.labReport.findMany({
    where: { patientId: { in: patientIds }, status: { in: ['published', 'corrected'] } },
    take: query.limit || 50,
    include: {
      labOrder: {
        select: {
          id: true,
          status: true,
          labOrderItems: {
            select: {
              id: true,
              status: true,
              test: { select: { id: true, testName: true, testCode: true } },
              labResults: {
                where: { status: 'approved' },
                select: {
                  id: true,
                  parameterName: true,
                  value: true,
                  unit: true,
                  normalRange: true,
                  isAbnormal: true,
                  enteredAt: true,
                },
              },
            },
          },
        },
      },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, tenant: { select: { id: true, name: true } } } },
      attachments: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          category: true,
          fileName: true,
          fileUrl: true,
          mimeType: true,
          sizeBytes: true,
          description: true,
          createdAt: true,
          labOrderItemId: true,
        },
      },
    },
    orderBy: { publishedAt: 'desc' },
  });

  return { data: reports };
}

export async function getPatientImagingReports(
  userId: string,
  email: string,
  query: { limit?: number; tenantId?: string; profileId?: string },
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId, query.profileId);
  if (patientIds.length === 0) return { data: [] };

  // Patients only see published radiology reports — the radiology-admin-approved
  // final state. Draft / finalized results are still inside the radiology
  // review loop and stay hidden, mirroring how lab gates on published.
  const results = await prisma.imagingResult.findMany({
    where: { patientId: { in: patientIds }, status: 'published' },
    take: query.limit || 50,
    include: {
      imagingRequest: {
        select: {
          id: true,
          imagingType: true,
          bodyPart: true,
          urgency: true,
          clinicalIndication: true,
          scheduledAt: true,
          // Attachments are linked to the request (the canonical link the
          // doctor viewer also reads), so the patient sees the same files.
          attachments: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              category: true,
              fileName: true,
              fileUrl: true,
              mimeType: true,
              sizeBytes: true,
              description: true,
              createdAt: true,
            },
          },
        },
      },
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          tenant: { select: { id: true, name: true } },
        },
      },
      radiologist: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { signedAt: 'desc' },
  });

  return { data: results };
}

export async function getPatientPrescriptions(
  userId: string,
  email: string,
  query: { limit?: number; tenantId?: string; profileId?: string },
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId, query.profileId);
  if (patientIds.length === 0) return { data: [] };

  const prescriptions = await prisma.prescription.findMany({
    where: { patientId: { in: patientIds } },
    take: query.limit || 30,
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, tenant: { select: { id: true, name: true } } } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      prescriptionItems: true,
      visit: {
        include: {
          progressNotes: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, content: true, createdAt: true },
          },
          diagnoses: {
            select: { id: true, diagnosisName: true, icdCode: true, diagnosisType: true },
          },
          vitals: {
            orderBy: { recordedAt: 'desc' },
            take: 1,
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return { data: prescriptions };
}

/**
 * Open lab + imaging orders raised by the doctor against the patient's
 * visits. Surfaces a unified list so the patient knows which lab tests and
 * imaging studies they still need to come in for. Completed / cancelled
 * orders are filtered out — the patient sees results separately under
 * /patient-portal/lab-reports.
 */
export async function getPatientOpenOrders(
  userId: string,
  email: string,
  query: { tenantId?: string; profileId?: string; includeCompleted?: boolean },
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId, query.profileId);
  if (patientIds.length === 0) return { data: [] };

  // Orders the patient marked done themselves are still surfaced (with the
  // "Done — uploaded externally" state) so they can revisit / re-upload the
  // file — but tenant-internal completed orders (lab signed the report)
  // are hidden, since those live under /lab-reports.
  const labStatuses = query.includeCompleted
    ? undefined
    : ['ordered', 'sample_collected', 'in_progress'];
  const imagingStatuses = query.includeCompleted
    ? undefined
    : ['requested', 'scheduled', 'in_progress'];

  const [labOrders, imagingOrders] = await Promise.all([
    prisma.labOrder.findMany({
      where: {
        patientId: { in: patientIds },
        OR: [
          ...(labStatuses ? [{ status: { in: labStatuses as any } }] : []),
          { completedExternallyAt: { not: null } },
        ],
      },
      include: {
        labOrderItems: {
          select: {
            id: true,
            test: { select: { id: true, testName: true, testCode: true, sampleType: true } },
          },
        },
        orderer: { select: { firstName: true, lastName: true } },
        patient: {
          select: {
            id: true,
            mrn: true,
            firstName: true,
            lastName: true,
            tenant: { select: { id: true, name: true, phone: true, address: true } },
          },
        },
        // When the lab has signed a report, surface it alongside the order so
        // the patient can pull the file directly — otherwise show their own
        // upload (externalReportUrl) when they self-completed.
        labReport: {
          select: { id: true, status: true, pdfUrl: true, publishedAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.imagingRequest.findMany({
      where: {
        patientId: { in: patientIds },
        OR: [
          ...(imagingStatuses ? [{ status: { in: imagingStatuses as any } }] : []),
          { completedExternallyAt: { not: null } },
        ],
      },
      include: {
        orderer: { select: { firstName: true, lastName: true } },
        patient: {
          select: {
            id: true,
            mrn: true,
            firstName: true,
            lastName: true,
            tenant: { select: { id: true, name: true, phone: true, address: true } },
          },
        },
        imagingResult: {
          select: { id: true, status: true, pdfReportUrl: true, signedAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  const labRows = labOrders.map((o) => ({
    orderType: 'lab' as const,
    id: o.id,
    orderNumber: o.id.slice(0, 8).toUpperCase(),
    status: o.status,
    urgency: o.urgency,
    notes: o.notes ?? null,
    description:
      o.labOrderItems.map((it) => it.test?.testName).filter(Boolean).join(', ') || 'Lab order',
    sampleTypes: Array.from(
      new Set(o.labOrderItems.map((it) => it.test?.sampleType).filter(Boolean)),
    ) as string[],
    items: o.labOrderItems.map((it) => ({
      id: it.id,
      testName: it.test?.testName ?? 'Test',
      testCode: it.test?.testCode ?? null,
    })),
    orderedBy: o.orderer ? `${o.orderer.firstName} ${o.orderer.lastName ?? ''}`.trim() : null,
    createdAt: o.createdAt,
    patient: o.patient,
    completedExternallyAt: o.completedExternallyAt ?? null,
    externalReportUrl: o.externalReportUrl ?? null,
    externalNotes: o.externalNotes ?? null,
    reportUrl: (o as any).labReport?.pdfUrl ?? null,
    reportStatus: (o as any).labReport?.status ?? null,
  }));

  const imagingRows = imagingOrders.map((o) => ({
    orderType: 'imaging' as const,
    id: o.id,
    orderNumber: o.id.slice(0, 8).toUpperCase(),
    status: o.status,
    urgency: o.urgency,
    notes: o.notes ?? null,
    description: `${o.imagingType}${o.bodyPart ? ' — ' + o.bodyPart : ''}`,
    imagingType: o.imagingType,
    bodyPart: o.bodyPart ?? null,
    clinicalIndication: o.clinicalIndication ?? null,
    scheduledAt: o.scheduledAt ?? null,
    items: [] as { id: string; testName: string; testCode: string | null }[],
    sampleTypes: [] as string[],
    orderedBy: o.orderer ? `${o.orderer.firstName} ${o.orderer.lastName ?? ''}`.trim() : null,
    createdAt: o.createdAt,
    patient: o.patient,
    completedExternallyAt: o.completedExternallyAt ?? null,
    externalReportUrl: o.externalReportUrl ?? null,
    externalNotes: o.externalNotes ?? null,
    reportUrl: (o as any).imagingResult?.pdfReportUrl ?? null,
    reportStatus: (o as any).imagingResult?.status ?? null,
  }));

  const merged = [...labRows, ...imagingRows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );

  return { data: merged };
}

/**
 * Patient marks one of their pending lab / imaging orders as "done externally"
 * — usually because they had the test performed at another facility. The
 * order's status flips to `completed` so it disappears from the lab /
 * radiology worklist, but a "completed externally" marker stays on the row
 * so the doctor + nurse see that the patient handled it (and can open the
 * uploaded report).
 *
 * Bypasses the orderer / clinician permission check because patient
 * portal users can only touch orders for patient records they own.
 */
export async function markPatientOrderDoneExternally(
  userId: string,
  email: string,
  params: {
    orderType: 'lab' | 'imaging';
    orderId: string;
    file?: Express.Multer.File;
    notes?: string;
  },
) {
  const patientIds = await resolvePatientIds(userId, email);
  if (patientIds.length === 0) throw AppError.notFound('No patient profile linked to this account');

  const fileUrl = params.file ? `/uploads/${params.file.filename}` : null;
  const now = new Date();

  if (params.orderType === 'lab') {
    const order = await prisma.labOrder.findFirst({
      where: { id: params.orderId, patientId: { in: patientIds } },
      select: { id: true, status: true },
    });
    if (!order) throw AppError.notFound('Lab order not found');
    if (order.status === 'cancelled') {
      throw AppError.badRequest('This order has already been cancelled');
    }

    return prisma.labOrder.update({
      where: { id: order.id },
      data: {
        status: 'completed',
        completedExternallyAt: now,
        completedExternallyBy: userId,
        externalReportUrl: fileUrl ?? undefined,
        externalNotes: params.notes ?? undefined,
      },
      select: {
        id: true,
        status: true,
        completedExternallyAt: true,
        externalReportUrl: true,
        externalNotes: true,
      },
    });
  }

  const imaging = await prisma.imagingRequest.findFirst({
    where: { id: params.orderId, patientId: { in: patientIds } },
    select: { id: true, status: true },
  });
  if (!imaging) throw AppError.notFound('Imaging request not found');
  if (imaging.status === 'cancelled') {
    throw AppError.badRequest('This request has already been cancelled');
  }

  return prisma.imagingRequest.update({
    where: { id: imaging.id },
    data: {
      status: 'completed',
      completedAt: now,
      completedExternallyAt: now,
      completedExternallyBy: userId,
      externalReportUrl: fileUrl ?? undefined,
      externalNotes: params.notes ?? undefined,
    },
    select: {
      id: true,
      status: true,
      completedExternallyAt: true,
      externalReportUrl: true,
      externalNotes: true,
    },
  });
}

// ── Patient-uploaded miscellaneous documents ────────────────

export async function listMyDocuments(userId: string, email: string, tenantId?: string) {
  const ids = await resolvePatientIds(userId, email, tenantId);
  if (ids.length === 0) return [];
  return prisma.patientDocument.findMany({
    where: { patientId: { in: ids } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createMyDocument(
  userId: string,
  email: string,
  file: Express.Multer.File,
  data: { title?: string; documentType?: string; notes?: string },
  tenantId?: string,
) {
  const patientId = await resolvePrimaryPatientId(userId, email, tenantId);
  if (!patientId) throw new Error('No patient record found');
  const fileUrl = `/uploads/${file.filename}`;
  return prisma.patientDocument.create({
    data: {
      patientId,
      documentType: (data.documentType as any) || 'other',
      title: data.title || file.originalname,
      fileUrl,
      fileSizeBytes: BigInt(file.size),
      mimeType: file.mimetype,
      uploadedBy: userId,
      notes: data.notes,
    },
  });
}

export async function deleteMyDocument(userId: string, email: string, id: string) {
  const ids = await resolvePatientIds(userId, email);
  const doc = await prisma.patientDocument.findFirst({ where: { id, patientId: { in: ids } } });
  if (!doc) throw new Error('Document not found');
  await prisma.patientDocument.delete({ where: { id } });
}

// Current medications — patient view (read-only, combined derived + manual)
export async function listMyCurrentMedications(userId: string, email: string, tenantId?: string) {
  const patientId = await resolvePrimaryPatientId(userId, email, tenantId);
  if (!patientId) return { derived: [], manual: [] };
  const { getAllCurrentMedications } = await import('../medical-history/medical-history.service');
  return getAllCurrentMedications(patientId, tenantId);
}

// ── Medical history (patient-facing) ────────────────────────
// When a patient is linked to multiple tenants they may have multiple patient records.
// For personal history we use the most recently updated one (single record per patient).
// For family history & allergies we aggregate across all linked records, tagging by tenant.

/**
 * The patient record the portal writes to.
 *
 * `resolvePatientIds` builds its result from an unordered Set, so `ids[0]` was
 * effectively arbitrary and could differ between two requests from the same
 * user — the portal could read one record and write another, which is why a
 * doctor's edit sometimes never appeared to the patient (and vice versa) for
 * anyone holding more than one patient row.
 *
 * Deterministic order: the record that already carries personal history wins,
 * then the most recently updated, then the oldest by id as a stable tiebreak.
 */
async function resolvePrimaryPatientId(userId: string, email: string, tenantId?: string) {
  const ids = await resolvePatientIds(userId, email, tenantId);
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];

  const withHistory = await prisma.patientPersonalHistory.findMany({
    where: { patientId: { in: ids } },
    select: { patientId: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (withHistory.length > 0) return withHistory[0].patientId;

  const rows = await prisma.patient.findMany({
    where: { id: { in: ids } },
    select: { id: true },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
  });
  return rows[0]?.id ?? ids[0];
}

/**
 * Every patient row belonging to the portal user's own person — the union of
 * the rows their account owns and the rows the clinical side considers the
 * same human. Used to authorise edits to entries that may have been filed
 * against a different hospital's record.
 */
async function resolveMyPersonPatientIds(userId: string, email: string) {
  const owned = await resolvePatientIds(userId, email);
  if (owned.length === 0) return [];
  const { resolvePersonPatientIds } = await import('../../shared/patient-identity');
  const sets = await Promise.all(owned.map((id) => resolvePersonPatientIds(id)));
  return Array.from(new Set(sets.flat()));
}

export async function getMyPersonalHistory(userId: string, email: string, tenantId?: string) {
  const patientId = await resolvePrimaryPatientId(userId, email, tenantId);
  if (!patientId) return null;
  // Delegate to the clinical service so the portal and the doctor resolve the
  // SAME person and read the SAME record — the two must never disagree.
  const { getPersonalHistory } = await import('../medical-history/medical-history.service');
  return getPersonalHistory(patientId);
}

export async function upsertMyPersonalHistory(userId: string, email: string, data: any, tenantId?: string) {
  const patientId = await resolvePrimaryPatientId(userId, email, tenantId);
  if (!patientId) throw new Error('No patient record found');
  const { upsertPersonalHistory } = await import('../medical-history/medical-history.service');
  return upsertPersonalHistory(patientId, userId, data);
}

export async function listMyFamilyHistory(userId: string, email: string, tenantId?: string) {
  const patientId = await resolvePrimaryPatientId(userId, email, tenantId);
  if (!patientId) return [];
  const { listFamilyHistory } = await import('../medical-history/medical-history.service');
  return listFamilyHistory(patientId);
}

export async function createMyFamilyHistory(userId: string, email: string, data: any, tenantId?: string) {
  const patientId = await resolvePrimaryPatientId(userId, email, tenantId);
  if (!patientId) throw new Error('No patient record found');
  const { createFamilyHistory } = await import('../medical-history/medical-history.service');
  return createFamilyHistory(patientId, userId, data);
}

export async function updateMyFamilyHistory(userId: string, email: string, id: string, data: any) {
  const ids = await resolveMyPersonPatientIds(userId, email);
  if (ids.length === 0) throw new Error('No patient record found');
  const entry = await prisma.patientFamilyHistory.findFirst({ where: { id, patientId: { in: ids } } });
  if (!entry) throw new Error('Family history entry not found');
  const { updateFamilyHistory } = await import('../medical-history/medical-history.service');
  return updateFamilyHistory(entry.patientId, userId, id, data);
}

export async function deleteMyFamilyHistory(userId: string, email: string, id: string) {
  const ids = await resolveMyPersonPatientIds(userId, email);
  if (ids.length === 0) throw new Error('No patient record found');
  const entry = await prisma.patientFamilyHistory.findFirst({ where: { id, patientId: { in: ids } } });
  if (!entry) throw new Error('Family history entry not found');
  const { deleteFamilyHistory } = await import('../medical-history/medical-history.service');
  return deleteFamilyHistory(entry.patientId, id);
}

export async function listMyAllergies(userId: string, email: string, tenantId?: string) {
  const patientId = await resolvePrimaryPatientId(userId, email, tenantId);
  if (!patientId) return [];
  const { listAllergies } = await import('../medical-history/medical-history.service');
  return listAllergies(patientId);
}

export async function createMyAllergy(userId: string, email: string, data: any, tenantId?: string) {
  const patientId = await resolvePrimaryPatientId(userId, email, tenantId);
  if (!patientId) throw new Error('No patient record found');
  const { createAllergy } = await import('../medical-history/medical-history.service');
  return createAllergy(patientId, userId, data);
}

export async function updateMyAllergy(userId: string, email: string, id: string, data: any) {
  const ids = await resolveMyPersonPatientIds(userId, email);
  const entry = await prisma.patientAllergy.findFirst({ where: { id, patientId: { in: ids } } });
  if (!entry) throw new Error('Allergy not found');
  const { updateAllergy } = await import('../medical-history/medical-history.service');
  return updateAllergy(entry.patientId, id, data);
}

export async function deleteMyAllergy(userId: string, email: string, id: string) {
  const ids = await resolveMyPersonPatientIds(userId, email);
  const entry = await prisma.patientAllergy.findFirst({ where: { id, patientId: { in: ids } } });
  if (!entry) throw new Error('Allergy not found');
  const { deleteAllergy } = await import('../medical-history/medical-history.service');
  return deleteAllergy(entry.patientId, id);
}

export async function getPatientDischargeSummaries(userId: string, email: string) {
  const patientIds = await resolvePatientIds(userId, email);
  const { getPublishedDischargeSummariesForPatients } = await import('../mrd/mrd.service');
  return getPublishedDischargeSummariesForPatients(patientIds);
}

// ────────────────────────────────────────────────────────────
// Consultation Summaries
//
// The OP-flow analogue of discharge summaries — composed from per-section pins
// the doctor flagged inside the consultation form, finalized via the standard
// /progress-notes/:id/sign endpoint. Only finalized (signed) notes are exposed
// to the patient; active drafts stay private until the doctor signs.
// ────────────────────────────────────────────────────────────

export async function getPatientConsultationSummaries(
  userId: string,
  email: string,
  query: { tenantId?: string; profileId?: string } = {},
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId, query.profileId);
  if (patientIds.length === 0) return [];

  const notes = await prisma.progressNote.findMany({
    where: {
      patientId: { in: patientIds },
      // Unsigned notes are included too. A note is written when the doctor
      // ENDS the consultation — the in-progress draft lives in the browser,
      // not here — so an unsigned note is a finished consultation waiting on
      // a signature, not a half-written one. Withholding it left the patient
      // with nothing to read while the signature sat outstanding, which on
      // this database was almost every consultation. The caller marks these
      // as awaiting sign-off rather than presenting them as final.
      status: { in: ['finalized', 'active', 'archived'] },
      // Every signed consultation note belongs to the patient — it is their
      // record of the visit. Requiring at least one pinned section meant a
      // perfectly ordinary consultation, written up and signed but with nothing
      // pinned, never appeared at all; the patient saw an empty list and
      // concluded the visit had not been documented.
      //
      // IP ward rounds are excluded (they live under /discharge-summaries) —
      // those carry an admissionId, an OP consultation does not.
      admissionId: null,
    },
    // Not signedAt — null on an unsigned note, which would bury the most
    // recent consultations at the bottom of the patient's list.
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      doctor: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          tenant: { select: { id: true, name: true } },
        },
      },
      signer: { select: { id: true, firstName: true, lastName: true } },
      pins: true,
      visit: {
        select: {
          id: true,
          visitDate: true,
          chiefComplaint: true,
          diagnoses: { select: { id: true, diagnosisName: true } },
        },
      },
    },
  });

  return notes;
}

export async function getPatientConsultationSummaryById(
  userId: string,
  email: string,
  id: string,
) {
  const patientIds = await resolvePatientIds(userId, email);
  // The whole consultation, not a digest of it: the doctor's note and SOAP
  // sections, what was diagnosed, the vitals taken, and the medicines
  // prescribed at that visit. The portal used to render pinned highlights only,
  // so a patient could open a consultation and be shown nothing.
  const note = await prisma.progressNote.findFirst({
    where: {
      id,
      patientId: { in: patientIds },
      // Matches the list: an unsigned consultation is readable, and marked.
      status: { in: ['finalized', 'active', 'archived'] },
    },
    include: {
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      },
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          tenant: { select: { id: true, name: true } },
        },
      },
      signer: { select: { id: true, firstName: true, lastName: true } },
      pins: true,
      visit: {
        select: {
          id: true,
          visitType: true,
          visitDate: true,
          chiefComplaint: true,
          diagnoses: {
            select: { id: true, diagnosisName: true, icdCode: true, diagnosisType: true },
          },
          vitals: { orderBy: { recordedAt: 'desc' }, take: 1 },
          prescriptions: {
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              status: true,
              notes: true,
              followUpDate: true,
              createdAt: true,
              prescriptionItems: {
                select: {
                  id: true,
                  drugName: true,
                  dosage: true,
                  frequency: true,
                  duration: true,
                  route: true,
                  instructions: true,
                  isPrn: true,
                  quantity: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!note) {
    throw AppError.notFound('Consultation summary not found');
  }
  return note;
}

export async function getPatientDischargeSummaryById(userId: string, email: string, id: string) {
  const patientIds = await resolvePatientIds(userId, email);
  const { getPublishedDischargeSummaryForPatient } = await import('../mrd/mrd.service');
  return getPublishedDischargeSummaryForPatient(patientIds, id);
}

// ────────────────────────────────────────────────────────────
// Hospitalizations (IP admissions) — the patient's own in-patient stays with
// all their details: admission info, diagnoses, vitals, medications,
// procedures, the IP bill and (once published) the discharge summary.
// Everything is scoped to the patient's own records via resolvePatientIds.
// ────────────────────────────────────────────────────────────

const daysBetween = (start: Date, end: Date | null): number => {
  const from = new Date(start).getTime();
  const to = (end ? new Date(end) : new Date()).getTime();
  return Math.max(0, Math.round((to - from) / 86_400_000));
};

const drName = (u?: { firstName?: string | null; lastName?: string | null } | null): string | null =>
  u ? `Dr. ${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() : null;

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function getPatientAdmissions(
  userId: string,
  email: string,
  query: { tenantId?: string; profileId?: string } = {},
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId, query.profileId);
  if (patientIds.length === 0) return { data: [] };

  const admissions = await prisma.admission.findMany({
    where: { patientId: { in: patientIds } },
    orderBy: { admissionDate: 'desc' },
    take: 50,
    include: {
      tenant: { select: { id: true, name: true } },
      ward: { select: { name: true } },
      bed: { select: { bedNumber: true } },
      doctor: { select: { specialization: true, user: { select: { firstName: true, lastName: true } } } },
      dischargeSummary: { select: { id: true, status: true } },
      visit: { select: { diagnoses: { select: { diagnosisName: true, diagnosisType: true } } } },
    },
  });

  return {
    data: admissions.map((a) => {
      const dx = a.visit?.diagnoses ?? [];
      const primary = dx.find((d) => d.diagnosisType === 'primary')?.diagnosisName ?? dx[0]?.diagnosisName ?? null;
      return {
        id: a.id,
        status: a.status,
        admissionDate: a.admissionDate,
        dischargeDate: a.dischargeDate,
        expectedDischargeDate: a.expectedDischargeDate,
        lengthOfStayDays: daysBetween(a.admissionDate, a.dischargeDate),
        admissionReason: a.admissionReason,
        ward: a.ward?.name ?? null,
        bed: a.bed?.bedNumber ?? null,
        hospital: a.tenant?.name ?? null,
        doctor: drName(a.doctor?.user),
        specialization: a.doctor?.specialization ?? null,
        primaryDiagnosis: primary,
        // Only surface the discharge summary once the doctor has PUBLISHED it.
        dischargeSummaryId: a.dischargeSummary?.status === 'published' ? a.dischargeSummary.id : null,
      };
    }),
  };
}

export async function getPatientAdmissionDetail(userId: string, email: string, admissionId: string) {
  const patientIds = await resolvePatientIds(userId, email);
  if (patientIds.length === 0) throw AppError.notFound('Admission not found');

  const a = await prisma.admission.findFirst({
    where: { id: admissionId, patientId: { in: patientIds } },
    include: {
      tenant: { select: { id: true, name: true } },
      ward: { select: { name: true } },
      bed: { select: { bedNumber: true } },
      doctor: { select: { specialization: true, user: { select: { firstName: true, lastName: true } } } },
      patient: { select: { mrn: true, firstName: true, lastName: true, dateOfBirth: true, gender: true, bloodGroup: true } },
      dischargeSummary: { select: { id: true, status: true } },
      visit: {
        select: {
          id: true,
          chiefComplaint: true,
          diagnoses: {
            orderBy: { diagnosedAt: 'asc' },
            select: { diagnosisName: true, diagnosisType: true, icdCode: true },
          },
          vitals: {
            where: { isCorrection: false },
            orderBy: { recordedAt: 'asc' },
            select: {
              recordedAt: true, bloodPressureSystolic: true, bloodPressureDiastolic: true, pulseRate: true,
              temperature: true, respiratoryRate: true, oxygenSaturation: true, weightKg: true, heightCm: true, bmi: true, bloodSugar: true,
            },
          },
          prescriptions: {
            where: { status: { not: 'cancelled' } },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true, createdAt: true, notes: true, status: true, followUpDate: true,
              doctor: { select: { user: { select: { firstName: true, lastName: true } } } },
              prescriptionItems: { select: { drugName: true, dosage: true, frequency: true, duration: true, route: true, instructions: true, isPrn: true } },
            },
          },
        },
      },
      clinicalProcedures: {
        orderBy: { performedAt: 'desc' },
        select: { procedureType: true, procedureSubtype: true, performedAt: true, status: true, site: true },
      },
      bills: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, billNumber: true, status: true, totalAmount: true, amountPaid: true, balanceDue: true,
          billItems: { select: { description: true, quantity: true, totalAmount: true } },
        },
      },
    },
  });
  if (!a) throw AppError.notFound('Admission not found');

  const bills = a.bills.map((b) => ({
    id: b.id,
    billNumber: b.billNumber,
    status: b.status,
    total: Number(b.totalAmount),
    paid: Number(b.amountPaid),
    balance: Number(b.balanceDue),
    items: b.billItems.map((it) => ({ description: it.description, quantity: it.quantity, amount: Number(it.totalAmount) })),
  }));

  return {
    id: a.id,
    status: a.status,
    hospital: a.tenant?.name ?? null,
    patient: {
      name: fullName(a.patient),
      mrn: a.patient.mrn,
      dateOfBirth: a.patient.dateOfBirth,
      gender: a.patient.gender,
      bloodGroup: a.patient.bloodGroup,
    },
    admission: {
      admissionDate: a.admissionDate,
      dischargeDate: a.dischargeDate,
      expectedDischargeDate: a.expectedDischargeDate,
      lengthOfStayDays: daysBetween(a.admissionDate, a.dischargeDate),
      ward: a.ward?.name ?? null,
      bed: a.bed?.bedNumber ?? null,
      reason: a.admissionReason,
      chiefComplaint: a.visit?.chiefComplaint ?? null,
      doctor: drName(a.doctor?.user),
      specialization: a.doctor?.specialization ?? null,
    },
    diagnoses: (a.visit?.diagnoses ?? []).map((d) => ({ name: d.diagnosisName, type: d.diagnosisType, icdCode: d.icdCode })),
    vitals: (a.visit?.vitals ?? []).map((v) => ({
      recordedAt: v.recordedAt,
      bp: v.bloodPressureSystolic != null && v.bloodPressureDiastolic != null ? `${v.bloodPressureSystolic}/${v.bloodPressureDiastolic}` : null,
      pulse: v.pulseRate,
      temp: numOrNull(v.temperature),
      rr: v.respiratoryRate,
      spo2: numOrNull(v.oxygenSaturation),
      weight: numOrNull(v.weightKg),
      height: numOrNull(v.heightCm),
      bmi: numOrNull(v.bmi),
      sugar: numOrNull(v.bloodSugar),
    })),
    medications: (a.visit?.prescriptions ?? []).map((rx) => ({
      id: rx.id,
      prescribedAt: rx.createdAt,
      status: rx.status,
      notes: rx.notes,
      followUpDate: rx.followUpDate,
      doctor: drName(rx.doctor?.user),
      items: rx.prescriptionItems.map((it) => ({
        drug: it.drugName, dosage: it.dosage, frequency: it.frequency, duration: it.duration, route: it.route, instructions: it.instructions, isPrn: it.isPrn,
      })),
    })),
    procedures: a.clinicalProcedures.map((p) => ({
      name: [p.procedureType, p.procedureSubtype].filter(Boolean).join(' — '),
      site: p.site,
      at: p.performedAt,
      status: p.status,
    })),
    billing: {
      deposit: Number(a.depositAmount),
      total: bills.reduce((s, b) => s + b.total, 0),
      paid: bills.reduce((s, b) => s + b.paid, 0),
      balance: bills.reduce((s, b) => s + b.balance, 0),
      bills,
    },
    dischargeSummaryId: a.dischargeSummary?.status === 'published' ? a.dischargeSummary.id : null,
  };
}

export async function getPatientDrugHistory(
  userId: string,
  email: string,
  query: { tenantId?: string; profileId?: string },
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId, query.profileId);
  const { buildDrugHistory } = await import('../prescriptions/drug-history.service');
  return buildDrugHistory({ patientIds, tenantId: query.tenantId, limit: 200 });
}

export async function getPatientFollowUps(
  userId: string,
  email: string,
  query: { limit?: number; tenantId?: string; profileId?: string },
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId, query.profileId);
  if (patientIds.length === 0) return { data: [] };

  const prescriptions = await prisma.prescription.findMany({
    where: {
      patientId: { in: patientIds },
      OR: [
        { followUpDate: { not: null } },
        { notes: { contains: 'follow-up', mode: 'insensitive' } },
      ],
    },
    take: query.limit || 50,
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, tenant: { select: { id: true, name: true } } } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const followUps = prescriptions
    .map((rx) => {
      let followUpDate: string | null = null;
      let durationText = '';
      let followUpNotes = '';

      // Prefer structured field over notes parsing
      if (rx.followUpDate) {
        followUpDate = new Date(rx.followUpDate).toISOString().split('T')[0];
        followUpNotes = rx.notes || '';
      } else if (rx.notes && /follow-up:/i.test(rx.notes)) {
        const match = rx.notes.match(/Follow-up:\s*(.+)/i);
        if (match) {
          const parts = match[1].split('—').map((s: string) => s.trim());
          for (const part of parts) {
            const dateMatch = part.match(/(\d{1,2}\s+\w+\s+\d{4}|\d{4}-\d{2}-\d{2})/);
            if (dateMatch) {
              const parsed = new Date(dateMatch[1]);
              if (!isNaN(parsed.getTime())) {
                followUpDate = parsed.toISOString().split('T')[0];
              }
            } else if (/^after\s/i.test(part)) {
              durationText = part;
            } else if (part) {
              followUpNotes = part;
            }
          }
        }
      }

      if (!followUpDate) return null;

      return {
        id: rx.id,
        prescriptionId: rx.id,
        followUpDate,
        durationText,
        notes: followUpNotes,
        prescriptionDate: rx.createdAt,
        // Fields required by /patient-portal/book-appointment for direct booking
        tenantId: rx.patient?.tenant?.id ?? null,
        doctorId: rx.doctorId,
        doctor: rx.doctor,
        patient: rx.patient,
      };
    })
    .filter(Boolean);

  return { data: followUps };
}

export async function getPatientBills(
  userId: string,
  email: string,
  query: { limit?: number; tenantId?: string; profileId?: string },
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId, query.profileId);
  if (patientIds.length === 0) return { data: [] };

  const bills = await prisma.bill.findMany({
    where: { patientId: { in: patientIds } },
    take: query.limit || 30,
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, tenant: { select: { id: true, name: true } } } },
      billItems: { select: { id: true, description: true, totalAmount: true } },
      payments: { select: { id: true, amount: true, paymentMethod: true, status: true, paymentDate: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return { data: bills };
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/** Convert HH:MM string to a Date object for @db.Time columns */
function timeToDate(time: string): Date {
  const [h, m] = time.split(':').map(Number);
  return new Date(`1970-01-01T${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:00.000Z`);
}

// ────────────────────────────────────────────────────────────
// Appointment Booking (Patient Side)
// ────────────────────────────────────────────────────────────

/**
 * List all active hospitals for patient to book appointments.
 */
export async function getAllHospitalsForBooking(
  query: { search?: string; page?: number; limit?: number } = {},
) {
  const limit = query.limit || 10;
  const page = query.page || 1;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {
    slug: { not: '__platform__' },
    isActive: true,
  };

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { city: { contains: query.search, mode: 'insensitive' } },
      { state: { contains: query.search, mode: 'insensitive' } },
      { address: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [hospitals, total] = await Promise.all([
    prisma.tenant.findMany({
      where,
      skip,
      take: limit,
      select: {
        id: true,
        name: true,
        slug: true,
        hospitalCode: true,
        logoUrl: true,
        city: true,
        state: true,
        address: true,
        phone: true,
        email: true,
      },
      orderBy: { name: 'asc' },
    }),
    prisma.tenant.count({ where }),
  ]);

  return { data: hospitals, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
}

/**
 * List doctors available in a hospital for the patient to book with.
 * No connection required — open booking.
 *
 * If users with the "doctor" role exist but lack a DoctorProfile row,
 * a profile is auto-created so they appear in booking and downstream
 * slot / appointment flows work (Appointment.doctorId → DoctorProfile).
 */
export async function getDoctorsForBooking(
  userId: string,
  tenantId: string,
  query: { departmentId?: string; search?: string },
) {
  // ── Auto-create missing DoctorProfile rows ──────────────────
  const doctorUsersWithoutProfile = await prisma.user.findMany({
    where: {
      tenantId,
      isActive: true,
      userRoles: { some: { role: { name: 'doctor' } } },
      doctorProfile: null,
    },
    select: { id: true },
  });

  if (doctorUsersWithoutProfile.length > 0) {
    // Ensure at least one department exists for the tenant
    let defaultDept = await prisma.department.findFirst({
      where: { tenantId, isActive: true },
      select: { id: true },
    });
    if (!defaultDept) {
      defaultDept = await prisma.department.create({
        data: { tenantId, name: 'General', isActive: true },
        select: { id: true },
      });
    }

    for (const u of doctorUsersWithoutProfile) {
      await prisma.doctorProfile.create({
        data: {
          userId: u.id,
          tenantId,
          departmentId: defaultDept.id,
          isAvailable: true,
        },
      });
    }
  }

  // ── Query DoctorProfile as before ───────────────────────────
  const where: Record<string, unknown> = { tenantId, isAvailable: true };
  if (query.departmentId) where.departmentId = query.departmentId;
  if (query.search) {
    where.OR = [
      { specialization: { contains: query.search, mode: 'insensitive' } },
      { user: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { user: { lastName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const horizon = new Date(today);
  horizon.setUTCDate(horizon.getUTCDate() + 90);

  const doctors = await prisma.doctorProfile.findMany({
    where,
    take: 50,
    include: {
      user: { select: { firstName: true, lastName: true } },
      department: { select: { id: true, name: true } },
      schedules: { where: { isActive: true }, orderBy: { dayOfWeek: 'asc' } },
      scheduleOverrides: {
        where: { date: { gte: today, lte: horizon } },
        select: { date: true, isDayOff: true, shifts: { select: { id: true } } },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const toDateStr = (d: Date) => {
    const y = d.getUTCFullYear();
    const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = d.getUTCDate().toString().padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  return {
    data: doctors.map((d) => {
      const workingOverrides = d.scheduleOverrides.filter(
        (o) => !o.isDayOff && o.shifts.length > 0,
      );
      const blockedOverrideDates = d.scheduleOverrides
        .filter((o) => o.isDayOff)
        .map((o) => toDateStr(o.date as Date));
      const extraDates = workingOverrides.map((o) => toDateStr(o.date as Date));
      return {
        id: d.id,
        userId: d.userId,
        firstName: d.user.firstName,
        lastName: d.user.lastName,
        specialization: d.specialization,
        qualifications: d.qualifications,
        consultationFee: d.consultationFee ? Number(d.consultationFee) : null,
        experienceYears: d.experienceYears,
        department: d.department,
        availableDays: [...new Set(d.schedules.map((s) => s.dayOfWeek))],
        /** Future override dates (YYYY-MM-DD) where the doctor is available even if dayOfWeek is not. */
        extraAvailableDates: extraDates,
        /** Future override dates (YYYY-MM-DD) where the doctor is marked off, overriding weekly availability. */
        blockedDates: blockedOverrideDates,
      };
    }),
  };
}

/**
 * Get available time slots for a doctor on a given date (patient-facing).
 *
 * Delegates to the unified appointments-service slot generator so patients see
 * the exact same view as admin / doctor: date-specific DoctorScheduleOverride
 * (monthly calendar edits) takes precedence over the weekly recurring schedule,
 * with correct handling of multiple shifts per day and partial/full leaves.
 */
export async function getDoctorSlotsForPatient(
  _userId: string,
  tenantId: string,
  doctorId: string,
  date: string,
) {
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: doctorId, tenantId, isAvailable: true },
    select: { id: true },
  });
  if (!doctor) throw AppError.notFound('Doctor not found');

  const targetDate = new Date(date);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  targetDate.setUTCHours(0, 0, 0, 0);
  if (targetDate < today) {
    return { date, doctorId, slots: [], message: 'Cannot view slots for past dates' };
  }

  return getAvailableSlots(tenantId, doctorId, date);
}

/**
 * Book an appointment as a patient.
 */
/**
 * Who at the hospital needs to know a patient booked or cancelled online. The
 * desk takes payment and checks the patient in; admin sees the day's list.
 */
const PORTAL_APPOINTMENT_DESK_ROLES = ['front_desk', 'admin'];

type NamedPatient = { firstName: string; lastName?: string | null; mrn?: string | null } | null | undefined;
type NamedDoctor = { user?: { firstName?: string | null; lastName?: string | null } | null } | null | undefined;

function patientLabel(p: NamedPatient): string {
  if (!p) return 'A patient';
  const name = `${p.firstName} ${p.lastName ?? ''}`.trim();
  return p.mrn ? `${name} (${p.mrn})` : name;
}

function doctorLabel(d: NamedDoctor): string {
  const u = d?.user;
  if (!u) return 'the doctor';
  return `Dr. ${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();
}

export async function bookAppointmentAsPatient(
  userId: string,
  email: string,
  tenantId: string,
  data: { doctorId: string; appointmentDate: string; startTime: string; endTime: string; reason?: string },
) {
  // Verify hospital exists
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, isActive: true, slug: true },
  });
  if (!tenant || !tenant.isActive || tenant.slug === '__platform__') {
    throw AppError.notFound('Hospital not found');
  }

  // Auto-create connection + patient record if not exists
  let connection = await prisma.patientHospitalConnection.findUnique({
    where: { userId_tenantId: { userId, tenantId } },
  });

  if (!connection) {
    // Create patient record and approved connection automatically
    const patientId = await createPatientInTenant(userId, email, tenantId);
    connection = await prisma.patientHospitalConnection.create({
      data: { userId, tenantId, status: 'approved', patientId },
    });
  } else if (connection.status !== 'approved' || !connection.patientId) {
    // Upgrade existing connection to approved
    const patientId = connection.patientId || await createPatientInTenant(userId, email, tenantId);
    connection = await prisma.patientHospitalConnection.update({
      where: { id: connection.id },
      data: { status: 'approved', patientId },
    });
  }

  const patientId = connection.patientId!;

  // Verify doctor
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: data.doctorId, tenantId, isAvailable: true },
  });
  if (!doctor) throw AppError.notFound('Doctor not found or unavailable');

  const appointmentDate = new Date(data.appointmentDate);
  appointmentDate.setUTCHours(0, 0, 0, 0);

  // Prevent booking in the past
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (appointmentDate < today) {
    throw AppError.badRequest('Cannot book an appointment in the past');
  }

  // Check leave — only approved leaves block bookings. Supports multi-day ranges
  // (leaveDate..endDate) and partial-day leaves (only overlap blocks the slot).
  const approvedLeaves = await prisma.doctorLeave.findMany({
    where: {
      doctorId: data.doctorId,
      status: 'approved',
      leaveDate: { lte: appointmentDate },
      OR: [
        { endDate: null, leaveDate: appointmentDate },
        { endDate: { gte: appointmentDate } },
      ],
    },
  });
  const fullDayLeave = approvedLeaves.find((l) => !l.startTime && !l.endTime);
  if (fullDayLeave) {
    throw AppError.badRequest('Doctor is on leave on the selected date');
  }
  const slotStartMin = parseInt(data.startTime.slice(0, 2)) * 60 + parseInt(data.startTime.slice(3, 5));
  const slotEndMin = parseInt(data.endTime.slice(0, 2)) * 60 + parseInt(data.endTime.slice(3, 5));
  const partialLeaveOverlap = approvedLeaves.some((l) => {
    if (!l.startTime || !l.endTime) return false;
    const ls = l.startTime as Date;
    const le = l.endTime as Date;
    const lStart = ls.getUTCHours() * 60 + ls.getUTCMinutes();
    const lEnd = le.getUTCHours() * 60 + le.getUTCMinutes();
    return slotStartMin < lEnd && slotEndMin > lStart;
  });
  if (partialLeaveOverlap) {
    throw AppError.badRequest('Doctor is on leave during the selected time');
  }

  // Check slot conflict
  const dayStart = new Date(appointmentDate);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(appointmentDate);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const startTimeDate = timeToDate(data.startTime);
  const endTimeDate = timeToDate(data.endTime);

  const conflicting = await prisma.appointment.findFirst({
    where: {
      doctorId: data.doctorId,
      appointmentDate: { gte: dayStart, lte: dayEnd },
      status: { notIn: ['cancelled', 'no_show', 'pending_payment'] },
      OR: [
        { startTime: { lt: endTimeDate }, endTime: { gt: startTimeDate } },
      ],
    },
  });
  if (conflicting) throw AppError.conflict('This time slot is already booked');

  const appointment = await prisma.appointment.create({
    data: {
      tenantId,
      patientId,
      doctorId: data.doctorId,
      appointmentDate,
      startTime: startTimeDate,
      endTime: endTimeDate,
      appointmentType: 'scheduled',
      visitType: 'new',
      reason: data.reason,
      status: 'pending_payment',
      bookedBy: userId,
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, tenant: { select: { id: true, name: true } } } },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
    },
  });

  // A booking made in the portal used to reach the hospital silently — nothing
  // told the doctor or the desk it had happened, so it was found only by
  // someone refreshing a list. The doctor holds the slot; the desk takes the
  // payment and checks the patient in, so both need it.
  await notifyUsers({
    tenantId,
    userIds: [
      await doctorUserIdFromProfile(tenantId, data.doctorId),
      ...(await usersWithRoles(tenantId, PORTAL_APPOINTMENT_DESK_ROLES)),
    ],
    title: 'New appointment booked online',
    message: `${patientLabel(appointment.patient)} booked ${formatDateTimeIST(appointment.appointmentDate)} with ${doctorLabel(appointment.doctor)}.`,
    referenceType: 'appointment_booked',
    referenceId: appointment.id,
  });

  return appointment;
}

/**
 * Confirm appointment payment — moves status from pending_payment to booked.
 */
export async function confirmAppointmentPayment(
  appointmentId: string,
  paymentMethod: 'online' | 'frontdesk',
) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
  });

  if (!appointment) throw AppError.notFound('Appointment not found');

  // Only transition from pending_payment
  if (appointment.status !== 'pending_payment') {
    return appointment;
  }

  const updated = await prisma.appointment.update({
    where: { id: appointmentId },
    data: { status: 'booked' },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  return updated;
}

/**
 * Cancel an appointment as a patient.
 */
export async function cancelAppointmentAsPatient(
  userId: string,
  email: string,
  appointmentId: string,
) {
  // Find the appointment and verify it belongs to the patient
  const patientLinks = await findConnectedPatients(userId);
  const patientIds = patientLinks.map((p) => p.id);

  if (patientIds.length === 0) {
    // Fallback to email
    const byEmail = await findPatientsByEmail(email);
    patientIds.push(...byEmail.map((p) => p.id));
  }

  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, patientId: { in: patientIds } },
  });
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (!['booked', 'confirmed'].includes(appointment.status)) {
    throw AppError.badRequest('Only booked or confirmed appointments can be cancelled');
  }

  const updated = await prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      status: 'cancelled',
      cancelledBy: userId,
      cancellationReason: 'Cancelled by patient',
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, tenant: { select: { id: true, name: true } } } },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
    },
  });

  // A cancelled slot is time somebody else could use, and the desk cannot see
  // it come free unless something says so. The doctor is told because it is
  // their list that just changed.
  await notifyUsers({
    tenantId: updated.tenantId,
    userIds: [
      await doctorUserIdFromProfile(updated.tenantId, updated.doctorId),
      ...(await usersWithRoles(updated.tenantId, PORTAL_APPOINTMENT_DESK_ROLES)),
    ],
    title: 'Appointment cancelled by patient',
    message: `${patientLabel(updated.patient)} cancelled ${formatDateTimeIST(updated.appointmentDate)} with ${doctorLabel(updated.doctor)}.`,
    referenceType: 'appointment_cancelled',
    referenceId: updated.id,
  });

  return updated;
}

/**
 * List departments for a connected hospital.
 */
export async function getDepartmentsForBooking(userId: string, tenantId: string) {
  const departments = await prisma.department.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  return { data: departments };
}

// ────────────────────────────────────────────────────────────
// Payment Info & Online Payment
// ────────────────────────────────────────────────────────────

/**
 * Check if a hospital supports online payments.
 */
export async function getPaymentInfo(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { linkedAccountId: true, bankVerified: true },
  });
  if (!tenant) throw AppError.notFound('Hospital not found');

  return {
    onlinePaymentAvailable: !!tenant.linkedAccountId && tenant.bankVerified,
  };
}

/**
 * The next `BILL-YYYYMMDD-XXXX`.
 *
 * Through the shared allocator, which reads the maximum ACROSS ALL TENANTS.
 * This scoped both the maximum and its duplicate re-check to one tenant, and
 * `bill_number` is unique globally — so two hospitals taking an online booking
 * on the same day both computed `…-0001` and the second insert was refused. The
 * tenant-scoped re-check was looking in the one place the clash could not be.
 */
async function generateBillNumber(_tenantId: string): Promise<string> {
  return nextBillNumberInSeries(prisma, 'BILL');
}

/**
 * Create a Razorpay order so the patient can pay online for a booked appointment.
 * Creates a Bill + BillItem + Payment + PaymentTransfer in one go.
 */
export async function createPatientPaymentOrder(
  userId: string,
  email: string,
  data: { appointmentId: string },
) {
  // Resolve patient
  const patientLinks = await findConnectedPatients(userId);
  const patientIds = patientLinks.map((p) => p.id);
  if (patientIds.length === 0) {
    const byEmail = await findPatientsByEmail(email);
    patientIds.push(...byEmail.map((p) => p.id));
  }

  const appointment = await prisma.appointment.findFirst({
    where: { id: data.appointmentId, patientId: { in: patientIds } },
    include: { doctor: true },
  });
  if (!appointment) throw AppError.notFound('Appointment not found');

  const consultationFee = appointment.doctor.consultationFee
    ? Number(appointment.doctor.consultationFee)
    : 0;
  if (consultationFee <= 0) {
    throw AppError.badRequest('No consultation fee for this doctor');
  }

  const tenantId = appointment.tenantId;

  // Verify hospital has bank linked
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant?.linkedAccountId || !tenant.bankVerified) {
    throw AppError.badRequest('Hospital bank account not linked. Online payment unavailable.');
  }

  // Check if a bill already exists for this appointment (avoid duplicates)
  const existingBill = await prisma.bill.findFirst({
    where: {
      tenantId,
      patientId: appointment.patientId,
      billItems: { some: { referenceType: 'appointment', referenceId: appointment.id } },
      status: { in: ['pending', 'partially_paid'] },
    },
  });

  let billId: string;

  if (existingBill) {
    billId = existingBill.id;
  } else {
    // Create a bill + bill item for the consultation fee
    const billNumber = await generateBillNumber(tenantId);
    const bill = await prisma.bill.create({
      data: {
        tenantId,
        patientId: appointment.patientId,
        billNumber,
        billDate: new Date(),
        subtotal: consultationFee,
        discountAmount: 0,
        taxAmount: 0,
        totalAmount: consultationFee,
        insuranceCoveredAmount: 0,
        patientPayableAmount: consultationFee,
        amountPaid: 0,
        balanceDue: consultationFee,
        status: 'pending',
        generatedBy: userId,
        billItems: {
          create: {
            description: 'Consultation Fee',
            category: 'consultation',
            quantity: 1,
            unitPrice: consultationFee,
            discountPercent: 0,
            discountAmount: 0,
            taxPercent: 0,
            taxAmount: 0,
            totalAmount: consultationFee,
            referenceType: 'appointment',
            referenceId: appointment.id,
          },
        },
      },
    });
    billId = bill.id;
  }

  // Commission calculation
  const commissionPercent = await commissionService.getCommissionForTenant(tenantId);
  const commissionAmount = Math.round((consultationFee * commissionPercent / 100) * 100) / 100;
  const hospitalAmount = Math.round((consultationFee - commissionAmount) * 100) / 100;
  const amountInPaise = Math.round(consultationFee * 100);

  // Create Razorpay order
  const order = await razorpay.orders.create({
    amount: amountInPaise,
    currency: 'INR',
    receipt: `appt_${data.appointmentId.slice(0, 8)}_${Date.now()}`,
    notes: { tenantId, billId, appointmentId: data.appointmentId },
  });

  // Create payment + transfer records
  const payment = await prisma.payment.create({
    data: {
      tenantId,
      billId,
      patientId: appointment.patientId,
      paymentDate: new Date(),
      amount: consultationFee,
      paymentMethod: 'upi',
      paymentSource: 'online',
      paymentType: 'regular',
      status: 'pending',
      processedBy: userId,
      gatewayReference: order.id,
      notes: 'Online consultation fee payment',
    },
  });

  await prisma.paymentTransfer.create({
    data: {
      tenantId,
      paymentId: payment.id,
      razorpayOrderId: order.id,
      totalAmount: consultationFee,
      commissionAmount,
      hospitalAmount,
      commissionPercent,
      transferStatus: 'pending',
    },
  });

  logger.info({ appointmentId: data.appointmentId, billId, orderId: order.id }, 'Patient payment order created');

  return {
    orderId: order.id,
    amount: amountInPaise,
    currency: 'INR',
    keyId: env.RAZORPAY_KEY_ID,
    paymentId: payment.id,
    billId,
  };
}

/**
 * Create a Razorpay order so a patient can pay an already-generated bill
 * online from the portal (lab / pharmacy / room / consultation charges).
 *
 * Mirrors createPatientPaymentOrder but targets an existing bill instead of
 * synthesising one from an appointment. Ownership is enforced by scoping the
 * bill lookup to the account's own patientIds — a patient can only pay their
 * own bills. Verification reuses verifyPatientPayment; the balance is settled
 * by the Razorpay webhook (payment.captured), same as every other online path.
 */
export async function createPatientBillPaymentOrder(
  userId: string,
  email: string,
  data: { billId: string },
) {
  // Resolve the account's own patient records (connections + email fallback).
  const patientLinks = await findConnectedPatients(userId);
  const patientIds = patientLinks.map((p) => p.id);
  if (patientIds.length === 0) {
    const byEmail = await findPatientsByEmail(email);
    patientIds.push(...byEmail.map((p) => p.id));
  }
  if (patientIds.length === 0) {
    throw AppError.notFound('No patient records linked to this account');
  }

  // Ownership check: the bill must belong to one of this account's patients.
  const bill = await prisma.bill.findFirst({
    where: { id: data.billId, patientId: { in: patientIds } },
  });
  if (!bill) throw AppError.notFound('Bill not found');

  if (bill.status !== 'pending' && bill.status !== 'partially_paid') {
    throw AppError.badRequest('Bill is not payable');
  }

  const amount = Number(bill.balanceDue);
  if (amount <= 0) throw AppError.badRequest('No balance due on this bill');

  const tenantId = bill.tenantId;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant?.linkedAccountId || !tenant.bankVerified) {
    throw AppError.badRequest('Hospital bank account not linked. Online payment unavailable.');
  }

  const commissionPercent = await commissionService.getCommissionForTenant(tenantId);
  const commissionAmount = Math.round((amount * commissionPercent / 100) * 100) / 100;
  const hospitalAmount = Math.round((amount - commissionAmount) * 100) / 100;
  const amountInPaise = Math.round(amount * 100);

  const order = await razorpay.orders.create({
    amount: amountInPaise,
    currency: 'INR',
    receipt: `bill_${data.billId.slice(0, 8)}_${Date.now()}`,
    notes: { tenantId, billId: data.billId },
  });

  const payment = await prisma.payment.create({
    data: {
      tenantId,
      billId: data.billId,
      patientId: bill.patientId,
      paymentDate: new Date(),
      amount,
      paymentMethod: 'upi',
      paymentSource: 'online',
      paymentType: 'regular',
      status: 'pending',
      processedBy: userId,
      gatewayReference: order.id,
      notes: 'Online bill payment via patient portal',
    },
  });

  await prisma.paymentTransfer.create({
    data: {
      tenantId,
      paymentId: payment.id,
      razorpayOrderId: order.id,
      totalAmount: amount,
      commissionAmount,
      hospitalAmount,
      commissionPercent,
      transferStatus: 'pending',
    },
  });

  logger.info({ billId: data.billId, orderId: order.id }, 'Patient bill payment order created');

  return {
    orderId: order.id,
    amount: amountInPaise,
    currency: 'INR',
    keyId: env.RAZORPAY_KEY_ID,
    paymentId: payment.id,
    billId: data.billId,
  };
}

/**
 * Verify a Razorpay payment signature (patient portal).
 */
export async function verifyPatientPayment(data: {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}) {
  const body = data.razorpay_order_id + '|' + data.razorpay_payment_id;
  const expectedSignature = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  if (expectedSignature !== data.razorpay_signature) {
    throw AppError.badRequest('Payment verification failed: Invalid signature');
  }

  const transfer = await prisma.paymentTransfer.findUnique({
    where: { razorpayOrderId: data.razorpay_order_id },
  });
  if (!transfer) throw AppError.notFound('Payment transfer not found');

  await prisma.paymentTransfer.update({
    where: { id: transfer.id },
    data: { razorpayPaymentId: data.razorpay_payment_id },
  });

  // Settle the payment and the bill it belongs to. The signature above proves
  // the gateway took the money; waiting only on the webhook meant a server
  // Razorpay could not reach left the patient charged and the bill open.
  // Idempotent, so the webhook arriving later is a no-op.
  await settleGatewayPayment(transfer.paymentId, data.razorpay_payment_id);

  // Confirm appointment (pending_payment → booked) via the payment record
  const payment = await prisma.payment.findUnique({
    where: { id: transfer.paymentId },
    include: { bill: { include: { billItems: true } } },
  });
  if (payment?.bill?.billItems) {
    const aptItem = payment.bill.billItems.find((i) => i.referenceType === 'appointment');
    if (aptItem?.referenceId) {
      await confirmAppointmentPayment(aptItem.referenceId, 'online');
    }
  }

  return { verified: true, transferId: transfer.id };
}

/**
 * Mark an appointment for front-desk payment.
 * Creates a pending Bill so the front desk knows to collect.
 */
export async function confirmFrontdeskPayment(
  userId: string,
  email: string,
  data: { appointmentId: string },
) {
  const patientLinks = await findConnectedPatients(userId);
  const patientIds = patientLinks.map((p) => p.id);
  if (patientIds.length === 0) {
    const byEmail = await findPatientsByEmail(email);
    patientIds.push(...byEmail.map((p) => p.id));
  }

  const appointment = await prisma.appointment.findFirst({
    where: { id: data.appointmentId, patientId: { in: patientIds } },
    include: { doctor: true },
  });
  if (!appointment) throw AppError.notFound('Appointment not found');

  const tenantId = appointment.tenantId;
  const consultationFee = appointment.doctor.consultationFee
    ? Number(appointment.doctor.consultationFee)
    : 0;

  // Check if a bill already exists for this appointment
  const existingBill = await prisma.bill.findFirst({
    where: {
      tenantId,
      patientId: appointment.patientId,
      billItems: { some: { referenceType: 'appointment', referenceId: appointment.id } },
    },
  });

  if (existingBill) {
    return { billId: existingBill.id, status: existingBill.status };
  }

  // Create a pending bill for front desk collection
  const billNumber = await generateBillNumber(tenantId);
  const amount = consultationFee > 0 ? consultationFee : 0;

  const bill = await prisma.bill.create({
    data: {
      tenantId,
      patientId: appointment.patientId,
      billNumber,
      billDate: new Date(),
      subtotal: amount,
      discountAmount: 0,
      taxAmount: 0,
      totalAmount: amount,
      insuranceCoveredAmount: 0,
      patientPayableAmount: amount,
      amountPaid: 0,
      balanceDue: amount,
      status: 'pending',
      generatedBy: userId,
      billItems: {
        create: {
          description: 'Consultation Fee (Pay at Front Desk)',
          category: 'consultation',
          quantity: 1,
          unitPrice: amount,
          discountPercent: 0,
          discountAmount: 0,
          taxPercent: 0,
          taxAmount: 0,
          totalAmount: amount,
          referenceType: 'appointment',
          referenceId: appointment.id,
        },
      },
    },
  });

  logger.info({ appointmentId: data.appointmentId, billId: bill.id }, 'Frontdesk payment bill created');

  // Confirm appointment (pending_payment → booked)
  await confirmAppointmentPayment(data.appointmentId, 'frontdesk');

  return { billId: bill.id, status: 'pending' };
}
