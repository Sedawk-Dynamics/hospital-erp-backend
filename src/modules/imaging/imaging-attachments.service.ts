import path from 'path';
import fs from 'fs';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { UPLOAD_DIR, getFileUrl, deleteFile } from '../../services/upload.service';

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
    select: { id: true, imagingResult: { select: { id: true } } },
  });
  if (!request) throw AppError.notFound('Imaging request not found');

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

  // If a result already exists on this request, attach to it by default so
  // the doctor's "report ready" surface sees the file. Caller can override
  // by passing imagingResultId explicitly.
  const resolvedResultId =
    options.imagingResultId ?? request.imagingResult?.id ?? null;

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

  logger.info(
    { tenantId, attachmentId: attachment.id, imagingRequestId },
    'Imaging attachment uploaded',
  );
  return attachment;
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
