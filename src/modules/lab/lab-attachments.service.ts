import path from 'path';
import fs from 'fs';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { UPLOAD_DIR, getFileUrl, deleteFile } from '../../services/upload.service';

// ── LabAttachment service ──────────────────────────────────────────────────
// File storage for everything a lab role needs to attach to an order or
// report — scanned PDF reports, microscopy images, gel/scope photos, raw
// instrument output, etc. Files are written to /uploads (multer disk storage)
// and the metadata row points at them. Soft-delete via deletedAt so an audit
// trail of corrections is preserved.

type AllowedCategory = 'report_pdf' | 'image' | 'scan' | 'raw_data' | 'other';

// A report a lab supervisor has finalized (anything past draft/review) is
// locked — no new files may be attached to the order and existing files may
// not be removed. Amendments go through the correction flow. Throws if locked.
async function assertOrderReportEditable(tenantId: string, labOrderId: string) {
  const report = await prisma.labReport.findFirst({
    where: { labOrderId, labOrder: { tenantId } },
    select: { status: true },
  });
  if (report && report.status !== 'draft' && report.status !== 'review') {
    throw AppError.badRequest(
      `Report is already ${report.status} and locked by the lab supervisor — use the correction flow to amend it.`,
    );
  }
}

function inferCategory(mimeType: string, hint?: AllowedCategory): AllowedCategory {
  if (hint) return hint;
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'report_pdf';
  return 'other';
}

export async function createLabAttachment(
  tenantId: string,
  uploaderId: string,
  labOrderId: string,
  file: Express.Multer.File,
  options: {
    labReportId?: string;
    labOrderItemId?: string;
    category?: AllowedCategory;
    description?: string;
  },
) {
  // Verify the order belongs to the tenant — otherwise we'd leak a way to
  // attach a file to another tenant's order via a guessed UUID.
  const order = await prisma.labOrder.findFirst({
    where: { id: labOrderId, tenantId },
    select: { id: true },
  });
  if (!order) throw AppError.notFound('Lab order not found');

  // Cannot attach files once the supervisor has finalized the report.
  await assertOrderReportEditable(tenantId, labOrderId);

  if (options.labReportId) {
    const report = await prisma.labReport.findFirst({
      where: { id: options.labReportId, labOrder: { tenantId } },
      select: { id: true, labOrderId: true },
    });
    if (!report) throw AppError.notFound('Lab report not found');
    if (report.labOrderId !== labOrderId) {
      throw AppError.badRequest('Report does not belong to this order');
    }
  }

  if (options.labOrderItemId) {
    const item = await prisma.labOrderItem.findFirst({
      where: { id: options.labOrderItemId, labOrderId },
      select: { id: true },
    });
    if (!item) throw AppError.notFound('Order item not found on this order');
  }

  const category = inferCategory(file.mimetype, options.category);

  const attachment = await prisma.labAttachment.create({
    data: {
      tenantId,
      labOrderId,
      labReportId: options.labReportId ?? null,
      labOrderItemId: options.labOrderItemId ?? null,
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

  // Mirror onto LabReport.pdfUrl so existing readers (patient portal) light up
  // automatically when a tech uploads the signed PDF and no pdfUrl was set.
  if (options.labReportId && category === 'report_pdf') {
    await prisma.labReport.update({
      where: { id: options.labReportId },
      data: { pdfUrl: attachment.fileUrl },
    }).catch((err) => logger.warn({ err, reportId: options.labReportId }, 'Failed to mirror pdfUrl onto LabReport'));
  }

  logger.info({ tenantId, attachmentId: attachment.id, labOrderId }, 'Lab attachment uploaded');
  return attachment;
}

export async function listLabAttachmentsForOrder(tenantId: string, labOrderId: string) {
  const order = await prisma.labOrder.findFirst({
    where: { id: labOrderId, tenantId },
    select: { id: true },
  });
  if (!order) throw AppError.notFound('Lab order not found');

  return prisma.labAttachment.findMany({
    where: { labOrderId, tenantId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      uploader: { select: { id: true, firstName: true, lastName: true } },
    },
  });
}

export async function listLabAttachmentsForReport(tenantId: string, labReportId: string) {
  const report = await prisma.labReport.findFirst({
    where: { id: labReportId, labOrder: { tenantId } },
    select: { id: true },
  });
  if (!report) throw AppError.notFound('Lab report not found');

  return prisma.labAttachment.findMany({
    where: { labReportId, tenantId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      uploader: { select: { id: true, firstName: true, lastName: true } },
    },
  });
}

export async function deleteLabAttachment(tenantId: string, id: string) {
  const att = await prisma.labAttachment.findFirst({
    where: { id, tenantId, deletedAt: null },
  });
  if (!att) throw AppError.notFound('Attachment not found');

  // Cannot remove files once the supervisor has finalized the report.
  await assertOrderReportEditable(tenantId, att.labOrderId);

  await prisma.labAttachment.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  // Best-effort physical delete — keep the row's deletedAt either way so the
  // audit trail says "this existed once".
  const fileName = att.fileUrl.replace(/^\/uploads\//, '');
  if (fileName && !fileName.includes('..') && !fileName.includes('/')) {
    try {
      const fullPath = path.join(UPLOAD_DIR, fileName);
      if (fs.existsSync(fullPath)) await deleteFile(fileName);
    } catch (err) {
      logger.warn({ err, fileName }, 'Failed to remove attachment file from disk');
    }
  }

  logger.info({ tenantId, attachmentId: id }, 'Lab attachment soft-deleted');
  return { success: true };
}
