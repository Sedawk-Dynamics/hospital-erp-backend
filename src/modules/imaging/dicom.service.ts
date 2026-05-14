import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateStudyInput,
  AddInstanceInput,
  GetStudiesQuery,
  WorklistQuery,
} from './dicom.validation';

// ============================================================
// Studies
// ============================================================

export async function createStudy(tenantId: string, data: CreateStudyInput) {
  // Validate patient
  const patient = await prisma.patient.findFirst({ where: { id: data.patientId, tenantId } });
  if (!patient) throw AppError.notFound('Patient not found');

  // Validate imaging request / result if provided
  if (data.imagingRequestId) {
    const req = await prisma.imagingRequest.findFirst({
      where: { id: data.imagingRequestId, tenantId },
    });
    if (!req) throw AppError.notFound('Imaging request not found');
  }

  if (data.imagingResultId) {
    const res = await prisma.imagingResult.findFirst({
      where: { id: data.imagingResultId, imagingRequest: { tenantId } },
    });
    if (!res) throw AppError.notFound('Imaging result not found');
  }

  // Upsert by studyInstanceUid so re-receiving the same study is idempotent.
  const study = await prisma.dicomStudy.upsert({
    where: { studyInstanceUid: data.studyInstanceUid },
    update: {
      imagingRequestId: data.imagingRequestId,
      imagingResultId: data.imagingResultId,
      accessionNumber: data.accessionNumber,
      studyDate: data.studyDate ? new Date(data.studyDate) : undefined,
      studyDescription: data.studyDescription,
      modality: data.modality,
      patientName: data.patientName,
      patientDicomId: data.patientDicomId,
      referringPhysician: data.referringPhysician,
      viewerUrl: data.viewerUrl,
    },
    create: {
      tenantId,
      patientId: data.patientId,
      imagingRequestId: data.imagingRequestId,
      imagingResultId: data.imagingResultId,
      studyInstanceUid: data.studyInstanceUid,
      accessionNumber: data.accessionNumber,
      studyDate: data.studyDate ? new Date(data.studyDate) : undefined,
      studyDescription: data.studyDescription,
      modality: data.modality,
      patientName: data.patientName,
      patientDicomId: data.patientDicomId,
      referringPhysician: data.referringPhysician,
      viewerUrl: data.viewerUrl,
      numberOfInstances: 0,
      numberOfSeries: 0,
    },
  });

  // If the study is now linked to an imaging result, mirror the PACS reference
  // back to the result so existing UI surfaces work without changes.
  if (data.imagingResultId) {
    await prisma.imagingResult.update({
      where: { id: data.imagingResultId },
      data: { pacsReferenceId: study.studyInstanceUid },
    });
  }

  logger.info({ tenantId, studyId: study.id, studyInstanceUid: study.studyInstanceUid }, 'DICOM study created/updated');
  return study;
}

export async function addInstance(tenantId: string, studyId: string, data: AddInstanceInput) {
  const study = await prisma.dicomStudy.findFirst({ where: { id: studyId, tenantId } });
  if (!study) throw AppError.notFound('DICOM study not found');

  // Find or create the series. If no seriesInstanceUid passed, instance is
  // attached directly to the study with no series.
  let seriesId: string | null = null;
  if (data.seriesInstanceUid) {
    const series = await prisma.dicomSeries.upsert({
      where: { seriesInstanceUid: data.seriesInstanceUid },
      update: {
        seriesDescription: data.seriesDescription,
        seriesNumber: data.seriesNumber,
        modality: data.seriesModality,
        bodyPart: data.bodyPart,
      },
      create: {
        tenantId,
        studyId: study.id,
        seriesInstanceUid: data.seriesInstanceUid,
        seriesDescription: data.seriesDescription,
        seriesNumber: data.seriesNumber,
        modality: data.seriesModality,
        bodyPart: data.bodyPart,
        numberOfInstances: 0,
      },
    });
    seriesId = series.id;
  }

  const instance = await prisma.dicomInstance.upsert({
    where: { sopInstanceUid: data.sopInstanceUid },
    update: {
      seriesId,
      sopClassUid: data.sopClassUid,
      instanceNumber: data.instanceNumber,
      fileUrl: data.fileUrl,
      fileSizeBytes: data.fileSizeBytes ? BigInt(data.fileSizeBytes) : undefined,
      mimeType: data.mimeType,
      rows: data.rows,
      columns: data.columns,
    },
    create: {
      tenantId,
      studyId: study.id,
      seriesId,
      sopInstanceUid: data.sopInstanceUid,
      sopClassUid: data.sopClassUid,
      instanceNumber: data.instanceNumber,
      fileUrl: data.fileUrl,
      fileSizeBytes: data.fileSizeBytes ? BigInt(data.fileSizeBytes) : undefined,
      mimeType: data.mimeType ?? 'application/dicom',
      rows: data.rows,
      columns: data.columns,
    },
  });

  // Refresh study counters
  const [instCount, seriesCount] = await Promise.all([
    prisma.dicomInstance.count({ where: { studyId: study.id } }),
    prisma.dicomSeries.count({ where: { studyId: study.id } }),
  ]);
  await prisma.dicomStudy.update({
    where: { id: study.id },
    data: {
      numberOfInstances: instCount,
      numberOfSeries: seriesCount,
    },
  });
  if (seriesId) {
    const seriesInstCount = await prisma.dicomInstance.count({ where: { seriesId } });
    await prisma.dicomSeries.update({
      where: { id: seriesId },
      data: { numberOfInstances: seriesInstCount },
    });
  }

  return instance;
}

export async function getStudies(tenantId: string, query: GetStudiesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: any = { tenantId };
  if (query.patientId) where.patientId = query.patientId;
  if (query.imagingRequestId) where.imagingRequestId = query.imagingRequestId;
  if (query.modality) where.modality = query.modality;
  if (query.fromDate) where.studyDate = { ...where.studyDate, gte: new Date(query.fromDate) };
  if (query.toDate) where.studyDate = { ...where.studyDate, lte: new Date(query.toDate) };

  if (query.search) {
    where.OR = [
      { studyDescription: { contains: query.search, mode: 'insensitive' } },
      { accessionNumber: { contains: query.search, mode: 'insensitive' } },
      { patientName: { contains: query.search, mode: 'insensitive' } },
      { studyInstanceUid: { contains: query.search } },
    ];
  }

  const [studies, total] = await Promise.all([
    prisma.dicomStudy.findMany({
      where,
      skip,
      take,
      orderBy: { studyDate: 'desc' },
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      },
    }),
    prisma.dicomStudy.count({ where }),
  ]);

  return { studies, total, page, limit };
}

export async function getStudyById(tenantId: string, id: string) {
  const study = await prisma.dicomStudy.findFirst({
    where: { id, tenantId },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true, gender: true } },
      series: {
        orderBy: { seriesNumber: 'asc' },
        include: {
          instances: {
            orderBy: { instanceNumber: 'asc' },
            select: {
              id: true, sopInstanceUid: true, instanceNumber: true, fileUrl: true,
              fileSizeBytes: true, mimeType: true, rows: true, columns: true,
            },
          },
        },
      },
      instances: {
        where: { seriesId: null },
        orderBy: { instanceNumber: 'asc' },
        select: {
          id: true, sopInstanceUid: true, instanceNumber: true, fileUrl: true,
          fileSizeBytes: true, mimeType: true, rows: true, columns: true,
        },
      },
    },
  });
  if (!study) throw AppError.notFound('DICOM study not found');
  return study;
}

export async function getStudiesByPatient(tenantId: string, patientId: string) {
  const studies = await prisma.dicomStudy.findMany({
    where: { tenantId, patientId },
    orderBy: { studyDate: 'desc' },
    include: { _count: { select: { instances: true, series: true } } },
  });
  return studies;
}

// ============================================================
// DICOM Worklist (MWL)
// ============================================================
// The modality (CT/MRI/X-Ray) queries this to know what to scan next.
// Returns scheduled imaging requests in MWL-friendly shape.

export async function getWorklist(tenantId: string, query: WorklistQuery) {
  const where: any = { tenantId };
  if (query.modality) where.imagingType = query.modality;
  if (query.status) where.status = query.status;
  else where.status = { in: ['requested', 'scheduled', 'in_progress'] };

  if (query.fromDate) where.scheduledAt = { ...where.scheduledAt, gte: new Date(query.fromDate) };
  if (query.toDate) where.scheduledAt = { ...where.scheduledAt, lte: new Date(query.toDate) };

  const requests = await prisma.imagingRequest.findMany({
    where,
    orderBy: { scheduledAt: 'asc' },
    include: {
      patient: {
        select: {
          id: true, mrn: true, firstName: true, lastName: true,
          dateOfBirth: true, gender: true,
        },
      },
      orderer: { select: { id: true, firstName: true, lastName: true } },
    },
    take: 200,
  });

  // Shape into MWL-ish records (accessionNumber + scheduled procedure step)
  return requests.map((r) => ({
    accessionNumber: `ACC-${r.id.slice(0, 12).toUpperCase()}`,
    requestId: r.id,
    patient: {
      patientId: r.patient.mrn,
      patientName: `${r.patient.firstName}^${r.patient.lastName ?? ''}`,
      patientDob: r.patient.dateOfBirth,
      patientGender: r.patient.gender,
    },
    scheduledProcedureStep: {
      modality: r.imagingType,
      scheduledStationAeTitle: 'PACS',
      scheduledProcedureStepStartDate: r.scheduledAt,
      bodyPart: r.bodyPart,
      room: r.room,
      indication: r.clinicalIndication,
      urgency: r.urgency,
      status: r.status,
    },
    referringPhysician: r.orderer ? `${r.orderer.firstName}^${r.orderer.lastName}` : null,
  }));
}
