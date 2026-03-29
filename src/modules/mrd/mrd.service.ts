import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';

interface GetMrdQuery {
  page?: number;
  limit?: number;
  direction?: string;
  status?: string;
  search?: string;
}

interface CreateMrdInput {
  patientId: string;
  locationFrom?: string;
  wardRoom?: string;
  doctorId?: string;
  notes?: string;
}

export async function getMrdDocuments(tenantId: string, query: GetMrdQuery) {
  const { skip, take, page, limit } = getPaginationParams(query as any);

  const where: any = { tenantId };

  if (query.direction) where.direction = query.direction;
  if (query.status) where.status = query.status;

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
      { requestedTo: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [documents, total] = await Promise.all([
    prisma.mrdRequest.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
        },
        user: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.mrdRequest.count({ where }),
  ]);

  return { documents, total, page, limit };
}

export async function createMrdRequest(
  tenantId: string,
  userId: string,
  data: CreateMrdInput,
) {
  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });

  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const mrdRequest = await prisma.mrdRequest.create({
    data: {
      tenantId,
      patientId: data.patientId,
      requestedTo: 'MRD Department',
      requestedBy: userId,
      locationFrom: data.locationFrom,
      wardRoom: data.wardRoom,
      status: 'initiated',
      direction: 'outbound',
      notes: data.notes,
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
      },
    },
  });

  logger.info({ tenantId, mrdId: mrdRequest.id }, 'MRD request created');
  return mrdRequest;
}

// ==================== Discharge Summary ====================

const dischargeSummaryInclude = {
  admission: {
    select: {
      id: true,
      admissionDate: true,
      dischargeDate: true,
      admissionReason: true,
      status: true,
      ward: { select: { id: true, name: true } },
      bed: { select: { id: true, bedNumber: true } },
    },
  },
  visit: {
    select: { id: true, visitType: true, visitDate: true, chiefComplaint: true },
  },
  patient: {
    select: {
      id: true,
      mrn: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      gender: true,
      phone: true,
      bloodGroup: true,
    },
  },
  doctor: {
    select: {
      id: true,
      user: { select: { firstName: true, lastName: true } },
      specialization: true,
    },
  },
  signer: {
    select: { id: true, firstName: true, lastName: true },
  },
};

export async function generateDischargeSummary(tenantId: string, admissionId: string) {
  // Check if a discharge summary already exists for this admission
  const existing = await prisma.dischargeSummary.findUnique({
    where: { admissionId },
    include: dischargeSummaryInclude,
  });

  if (existing) {
    return existing;
  }

  // Get admission with related data
  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    include: {
      visit: true,
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          dateOfBirth: true,
          gender: true,
          phone: true,
          bloodGroup: true,
        },
      },
      doctor: {
        select: {
          id: true,
          user: { select: { firstName: true, lastName: true } },
          specialization: true,
        },
      },
    },
  });

  if (!admission) {
    throw AppError.notFound('Admission not found');
  }

  const visitId = admission.visitId;
  const patientId = admission.patientId;

  // Fetch related clinical data in parallel
  const [diagnoses, pinnedNotes, labResults, prescriptions] = await Promise.all([
    // Diagnoses for this visit
    prisma.diagnosis.findMany({
      where: { visitId },
      orderBy: { diagnosedAt: 'asc' },
    }),

    // Progress notes pinned to discharge summary
    prisma.progressNote.findMany({
      where: { visitId, pinToDischargeSummary: true, status: 'active' },
      orderBy: { createdAt: 'asc' },
    }),

    // Lab results for this visit (via lab orders)
    prisma.labResult.findMany({
      where: {
        labOrder: { visitId, tenantId },
      },
      include: {
        labOrderItem: {
          select: { test: { select: { testName: true } } },
        },
      },
      orderBy: { enteredAt: 'desc' },
    }),

    // Active prescriptions for this visit
    prisma.prescription.findMany({
      where: { visitId, tenantId, status: 'active' },
      include: {
        prescriptionItems: {
          select: {
            drugName: true,
            dosage: true,
            frequency: true,
            duration: true,
            route: true,
            instructions: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  // Build diagnoses summary text
  const diagnosesSummary = diagnoses.length > 0
    ? diagnoses
        .map((d) => {
          const code = d.icdCode ? ` (${d.icdCode})` : '';
          return `- [${d.diagnosisType}] ${d.diagnosisName}${code}`;
        })
        .join('\n')
    : null;

  // Build procedures summary from pinned notes
  const proceduresSummary = pinnedNotes.length > 0
    ? pinnedNotes
        .map((n) => `- [${n.noteType || 'note'}] ${n.content}`)
        .join('\n')
    : null;

  // Build lab results summary
  const labResultsSummary = labResults.length > 0
    ? labResults
        .map((r) => {
          const testName = r.labOrderItem?.test?.testName || 'Unknown Test';
          const abnormal = r.isAbnormal ? ' [ABNORMAL]' : '';
          return `- ${testName}: ${r.parameterName} = ${r.value ?? 'N/A'} ${r.unit ?? ''} (Ref: ${r.normalRange ?? 'N/A'})${abnormal}`;
        })
        .join('\n')
    : null;

  // Build medication reconciliation
  const medicationReconciliation = prescriptions.length > 0
    ? prescriptions
        .flatMap((p) =>
          p.prescriptionItems.map(
            (item) =>
              `- ${item.drugName} ${item.dosage} | ${item.frequency} | ${item.duration ?? 'ongoing'} | ${item.route}${item.instructions ? ` | ${item.instructions}` : ''}`,
          ),
        )
        .join('\n')
    : null;

  // Create the discharge summary record
  const dischargeSummary = await prisma.dischargeSummary.create({
    data: {
      admissionId,
      visitId,
      patientId,
      doctorId: admission.doctorId,
      admissionDate: admission.admissionDate,
      dischargeDate: admission.dischargeDate,
      diagnosesSummary,
      proceduresSummary,
      labResultsSummary,
      medicationReconciliation,
      status: 'draft',
    },
    include: dischargeSummaryInclude,
  });

  logger.info(
    { tenantId, dischargeSummaryId: dischargeSummary.id, admissionId },
    'Discharge summary generated',
  );

  return dischargeSummary;
}

export async function getDischargeSummaryById(tenantId: string, id: string) {
  const summary = await prisma.dischargeSummary.findUnique({
    where: { id },
    include: dischargeSummaryInclude,
  });

  if (!summary) {
    throw AppError.notFound('Discharge summary not found');
  }

  // Verify tenant access via admission
  const admission = await prisma.admission.findFirst({
    where: { id: summary.admissionId, tenantId },
    select: { id: true },
  });

  if (!admission) {
    throw AppError.notFound('Discharge summary not found');
  }

  return summary;
}

export async function getDischargeSummaryByAdmission(tenantId: string, admissionId: string) {
  // Verify admission belongs to tenant
  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    select: { id: true },
  });

  if (!admission) {
    throw AppError.notFound('Admission not found');
  }

  const summary = await prisma.dischargeSummary.findUnique({
    where: { admissionId },
    include: dischargeSummaryInclude,
  });

  if (!summary) {
    throw AppError.notFound('Discharge summary not found for this admission');
  }

  return summary;
}

interface UpdateDischargeSummaryInput {
  diagnosesSummary?: string;
  proceduresSummary?: string;
  labResultsSummary?: string;
  medicationReconciliation?: string;
  dischargeInstructions?: string;
  followUpDate?: string;
  followUpInstructions?: string;
}

export async function updateDischargeSummary(
  tenantId: string,
  id: string,
  data: UpdateDischargeSummaryInput,
) {
  // Verify the summary exists and belongs to tenant
  const existing = await getDischargeSummaryById(tenantId, id);

  if (existing.status !== 'draft') {
    throw AppError.badRequest('Cannot edit a discharge summary that is not in draft status');
  }

  const updateData: any = { ...data };
  if (data.followUpDate) {
    updateData.followUpDate = new Date(data.followUpDate);
  }

  const updated = await prisma.dischargeSummary.update({
    where: { id },
    data: updateData,
    include: dischargeSummaryInclude,
  });

  logger.info({ tenantId, dischargeSummaryId: id }, 'Discharge summary updated');
  return updated;
}

export async function signDischargeSummary(tenantId: string, id: string, userId: string) {
  const existing = await getDischargeSummaryById(tenantId, id);

  if (existing.status !== 'draft') {
    throw AppError.badRequest('Only draft discharge summaries can be signed');
  }

  const signed = await prisma.dischargeSummary.update({
    where: { id },
    data: {
      status: 'finalized',
      signedBy: userId,
      signedAt: new Date(),
    },
    include: dischargeSummaryInclude,
  });

  logger.info({ tenantId, dischargeSummaryId: id, signedBy: userId }, 'Discharge summary signed');
  return signed;
}

export async function publishDischargeSummary(tenantId: string, id: string) {
  const existing = await getDischargeSummaryById(tenantId, id);

  if (existing.status !== 'finalized') {
    throw AppError.badRequest('Only finalized discharge summaries can be published');
  }

  const published = await prisma.dischargeSummary.update({
    where: { id },
    data: {
      status: 'published',
      // In a real implementation, PDF generation would happen here
      // pdfUrl: await generatePdf(existing),
    },
    include: dischargeSummaryInclude,
  });

  logger.info({ tenantId, dischargeSummaryId: id }, 'Discharge summary published');
  return published;
}
