import crypto from 'crypto';
import { prisma } from '../../config/database';
import { razorpay } from '../../config/razorpay';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { commissionService } from '../commission/commission.service';
import { getAvailableSlots } from '../appointments/appointments.service';

// ────────────────────────────────────────────────────────────
// MRN Generation (mirrors patients.service.ts)
// ────────────────────────────────────────────────────────────

async function generateMRN(tenantId: string): Promise<string> {
  const today = new Date();
  const dateStr =
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, '0') +
    today.getDate().toString().padStart(2, '0');

  const prefix = `MRN-${dateStr}-`;

  const latestPatient = await prisma.patient.findFirst({
    where: { tenantId, mrn: { startsWith: prefix } },
    orderBy: { mrn: 'desc' },
    select: { mrn: true },
  });

  let nextNumber = 1;
  if (latestPatient?.mrn) {
    const lastNumber = parseInt(latestPatient.mrn.replace(prefix, ''), 10);
    if (!isNaN(lastNumber)) nextNumber = lastNumber + 1;
  }

  const mrn = `${prefix}${nextNumber.toString().padStart(4, '0')}`;

  const existing = await prisma.patient.findFirst({
    where: { tenantId, mrn },
  });
  if (existing) return generateMRN(tenantId);

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

  return combined;
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
  },
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');

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
    return ids.has(profileId) ? [profileId] : [];
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

  const mrn = await generateMRN(tenantId);

  const patient = await prisma.patient.create({
    data: {
      tenantId,
      mrn,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
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
  query: { status?: string; limit?: number; sortOrder?: 'asc' | 'desc'; tenantId?: string; profileId?: string },
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId, query.profileId);
  if (patientIds.length === 0) return { data: [] };

  const limit = query.limit || 50;
  const where: Record<string, unknown> = { patientId: { in: patientIds } };
  if (query.status) where.status = query.status;

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

// ─────────────────────────────────────────────────────────
// Forms — patient inbox
// ─────────────────────────────────────────────────────────

/**
 * Returns every form assignment that's visible to this patient across every
 * hospital they're connected to. Includes:
 *   - Form metadata
 *   - Hospital info (tenantId, name)
 *   - Whether the patient has already submitted it
 *
 * Sources of "patient is connected to hospital X":
 *   1. Patient record at X (with userId or matching email)
 *   2. PatientHospitalConnection at X (approved or pending)
 *
 * Used by the patient's "My Forms" inbox page.
 */
export async function getPatientAvailableForms(userId: string, email: string) {
  // Source 1: every patient record this user owns
  const patientRecords = await prisma.patient.findMany({
    where: {
      OR: [{ userId }, ...(email ? [{ email }] : [])],
    },
    select: {
      id: true,
      tenantId: true,
      tenant: { select: { id: true, name: true, slug: true, city: true } },
    },
  });

  // Source 2: every connection this user has to a hospital (any status)
  const connections = await prisma.patientHospitalConnection.findMany({
    where: { userId },
    select: {
      tenantId: true,
      patientId: true,
      tenant: { select: { id: true, name: true, slug: true, city: true } },
    },
  });

  // Aggregate tenant IDs + patientId-by-tenant + tenant info
  const tenantIds = Array.from(
    new Set([
      ...patientRecords.map((p) => p.tenantId),
      ...connections.map((c) => c.tenantId),
    ]),
  );

  if (tenantIds.length === 0) return { data: [] };

  const patientIdByTenant = new Map<string, string>();
  for (const p of patientRecords) {
    if (!patientIdByTenant.has(p.tenantId)) patientIdByTenant.set(p.tenantId, p.id);
  }
  // Connections may also have a patientId (if approved)
  for (const c of connections) {
    if (c.patientId && !patientIdByTenant.has(c.tenantId)) {
      patientIdByTenant.set(c.tenantId, c.patientId);
    }
  }

  const tenantInfoById = new Map<
    string,
    { id: string; name: string; slug: string; city: string | null }
  >();
  for (const p of patientRecords) {
    if (p.tenant) tenantInfoById.set(p.tenantId, p.tenant);
  }
  for (const c of connections) {
    if (c.tenant && !tenantInfoById.has(c.tenantId)) tenantInfoById.set(c.tenantId, c.tenant);
  }

  // Find all active assignments visible to 'patient' role across these tenants
  const assignments = await prisma.formAssignment.findMany({
    where: {
      tenantId: { in: tenantIds },
      isActive: true,
      instance: { isArchived: false, status: 'published' },
      // Visibility check: rolesAllowed empty (all) or contains 'patient'
      OR: [
        { rolesAllowed: { isEmpty: true } },
        { rolesAllowed: { has: 'patient' } },
      ],
    },
    include: {
      instance: true,
    },
    orderBy: [{ tenantId: 'asc' }, { trigger: 'asc' }, { sortOrder: 'asc' }],
  });

  // Submitted check: a form is "done" if there's a submission either tied to one
  // of the patient's Patient records OR submitted directly by this user.
  // The OR is needed because a patient might submit a form before having any
  // Patient record at the hospital (rare but possible).
  const instanceIds = assignments.map((a) => a.instance.id);
  const allPatientIds = Array.from(
    new Set([
      ...patientRecords.map((p) => p.id),
      ...connections.filter((c) => c.patientId).map((c) => c.patientId as string),
    ]),
  );
  const existingSubmissions = await prisma.formSubmission.findMany({
    where: {
      instanceId: { in: instanceIds },
      status: { in: ['submitted', 'verified'] },
      OR: [
        ...(allPatientIds.length > 0 ? [{ patientId: { in: allPatientIds } }] : []),
        { submittedBy: userId },
      ],
    },
    select: { instanceId: true },
  });
  // Simple per-instance check — if any submission exists for this instance, it's done
  const submittedInstanceIds = new Set(existingSubmissions.map((s) => s.instanceId));

  // Build the response — one row per assignment, enriched with hospital + submission status
  const result = assignments.map((a) => {
    const patientIdForTenant = patientIdByTenant.get(a.tenantId) ?? null;
    const isSubmitted = submittedInstanceIds.has(a.instance.id);
    const isRequiredForPatient =
      a.rolesRequired && a.rolesRequired.length > 0
        ? a.rolesRequired.includes('patient')
        : a.isRequired;
    return {
      assignmentId: a.id,
      trigger: a.trigger,
      isRequired: isRequiredForPatient,
      isSubmitted,
      tenant: tenantInfoById.get(a.tenantId) ?? { id: a.tenantId, name: 'Unknown', slug: '', city: null },
      patientId: patientIdForTenant,
      instance: a.instance,
    };
  });

  return { data: result };
}

export async function getPatientLabReports(
  userId: string,
  email: string,
  query: { limit?: number; tenantId?: string; profileId?: string },
) {
  const patientIds = await resolvePatientIds(userId, email, query.tenantId, query.profileId);
  if (patientIds.length === 0) return { data: [] };

  const reports = await prisma.labReport.findMany({
    where: { patientId: { in: patientIds } },
    take: query.limit || 50,
    include: {
      labOrder: {
        select: {
          id: true,
          status: true,
          labOrderItems: {
            select: { id: true, test: { select: { id: true, testName: true, testCode: true } } },
          },
        },
      },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, tenant: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return { data: reports };
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

async function resolvePrimaryPatientId(userId: string, email: string, tenantId?: string) {
  const ids = await resolvePatientIds(userId, email, tenantId);
  if (ids.length === 0) return null;
  return ids[0];
}

export async function getMyPersonalHistory(userId: string, email: string, tenantId?: string) {
  const patientId = await resolvePrimaryPatientId(userId, email, tenantId);
  if (!patientId) return null;
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
  const ids = await resolvePatientIds(userId, email, tenantId);
  if (ids.length === 0) return [];
  return prisma.patientFamilyHistory.findMany({
    where: { patientId: { in: ids } },
    orderBy: [{ relationSide: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function createMyFamilyHistory(userId: string, email: string, data: any, tenantId?: string) {
  const patientId = await resolvePrimaryPatientId(userId, email, tenantId);
  if (!patientId) throw new Error('No patient record found');
  const { createFamilyHistory } = await import('../medical-history/medical-history.service');
  return createFamilyHistory(patientId, userId, data);
}

export async function updateMyFamilyHistory(userId: string, email: string, id: string, data: any) {
  const ids = await resolvePatientIds(userId, email);
  if (ids.length === 0) throw new Error('No patient record found');
  const entry = await prisma.patientFamilyHistory.findFirst({ where: { id, patientId: { in: ids } } });
  if (!entry) throw new Error('Family history entry not found');
  const { updateFamilyHistory } = await import('../medical-history/medical-history.service');
  return updateFamilyHistory(entry.patientId, userId, id, data);
}

export async function deleteMyFamilyHistory(userId: string, email: string, id: string) {
  const ids = await resolvePatientIds(userId, email);
  if (ids.length === 0) throw new Error('No patient record found');
  const entry = await prisma.patientFamilyHistory.findFirst({ where: { id, patientId: { in: ids } } });
  if (!entry) throw new Error('Family history entry not found');
  const { deleteFamilyHistory } = await import('../medical-history/medical-history.service');
  return deleteFamilyHistory(entry.patientId, id);
}

export async function listMyAllergies(userId: string, email: string, tenantId?: string) {
  const ids = await resolvePatientIds(userId, email, tenantId);
  if (ids.length === 0) return [];
  return prisma.patientAllergy.findMany({
    where: { patientId: { in: ids } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createMyAllergy(userId: string, email: string, data: any, tenantId?: string) {
  const patientId = await resolvePrimaryPatientId(userId, email, tenantId);
  if (!patientId) throw new Error('No patient record found');
  const { createAllergy } = await import('../medical-history/medical-history.service');
  return createAllergy(patientId, userId, data);
}

export async function updateMyAllergy(userId: string, email: string, id: string, data: any) {
  const ids = await resolvePatientIds(userId, email);
  const entry = await prisma.patientAllergy.findFirst({ where: { id, patientId: { in: ids } } });
  if (!entry) throw new Error('Allergy not found');
  const { updateAllergy } = await import('../medical-history/medical-history.service');
  return updateAllergy(entry.patientId, id, data);
}

export async function deleteMyAllergy(userId: string, email: string, id: string) {
  const ids = await resolvePatientIds(userId, email);
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

export async function getPatientDischargeSummaryById(userId: string, email: string, id: string) {
  const patientIds = await resolvePatientIds(userId, email);
  const { getPublishedDischargeSummaryForPatient } = await import('../mrd/mrd.service');
  return getPublishedDischargeSummaryForPatient(patientIds, id);
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
 * Generate a bill number in IST timezone (BILL-YYYYMMDD-XXXX).
 */
async function generateBillNumber(tenantId: string): Promise<string> {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = (ist.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = ist.getUTCDate().toString().padStart(2, '0');
  const prefix = `BILL-${y}${m}${d}-`;

  const latest = await prisma.bill.findFirst({
    where: { tenantId, billNumber: { startsWith: prefix } },
    orderBy: { billNumber: 'desc' },
    select: { billNumber: true },
  });

  let next = 1;
  if (latest?.billNumber) {
    next = parseInt(latest.billNumber.split('-').pop() || '0', 10) + 1;
  }

  const billNumber = `${prefix}${next.toString().padStart(4, '0')}`;

  const dup = await prisma.bill.findFirst({ where: { tenantId, billNumber } });
  if (dup) return generateBillNumber(tenantId);

  return billNumber;
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
