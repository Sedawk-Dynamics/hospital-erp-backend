import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateNurseDoctorAssignmentInput,
  GetNurseDoctorAssignmentsQuery,
  EndNurseDoctorAssignmentInput,
  MyPatientsQuery,
} from './nurse-doctor-assignments.validation';

const assignmentInclude = {
  nurse: { select: { id: true, firstName: true, lastName: true, email: true } },
  doctor: {
    select: {
      id: true,
      specialization: true,
      user: { select: { id: true, firstName: true, lastName: true } },
      department: { select: { id: true, name: true } },
    },
  },
  assigner: { select: { id: true, firstName: true, lastName: true } },
} as const;

/**
 * Bulk-create assignments mapping one nurse to one or more doctors. Each
 * (nurse, doctor) pair gets at most one active row at a time — duplicates are
 * silently skipped (idempotent re-assign). Returns the full set of currently
 * active rows for the nurse so the UI can render the new state in one shot.
 */
export async function createNurseDoctorAssignments(
  tenantId: string,
  assignerUserId: string,
  data: CreateNurseDoctorAssignmentInput,
) {
  const nurse = await prisma.user.findFirst({
    where: { id: data.nurseId, tenantId, isActive: true },
    select: { id: true },
  });
  if (!nurse) throw AppError.notFound('Nurse user not found or inactive');

  const doctors = await prisma.doctorProfile.findMany({
    where: { id: { in: data.doctorIds }, tenantId },
    select: { id: true },
  });
  const doctorIds = new Set(doctors.map((d) => d.id));
  const missing = data.doctorIds.filter((id) => !doctorIds.has(id));
  if (missing.length > 0) {
    throw AppError.notFound(`Doctor(s) not found: ${missing.join(', ')}`);
  }

  const existing = await prisma.nurseDoctorAssignment.findMany({
    where: {
      tenantId,
      nurseId: data.nurseId,
      doctorId: { in: data.doctorIds },
      isActive: true,
    },
    select: { doctorId: true },
  });
  const alreadyActive = new Set(existing.map((e) => e.doctorId));
  const toCreate = data.doctorIds.filter((id) => !alreadyActive.has(id));

  if (toCreate.length > 0) {
    await prisma.nurseDoctorAssignment.createMany({
      data: toCreate.map((doctorId) => ({
        tenantId,
        nurseId: data.nurseId,
        doctorId,
        assignedById: assignerUserId,
        notes: data.notes ?? null,
      })),
    });
  }

  logger.info(
    { tenantId, nurseId: data.nurseId, created: toCreate.length, skipped: alreadyActive.size },
    'Nurse-doctor assignments created',
  );

  const active = await prisma.nurseDoctorAssignment.findMany({
    where: { tenantId, nurseId: data.nurseId, isActive: true },
    include: assignmentInclude,
    orderBy: { assignedAt: 'desc' },
  });
  return { created: toCreate.length, skipped: alreadyActive.size, assignments: active };
}

export async function listNurseDoctorAssignments(
  tenantId: string,
  query: GetNurseDoctorAssignmentsQuery,
) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };
  if (query.nurseId) where.nurseId = query.nurseId;
  if (query.doctorId) where.doctorId = query.doctorId;
  if (query.isActive === 'true') where.isActive = true;
  else if (query.isActive === 'false') where.isActive = false;
  // 'all' or undefined → no filter
  if (query.isActive === undefined) where.isActive = true;

  const [rows, total] = await Promise.all([
    prisma.nurseDoctorAssignment.findMany({
      where,
      skip,
      take,
      orderBy: [{ isActive: 'desc' }, { assignedAt: 'desc' }],
      include: assignmentInclude,
    }),
    prisma.nurseDoctorAssignment.count({ where }),
  ]);

  return { rows, total, page, limit };
}

export async function getNurseDoctorAssignmentById(tenantId: string, id: string) {
  const row = await prisma.nurseDoctorAssignment.findFirst({
    where: { id, tenantId },
    include: assignmentInclude,
  });
  if (!row) throw AppError.notFound('Nurse-doctor assignment not found');
  return row;
}

export async function endNurseDoctorAssignment(
  tenantId: string,
  id: string,
  data: EndNurseDoctorAssignmentInput,
) {
  const existing = await prisma.nurseDoctorAssignment.findFirst({
    where: { id, tenantId },
    select: { id: true, isActive: true },
  });
  if (!existing) throw AppError.notFound('Nurse-doctor assignment not found');
  if (!existing.isActive) {
    throw AppError.badRequest('This assignment is already ended');
  }

  const row = await prisma.nurseDoctorAssignment.update({
    where: { id },
    data: {
      isActive: false,
      endedAt: new Date(),
      endedReason: data.reason ?? null,
    },
    include: assignmentInclude,
  });
  logger.info({ tenantId, id }, 'Nurse-doctor assignment ended');
  return row;
}

/**
 * Doctors that the calling user is currently assigned to. Used by the bedside
 * nurse UI to scope patient lists to "patients of doctors I'm assigned to".
 */
export async function getMyDoctors(tenantId: string, nurseUserId: string) {
  const rows = await prisma.nurseDoctorAssignment.findMany({
    where: { tenantId, nurseId: nurseUserId, isActive: true },
    include: {
      doctor: {
        select: {
          id: true,
          specialization: true,
          user: { select: { id: true, firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { assignedAt: 'desc' },
  });
  return rows.map((r) => ({
    assignmentId: r.id,
    doctor: r.doctor,
    assignedAt: r.assignedAt,
  }));
}

/**
 * Patients whose current visit/admission doctor is one of the doctors the
 * calling nurse is assigned to. Returns admissions (IPD) and visits (OPD)
 * uniformly under a `patients` shape so the UI can list both.
 */
export async function getMyPatients(
  tenantId: string,
  nurseUserId: string,
  query: MyPatientsQuery,
) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const myDoctors = await prisma.nurseDoctorAssignment.findMany({
    where: { tenantId, nurseId: nurseUserId, isActive: true },
    select: { doctorId: true },
  });
  const doctorIds = myDoctors.map((d) => d.doctorId);
  if (doctorIds.length === 0) {
    return { rows: [], total: 0, page, limit };
  }

  const status = query.status ?? 'admitted';
  const type = query.type ?? 'all';

  // Admissions branch (IPD)
  const admissionWhere: any = {
    tenantId,
    doctorId: { in: doctorIds },
  };
  if (status === 'admitted') admissionWhere.status = 'admitted';
  else if (status === 'discharged') admissionWhere.status = 'discharged';
  if (query.search) {
    admissionWhere.patient = {
      OR: [
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { lastName: { contains: query.search, mode: 'insensitive' } },
        { mrn: { contains: query.search, mode: 'insensitive' } },
      ],
    };
  }

  let admissions: any[] = [];
  let admissionsTotal = 0;
  if (type === 'ip' || type === 'all') {
    [admissions, admissionsTotal] = await Promise.all([
      prisma.admission.findMany({
        where: admissionWhere,
        skip: type === 'ip' ? skip : 0,
        take: type === 'ip' ? take : 200,
        orderBy: { admissionDate: 'desc' },
        include: {
          patient: {
            select: { id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true, gender: true, phone: true },
          },
          ward: { select: { id: true, name: true } },
          bed: { select: { id: true, bedNumber: true } },
          doctor: {
            select: {
              id: true,
              user: { select: { id: true, firstName: true, lastName: true } },
            },
          },
        },
      }),
      prisma.admission.count({ where: admissionWhere }),
    ]);
  }

  let visits: any[] = [];
  let visitsTotal = 0;
  if (type === 'op' || type === 'all') {
    const visitWhere: any = {
      tenantId,
      doctorId: { in: doctorIds },
      visitType: 'op',
    };
    if (query.search) {
      visitWhere.patient = admissionWhere.patient;
    }
    [visits, visitsTotal] = await Promise.all([
      prisma.visit.findMany({
        where: visitWhere,
        skip: type === 'op' ? skip : 0,
        take: type === 'op' ? take : 200,
        orderBy: { visitDate: 'desc' },
        include: {
          patient: {
            select: { id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true, gender: true, phone: true },
          },
          doctor: {
            select: {
              id: true,
              user: { select: { id: true, firstName: true, lastName: true } },
            },
          },
        },
      }),
      prisma.visit.count({ where: visitWhere }),
    ]);
  }

  // Normalize into a single list with `recordType`.
  const rows = [
    ...admissions.map((a) => ({
      recordType: 'admission' as const,
      id: a.id,
      patientId: a.patientId,
      patient: a.patient,
      doctor: a.doctor,
      ward: a.ward,
      bed: a.bed,
      status: a.status,
      admissionDate: a.admissionDate,
      dischargeDate: a.dischargeDate,
    })),
    ...visits.map((v) => ({
      recordType: 'visit' as const,
      id: v.id,
      patientId: v.patientId,
      patient: v.patient,
      doctor: v.doctor,
      visitDate: v.visitDate,
      visitType: v.visitType,
      status: v.status,
    })),
  ];

  return {
    rows,
    total: admissionsTotal + visitsTotal,
    page,
    limit,
  };
}
