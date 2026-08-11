import path from 'path';
import fs from 'fs';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { UPLOAD_DIR, getFileUrl, deleteFile } from '../../services/upload.service';
import { syncAttachmentToPacs } from './dicom.service';
import { pacsSupportsArchive } from './pacs';

// ── ImagingAttachment service ──────────────────────────────────────────────
// File storage for anything a radiology role needs to attach to a request or
// its result — scanned PDF reports, JPEG/PNG snapshots from the modality,
// DICOM .dcm files, video loops (USG/echo), etc. Files land on disk via
// multer; the metadata row points at the public URL. Soft-delete via
// deletedAt so audit trail of corrections is preserved.

type AllowedCategory =
  | 'report_pdf'
  | 'image'
  | 'dicom'
  | 'video'
  | 'scan'
  | 'raw_data'
  | 'other';

function inferCategory(
  mimeType: string,
  fileName: string,
  hint?: AllowedCategory,
): AllowedCategory {
  if (hint) return hint;
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.dcm' || mimeType === 'application/dicom') return 'dicom';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'report_pdf';
  return 'other';
}

export async function createImagingAttachment(
  tenantId: string,
  uploaderId: string,
  imagingRequestId: string,
  file: Express.Multer.File,
  options: {
    imagingResultId?: string;
    category?: AllowedCategory;
    description?: string;
  },
) {
  // Tenant ownership check — same shape as the lab variant.
  const request = await prisma.imagingRequest.findFirst({
    where: { id: imagingRequestId, tenantId },
    select: {
      id: true,
      status: true,
      patientId: true,
      imagingResult: { select: { id: true, status: true } },
    },
  });
  if (!request) throw AppError.notFound('Imaging request not found');

  // Once the report is published it is locked — nobody (radiologist or admin)
  // can add, change, or remove its files.
  if (request.imagingResult?.status === 'published') {
    throw AppError.badRequest(
      'This report is published and locked — its files can no longer be changed.',
    );
  }

  if (options.imagingResultId) {
    const result = await prisma.imagingResult.findFirst({
      where: { id: options.imagingResultId, imagingRequest: { tenantId } },
      select: { id: true, imagingRequestId: true },
    });
    if (!result) throw AppError.notFound('Imaging result not found');
    if (result.imagingRequestId !== imagingRequestId) {
      throw AppError.badRequest('Result does not belong to this imaging request');
    }
  }

  const category = inferCategory(file.mimetype, file.originalname, options.category);

  // Resolve (and lazily create) the result row this file hangs off of.
  // The radiologist's "Upload Result" dialog NO LONGER pre-creates a draft on
  // open — that left an empty result behind whenever they opened and closed
  // without uploading, which then tripped a "result already exists" conflict
  // on the next open. Instead the result is created here, on the FIRST actual
  // file upload. Opening + closing the dialog with no file now changes nothing.
  let resolvedResultId =
    options.imagingResultId ?? request.imagingResult?.id ?? null;
  if (!resolvedResultId) {
    try {
      const createdResult = await prisma.imagingResult.create({
        data: {
          imagingRequestId,
          patientId: request.patientId,
          radiologistId: uploaderId,
          status: 'draft',
        },
        select: { id: true },
      });
      resolvedResultId = createdResult.id;
    } catch (err) {
      // imagingRequestId is unique on ImagingResult — a concurrent upload may
      // have created it first. Reuse whatever exists rather than failing.
      const existing = await prisma.imagingResult.findUnique({
        where: { imagingRequestId },
        select: { id: true },
      });
      if (existing) {
        resolvedResultId = existing.id;
      } else {
        throw err;
      }
    }
  }

  const attachment = await prisma.imagingAttachment.create({
    data: {
      tenantId,
      imagingRequestId,
      imagingResultId: resolvedResultId,
      category,
      fileName: file.originalname,
      fileUrl: getFileUrl(file.filename),
      mimeType: file.mimetype,
      sizeBytes: file.size,
      description: options.description ?? null,
      uploadedBy: uploaderId,
    },
    include: {
      uploader: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  // A file means work has started, not that it is finished. The study moves to
  // `in_progress` and the result stays a DRAFT the radiologist can keep editing
  // — add another series, swap a wrong file, remove one — until they explicitly
  // Mark as Done (submitImagingResult), which is what hands it to the admin for
  // approval. Uploading used to complete the request outright, so a half-loaded
  // study appeared in the approval queue with no way back.
  // Skip terminal states (completed, or admin-closed as cancelled/no_show).
  if (!['completed', 'cancelled', 'no_show', 'in_progress'].includes(request.status)) {
    await prisma.imagingRequest
      .update({
        where: { id: imagingRequestId },
        data: { status: 'in_progress' },
      })
      .catch((err) =>
        logger.warn(
          { err, imagingRequestId },
          'Failed to move imaging request to in_progress after attachment upload',
        ),
      );
  }

  // Mirror the first PDF upload onto ImagingResult.pdfReportUrl so existing
  // readers (doctor orders panel, patient portal) light up without needing
  // to refactor them all at once.
  if (resolvedResultId && category === 'report_pdf') {
    const existing = await prisma.imagingResult.findUnique({
      where: { id: resolvedResultId },
      select: { pdfReportUrl: true },
    });
    if (!existing?.pdfReportUrl) {
      await prisma.imagingResult
        .update({
          where: { id: resolvedResultId },
          data: { pdfReportUrl: attachment.fileUrl },
        })
        .catch((err) =>
          logger.warn(
            { err, resultId: resolvedResultId },
            'Failed to mirror pdfReportUrl onto ImagingResult',
          ),
        );
    }
  }

  // When a real PACS is configured, archive DICOM uploads to it and mirror the
  // study/series/instance records. Best-effort: a PACS outage must not fail the
  // upload — the file already lives in /uploads and the in-house viewer reads it.
  if (category === 'dicom' && pacsSupportsArchive()) {
    try {
      await syncAttachmentToPacs(tenantId, attachment.id);
    } catch (err) {
      logger.warn(
        { err, attachmentId: attachment.id },
        'PACS sync failed; file kept in /uploads as fallback',
      );
    }
  }

  logger.info(
    { tenantId, attachmentId: attachment.id, imagingRequestId },
    'Imaging attachment uploaded',
  );
  return attachment;
}

// A published report is immutable. Throws if the request behind an attachment
// already has a published result — used by update/delete so locked files can't
// be edited or removed by anyone.
async function assertNotPublished(imagingRequestId: string) {
  const result = await prisma.imagingResult.findUnique({
    where: { imagingRequestId },
    select: { status: true },
  });
  if (result?.status === 'published') {
    throw AppError.badRequest(
      'This report is published and locked — its files can no longer be changed.',
    );
  }
}

export async function listImagingAttachmentsForRequest(
  tenantId: string,
  imagingRequestId: string,
) {
  const request = await prisma.imagingRequest.findFirst({
    where: { id: imagingRequestId, tenantId },
    select: { id: true },
  });
  if (!request) throw AppError.notFound('Imaging request not found');

  return prisma.imagingAttachment.findMany({
    where: { imagingRequestId, tenantId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      uploader: { select: { id: true, firstName: true, lastName: true } },
    },
  });
}

export async function listImagingAttachmentsForResult(
  tenantId: string,
  imagingResultId: string,
) {
  const result = await prisma.imagingResult.findFirst({
    where: { id: imagingResultId, imagingRequest: { tenantId } },
    select: { id: true },
  });
  if (!result) throw AppError.notFound('Imaging result not found');

  return prisma.imagingAttachment.findMany({
    where: { imagingResultId, tenantId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      uploader: { select: { id: true, firstName: true, lastName: true } },
    },
  });
}

export async function deleteImagingAttachment(tenantId: string, id: string) {
  const att = await prisma.imagingAttachment.findFirst({
    where: { id, tenantId, deletedAt: null },
  });
  if (!att) throw AppError.notFound('Attachment not found');

  await assertNotPublished(att.imagingRequestId);

  await prisma.imagingAttachment.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  const fileName = att.fileUrl.replace(/^\/uploads\//, '');
  if (fileName && !fileName.includes('..') && !fileName.includes('/')) {
    try {
      const fullPath = path.join(UPLOAD_DIR, fileName);
      if (fs.existsSync(fullPath)) await deleteFile(fileName);
    } catch (err) {
      logger.warn({ err, fileName }, 'Failed to remove attachment file from disk');
    }
  }

  logger.info({ tenantId, attachmentId: id }, 'Imaging attachment soft-deleted');
  return { success: true };
}

export async function updateImagingAttachment(
  tenantId: string,
  id: string,
  data: { description?: string; category?: AllowedCategory },
) {
  const att = await prisma.imagingAttachment.findFirst({
    where: { id, tenantId, deletedAt: null },
  });
  if (!att) throw AppError.notFound('Attachment not found');

  await assertNotPublished(att.imagingRequestId);

  return prisma.imagingAttachment.update({
    where: { id },
    data: {
      description: data.description,
      category: data.category,
    },
    include: {
      uploader: { select: { id: true, firstName: true, lastName: true } },
    },
  });
}
