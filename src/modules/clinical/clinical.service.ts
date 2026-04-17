import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateVisitInput,
  GetVisitsQuery,
  UpdateVisitInput,
  CreateAdmissionInput,
  GetAdmissionsQuery,
  UpdateAdmissionInput,
  CreateTransferInput,
  GetTransfersQuery,
  RecordVitalsInput,
  GetVitalsQuery,
  GetAllVitalsQuery,
  AddDiagnosisInput,
  GetDiagnosesQuery,
  GetAllDiagnosesQuery,
  UpdateDiagnosisInput,
  CreateOtRequestInput,
  GetOtRequestsQuery,
  CreateReservationInput,
  GetReservationsQuery,
  UpdateReservationInput,
  CreateEstimationInput,
  GetEstimationsQuery,
  UpdateEstimationInput,
} from './clinical.validation';

// ==================== Visits ====================

/**
 * Create a new visit.
 */
export async function createVisit(tenantId: string, data: CreateVisitInput) {
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

  const visit = await prisma.visit.create({
    data: {
      tenantId,
      patientId: data.patientId,
      doctorId: data.doctorId,
      appointmentId: data.appointmentId,
      visitType: data.visitType,
      visitDate: new Date(data.visitDate),
      chiefComplaint: data.chiefComplaint,
      status: 'active',
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
    },
  });

  logger.info({ tenantId, visitId: visit.id }, 'Visit created');
  return visit;
}

/**
 * Get paginated list of visits with filters.
 */
export async function getVisits(tenantId: string, query: GetVisitsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.doctorId) where.doctorId = query.doctorId;
  if (query.visitType) where.visitType = query.visitType;
  if (query.status) where.status = query.status;

  if (query.fromDate) {
    where.visitDate = { ...where.visitDate, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.visitDate = { ...where.visitDate, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { chiefComplaint: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [visits, total] = await Promise.all([
    prisma.visit.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
        },
        doctor: {
          include: {
            user: { select: { firstName: true, lastName: true } },
            department: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { visitDate: query.sortOrder ?? 'desc' },
    }),
    prisma.visit.count({ where }),
  ]);

  return { visits, total, page, limit };
}

/**
 * Get a single visit by ID.
 */
export async function getVisitById(tenantId: string, id: string) {
  const visit = await prisma.visit.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          dateOfBirth: true,
          gender: true,
          bloodGroup: true,
        },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
          department: { select: { id: true, name: true } },
        },
      },
      admission: true,
      vitals: { orderBy: { recordedAt: 'desc' }, take: 5 },
      diagnoses: { orderBy: { diagnosedAt: 'desc' } },
    },
  });

  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  return visit;
}

/**
 * Update a visit.
 */
export async function updateVisit(tenantId: string, id: string, data: UpdateVisitInput) {
  const visit = await prisma.visit.findFirst({
    where: { id, tenantId },
  });

  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  if (visit.status === 'completed' || visit.status === 'discharged') {
    throw AppError.badRequest('Cannot update a closed visit');
  }

  if (data.doctorId) {
    const doctor = await prisma.doctorProfile.findFirst({
      where: { id: data.doctorId, tenantId },
    });
    if (!doctor) {
      throw AppError.notFound('Doctor not found');
    }
  }

  const updated = await prisma.visit.update({
    where: { id },
    data: {
      ...(data.doctorId && { doctorId: data.doctorId }),
      ...(data.chiefComplaint !== undefined && { chiefComplaint: data.chiefComplaint }),
      ...(data.visitType && { visitType: data.visitType }),
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
    },
  });

  logger.info({ tenantId, visitId: id }, 'Visit updated');
  return updated;
}

/**
 * Close (complete) a visit.
 */
export async function closeVisit(tenantId: string, id: string) {
  const visit = await prisma.visit.findFirst({
    where: { id, tenantId },
  });

  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  if (visit.status === 'completed') {
    throw AppError.badRequest('Visit is already closed');
  }

  if (visit.status === 'discharged') {
    throw AppError.badRequest('Visit has already been discharged');
  }

  const updated = await prisma.visit.update({
    where: { id },
    data: { status: 'completed' },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  logger.info({ tenantId, visitId: id }, 'Visit closed');
  return updated;
}

// ==================== Admissions ====================

/**
 * Create a new admission.
 */
export async function createAdmission(tenantId: string, userId: string, data: CreateAdmissionInput) {
  // Verify visit belongs to tenant
  const visit = await prisma.visit.findFirst({
    where: { id: data.visitId, tenantId },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  // Check if visit already has an admission
  const existingAdmission = await prisma.admission.findUnique({
    where: { visitId: data.visitId },
  });
  if (existingAdmission) {
    throw AppError.conflict('This visit already has an admission');
  }

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

  // Verify bed exists and belongs to the ward (bed→room→ward)
  const bed = await prisma.bed.findFirst({
    where: { id: data.bedId, room: { wardId: data.wardId } },
    include: { room: true },
  });
  if (!bed) {
    throw AppError.notFound('Bed not found in the specified ward');
  }

  const admission = await prisma.admission.create({
    data: {
      tenantId,
      visitId: data.visitId,
      patientId: data.patientId,
      doctorId: data.doctorId,
      wardId: data.wardId,
      bedId: data.bedId,
      admissionDate: new Date(data.admissionDate),
      expectedDischargeDate: data.expectedDischargeDate
        ? new Date(data.expectedDischargeDate)
        : undefined,
      admissionReason: data.admissionReason,
      depositAmount: data.depositAmount ?? 0,
      status: 'admitted',
      admittedBy: userId,
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
      ward: { select: { id: true, name: true } },
      bed: { select: { id: true, bedNumber: true } },
    },
  });

  // Update visit type to IP if not already
  if (visit.visitType !== 'ip') {
    await prisma.visit.update({
      where: { id: data.visitId },
      data: { visitType: 'ip' },
    });
  }

  logger.info({ tenantId, admissionId: admission.id }, 'Admission created');
  return admission;
}

/**
 * Get paginated list of admissions.
 */
export async function getAdmissions(tenantId: string, query: GetAdmissionsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.doctorId) where.doctorId = query.doctorId;
  if ((query as any).nurseId) where.nurseId = (query as any).nurseId;
  if (query.wardId) where.wardId = query.wardId;
  if (query.status) where.status = query.status;

  if ((query as any).date) {
    const d = new Date((query as any).date);
    if (!isNaN(d.getTime())) {
      const start = new Date(d);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(d);
      end.setUTCHours(23, 59, 59, 999);
      where.admissionDate = { gte: start, lte: end };
    }
  }

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
      { admissionReason: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [admissions, total] = await Promise.all([
    prisma.admission.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
        },
        doctor: {
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        },
        ward: { select: { id: true, name: true } },
        bed: { select: { id: true, bedNumber: true } },
      },
      orderBy: { admissionDate: query.sortOrder ?? 'desc' },
    }),
    prisma.admission.count({ where }),
  ]);

  return { admissions, total, page, limit };
}

/**
 * Get a single admission by ID.
 */
export async function getAdmissionById(tenantId: string, id: string) {
  const admission = await prisma.admission.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          dateOfBirth: true,
          gender: true,
          bloodGroup: true,
        },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
          department: { select: { id: true, name: true } },
        },
      },
      ward: { select: { id: true, name: true } },
      bed: { select: { id: true, bedNumber: true } },
      visit: {
        select: { id: true, visitType: true, visitDate: true, chiefComplaint: true, status: true },
      },
      admitter: { select: { id: true, firstName: true, lastName: true } },
      discharger: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  if (!admission) {
    throw AppError.notFound('Admission not found');
  }

  return admission;
}

/**
 * Update an admission.
 */
export async function updateAdmission(tenantId: string, id: string, data: UpdateAdmissionInput) {
  const admission = await prisma.admission.findFirst({
    where: { id, tenantId },
  });

  if (!admission) {
    throw AppError.notFound('Admission not found');
  }

  if (admission.status === 'discharged') {
    throw AppError.badRequest('Cannot update a discharged admission');
  }

  // If changing bed, verify bed exists in the ward (bed→room→ward)
  if (data.bedId) {
    const wardId = data.wardId ?? admission.wardId;
    const bed = await prisma.bed.findFirst({
      where: { id: data.bedId, room: { wardId } },
    });
    if (!bed) {
      throw AppError.notFound('Bed not found in the specified ward');
    }
  }

  const updated = await prisma.admission.update({
    where: { id },
    data: {
      ...(data.wardId && { wardId: data.wardId }),
      ...(data.bedId && { bedId: data.bedId }),
      ...(data.expectedDischargeDate !== undefined && {
        expectedDischargeDate: data.expectedDischargeDate
          ? new Date(data.expectedDischargeDate)
          : null,
      }),
      ...(data.admissionReason !== undefined && { admissionReason: data.admissionReason }),
      ...(data.depositAmount !== undefined && { depositAmount: data.depositAmount }),
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      doctor: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      ward: { select: { id: true, name: true } },
      bed: { select: { id: true, bedNumber: true } },
    },
  });

  logger.info({ tenantId, admissionId: id }, 'Admission updated');
  return updated;
}

/**
 * Discharge a patient (close admission).
 */
export async function dischargePatient(
  tenantId: string,
  id: string,
  userId: string,
  data?: { dischargeDate?: string; notes?: string },
) {
  const admission = await prisma.admission.findFirst({
    where: { id, tenantId },
  });

  if (!admission) {
    throw AppError.notFound('Admission not found');
  }

  if (admission.status === 'discharged') {
    throw AppError.badRequest('Patient is already discharged');
  }

  const dischargeDate = data?.dischargeDate ? new Date(data.dischargeDate) : new Date();

  const updated = await prisma.$transaction(async (tx) => {
    // Update admission status
    const discharged = await tx.admission.update({
      where: { id },
      data: {
        status: 'discharged',
        dischargeDate,
        dischargedBy: userId,
      },
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true },
        },
        doctor: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
        ward: { select: { id: true, name: true } },
        bed: { select: { id: true, bedNumber: true } },
      },
    });

    // Update the visit status to discharged
    await tx.visit.update({
      where: { id: admission.visitId },
      data: { status: 'discharged' },
    });

    return discharged;
  });

  logger.info({ tenantId, admissionId: id }, 'Patient discharged');
  return updated;
}

// ==================== Transfers ====================

/**
 * Create a patient transfer request.
 */
export async function createTransfer(tenantId: string, userId: string, data: CreateTransferInput) {
  // Verify visit belongs to tenant
  const visit = await prisma.visit.findFirst({
    where: { id: data.visitId, tenantId },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const transfer = await prisma.patientTransfer.create({
    data: {
      tenantId,
      patientId: data.patientId,
      visitId: data.visitId,
      transferType: data.transferType,
      fromDoctorId: data.fromDoctorId,
      toDoctorId: data.toDoctorId,
      fromBedId: data.fromBedId,
      toBedId: data.toBedId,
      fromWardId: data.fromWardId,
      toWardId: data.toWardId,
      reason: data.reason,
      requestedBy: userId,
      status: 'requested',
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      fromDoctor: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      toDoctor: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      fromWard: { select: { id: true, name: true } },
      toWard: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, transferId: transfer.id }, 'Transfer request created');
  return transfer;
}

/**
 * Get paginated list of transfers.
 */
export async function getTransfers(tenantId: string, query: GetTransfersQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.visitId) where.visitId = query.visitId;
  if (query.status) where.status = query.status;
  if (query.transferType) where.transferType = query.transferType;
  if (query.fromDoctorId) where.fromDoctorId = query.fromDoctorId;
  if (query.toDoctorId) where.toDoctorId = query.toDoctorId;

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { reason: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [transfers, total] = await Promise.all([
    prisma.patientTransfer.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true },
        },
        fromDoctor: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
        toDoctor: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
        fromWard: { select: { id: true, name: true } },
        toWard: { select: { id: true, name: true } },
        requester: { select: { id: true, firstName: true, lastName: true } },
        approver: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: query.sortOrder ?? 'desc' },
    }),
    prisma.patientTransfer.count({ where }),
  ]);

  return { transfers, total, page, limit };
}

/**
 * Get a single transfer by ID.
 */
export async function getTransferById(tenantId: string, id: string) {
  const transfer = await prisma.patientTransfer.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          phone: true,
        },
      },
      visit: {
        select: { id: true, visitType: true, visitDate: true, status: true },
      },
      fromDoctor: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      toDoctor: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      fromBed: { select: { id: true, bedNumber: true } },
      toBed: { select: { id: true, bedNumber: true } },
      fromWard: { select: { id: true, name: true } },
      toWard: { select: { id: true, name: true } },
      requester: { select: { id: true, firstName: true, lastName: true } },
      approver: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  if (!transfer) {
    throw AppError.notFound('Transfer not found');
  }

  return transfer;
}

/**
 * Approve or reject a transfer.
 */
export async function approveTransfer(
  tenantId: string,
  id: string,
  userId: string,
  data?: { status?: 'approved' | 'rejected'; notes?: string },
) {
  const transfer = await prisma.patientTransfer.findFirst({
    where: { id, tenantId },
  });

  if (!transfer) {
    throw AppError.notFound('Transfer not found');
  }

  if (transfer.status !== 'requested') {
    throw AppError.badRequest(`Transfer has already been ${transfer.status}`);
  }

  const newStatus = data?.status ?? 'approved';

  const updated = await prisma.patientTransfer.update({
    where: { id },
    data: {
      status: newStatus,
      approvedBy: userId,
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      fromDoctor: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      toDoctor: {
        include: { user: { select: { firstName: true, lastName: true } } },
      },
      fromWard: { select: { id: true, name: true } },
      toWard: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, transferId: id, status: newStatus }, 'Transfer status updated');
  return updated;
}

// ==================== Vitals ====================

/**
 * Record vital signs for a patient.
 * Scoped by tenant through the visit relation since Vital has no tenantId.
 */
export async function recordVitals(tenantId: string, userId: string, data: RecordVitalsInput) {
  // Verify visit belongs to tenant
  const visit = await prisma.visit.findFirst({
    where: { id: data.visitId, tenantId },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  // Verify patient matches the visit
  if (visit.patientId !== data.patientId) {
    throw AppError.badRequest('Patient does not match the visit');
  }

  // Calculate BMI if weight and height provided
  let bmi: number | undefined;
  if (data.weightKg && data.heightCm && data.heightCm >= 30) {
    const heightM = data.heightCm / 100;
    const rawBmi = parseFloat((data.weightKg / (heightM * heightM)).toFixed(1));
    // Clamp to Decimal(4,1) range (max 999.9) — reject obviously wrong values
    bmi = rawBmi > 0 && rawBmi < 999.9 ? rawBmi : undefined;
  }

  // Clamp decimal values to their column precision to prevent overflow
  const clamp = (val: number | undefined | null, max: number): number | undefined =>
    val != null && val > 0 && val <= max ? val : undefined;

  const vital = await prisma.vital.create({
    data: {
      visitId: data.visitId,
      patientId: data.patientId,
      bloodPressureSystolic: data.bloodPressureSystolic,
      bloodPressureDiastolic: data.bloodPressureDiastolic,
      pulseRate: data.pulseRate,
      temperature: clamp(data.temperature, 999.9),         // Decimal(4,1)
      respiratoryRate: data.respiratoryRate,
      oxygenSaturation: clamp(data.oxygenSaturation, 100), // Decimal(4,1), max 100%
      weightKg: clamp(data.weightKg, 999.99),              // Decimal(5,2)
      heightCm: clamp(data.heightCm, 9999.9),              // Decimal(5,1)
      bmi,
      bloodSugar: clamp(data.bloodSugar, 9999.99),         // Decimal(6,2)
      notes: data.notes,
      recordedBy: userId,
    },
    include: {
      recorder: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ visitId: data.visitId, vitalId: vital.id }, 'Vitals recorded');
  return vital;
}

/**
 * Get paginated vitals for a patient.
 * Scoped by tenant through the visit relation.
 */
export async function getVitals(tenantId: string, patientId: string, query: GetVitalsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const where: any = {
    patientId,
    visit: { tenantId },
  };

  if (query.visitId) {
    where.visitId = query.visitId;
  }

  const [vitals, total] = await Promise.all([
    prisma.vital.findMany({
      where,
      skip,
      take,
      include: {
        recorder: { select: { id: true, firstName: true, lastName: true } },
        visit: { select: { id: true, visitDate: true, visitType: true } },
      },
      orderBy: { recordedAt: 'desc' },
    }),
    prisma.vital.count({ where }),
  ]);

  return { vitals, total, page, limit };
}

/**
 * Get all vitals for a tenant (across all patients).
 */
export async function getAllVitals(tenantId: string, query: GetAllVitalsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = {
    visit: { tenantId },
  };

  if (query.patientId) where.patientId = query.patientId;
  if (query.visitId) where.visitId = query.visitId;

  if (query.search) {
    where.patient = {
      OR: [
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { lastName: { contains: query.search, mode: 'insensitive' } },
        { mrn: { contains: query.search, mode: 'insensitive' } },
      ],
    };
  }

  const [vitals, total] = await Promise.all([
    prisma.vital.findMany({
      where,
      skip,
      take,
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        recorder: { select: { id: true, firstName: true, lastName: true } },
        visit: { select: { id: true, visitDate: true, visitType: true } },
      },
      orderBy: { recordedAt: 'desc' },
    }),
    prisma.vital.count({ where }),
  ]);

  return { vitals, total, page, limit };
}

/**
 * Get latest vitals for a patient.
 * Scoped by tenant through the visit relation.
 */
export async function getLatestVitals(tenantId: string, patientId: string) {
  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const vital = await prisma.vital.findFirst({
    where: {
      patientId,
      visit: { tenantId },
    },
    include: {
      recorder: { select: { id: true, firstName: true, lastName: true } },
      visit: { select: { id: true, visitDate: true, visitType: true } },
    },
    orderBy: { recordedAt: 'desc' },
  });

  return vital;
}

// ==================== Diagnoses ====================

/**
 * Add a diagnosis for a patient.
 * Scoped by tenant through the visit relation since Diagnosis has no tenantId.
 */
export async function addDiagnosis(tenantId: string, userId: string, data: AddDiagnosisInput) {
  // Verify visit belongs to tenant
  const visit = await prisma.visit.findFirst({
    where: { id: data.visitId, tenantId },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  // Verify patient matches the visit
  if (visit.patientId !== data.patientId) {
    throw AppError.badRequest('Patient does not match the visit');
  }

  const diagnosis = await prisma.diagnosis.create({
    data: {
      visitId: data.visitId,
      patientId: data.patientId,
      icdCode: data.icdCode,
      diagnosisName: data.diagnosisName,
      diagnosisType: data.diagnosisType ?? 'primary',
      notes: data.notes,
      diagnosedBy: userId,
    },
    include: {
      diagnoser: { select: { id: true, firstName: true, lastName: true } },
      visit: { select: { id: true, visitDate: true, visitType: true } },
    },
  });

  logger.info({ visitId: data.visitId, diagnosisId: diagnosis.id }, 'Diagnosis added');
  return diagnosis;
}

/**
 * Get diagnoses for a patient.
 * Scoped by tenant through the visit relation.
 */
export async function getDiagnoses(tenantId: string, patientId: string, query: GetDiagnosesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const where: any = {
    patientId,
    visit: { tenantId },
  };

  if (query.visitId) where.visitId = query.visitId;
  if (query.diagnosisType) where.diagnosisType = query.diagnosisType;

  if (query.search) {
    where.OR = [
      { diagnosisName: { contains: query.search, mode: 'insensitive' } },
      { icdCode: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [diagnoses, total] = await Promise.all([
    prisma.diagnosis.findMany({
      where,
      skip,
      take,
      include: {
        diagnoser: { select: { id: true, firstName: true, lastName: true } },
        visit: { select: { id: true, visitDate: true, visitType: true } },
      },
      orderBy: { diagnosedAt: 'desc' },
    }),
    prisma.diagnosis.count({ where }),
  ]);

  return { diagnoses, total, page, limit };
}

/**
 * Get all diagnoses for a tenant (across all patients).
 */
export async function getAllDiagnoses(tenantId: string, query: GetAllDiagnosesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = {
    visit: { tenantId },
  };

  if (query.patientId) where.patientId = query.patientId;
  if (query.visitId) where.visitId = query.visitId;
  if (query.diagnosisType) where.diagnosisType = query.diagnosisType;

  if (query.search) {
    where.OR = [
      { diagnosisName: { contains: query.search, mode: 'insensitive' } },
      { icdCode: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [diagnoses, total] = await Promise.all([
    prisma.diagnosis.findMany({
      where,
      skip,
      take,
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        diagnoser: { select: { id: true, firstName: true, lastName: true } },
        visit: { select: { id: true, visitDate: true, visitType: true } },
      },
      orderBy: { diagnosedAt: 'desc' },
    }),
    prisma.diagnosis.count({ where }),
  ]);

  return { diagnoses, total, page, limit };
}

/**
 * Update a diagnosis.
 * Scoped by tenant through the visit relation.
 */
export async function updateDiagnosis(tenantId: string, id: string, data: UpdateDiagnosisInput) {
  const diagnosis = await prisma.diagnosis.findFirst({
    where: {
      id,
      visit: { tenantId },
    },
  });

  if (!diagnosis) {
    throw AppError.notFound('Diagnosis not found');
  }

  const updated = await prisma.diagnosis.update({
    where: { id },
    data: {
      ...(data.icdCode !== undefined && { icdCode: data.icdCode }),
      ...(data.diagnosisName && { diagnosisName: data.diagnosisName }),
      ...(data.diagnosisType && { diagnosisType: data.diagnosisType }),
      ...(data.notes !== undefined && { notes: data.notes }),
    },
    include: {
      diagnoser: { select: { id: true, firstName: true, lastName: true } },
      visit: { select: { id: true, visitDate: true, visitType: true } },
    },
  });

  logger.info({ diagnosisId: id }, 'Diagnosis updated');
  return updated;
}

/**
 * Delete a diagnosis.
 * Scoped by tenant through the visit relation.
 */
export async function deleteDiagnosis(tenantId: string, id: string) {
  const diagnosis = await prisma.diagnosis.findFirst({
    where: {
      id,
      visit: { tenantId },
    },
  });

  if (!diagnosis) {
    throw AppError.notFound('Diagnosis not found');
  }

  await prisma.diagnosis.delete({ where: { id } });

  logger.info({ diagnosisId: id }, 'Diagnosis deleted');
}

// ==================== OT Requests ====================

/**
 * Create an OT (Operating Theater) request.
 */
export async function createOtRequest(tenantId: string, data: CreateOtRequestInput) {
  // Verify patient belongs to tenant
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Verify visit belongs to tenant
  const visit = await prisma.visit.findFirst({
    where: { id: data.visitId, tenantId },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  // Verify doctor belongs to tenant
  const doctor = await prisma.doctorProfile.findFirst({
    where: { id: data.doctorId, tenantId },
  });
  if (!doctor) {
    throw AppError.notFound('Doctor not found');
  }

  const otRequest = await prisma.otRequest.create({
    data: {
      tenantId,
      patientId: data.patientId,
      visitId: data.visitId,
      doctorId: data.doctorId,
      procedureName: data.procedureName,
      procedureDetails: data.procedureDetails,
      urgency: data.urgency ?? 'elective',
      preferredDate: data.preferredDate ? new Date(data.preferredDate) : undefined,
      preferredTime: data.preferredTime ? new Date(`1970-01-01T${data.preferredTime}`) : undefined,
      durationMinutes: data.durationMinutes,
      requiredEquipment: data.requiredEquipment ?? undefined,
      status: 'requested',
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
        },
      },
      visit: {
        select: { id: true, visitType: true, visitDate: true },
      },
      ot: true,
    },
  });

  logger.info({ tenantId, otRequestId: otRequest.id }, 'OT request created');
  return otRequest;
}

/**
 * Get paginated list of OT requests with filters.
 */
export async function getOtRequests(tenantId: string, query: GetOtRequestsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.status) where.status = query.status;
  if (query.doctorId) where.doctorId = query.doctorId;
  if (query.patientId) where.patientId = query.patientId;

  if (query.fromDate) {
    where.preferredDate = { ...where.preferredDate, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.preferredDate = { ...where.preferredDate, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { procedureName: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [otRequests, total] = await Promise.all([
    prisma.otRequest.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
        },
        doctor: {
          include: {
            user: { select: { firstName: true, lastName: true } },
            department: { select: { id: true, name: true } },
          },
        },
        visit: {
          select: { id: true, visitType: true, visitDate: true },
        },
        ot: true,
      },
      orderBy: { createdAt: query.sortOrder ?? 'desc' },
    }),
    prisma.otRequest.count({ where }),
  ]);

  return { otRequests, total, page, limit };
}

/**
 * Get a single OT request by ID.
 */
export async function getOtRequestById(tenantId: string, id: string) {
  const otRequest = await prisma.otRequest.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          dateOfBirth: true,
          gender: true,
          bloodGroup: true,
        },
      },
      doctor: {
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
          department: { select: { id: true, name: true } },
        },
      },
      visit: {
        select: { id: true, visitType: true, visitDate: true, chiefComplaint: true, status: true },
      },
      ot: true,
    },
  });

  if (!otRequest) {
    throw AppError.notFound('OT request not found');
  }

  return otRequest;
}

// ==================== Reservations ====================

export async function createReservation(tenantId: string, userId: string, data: CreateReservationInput) {
  const reservation = await prisma.reservation.create({
    data: {
      tenantId,
      patientId: data.patientId,
      doctorId: data.doctorId,
      wardId: data.wardId,
      bedId: data.bedId,
      reservedDate: new Date(data.reservedDate),
      expectedAdmission: data.expectedAdmission ? new Date(data.expectedAdmission) : undefined,
      diagnosis: data.diagnosis,
      speciality: data.speciality,
      advanceAmount: data.advanceAmount ?? 0,
      notes: data.notes,
      createdBy: userId,
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      ward: { select: { id: true, name: true } },
      bed: { select: { id: true, bedNumber: true } },
    },
  });

  logger.info({ tenantId, reservationId: reservation.id }, 'Reservation created');
  return reservation;
}

export async function getReservations(tenantId: string, query: GetReservationsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.doctorId) where.doctorId = query.doctorId;
  if (query.wardId) where.wardId = query.wardId;
  if (query.status) where.status = query.status;

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
      { diagnosis: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  if (query.fromDate || query.toDate) {
    where.reservedDate = {};
    if (query.fromDate) where.reservedDate.gte = new Date(query.fromDate);
    if (query.toDate) {
      const end = new Date(query.toDate);
      end.setUTCHours(23, 59, 59, 999);
      where.reservedDate.lte = end;
    }
  }

  const [reservations, total] = await Promise.all([
    prisma.reservation.findMany({
      where,
      skip,
      take,
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
        ward: { select: { id: true, name: true } },
        bed: { select: { id: true, bedNumber: true } },
      },
      orderBy: { reservedDate: 'desc' },
    }),
    prisma.reservation.count({ where }),
  ]);

  return { reservations, total, page, limit };
}

export async function getReservationById(tenantId: string, id: string) {
  const reservation = await prisma.reservation.findFirst({
    where: { id, tenantId },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      ward: { select: { id: true, name: true } },
      bed: { select: { id: true, bedNumber: true } },
    },
  });
  if (!reservation) throw AppError.notFound('Reservation not found');
  return reservation;
}

export async function updateReservation(tenantId: string, id: string, data: UpdateReservationInput) {
  const existing = await prisma.reservation.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Reservation not found');

  const reservation = await prisma.reservation.update({
    where: { id },
    data: {
      ...(data.wardId && { wardId: data.wardId }),
      ...(data.bedId !== undefined && { bedId: data.bedId }),
      ...(data.expectedAdmission && { expectedAdmission: new Date(data.expectedAdmission) }),
      ...(data.diagnosis !== undefined && { diagnosis: data.diagnosis }),
      ...(data.advanceAmount !== undefined && { advanceAmount: data.advanceAmount }),
      ...(data.notes !== undefined && { notes: data.notes }),
      ...(data.status && { status: data.status as any }),
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      ward: { select: { id: true, name: true } },
      bed: { select: { id: true, bedNumber: true } },
    },
  });

  logger.info({ tenantId, reservationId: id }, 'Reservation updated');
  return reservation;
}

// ==================== Estimations ====================

export async function createEstimation(tenantId: string, userId: string, data: CreateEstimationInput) {
  const estimation = await prisma.estimation.create({
    data: {
      tenantId,
      patientId: data.patientId,
      doctorId: data.doctorId,
      complaints: data.complaints,
      estimationPeriodDays: data.estimationPeriodDays ?? 1,
      totalEstimateAmount: data.totalEstimateAmount,
      items: data.items ?? [],
      notes: data.notes,
      admissionId: data.admissionId,
      createdBy: userId,
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
    },
  });

  logger.info({ tenantId, estimationId: estimation.id }, 'Estimation created');
  return estimation;
}

export async function getEstimations(tenantId: string, query: GetEstimationsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.doctorId) where.doctorId = query.doctorId;
  if (query.status) where.status = query.status;

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
      { complaints: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  if (query.fromDate || query.toDate) {
    where.createdAt = {};
    if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
    if (query.toDate) {
      const end = new Date(query.toDate);
      end.setUTCHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }

  const [estimations, total] = await Promise.all([
    prisma.estimation.findMany({
      where,
      skip,
      take,
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.estimation.count({ where }),
  ]);

  return { estimations, total, page, limit };
}

export async function getEstimationById(tenantId: string, id: string) {
  const estimation = await prisma.estimation.findFirst({
    where: { id, tenantId },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
    },
  });
  if (!estimation) throw AppError.notFound('Estimation not found');
  return estimation;
}

export async function updateEstimation(tenantId: string, id: string, data: UpdateEstimationInput) {
  const existing = await prisma.estimation.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Estimation not found');

  const estimation = await prisma.estimation.update({
    where: { id },
    data: {
      ...(data.complaints !== undefined && { complaints: data.complaints }),
      ...(data.estimationPeriodDays && { estimationPeriodDays: data.estimationPeriodDays }),
      ...(data.totalEstimateAmount !== undefined && { totalEstimateAmount: data.totalEstimateAmount }),
      ...(data.items && { items: data.items }),
      ...(data.notes !== undefined && { notes: data.notes }),
      ...(data.status && { status: data.status as any }),
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
    },
  });

  logger.info({ tenantId, estimationId: id }, 'Estimation updated');
  return estimation;
}
