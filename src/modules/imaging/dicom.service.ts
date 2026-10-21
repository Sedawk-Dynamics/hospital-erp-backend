import path from 'path';
import fs from 'fs';
import unzipper from 'unzipper';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { env } from '../../config/env';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { UPLOAD_DIR } from '../../services/upload.service';
import {
  getPacsProvider,
  getPacsConfigSummary,
  pacsSupportsArchive,
  buildRetrieveUrl,
  PacsArchiveUnsupportedError,
} from './pacs';
import type {
  CreateStudyInput,
  AddInstanceInput,
  GetStudiesQuery,
  WorklistQuery,
} from './dicom.validation';
import { file } from 'pdfkit';

// ============================================================
// Imaging-attachment → study bridge
// ============================================================
// When no external PACS is configured, modality output is uploaded as
// ImagingAttachment files (DICOM / images / video) rather than archived into a
// PACS. To keep the Studies surface useful in that (default) mode, we expose
// each imaging request that has viewable files as a synthesized "study" backed
// by its attachments. Real PACS-archived DicomStudy rows take precedence and
// are deduped by imagingRequestId so a request never shows twice.

// Attachment categories that count as image/instance data for a study.
// `report_pdf` is excluded — a PDF report lives on the Results surface, not as
// an imaging study.
const STUDY_INSTANCE_CATEGORIES = ['image', 'dicom', 'video', 'scan', 'raw_data'] as const;

// Map our ImagingType enum to a short DICOM-style modality code for display.
const MODALITY_CODE: Record<string, string> = {
  xray: 'XR',
  ct_scan: 'CT',
  mri: 'MR',
  ultrasound: 'US',
  ecg: 'ECG',
  echo: 'US',
  other: 'OT',
};

function mapAttachmentToInstance(
  att: { id: string; instanceNumber?: number; fileUrl: string; sizeBytes: number | null; mimeType: string | null },
  index: number,
) {
  return {
    id: att.id,
    sopInstanceUid: `local-${att.id}`,
    instanceNumber: att.instanceNumber ?? index + 1,
    fileUrl: att.fileUrl,
    fileSizeBytes: att.sizeBytes ?? null,
    mimeType: att.mimeType ?? null,
    rows: null as number | null,
    columns: null as number | null,
  };
}

// Build a DicomStudy-shaped object from an imaging request + its attachments.
function buildSynthesizedStudy(req: any, instanceCount: number) {
  const ordererName = req.orderer
    ? `${req.orderer.firstName} ${req.orderer.lastName ?? ''}`.trim()
    : null;
  return {
    id: req.id,
    tenantId: req.tenantId,
    patientId: req.patientId,
    imagingRequestId: req.id,
    imagingResultId: req.imagingResult?.id ?? null,
    studyInstanceUid: `local-${req.id}`,
    accessionNumber: `ACC-${String(req.id).slice(0, 12).toUpperCase()}`,
    studyDate: req.completedAt ?? req.createdAt ?? null,
    studyDescription: req.bodyPart || req.imagingType?.replace(/_/g, ' ') || 'Imaging study',
    modality: MODALITY_CODE[req.imagingType] ?? (req.imagingType?.toUpperCase() ?? null),
    numberOfSeries: instanceCount > 0 ? 1 : 0,
    numberOfInstances: instanceCount,
    patientName: req.patient
      ? `${req.patient.firstName} ${req.patient.lastName ?? ''}`.trim()
      : null,
    patientDicomId: req.patient?.mrn ?? null,
    referringPhysician: ordererName,
    storagePath: null,
    viewerUrl: null,
    createdAt: req.createdAt,
    synthesized: true as const,
    patient: req.patient
      ? {
        id: req.patient.id,
        mrn: req.patient.mrn,
        firstName: req.patient.firstName,
        lastName: req.patient.lastName,
        dateOfBirth: req.patient.dateOfBirth,
        gender: req.patient.gender,
      }
      : undefined,
  };
}

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
    where: { tenantId_studyInstanceUid: { tenantId, studyInstanceUid: data.studyInstanceUid } },
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
      where: { tenantId_seriesInstanceUid: { tenantId, seriesInstanceUid: data.seriesInstanceUid } },
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
    where: { tenantId_sopInstanceUid: { tenantId, sopInstanceUid: data.sopInstanceUid } },
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

  // 1) Real PACS-archived studies.
  const realWhere: any = { tenantId };
  if (query.patientId) realWhere.patientId = query.patientId;
  if (query.imagingRequestId) realWhere.imagingRequestId = query.imagingRequestId;
  if (query.modality) realWhere.modality = query.modality;
  if (query.fromDate) realWhere.studyDate = { ...realWhere.studyDate, gte: new Date(query.fromDate) };
  if (query.toDate) realWhere.studyDate = { ...realWhere.studyDate, lte: new Date(query.toDate) };
  if (query.search) {
    realWhere.OR = [
      { studyDescription: { contains: query.search, mode: 'insensitive' } },
      { accessionNumber: { contains: query.search, mode: 'insensitive' } },
      { patientName: { contains: query.search, mode: 'insensitive' } },
      { studyInstanceUid: { contains: query.search } },
    ];
  }

  const realStudies = await prisma.dicomStudy.findMany({
    where: realWhere,
    orderBy: { studyDate: 'desc' },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
    },
  });
  const coveredRequestIds = new Set(
    realStudies.map((s) => s.imagingRequestId).filter(Boolean) as string[],
  );

  // 2) Synthesized studies from imaging requests that have viewable files but
  //    aren't already archived in a PACS.
  const reqWhere: any = {
    tenantId,
    attachments: {
      some: { deletedAt: null, category: { in: STUDY_INSTANCE_CATEGORIES as any } },
    },
  };
  if (query.patientId) reqWhere.patientId = query.patientId;
  if (query.imagingRequestId) reqWhere.id = query.imagingRequestId;
  if (query.modality) {
    // Reverse-map the modality code back to ImagingType values.
    const types = Object.entries(MODALITY_CODE)
      .filter(([, code]) => code === query.modality)
      .map(([t]) => t);
    if (types.length) reqWhere.imagingType = { in: types };
    else reqWhere.imagingType = '__none__';
  }

  const requests = await prisma.imagingRequest.findMany({
    where: reqWhere,
    orderBy: { createdAt: 'desc' },
    include: {
      patient: {
        select: {
          id: true, mrn: true, firstName: true, lastName: true,
          dateOfBirth: true, gender: true,
        },
      },
      orderer: { select: { id: true, firstName: true, lastName: true } },
      imagingResult: { select: { id: true } },
      attachments: {
        where: { deletedAt: null, category: { in: STUDY_INSTANCE_CATEGORIES as any } },
        select: { id: true },
      },
    },
  });

  let synthesized = requests
    .filter((r) => !coveredRequestIds.has(r.id))
    .map((r) => buildSynthesizedStudy(r, r.attachments.length));

  // Apply the free-text search to synthesized rows in-memory.
  if (query.search) {
    const q = query.search.toLowerCase();
    synthesized = synthesized.filter(
      (s) =>
        (s.studyDescription ?? '').toLowerCase().includes(q) ||
        (s.accessionNumber ?? '').toLowerCase().includes(q) ||
        (s.patientName ?? '').toLowerCase().includes(q) ||
        (s.patient ? `${s.patient.firstName} ${s.patient.lastName ?? ''}`.toLowerCase().includes(q) : false) ||
        (s.patient?.mrn ?? '').toLowerCase().includes(q),
    );
  }

  // 3) Merge, sort by date desc, paginate in-memory.
  const combined = [...realStudies.map((s) => ({ ...s, synthesized: false })), ...synthesized];
  combined.sort((a, b) => {
    const da = a.studyDate ? new Date(a.studyDate).getTime() : 0;
    const db = b.studyDate ? new Date(b.studyDate).getTime() : 0;
    return db - da;
  });

  const total = combined.length;
  const studies = combined.slice(skip, skip + take);
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
  if (study) return study;

  // Not a real PACS study — try a synthesized study backed by an imaging
  // request's uploaded files.
  const req = await prisma.imagingRequest.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: {
          id: true, mrn: true, firstName: true, lastName: true,
          dateOfBirth: true, gender: true,
        },
      },
      orderer: { select: { id: true, firstName: true, lastName: true } },
      imagingResult: { select: { id: true } },
      attachments: {
        where: { deletedAt: null, category: { in: STUDY_INSTANCE_CATEGORIES as any } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, fileUrl: true, sizeBytes: true, mimeType: true, fileName: true },
      },
    },
  });

  if (!req) throw AppError.notFound('DICOM study not found');

  const base = buildSynthesizedStudy(req, req.attachments.length);
  return {
    ...base,
    series: [],
    // All files hang off the study directly (no series grouping for synthesized).
    instances: req.attachments.map((att, i) =>
      mapAttachmentToInstance({ ...att, instanceNumber: undefined }, i),
    ),
  };
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
    orderBy: { createdAt: 'desc' },
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
    referringPhysician: r.orderer
      ? // DICOM PersonName is caret-separated, so the shared name helper's space
      // is wrong here — a missing surname just leaves the component empty.
      `${r.orderer.firstName}^${r.orderer.lastName ?? ''}`
      : null,
  }));
}

// ============================================================
// PACS integration (Orthanc / PostDICOM)
// ============================================================

/** Frontend-facing summary of how DICOM is archived + viewed. */
export function getPacsConfig() {
  return getPacsConfigSummary();
}

/** Resolve the on-disk path for an attachment whose fileUrl is /uploads/<name>. */
function resolveUploadPath(fileUrl: string): string | null {
  const fileName = fileUrl.replace(/^\/uploads\//, '');
  // Guard against path traversal — uploads are flat filenames only.
  if (!fileName || fileName.includes('..') || fileName.includes('/')) return null;
  const full = path.join(UPLOAD_DIR, fileName);
  return fs.existsSync(full) ? full : null;
}

export interface SyncAttachmentResult {
  synced: boolean;
  reason?: string;
  studyId?: string;
  studyInstanceUid?: string;
  viewerUrl?: string;
}


export async function syncAttachmentToPacs(
  tenantId: string,
  attachmentId: string,
): Promise<SyncAttachmentResult> {
  const provider = getPacsProvider();
  if (!provider || !provider.isConfigured()) {
    return { synced: false, reason: 'pacs-disabled' };
  }

  const attachment = await prisma.imagingAttachment.findFirst({
    where: { id: attachmentId, tenantId, deletedAt: null },
    include: {
      imagingRequest: {
        select: {
          id: true,
          patientId: true,
          bodyPart: true,
          imagingType: true,
          patient: { select: { mrn: true, firstName: true, lastName: true } },
        },
      },
    },
  });
  if (!attachment) throw AppError.notFound('Attachment not found');
  if (attachment.category !== 'dicom') {
    return { synced: false, reason: 'not-dicom' };
  }
  if (!provider.embeddable || !pacsSupportsArchive()) {
    return { synced: false, reason: 'archive-unsupported' };
  }

  const filePath = resolveUploadPath(attachment.fileUrl);
  if (!filePath) return { synced: false, reason: 'file-missing' }

  let isZipFile = path.extname(attachment.fileName).toLowerCase() === '.zip';

  const req = attachment.imagingRequest;
  const patientName = req?.patient
    ? `${req.patient.firstName} ${req.patient.lastName ?? ''}`.trim()
    : undefined;

  let stored;

  if (isZipFile) {
    let storedlist = [];
    try {
      const buffer = await fs.promises.readFile(filePath);
      const directory = await unzipper.Open.buffer(buffer);

      const dicomEntries = directory.files.filter((f) => {
        if (f.type !== 'File') return false;
        if (f.path.includes('__MACOSX')) return false;
        const base = path.basename(f.path);
        if (base.startsWith('.') || base === 'DICOMDIR') return false;
        const ext = path.extname(f.path).toLowerCase();
        return ext === '.dcm' || ext === '.dicom';
      });

      if (dicomEntries.length === 0) {
        return { synced: false, reason: 'no-dicom-in-zip' };
      }

      for (const files of dicomEntries) {
        const fileBuffer = await files.buffer();
        stored = await provider.storeInstance({
          buffer: fileBuffer,
          fileName: path.basename(files.path),
          patientMrn: req?.patient?.mrn,
          patientName,
        })
        storedlist.push(stored)
      }
    } catch (err) {
      if (err instanceof PacsArchiveUnsupportedError) {
        return { synced: false, reason: 'archive-unsupported' };
      }
      logger.error({ err, attachmentId }, 'PACS zip store failed');
      throw err;
    }
    const zipViewerUrl = provider.buildViewerUrl(storedlist[0].studyInstanceUid) ?? undefined;
    const study = await createStudy(tenantId, {
      patientId: req!.patientId,
      imagingRequestId: attachment.imagingRequestId,
      imagingResultId: attachment.imagingResultId ?? undefined,
      studyInstanceUid: storedlist[0].studyInstanceUid,
      accessionNumber: storedlist[0].accessionNumber,
      studyDate: storedlist[0].studyDate,
      studyDescription: storedlist[0].studyDescription,
      modality: storedlist[0].modality,
      patientName: storedlist[0].patientName,
      patientDicomId: storedlist[0].patientDicomId,
      referringPhysician: storedlist[0].referringPhysician,
      viewerUrl: zipViewerUrl,
    })

    for (const entries of storedlist) {
      await addInstance(tenantId, study.id, {
        seriesInstanceUid: entries.seriesInstanceUid,
        seriesDescription: entries.seriesDescription,
        seriesNumber: entries.seriesNumber,
        seriesModality: entries.modality,
        bodyPart: entries.bodyPart ?? req?.bodyPart ?? undefined,
        sopInstanceUid: entries.sopInstanceUid,
        instanceNumber: entries.instanceNumber,
        fileUrl: attachment.fileUrl,
        fileSizeBytes: attachment.sizeBytes ?? undefined,
        mimeType: attachment.mimeType ?? 'application/dicom',
        rows: entries.rows,
        columns: entries.columns,
      });
    }
    if (env.PACS_DROP_LOCAL && filePath) {
      for (const a of storedlist) {
        await prisma.dicomInstance.updateMany({
          where: { tenantId, sopInstanceUid: a.sopInstanceUid },
          data: { fileUrl: buildRetrieveUrl(a.sopInstanceUid) },
        });
      }
      await prisma.imagingAttachment.update({
        where: { id: attachmentId },
        data: { fileUrl: buildRetrieveUrl(storedlist[0].sopInstanceUid) },
      });
      try {
        await fs.promises.unlink(filePath);
      } catch (err) {
        logger.warn({ err, filePath }, 'PACS_DROP_LOCAL: failed to delete local DICOM copy');
      }
    }
    logger.info(
      { tenantId, attachmentId, studyInstanceUid: storedlist[0].studyInstanceUid, provider: provider.name },
      'DICOM attachment synced to PACS',
    );
    return {
      synced: true,
      studyId: study.id,
      studyInstanceUid: storedlist[0].studyInstanceUid,
      viewerUrl: zipViewerUrl,
    };
  }

  else {
    try {
      const buffer = await fs.promises.readFile(filePath);
      stored = await provider.storeInstance({
        buffer,
        fileName: attachment.fileName,
        patientMrn: req?.patient?.mrn,
        patientName,
      });
    } catch (err) {
      if (err instanceof PacsArchiveUnsupportedError) {
        return { synced: false, reason: 'archive-unsupported' };
      }
      logger.error({ err, attachmentId }, 'PACS storeInstance failed');
      throw err;
    }
    const viewerUrl = provider.buildViewerUrl(stored.studyInstanceUid) ?? undefined;


    const study = await createStudy(tenantId, {
      patientId: req!.patientId,
      imagingRequestId: attachment.imagingRequestId,
      imagingResultId: attachment.imagingResultId ?? undefined,
      studyInstanceUid: stored.studyInstanceUid,
      accessionNumber: stored.accessionNumber,
      studyDate: stored.studyDate,
      studyDescription: stored.studyDescription,
      modality: stored.modality,
      patientName: stored.patientName,
      patientDicomId: stored.patientDicomId,
      referringPhysician: stored.referringPhysician,
      viewerUrl,
    });

    // Stamp the archive's internal study id for traceability.
    if (stored.externalStudyId && study.storagePath !== stored.externalStudyId) {
      await prisma.dicomStudy.update({
        where: { id: study.id },
        data: { storagePath: stored.externalStudyId },
      });
    }

    await addInstance(tenantId, study.id, {
      seriesInstanceUid: stored.seriesInstanceUid,
      seriesDescription: stored.seriesDescription,
      seriesNumber: stored.seriesNumber,
      seriesModality: stored.modality,
      bodyPart: stored.bodyPart ?? req?.bodyPart ?? undefined,
      sopInstanceUid: stored.sopInstanceUid,
      instanceNumber: stored.instanceNumber,
      fileUrl: attachment.fileUrl,
      fileSizeBytes: attachment.sizeBytes ?? undefined,
      mimeType: attachment.mimeType ?? 'application/dicom',
      rows: stored.rows,
      columns: stored.columns,
    });

    if (env.PACS_DROP_LOCAL && filePath) {
      const retrieveUrl = buildRetrieveUrl(stored.sopInstanceUid);
      await prisma.imagingAttachment.update({
        where: { id: attachmentId },
        data: { fileUrl: retrieveUrl },
      });
      await prisma.dicomInstance.updateMany({
        where: { tenantId, sopInstanceUid: stored.sopInstanceUid },
        data: { fileUrl: retrieveUrl },
      });
      try {
        await fs.promises.unlink(filePath);
      } catch (err) {
        logger.warn({ err, filePath }, 'PACS_DROP_LOCAL: failed to delete local DICOM copy');
      }
    }

    logger.info(
      { tenantId, attachmentId, studyInstanceUid: stored.studyInstanceUid, provider: provider.name },
      'DICOM attachment synced to PACS',
    );
    return {
      synced: true,
      studyId: study.id,
      studyInstanceUid: stored.studyInstanceUid,
      viewerUrl,
    };
  }
}





export interface ResolveViewerResult {
  viewerUrl: string | null;
  studyInstanceUid?: string;
  reason?: string;
}


export async function resolveAttachmentViewer(
  tenantId: string,
  attachmentId: string,
): Promise<ResolveViewerResult> {
  const provider = getPacsProvider();
  if (!provider || !provider.isConfigured() || !provider.embeddable) {
    return { viewerUrl: null, reason: 'pacs-disabled' };
  }

  const att = await prisma.imagingAttachment.findFirst({
    where: { id: attachmentId, tenantId, deletedAt: null },
    select: { id: true, category: true, fileUrl: true },
  });
  if (!att) throw AppError.notFound('Attachment not found');
  if (att.category !== 'dicom') return { viewerUrl: null, reason: 'not-dicom' };

  // Already mirrored? Match the instance pushed from this exact file.
  const inst = await prisma.dicomInstance.findFirst({
    where: { tenantId, fileUrl: att.fileUrl },
    select: { study: { select: { studyInstanceUid: true, viewerUrl: true } } },
  });
  if (inst?.study?.viewerUrl) {
    return { viewerUrl: inst.study.viewerUrl, studyInstanceUid: inst.study.studyInstanceUid };
  }

  // Lazy archive (idempotent) for providers that can store server-side.
  if (pacsSupportsArchive()) {
    const r = await syncAttachmentToPacs(tenantId, attachmentId);
    if (r.synced && r.viewerUrl) {
      return { viewerUrl: r.viewerUrl, studyInstanceUid: r.studyInstanceUid };
    }
    return { viewerUrl: null, reason: r.reason ?? 'unresolved' };
  }

  return { viewerUrl: null, reason: 'archive-unsupported' };
}


export async function resolvePreview(tenantId: string, attachmentId: string): Promise<Buffer | null> {
  const provider = getPacsProvider();
  if (!provider || !provider.isConfigured() || !provider.embeddable) {
    return null;
  }

  const att = await prisma.imagingAttachment.findFirst({
    where: { id: attachmentId, tenantId, deletedAt: null },
    select: { id: true, category: true, fileUrl: true },
  });
  if (!att) throw AppError.notFound('Attachment not found');
  if (att.category !== 'dicom') return null;

  const inst = await prisma.dicomInstance.findFirst({
    where: { tenantId, fileUrl: att.fileUrl },
    select: { sopInstanceUid: true, study: { select: { studyInstanceUid: true } } },
  });
  if (!inst?.sopInstanceUid) return null;

  if (!provider.getInstancePreview) return null;
  return provider.getInstancePreview(inst.sopInstanceUid);
}

export async function dicomFolderUpload(
  tenantId: string,
  userId: string,
  requestId: string,
  files: Express.Multer.File[],
) {
  const provider = getPacsProvider();
  if (!provider || !provider.isConfigured() || !pacsSupportsArchive()) {
    throw AppError.badRequest('PACS archive not configured');
  }

  const req = await prisma.imagingRequest.findFirst({
    where: { id: requestId, tenantId },
    include: { patient: true },
  });
  if (!req) throw AppError.notFound('Imaging request not found');

  if (!files || files.length === 0) throw AppError.badRequest('No files uploaded');

  const patientName = req.patient
    ? `${req.patient.firstName} ${req.patient.lastName ?? ''}`.trim()
    : undefined;

  // Step 1: push every slice in the folder to the PACS server (Orthanc).
  // Orthanc groups them into one study/series by their shared DICOM UIDs.
  const stored = [];
  for (const file of files) {
    const buffer = await fs.promises.readFile(file.path);
    const result = await provider.storeInstance({
      buffer,
      fileName: file.originalname,
      patientMrn: req.patient?.mrn,
      patientName,
    });
    stored.push(result);
  }

  // Step 2: create ONE attachment row for the whole study (not one per slice),
  // so the UI shows a single DICOM entry with one preview + one full-screen
  // viewer instead of N separate ones.
  const firstFile = files[0];
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const attachment = await prisma.imagingAttachment.create({
    data: {
      tenantId,
      imagingRequestId: req.id,
      category: 'dicom',
      fileUrl: `/uploads/${firstFile.filename}`,
      fileName: `DICOM study (${files.length} images)`,
      sizeBytes: totalSize,
      // These are DICOM by definition here — never trust the browser MIME.
      // Windows tags extensionless DICOM as application/octet-stream, which
      // the viewer's type-detector rejects; force the correct type so the
      // study previews regardless of the uploading OS.
      mimeType: 'application/dicom',
      uploadedBy: userId,
    },
  });

  const head = stored[0];
  const viewerUrl = provider.buildViewerUrl(head.studyInstanceUid) ?? undefined;
  const study = await createStudy(tenantId, {
    patientId: req.patientId,
    imagingRequestId: attachment.imagingRequestId,
    imagingResultId: attachment.imagingResultId ?? undefined,
    studyInstanceUid: head.studyInstanceUid,
    accessionNumber: head.accessionNumber,
    studyDate: head.studyDate,
    studyDescription: head.studyDescription,
    modality: head.modality,
    patientName: head.patientName,
    patientDicomId: head.patientDicomId,
    referringPhysician: head.referringPhysician,
    viewerUrl,
  });

  for (let i = 0; i < stored.length; i++) {
    const s = stored[i];
    await addInstance(tenantId, study.id, {
      seriesInstanceUid: s.seriesInstanceUid,
      seriesDescription: s.seriesDescription,
      seriesNumber: s.seriesNumber,
      seriesModality: s.modality,
      bodyPart: s.bodyPart ?? req.bodyPart ?? undefined,
      sopInstanceUid: s.sopInstanceUid,
      instanceNumber: s.instanceNumber,
      fileUrl: `/uploads/${files[i].filename}`,
      fileSizeBytes: files[i].size,
      mimeType: 'application/dicom',
      rows: s.rows,
      columns: s.columns,
    });
  }

  return { attachmentId: attachment.id, studyId: study.id, count: stored.length, stored };
}