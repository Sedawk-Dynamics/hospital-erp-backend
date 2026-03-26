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
