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
  GetClinicalOrdersQuery,
  AcknowledgeClinicalOrderInput,
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
 *
 * On approval the receiving doctor / bed / ward is actually applied to the
 * underlying records (visit, admission, appointment, bed occupancy) so the
 * patient appears in the destination's worklist. Rejection is purely a status
 * change.
 */
export async function approveTransfer(
  tenantId: string,
  id: string,
  userId: string,
  data?: { status?: 'approved' | 'rejected'; notes?: string },
) {
  const transfer = await prisma.patientTransfer.findFirst({
    where: { id, tenantId },
    include: { visit: { select: { id: true, appointmentId: true, patientId: true } } },
  });

  if (!transfer) {
    throw AppError.notFound('Transfer not found');
  }

  if (transfer.status !== 'requested') {
    throw AppError.badRequest(`Transfer has already been ${transfer.status}`);
  }

  const newStatus = data?.status ?? 'approved';

  const updated = await prisma.$transaction(async (tx) => {
    if (newStatus === 'approved') {
      switch (transfer.transferType) {
        case 'doctor_to_doctor': {
          if (!transfer.toDoctorId) {
            throw AppError.badRequest('Transfer is missing the receiving doctor');
          }
          // Reassign the visit to the receiving doctor.
          await tx.visit.update({
            where: { id: transfer.visitId },
            data: { doctorId: transfer.toDoctorId },
          });
          // Mirror onto the active admission (if IP) so the IP worklist follows.
          await tx.admission.updateMany({
            where: { visitId: transfer.visitId, tenantId },
            data: { doctorId: transfer.toDoctorId },
          });
          // Move the linked appointment so the patient surfaces on the new
          // doctor's OP list.
          if (transfer.visit?.appointmentId) {
            await tx.appointment.update({
              where: { id: transfer.visit.appointmentId },
              data: { doctorId: transfer.toDoctorId },
            });
          }
          break;
        }
        case 'ward_to_ward':
        case 'bed_to_bed': {
          const admission = await tx.admission.findFirst({
            where: { visitId: transfer.visitId, tenantId },
          });
          if (!admission) {
            throw AppError.badRequest('No active admission found for this transfer');
          }
          const admissionUpdate: { wardId?: string; bedId?: string } = {};
          if (transfer.toWardId) admissionUpdate.wardId = transfer.toWardId;
          if (transfer.toBedId) admissionUpdate.bedId = transfer.toBedId;
          if (Object.keys(admissionUpdate).length > 0) {
            await tx.admission.update({
              where: { id: admission.id },
              data: admissionUpdate,
            });
          }
          // Free the old bed and occupy the new one.
          if (transfer.fromBedId && transfer.fromBedId !== transfer.toBedId) {
            await tx.bed.update({
              where: { id: transfer.fromBedId },
              data: { status: 'available', currentPatientId: null },
            });
          }
          if (transfer.toBedId) {
            await tx.bed.update({
              where: { id: transfer.toBedId },
              data: { status: 'occupied', currentPatientId: transfer.patientId },
            });
          }
          break;
        }
      }
    }

    return tx.patientTransfer.update({
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
  });

  logger.info(
    { tenantId, transferId: id, status: newStatus, type: transfer.transferType },
    'Transfer status updated',
  );
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

// ============================================================
// Clinical Orders — Unified nurse view (lab + imaging)
// ============================================================

/**
 * Shape normalised across lab and imaging so the nurse UI can render
 * them in a single table.
 */
export interface NurseClinicalOrder {
  id: string;
  orderType: 'lab' | 'imaging';
  orderNumber: string;
  status: string;
  priority: string;
  description: string;
  createdAt: Date;
  patientId: string;
  patient: { id: string; firstName: string; lastName: string; mrn: string | null } | null;
  doctor: { id: string; user: { firstName: string; lastName: string } | null } | null;
  wardId: string | null;
  ward: { id: string; name: string } | null;
}

/**
 * Fetch pending (or filtered) doctor orders across lab + imaging.
 * If `wardId` is provided we scope via the admission bound to the order's visit.
 */
export async function getClinicalOrders(tenantId: string, query: GetClinicalOrdersQuery) {
  const status = query.status ?? 'pending';
  const type = query.type ?? 'all';
  const limit = query.limit ?? 100;

  // Lab "pending" = status='ordered'; imaging "pending" = status='requested'.
  const labWhere: any = { tenantId };
  const imagingWhere: any = { tenantId };

  if (status === 'pending') {
    labWhere.status = 'ordered';
    imagingWhere.status = 'requested';
  } else if (status === 'completed') {
    labWhere.status = 'completed';
    imagingWhere.status = 'completed';
  } else if (status === 'cancelled') {
    labWhere.status = 'cancelled';
    imagingWhere.status = 'cancelled';
  }

  // Ward filter resolves via admission.visitId === visitId
  if (query.wardId) {
    const admission = { some: { wardId: query.wardId, tenantId } };
    labWhere.visit = { admission };
    imagingWhere.visit = { admission };
  }

  const [labOrders, imagingOrders] = await Promise.all([
    type === 'imaging'
      ? Promise.resolve([])
      : prisma.labOrder.findMany({
          where: labWhere,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
            orderer: { select: { id: true, firstName: true, lastName: true } },
            visit: {
              select: {
                id: true,
                admission: {
                  select: {
                    wardId: true,
                    ward: { select: { id: true, name: true } },
                  },
                },
              },
            },
            labOrderItems: {
              include: { test: { select: { testName: true } } },
            },
          },
        }),
    type === 'lab'
      ? Promise.resolve([])
      : prisma.imagingRequest.findMany({
          where: imagingWhere,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
            orderer: { select: { id: true, firstName: true, lastName: true } },
            visit: {
              select: {
                id: true,
                admission: {
                  select: {
                    wardId: true,
                    ward: { select: { id: true, name: true } },
                  },
                },
              },
            },
          },
        }),
  ]);

  const normalised: NurseClinicalOrder[] = [];

  for (const o of labOrders as any[]) {
    const testNames = (o.labOrderItems ?? [])
      .map((i: any) => i.test?.testName)
      .filter(Boolean)
      .join(', ');
    normalised.push({
      id: o.id,
      orderType: 'lab',
      orderNumber: o.id.slice(0, 8).toUpperCase(),
      status: o.status,
      priority: o.urgency,
      description: testNames || 'Lab order',
      createdAt: o.createdAt,
      patientId: o.patientId,
      patient: o.patient,
      doctor: o.orderer
        ? { id: o.orderer.id, user: { firstName: o.orderer.firstName, lastName: o.orderer.lastName } }
        : null,
      wardId: o.visit?.admission?.wardId ?? null,
      ward: o.visit?.admission?.ward ?? null,
    });
  }

  for (const o of imagingOrders as any[]) {
    normalised.push({
      id: o.id,
      orderType: 'imaging',
      orderNumber: o.id.slice(0, 8).toUpperCase(),
      status: o.status,
      priority: o.urgency,
      description: `${o.imagingType}${o.bodyPart ? ' — ' + o.bodyPart : ''}${o.clinicalIndication ? ' (' + o.clinicalIndication + ')' : ''}`,
      createdAt: o.createdAt,
      patientId: o.patientId,
      patient: o.patient,
      doctor: o.orderer
        ? { id: o.orderer.id, user: { firstName: o.orderer.firstName, lastName: o.orderer.lastName } }
        : null,
      wardId: o.visit?.admission?.wardId ?? null,
      ward: o.visit?.admission?.ward ?? null,
    });
  }

  // Sort newest-first after merging.
  normalised.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return normalised;
}

/**
 * Record nurse acknowledgment of a doctor order as a nursing note.
 * This gives us an audit trail without schema changes. The note is
 * attached to the order's visit + patient and tagged via metadata.
 */
export async function acknowledgeClinicalOrder(
  tenantId: string,
  userId: string,
  data: AcknowledgeClinicalOrderInput,
) {
  let patientId: string;
  let visitId: string;
  let description: string;

  if (data.orderType === 'lab') {
    const order = await prisma.labOrder.findFirst({
      where: { id: data.orderId, tenantId },
      select: { patientId: true, visitId: true, id: true },
    });
    if (!order) throw AppError.notFound('Lab order not found');
    patientId = order.patientId;
    visitId = order.visitId;
    description = `Lab order ${order.id.slice(0, 8).toUpperCase()}`;
  } else {
    const order = await prisma.imagingRequest.findFirst({
      where: { id: data.orderId, tenantId },
      select: { patientId: true, visitId: true, id: true, imagingType: true },
    });
    if (!order) throw AppError.notFound('Imaging request not found');
    patientId = order.patientId;
    visitId = order.visitId;
    description = `Imaging request (${order.imagingType})`;
  }

  const content = data.note?.trim()
    ? `Acknowledged ${description}. ${data.note.trim()}`
    : `Acknowledged ${description}.`;

  const note = await prisma.nursingNote.create({
    data: {
      patientId,
      visitId,
      nurseId: userId,
      noteType: 'observation',
      content,
      metadata: {
        kind: 'order_acknowledgment',
        orderType: data.orderType,
        orderId: data.orderId,
      },
    },
  });

  logger.info(
    { tenantId, orderType: data.orderType, orderId: data.orderId, noteId: note.id },
    'Clinical order acknowledged by nurse',
  );
  return { noteId: note.id, orderType: data.orderType, orderId: data.orderId };
}

