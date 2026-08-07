import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { resolvePersonPatientIds } from '../../shared/patient-identity';
import { TEMP_MRN_PREFIX } from '../../shared/temporary-patient';
import { ACTIVE_ADMISSION_STATUSES } from '../../shared/admission-status';

// ---------------------------------------------------------------------------
// The centralized patient file.
//
// Everything the hospital holds on one patient, on one page: who they are, how
// to reach them, what they are allergic to, every encounter, every order, every
// prescription, every rupee — assembled from the records that were previously
// only reachable by opening six different modules.
//
// WHO CAN SEE WHAT — this is the whole access story, and it is enforced here
// rather than in the UI:
//
//   • A hospital user (admin included) can open a patient file only for a
//     Patient row that belongs to THEIR tenant. A person who has never been to
//     this hospital has no row here, so there is nothing to open — the id is
//     simply not found, exactly as if it did not exist.
//
//   • super_admin runs the platform, not a hospital, so the tenant filter is
//     dropped: any patient at any hospital, plus a platform-wide directory.
//
// The file reports THIS hospital's records. Other hospitals the same person is
// known at are listed by name and MRN only — their clinical detail belongs to
// them, and the deliberate cross-hospital view already exists separately
// (/patients/:id/global-history).
// ---------------------------------------------------------------------------

export interface FileActor {
  tenantId: string;
  roles: string[];
}

export function isPlatformActor(actor: FileActor): boolean {
  return actor.roles.includes('super_admin');
}

/**
 * The patient row this actor is allowed to open, or a 404.
 *
 * Deliberately 404 and not 403: telling a hospital admin "this patient exists
 * but is not yours" would confirm that a person is a patient somewhere else,
 * which is exactly the thing they must not learn from this screen.
 */
async function authorisePatient(actor: FileActor, patientId: string) {
  const patient = await prisma.patient.findFirst({
    where: isPlatformActor(actor) ? { id: patientId } : { id: patientId, tenantId: actor.tenantId },
    include: {
      tenant: { select: { id: true, name: true } },
      user: { select: { id: true, email: true, phone: true, isActive: true, lastLoginAt: true } },
      emergencyContacts: { orderBy: { isPrimary: 'desc' } },
    },
  });
  if (!patient) throw AppError.notFound('Patient not found');
  return patient;
}

const money = (v: unknown) => Number(v ?? 0);
const docName = (d: { user?: { firstName?: string | null; lastName?: string | null } | null } | null) =>
  d?.user ? `Dr. ${d.user.firstName ?? ''} ${d.user.lastName ?? ''}`.trim() : null;

export async function getPatientFile(actor: FileActor, patientId: string) {
  const patient = await authorisePatient(actor, patientId);
  const tenantId = patient.tenantId;

  // Allergies and family history belong to the PERSON, not to one hospital's
  // row — a reaction recorded at the front desk last year must show here.
  const personIds = await resolvePersonPatientIds(patient.id);

  const [
    visits,
    admissions,
    appointments,
    allergies,
    familyHistory,
    personalHistory,
    diagnoses,
    prescriptions,
    labOrders,
    imaging,
    bills,
    payments,
    documents,
    dischargeSummaries,
    otherRows,
  ] = await Promise.all([
    prisma.visit.findMany({
      where: { patientId: patient.id, tenantId },
      include: {
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
        diagnoses: { select: { id: true } },
      },
      orderBy: { visitDate: 'desc' },
      take: 50,
    }),
    prisma.admission.findMany({
      where: { patientId: patient.id, tenantId },
      include: {
        ward: { select: { name: true } },
        bed: { select: { bedNumber: true } },
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      },
      orderBy: { admissionDate: 'desc' },
      take: 50,
    }),
    prisma.appointment.findMany({
      where: { patientId: patient.id, tenantId },
      include: { doctor: { include: { user: { select: { firstName: true, lastName: true } } } } },
      orderBy: { appointmentDate: 'desc' },
      take: 50,
    }),
    prisma.patientAllergy.findMany({
      where: { patientId: { in: personIds } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.patientFamilyHistory.findMany({
      where: { patientId: { in: personIds } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    prisma.patientPersonalHistory.findFirst({ where: { patientId: { in: personIds } } }),
    prisma.diagnosis.findMany({
      where: { visit: { patientId: patient.id, tenantId } },
      orderBy: { diagnosedAt: 'desc' },
      take: 60,
    }),
    prisma.prescription.findMany({
      where: { patientId: patient.id, tenantId },
      include: {
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
        _count: { select: { prescriptionItems: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 40,
    }),
    prisma.labOrder.findMany({
      where: { patientId: patient.id, tenantId },
      include: {
        labOrderItems: { include: { test: { select: { testName: true } } } },
        labReport: { select: { status: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 40,
    }),
    prisma.imagingRequest.findMany({
      where: { patientId: patient.id, tenantId },
      orderBy: { createdAt: 'desc' },
      take: 40,
    }),
    prisma.bill.findMany({
      where: { patientId: patient.id, tenantId },
      orderBy: { createdAt: 'desc' },
      take: 60,
    }),
    prisma.payment.findMany({
      where: { bill: { patientId: patient.id, tenantId } },
      orderBy: { createdAt: 'desc' },
      take: 60,
    }),
    // Documents follow the person: what the patient uploaded from the portal is
    // on file for them, not for one hospital's row.
    prisma.patientDocument.findMany({
      where: { patientId: { in: personIds } },
      orderBy: { createdAt: 'desc' },
      take: 60,
    }),
    // DischargeSummary has no tenant column — it hangs off the admission, and
    // the patient row is already tenant-scoped, so patientId is the scope.
    prisma.dischargeSummary.findMany({
      where: { patientId: patient.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    // Presence only. Which hospitals know this person, never what they hold.
    prisma.patient.findMany({
      where: { id: { in: personIds }, NOT: { id: patient.id } },
      select: {
        id: true,
        mrn: true,
        tenantId: true,
        createdAt: true,
        tenant: { select: { name: true } },
      },
    }),
  ]);

  // Money is stated once, from the bills, so the file never disagrees with the
  // billing screen.
  const live = bills.filter((b) => b.status !== 'cancelled');
  const totals = {
    billed: live.reduce((n, b) => n + money(b.totalAmount), 0),
    paid: live.reduce((n, b) => n + money(b.amountPaid), 0),
    outstanding: live.reduce((n, b) => n + money(b.balanceDue), 0),
    billCount: live.length,
  };

  const currentAdmission = admissions.find((a) =>
    (ACTIVE_ADMISSION_STATUSES as readonly string[]).includes(a.status),
  );

  return {
    access: {
      // The UI says which of these it is, so nobody wonders why a colleague
      // sees a different list.
      scope: isPlatformActor(actor) ? ('platform' as const) : ('hospital' as const),
      hospital: { id: patient.tenant?.id ?? tenantId, name: patient.tenant?.name ?? 'Hospital' },
    },
    patient: {
      id: patient.id,
      mrn: patient.mrn,
      isTemporary: patient.mrn?.startsWith(TEMP_MRN_PREFIX) ?? false,
      firstName: patient.firstName,
      lastName: patient.lastName,
      dateOfBirth: patient.dateOfBirth,
      gender: patient.gender,
      bloodGroup: patient.bloodGroup,
      maritalStatus: patient.maritalStatus,
      phone: patient.phone,
      email: patient.email,
      addressLine1: patient.addressLine1,
      addressLine2: patient.addressLine2,
      city: patient.city,
      state: patient.state,
      postalCode: patient.postalCode,
      country: patient.country,
      occupation: patient.occupation,
      nationality: patient.nationality,
      religion: patient.religion,
      abhaNumber: patient.abhaNumber,
      idProofType: patient.idProofType,
      idProofNumber: patient.idProofNumber,
      referredBy: patient.referredBy,
      notes: patient.notes,
      isActive: patient.isActive,
      registeredOn: patient.createdAt,
      updatedAt: patient.updatedAt,
    },
    portalAccount: patient.user
      ? {
          id: patient.user.id,
          email: patient.user.email,
          phone: patient.user.phone,
          isActive: patient.user.isActive,
          lastLoginAt: patient.user.lastLoginAt,
        }
      : null,
    emergencyContacts: patient.emergencyContacts,
    safety: {
      allergies: allergies.map((a) => ({
        id: a.id,
        allergen: a.allergen,
        allergyType: a.allergyType,
        severity: a.severity,
        reaction: a.reaction,
      })),
      familyHistory: familyHistory.map((f) => ({
        id: f.id,
        relationSide: f.relationSide,
        relationship: f.relationship,
        conditionName: f.conditionName,
        notes: f.notes,
      })),
      personalHistory: personalHistory
        ? {
            smokingStatus: personalHistory.smokingStatus,
            alcoholConsumption: personalHistory.alcoholConsumption,
            diet: personalHistory.diet,
            disorders: personalHistory.disorders,
          }
        : null,
    },
    status: {
      currentlyAdmitted: !!currentAdmission,
      currentAdmission: currentAdmission
        ? {
            id: currentAdmission.id,
            admittedOn: currentAdmission.admissionDate,
            status: currentAdmission.status,
            ward: currentAdmission.ward?.name ?? null,
            bed: currentAdmission.bed?.bedNumber ?? null,
            doctor: docName(currentAdmission.doctor as never),
          }
        : null,
    },
    counts: {
      visits: visits.length,
      admissions: admissions.length,
      appointments: appointments.length,
      prescriptions: prescriptions.length,
      labOrders: labOrders.length,
      imaging: imaging.length,
      documents: documents.length,
      dischargeSummaries: dischargeSummaries.length,
    },
    visits: visits.map((v) => ({
      id: v.id,
      date: v.visitDate,
      type: v.visitType,
      status: v.status,
      chiefComplaint: v.chiefComplaint,
      doctor: docName(v.doctor as never),
      diagnosisCount: v.diagnoses.length,
    })),
    admissions: admissions.map((a) => ({
      id: a.id,
      ipNumber: (a as { ipNumber?: string | null }).ipNumber ?? null,
      admittedOn: a.admissionDate,
      dischargedOn: a.dischargeDate,
      status: a.status,
      ward: a.ward?.name ?? null,
      bed: a.bed?.bedNumber ?? null,
      doctor: docName(a.doctor as never),
    })),
    appointments: appointments.map((a) => ({
      id: a.id,
      date: a.appointmentDate,
      startTime: a.startTime,
      status: a.status,
      type: a.appointmentType,
      visitType: a.visitType,
      doctor: docName(a.doctor as never),
    })),
    diagnoses: diagnoses.map((d) => ({
      id: d.id,
      code: d.icdCode,
      name: d.diagnosisName,
      type: d.diagnosisType,
      notes: d.notes,
      recordedOn: d.diagnosedAt,
    })),
    prescriptions: prescriptions.map((p) => ({
      id: p.id,
      date: p.createdAt,
      status: p.status,
      type: p.prescriptionType,
      doctor: docName(p.doctor as never),
      itemCount: p._count.prescriptionItems,
    })),
    labOrders: labOrders.map((o) => ({
      id: o.id,
      date: o.createdAt,
      status: o.status,
      reportStatus: o.labReport?.status ?? null,
      tests: o.labOrderItems.map((i) => i.test?.testName).filter(Boolean),
    })),
    imaging: imaging.map((r) => ({
      id: r.id,
      date: r.createdAt,
      modality: r.imagingType,
      bodyPart: r.bodyPart,
      status: r.status,
    })),
    billing: {
      totals,
      bills: bills.map((b) => ({
        id: b.id,
        billNumber: b.billNumber,
        date: b.billDate ?? b.createdAt,
        status: b.status,
        total: money(b.totalAmount),
        paid: money(b.amountPaid),
        balance: money(b.balanceDue),
      })),
      payments: payments.map((p) => ({
        id: p.id,
        date: p.createdAt,
        amount: money(p.amount),
        method: p.paymentMethod,
        type: p.paymentType,
        status: p.status,
      })),
    },
    documents: documents.map((d) => ({
      id: d.id,
      documentType: d.documentType,
      title: d.title,
      fileUrl: d.fileUrl,
      uploadedAt: d.createdAt,
      /** Filed against another of this person's rows — i.e. another hospital. */
      fromAnotherHospital: d.patientId !== patient.id,
    })),
    dischargeSummaries: dischargeSummaries.map((s) => ({
      id: s.id,
      status: s.status,
      createdAt: s.createdAt,
      admissionId: s.admissionId,
    })),
    /**
     * Presence only — name, MRN and when they were first seen there. No
     * clinical detail: that belongs to the hospital that recorded it.
     */
    otherHospitals: otherRows.map((r) => ({
      patientId: r.id,
      tenantId: r.tenantId,
      name: r.tenant?.name ?? 'Hospital',
      mrn: r.mrn,
      firstSeen: r.createdAt,
    })),
  };
}

// ── Platform-wide directory (super_admin only) ─────────────────────────────

export interface PlatformDirectoryQuery {
  page?: number;
  limit?: number;
  search?: string;
  tenantId?: string;
  isActive?: boolean;
}

/**
 * Every patient on the platform, across every hospital. Reachable only by
 * super_admin — the route enforces that; this function assumes it has already
 * happened and does no tenant filtering of its own.
 */
export async function getPlatformPatientDirectory(query: PlatformDirectoryQuery) {
  const { skip, take, page, limit } = getPaginationParams({
    page: query.page ?? 1,
    limit: query.limit ?? 25,
    sortOrder: 'desc',
  });

  const where: Record<string, unknown> = {};
  if (query.tenantId) where.tenantId = query.tenantId;
  if (query.isActive !== undefined) where.isActive = query.isActive;
  if (query.search?.trim()) {
    const s = query.search.trim();
    where.OR = [
      { firstName: { contains: s, mode: 'insensitive' } },
      { lastName: { contains: s, mode: 'insensitive' } },
      { mrn: { contains: s, mode: 'insensitive' } },
      { phone: { contains: s } },
      { email: { contains: s, mode: 'insensitive' } },
      { abhaNumber: { contains: s } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.patient.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        mrn: true,
        firstName: true,
        lastName: true,
        dateOfBirth: true,
        gender: true,
        phone: true,
        email: true,
        abhaNumber: true,
        isActive: true,
        createdAt: true,
        tenantId: true,
        tenant: { select: { name: true } },
        user: { select: { id: true, email: true, isActive: true } },
      },
    }),
    prisma.patient.count({ where }),
  ]);

  return {
    patients: rows.map((r) => ({
      id: r.id,
      mrn: r.mrn,
      isTemporary: r.mrn?.startsWith(TEMP_MRN_PREFIX) ?? false,
      firstName: r.firstName,
      lastName: r.lastName,
      dateOfBirth: r.dateOfBirth,
      gender: r.gender,
      phone: r.phone,
      email: r.email,
      abhaNumber: r.abhaNumber,
      isActive: r.isActive,
      registeredOn: r.createdAt,
      hospital: { id: r.tenantId, name: r.tenant?.name ?? 'Hospital' },
      hasPortalAccount: !!r.user,
    })),
    total,
    page,
    limit,
  };
}

/** Hospitals with at least one patient — the directory's hospital filter. */
export async function getPlatformPatientHospitals() {
  const grouped = await prisma.patient.groupBy({
    by: ['tenantId'],
    _count: { _all: true },
  });
  const tenants = await prisma.tenant.findMany({
    where: { id: { in: grouped.map((g) => g.tenantId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(tenants.map((t) => [t.id, t.name]));
  return grouped
    .map((g) => ({
      tenantId: g.tenantId,
      name: nameById.get(g.tenantId) ?? 'Hospital',
      patientCount: g._count._all,
    }))
    .sort((a, b) => b.patientCount - a.patientCount);
}
