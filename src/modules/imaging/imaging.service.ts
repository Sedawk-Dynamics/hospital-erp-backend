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

// Best-effort notification (failures don't break workflow)
async function safeNotify(params: {
  tenantId: string;
  userId: string;
  title: string;
  message: string;
  notificationType?: 'lab_result' | 'general' | 'alert';
  referenceType?: string;
  referenceId?: string;
}) {
  try {
    await prisma.notification.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        title: params.title,
        message: params.message,
        notificationType: params.notificationType ?? 'general',
        channel: 'in_app',
        referenceType: params.referenceType,
        referenceId: params.referenceId,
      },
    });
  } catch (err) {
    logger.warn({ err, ...params }, 'Failed to dispatch imaging notification');
  }
}

// Resolve a tariff price for a given imaging type (best-effort lookup against ServiceTariff)
async function lookupImagingPrice(tenantId: string, imagingType: string, bodyPart?: string | null) {
  try {
    const tariff = await prisma.serviceTariff.findFirst({
      where: {
        tenantId,
        category: 'radiology',
        OR: [
          { serviceName: { contains: bodyPart || imagingType, mode: 'insensitive' } },
          { serviceName: { contains: imagingType, mode: 'insensitive' } },
        ],
      },
    });
    if (tariff) return { id: tariff.id, price: Number(tariff.basePrice ?? 0) };
  } catch {}
  return { id: null as string | null, price: 0 };
}

// Auto-add a radiology line item to the patient's draft bill
export async function autoLinkImagingToBill(tenantId: string, requestId: string) {
  try {
    const request = await prisma.imagingRequest.findFirst({
      where: { id: requestId, tenantId },
    });
    if (!request) return;

    let bill = await prisma.bill.findFirst({
      where: { tenantId, visitId: request.visitId, status: 'draft' },
    });
    if (!bill) {
      const billNumber = `BILL-${Date.now()}`;
      bill = await prisma.bill.create({
        data: {
          tenantId,
          billNumber,
          patientId: request.patientId,
          visitId: request.visitId,
          billDate: new Date(),
          status: 'draft',
        },
      });
    }

    const existing = await prisma.billItem.findFirst({
      where: {
        billId: bill.id,
        referenceType: 'imaging_request',
        referenceId: requestId,
      },
    });
    if (existing) return;

    const { id: serviceTariffId, price } = await lookupImagingPrice(
      tenantId,
      request.imagingType,
      request.bodyPart,
    );

    await prisma.billItem.create({
      data: {
        billId: bill.id,
        serviceTariffId: serviceTariffId ?? undefined,
        description: `${request.imagingType.toUpperCase()}${request.bodyPart ? ' — ' + request.bodyPart : ''}`,
        category: 'radiology',
        quantity: 1,
        unitPrice: price,
        totalAmount: price,
        referenceType: 'imaging_request',
        referenceId: requestId,
        isAutoPulled: true,
      },
    });

    const items = await prisma.billItem.findMany({ where: { billId: bill.id } });
    const subtotal = items.reduce((sum, x) => sum + Number(x.totalAmount ?? 0), 0);
    await prisma.bill.update({
      where: { id: bill.id },
      data: {
        subtotal,
        totalAmount: subtotal,
        patientPayableAmount: subtotal,
        balanceDue: subtotal - Number(bill.amountPaid ?? 0),
      },
    });
  } catch (err) {
    logger.warn({ err, requestId }, 'Failed to auto-link imaging request to bill');
  }
}

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

  // Auto-link to draft bill (best effort)
  void autoLinkImagingToBill(tenantId, request.id);

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

  if (query.assignedTechnicianId) {
    where.assignedTechnicianId = query.assignedTechnicianId;
  }

  if (query.date) {
    const start = new Date(query.date);
    if (!isNaN(start.getTime())) {
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      where.scheduledAt = { gte: start, lt: end };
    }
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
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
        orderer: { select: { id: true, firstName: true, lastName: true } },
        assignedTechnician: { select: { id: true, firstName: true, lastName: true } },
        visit: { select: { id: true, visitType: true } },
        imagingResult: { select: { id: true, status: true } },
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

  // Validate technician belongs to tenant
  if (data.assignedTechnicianId) {
    const tech = await prisma.user.findFirst({
      where: { id: data.assignedTechnicianId, tenantId, isActive: true },
    });
    if (!tech) throw AppError.badRequest('Assigned technician not found in tenant');
  }

  const updated = await prisma.imagingRequest.update({
    where: { id },
    data: {
      imagingType: data.imagingType,
      bodyPart: data.bodyPart,
      urgency: data.urgency,
      clinicalIndication: data.clinicalIndication,
      notes: data.notes,
      scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
      assignedTechnicianId: data.assignedTechnicianId,
      room: data.room,
      // If a schedule is being set on a 'requested' record, advance it
      ...(data.scheduledAt && request.status === 'requested' ? { status: 'scheduled' } : {}),
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      orderer: { select: { id: true, firstName: true, lastName: true } },
      assignedTechnician: { select: { id: true, firstName: true, lastName: true } },
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

  if (data.assignedTechnicianId) {
    const tech = await prisma.user.findFirst({
      where: { id: data.assignedTechnicianId, tenantId, isActive: true },
    });
    if (!tech) throw AppError.badRequest('Assigned technician not found in tenant');
  }

  const updated = await prisma.imagingRequest.update({
    where: { id },
    data: {
      scheduledAt: new Date(data.scheduledAt),
      assignedTechnicianId: data.assignedTechnicianId,
      room: data.room,
      status: 'scheduled',
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      orderer: { select: { id: true, firstName: true, lastName: true } },
      assignedTechnician: { select: { id: true, firstName: true, lastName: true } },
      visit: { select: { id: true, visitType: true } },
    },
  });

  // Notify the assigned technician
  if (data.assignedTechnicianId) {
    await safeNotify({
      tenantId,
      userId: data.assignedTechnicianId,
      title: 'New imaging study assigned',
      message: `Imaging study scheduled at ${new Date(data.scheduledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.`,
      notificationType: 'general',
      referenceType: 'imaging_request',
      referenceId: id,
    });
  }

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
        select: { id: true, imagingType: true, bodyPart: true, orderedBy: true },
      },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      radiologist: { select: { id: true, firstName: true, lastName: true } },
      signer: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  const reportRefMsg = `Radiology report (${updated.imagingRequest.imagingType.toUpperCase()}${updated.imagingRequest.bodyPart ? ' - ' + updated.imagingRequest.bodyPart : ''}) is ready.`;

  if (updated.imagingRequest.orderedBy) {
    await safeNotify({
      tenantId,
      userId: updated.imagingRequest.orderedBy,
      title: 'Radiology report ready',
      message: reportRefMsg,
      notificationType: 'lab_result',
      referenceType: 'imaging_result',
      referenceId: id,
    });
  }
  const patient = await prisma.patient.findUnique({ where: { id: result.patientId } });
  const patientUserId = (patient as any)?.userId as string | undefined;
  if (patientUserId) {
    await safeNotify({
      tenantId,
      userId: patientUserId,
      title: 'Your imaging report is ready',
      message: 'Your imaging report has been published. Tap to view.',
      notificationType: 'lab_result',
      referenceType: 'imaging_result',
      referenceId: id,
    });
  }

  logger.info({ tenantId, imagingResultId: id, verifiedBy: userId }, 'Imaging result verified');
  return updated;
}

// ============================================================
// Analytics (TAT, volume by modality, status mix, technician load)
// ============================================================

export async function getImagingAnalytics(
  tenantId: string,
  range: { fromDate?: string; toDate?: string },
) {
  const where: any = { tenantId };
  if (range.fromDate) where.createdAt = { ...where.createdAt, gte: new Date(range.fromDate) };
  if (range.toDate) where.createdAt = { ...where.createdAt, lte: new Date(range.toDate) };

  const [requests, publishedResults] = await Promise.all([
    prisma.imagingRequest.findMany({
      where,
      select: {
        id: true,
        status: true,
        imagingType: true,
        bodyPart: true,
        urgency: true,
        createdAt: true,
        scheduledAt: true,
        completedAt: true,
        assignedTechnicianId: true,
        assignedTechnician: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
    prisma.imagingResult.findMany({
      where: { imagingRequest: where, status: 'published' },
      select: {
        id: true,
        imagingRequest: { select: { createdAt: true } },
        signedAt: true,
      },
    }),
  ]);

  // Status mix
  const statusMix: Record<string, number> = {
    requested: 0,
    scheduled: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const r of requests) {
    statusMix[r.status] = (statusMix[r.status] ?? 0) + 1;
  }

  // Volume by modality
  const modalityMap = new Map<string, number>();
  for (const r of requests) {
    modalityMap.set(r.imagingType, (modalityMap.get(r.imagingType) ?? 0) + 1);
  }
  const modalityVolume = Array.from(modalityMap.entries())
    .map(([modality, count]) => ({ modality, count }))
    .sort((a, b) => b.count - a.count);

  // Body part top list
  const bodyPartMap = new Map<string, number>();
  for (const r of requests) {
    if (r.bodyPart) bodyPartMap.set(r.bodyPart, (bodyPartMap.get(r.bodyPart) ?? 0) + 1);
  }
  const bodyPartVolume = Array.from(bodyPartMap.entries())
    .map(([bodyPart, count]) => ({ bodyPart, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Urgency mix
  const urgencyMix: Record<string, number> = { routine: 0, urgent: 0, stat: 0 };
  for (const r of requests) {
    urgencyMix[r.urgency] = (urgencyMix[r.urgency] ?? 0) + 1;
  }

  // TAT: request createdAt → result signedAt
  const tats: number[] = [];
  for (const res of publishedResults) {
    if (res.signedAt && res.imagingRequest?.createdAt) {
      tats.push((res.signedAt.getTime() - res.imagingRequest.createdAt.getTime()) / (1000 * 60 * 60));
    }
  }
  const avgTatHours = tats.length ? tats.reduce((a, b) => a + b, 0) / tats.length : 0;
  const medianTatHours = tats.length
    ? [...tats].sort((a, b) => a - b)[Math.floor(tats.length / 2)]
    : 0;

  // Technician workload (assigned requests)
  const techMap = new Map<string, { id: string; name: string; count: number }>();
  for (const r of requests) {
    if (!r.assignedTechnicianId || !r.assignedTechnician) continue;
    const key = r.assignedTechnicianId;
    const existing = techMap.get(key);
    const name = `${r.assignedTechnician.firstName} ${r.assignedTechnician.lastName ?? ''}`.trim();
    if (existing) {
      existing.count += 1;
    } else {
      techMap.set(key, { id: r.assignedTechnicianId, name, count: 1 });
    }
  }
  const technicianWorkload = Array.from(techMap.values()).sort((a, b) => b.count - a.count);

  return {
    summary: {
      totalRequests: requests.length,
      completedRequests: statusMix.completed,
      openRequests:
        statusMix.requested + statusMix.scheduled + statusMix.in_progress,
      publishedReports: publishedResults.length,
      avgTatHours: Number(avgTatHours.toFixed(2)),
      medianTatHours: Number(medianTatHours.toFixed(2)),
    },
    statusMix,
    urgencyMix,
    modalityVolume,
    bodyPartVolume,
    technicianWorkload,
  };
}
