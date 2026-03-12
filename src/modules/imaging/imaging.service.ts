import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateImagingRequestInput,
  UpdateImagingRequestInput,
  GetImagingRequestsQuery,
  ScheduleImagingInput,
  UploadImagingResultInput,
  GetImagingResultsQuery,
  AddImagingReportInput,
} from './imaging.validation';

// ============================================================
// Imaging Requests
// ============================================================

export async function createImagingRequest(
  tenantId: string,
  userId: string,
  data: CreateImagingRequestInput,
) {
  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Verify visit exists
  const visit = await prisma.visit.findFirst({
    where: { id: data.visitId, tenantId },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  const request = await prisma.imagingRequest.create({
    data: {
      tenantId,
      patientId: data.patientId,
      visitId: data.visitId,
      orderedBy: userId,
      imagingType: data.imagingType,
      bodyPart: data.bodyPart,
      urgency: data.urgency,
      clinicalIndication: data.clinicalIndication,
      notes: data.notes,
      scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      orderer: { select: { id: true, firstName: true, lastName: true } },
      visit: { select: { id: true, visitType: true } },
    },
  });

  logger.info({ tenantId, imagingRequestId: request.id }, 'Imaging request created');
  return request;
}

export async function getImagingRequests(tenantId: string, query: GetImagingRequestsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.status) {
    where.status = query.status;
  }

  if (query.imagingType) {
    where.imagingType = query.imagingType;
  }

  if (query.urgency) {
    where.urgency = query.urgency;
  }

  if (query.patientId) {
    where.patientId = query.patientId;
  }

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { bodyPart: { contains: query.search, mode: 'insensitive' } },
      { clinicalIndication: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [requests, total] = await Promise.all([
    prisma.imagingRequest.findMany({
      where,
      skip,
      take,
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        orderer: { select: { id: true, firstName: true, lastName: true } },
        visit: { select: { id: true, visitType: true } },
      },
      orderBy: { createdAt: query.sortOrder || 'desc' },
    }),
    prisma.imagingRequest.count({ where }),
  ]);

  return { requests, total, page, limit };
}

export async function getImagingRequestById(tenantId: string, id: string) {
  const request = await prisma.imagingRequest.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          phone: true,
          dateOfBirth: true,
          gender: true,
        },
      },
      orderer: { select: { id: true, firstName: true, lastName: true, email: true } },
      visit: { select: { id: true, visitType: true } },
      imagingResult: true,
    },
  });

  if (!request) {
    throw AppError.notFound('Imaging request not found');
  }

  return request;
}

export async function updateImagingRequest(
  tenantId: string,
  id: string,
  data: UpdateImagingRequestInput,
) {
  const request = await prisma.imagingRequest.findFirst({
    where: { id, tenantId },
  });

  if (!request) {
    throw AppError.notFound('Imaging request not found');
  }

  if (request.status === 'completed' || request.status === 'cancelled') {
    throw AppError.badRequest(`Cannot update a ${request.status} imaging request`);
  }

  const updated = await prisma.imagingRequest.update({
    where: { id },
    data: {
      imagingType: data.imagingType,
      bodyPart: data.bodyPart,
      urgency: data.urgency,
      clinicalIndication: data.clinicalIndication,
      notes: data.notes,
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      orderer: { select: { id: true, firstName: true, lastName: true } },
      visit: { select: { id: true, visitType: true } },
    },
  });

  logger.info({ tenantId, imagingRequestId: id }, 'Imaging request updated');
  return updated;
}

export async function cancelImagingRequest(tenantId: string, id: string) {
  const request = await prisma.imagingRequest.findFirst({
    where: { id, tenantId },
  });

  if (!request) {
    throw AppError.notFound('Imaging request not found');
  }

  if (request.status === 'cancelled') {
    throw AppError.badRequest('Imaging request is already cancelled');
  }

  if (request.status === 'completed') {
    throw AppError.badRequest('Cannot cancel a completed imaging request');
  }

  const updated = await prisma.imagingRequest.update({
    where: { id },
    data: { status: 'cancelled' },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      orderer: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, imagingRequestId: id }, 'Imaging request cancelled');
  return updated;
}

export async function scheduleImaging(tenantId: string, id: string, data: ScheduleImagingInput) {
  const request = await prisma.imagingRequest.findFirst({
    where: { id, tenantId },
  });

  if (!request) {
    throw AppError.notFound('Imaging request not found');
  }

  if (request.status === 'completed' || request.status === 'cancelled') {
    throw AppError.badRequest(`Cannot schedule a ${request.status} imaging request`);
  }

  const updated = await prisma.imagingRequest.update({
    where: { id },
    data: {
      scheduledAt: new Date(data.scheduledAt),
      status: 'scheduled',
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      orderer: { select: { id: true, firstName: true, lastName: true } },
      visit: { select: { id: true, visitType: true } },
    },
  });

  logger.info({ tenantId, imagingRequestId: id }, 'Imaging request scheduled');
  return updated;
}

// ============================================================
// Imaging Results
// ============================================================

export async function uploadImagingResult(
  tenantId: string,
  userId: string,
  data: UploadImagingResultInput,
) {
  // Verify imaging request exists and belongs to tenant
  const request = await prisma.imagingRequest.findFirst({
    where: { id: data.imagingRequestId, tenantId },
  });

  if (!request) {
    throw AppError.notFound('Imaging request not found');
  }

  // Check if a result already exists
  const existingResult = await prisma.imagingResult.findUnique({
    where: { imagingRequestId: data.imagingRequestId },
  });

  if (existingResult) {
    throw AppError.conflict('A result already exists for this imaging request');
  }

  const result = await prisma.$transaction(async (tx) => {
    const newResult = await tx.imagingResult.create({
      data: {
        imagingRequestId: data.imagingRequestId,
        patientId: data.patientId,
        radiologistId: userId,
        findings: data.findings,
        impression: data.impression,
        imageUrls: data.imageUrls,
        pacsReferenceId: data.pacsReferenceId,
        status: 'draft',
      },
      include: {
        imagingRequest: {
          select: { id: true, imagingType: true, bodyPart: true, status: true },
        },
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        radiologist: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    // Update request status to completed
    await tx.imagingRequest.update({
      where: { id: data.imagingRequestId },
      data: { status: 'completed', completedAt: new Date() },
    });

    return newResult;
  });

  logger.info({ tenantId, imagingResultId: result.id }, 'Imaging result uploaded');
  return result;
}

export async function getImagingResults(tenantId: string, query: GetImagingResultsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = {
    imagingRequest: { tenantId },
  };

  if (query.status) {
    where.status = query.status;
  }

  if (query.imagingRequestId) {
    where.imagingRequestId = query.imagingRequestId;
  }

  if (query.patientId) {
    where.patientId = query.patientId;
  }

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { findings: { contains: query.search, mode: 'insensitive' } },
      { impression: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [results, total] = await Promise.all([
    prisma.imagingResult.findMany({
      where,
      skip,
      take,
      include: {
        imagingRequest: {
          select: { id: true, imagingType: true, bodyPart: true, urgency: true },
        },
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        radiologist: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: query.sortOrder || 'desc' },
    }),
    prisma.imagingResult.count({ where }),
  ]);

  return { results, total, page, limit };
}

export async function getImagingResultById(tenantId: string, id: string) {
  const result = await prisma.imagingResult.findFirst({
    where: { id, imagingRequest: { tenantId } },
    include: {
      imagingRequest: {
        select: {
          id: true,
          imagingType: true,
          bodyPart: true,
          urgency: true,
          clinicalIndication: true,
          status: true,
          notes: true,
        },
      },
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          phone: true,
          dateOfBirth: true,
          gender: true,
        },
      },
      radiologist: { select: { id: true, firstName: true, lastName: true, email: true } },
      signer: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  if (!result) {
    throw AppError.notFound('Imaging result not found');
  }

  return result;
}

export async function addImagingReport(
  tenantId: string,
  id: string,
  userId: string,
  data: AddImagingReportInput,
) {
  const result = await prisma.imagingResult.findFirst({
    where: { id, imagingRequest: { tenantId } },
  });

  if (!result) {
    throw AppError.notFound('Imaging result not found');
  }

  if (result.status === 'published') {
    throw AppError.badRequest('Cannot modify a published imaging result');
  }

  const updated = await prisma.imagingResult.update({
    where: { id },
    data: {
      findings: data.findings,
      impression: data.impression,
      pdfReportUrl: data.pdfReportUrl,
      radiologistId: userId,
      status: 'finalized',
    },
    include: {
      imagingRequest: {
        select: { id: true, imagingType: true, bodyPart: true },
      },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      radiologist: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, imagingResultId: id, reportedBy: userId }, 'Imaging report added');
  return updated;
}

export async function verifyImagingResult(tenantId: string, id: string, userId: string) {
  const result = await prisma.imagingResult.findFirst({
    where: { id, imagingRequest: { tenantId } },
  });

  if (!result) {
    throw AppError.notFound('Imaging result not found');
  }

  if (result.status === 'published') {
    throw AppError.badRequest('Imaging result is already verified and published');
  }

  if (result.status === 'draft') {
    throw AppError.badRequest('Cannot verify a draft result. Please finalize the report first.');
  }

  const updated = await prisma.imagingResult.update({
    where: { id },
    data: {
      status: 'published',
      signedBy: userId,
      signedAt: new Date(),
    },
    include: {
      imagingRequest: {
        select: { id: true, imagingType: true, bodyPart: true },
      },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      radiologist: { select: { id: true, firstName: true, lastName: true } },
      signer: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, imagingResultId: id, verifiedBy: userId }, 'Imaging result verified');
  return updated;
}
