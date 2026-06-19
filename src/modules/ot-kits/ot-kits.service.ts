import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';

// ============================================================
// OT Surgical Kits — "Issue Bulk, Reconcile Net" (spec)
// ============================================================
// A surgeon-preference kit is issued as a bulk crate into a Virtual OT Ledger
// bound to the patient's session; only the consumed quantity (issued − returned)
// is billed, and the sealed leftovers are reversed back into pharmacy stock.

const OT_KIT_ROLES = new Set(['super_admin', 'admin', 'pharmacy_admin', 'ot_admin', 'ot_technician']);

function assertOtKit(roles: string[], action: string) {
  if (!roles.some((r) => OT_KIT_ROLES.has(r))) {
    throw AppError.forbidden(`You do not have permission to ${action}.`);
  }
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

async function nextOtBillNumber(tx: any, tenantId: string): Promise<string> {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const prefix = `OT-${ymd}-`;
  const todays = await tx.bill.count({ where: { tenantId, billNumber: { startsWith: prefix } } });
  return `${prefix}${String(todays + 1).padStart(4, '0')}`;
}

// ── Surgical kit templates (master) ─────────────────────────

export async function createKitTemplate(
  tenantId: string,
  roles: string[],
  data: { name: string; surgeryType?: string; doctorId?: string; description?: string; items: Array<{ drugFormularyId: string; quantity: number }> },
) {
  assertOtKit(roles, 'manage surgical kit templates');
  if (!data.items?.length) throw AppError.badRequest('A kit needs at least one item');
  return prisma.surgicalKitTemplate.create({
    data: {
      tenantId,
      name: data.name,
      surgeryType: data.surgeryType ?? null,
      doctorId: data.doctorId ?? null,
      description: data.description ?? null,
      items: { create: data.items.map((i) => ({ drugFormularyId: i.drugFormularyId, quantity: i.quantity })) },
    },
    include: { items: { include: { drug: { select: { id: true, drugName: true, strength: true } } } } },
  });
}

export async function listKitTemplates(tenantId: string, query: { search?: string } = {}) {
  const where: any = { tenantId, isActive: true };
  if (query.search) where.name = { contains: query.search, mode: 'insensitive' };
  return prisma.surgicalKitTemplate.findMany({
    where,
    orderBy: { name: 'asc' },
    include: { items: { include: { drug: { select: { id: true, drugName: true, strength: true } } } } },
  });
}

export async function updateKitTemplate(
  tenantId: string,
  roles: string[],
  id: string,
  data: { name?: string; surgeryType?: string | null; doctorId?: string | null; description?: string | null; isActive?: boolean; items?: Array<{ drugFormularyId: string; quantity: number }> },
) {
  assertOtKit(roles, 'manage surgical kit templates');
  const existing = await prisma.surgicalKitTemplate.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Kit template not found');
  return prisma.$transaction(async (tx) => {
    if (data.items) {
      await tx.surgicalKitTemplateItem.deleteMany({ where: { templateId: id } });
      await tx.surgicalKitTemplateItem.createMany({ data: data.items.map((i) => ({ templateId: id, drugFormularyId: i.drugFormularyId, quantity: i.quantity })) });
    }
    return tx.surgicalKitTemplate.update({
      where: { id },
      data: {
        name: data.name ?? undefined,
        surgeryType: data.surgeryType !== undefined ? data.surgeryType : undefined,
        doctorId: data.doctorId !== undefined ? data.doctorId : undefined,
        description: data.description !== undefined ? data.description : undefined,
        isActive: data.isActive ?? undefined,
      },
      include: { items: { include: { drug: { select: { id: true, drugName: true, strength: true } } } } },
    });
  });
}

export async function deleteKitTemplate(tenantId: string, roles: string[], id: string) {
  assertOtKit(roles, 'manage surgical kit templates');
  const existing = await prisma.surgicalKitTemplate.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Kit template not found');
  await prisma.surgicalKitTemplate.update({ where: { id }, data: { isActive: false } });
  return { id, deactivated: true };
}

// ── Issue (Virtual OT Ledger transit-lock) ──────────────────

/**
 * Bulk-issue a kit to a patient's OT session. Each item is taken FEFO from
 * pharmacy stock (the stock leaves the active pool) but is NOT billed yet — it
 * sits in the Virtual OT Ledger under this issue until post-op reconciliation.
 */
export async function issueKit(
  tenantId: string,
  userId: string,
  roles: string[],
  data: {
    patientId: string;
    admissionId?: string;
    templateId?: string;
    surgeryName: string;
    items?: Array<{ drugFormularyId: string; quantity: number }>;
  },
) {
  assertOtKit(roles, 'issue a surgical kit');
  const patient = await prisma.patient.findFirst({ where: { id: data.patientId, tenantId }, select: { id: true } });
  if (!patient) throw AppError.notFound('Patient not found');

  let lines = data.items ?? [];
  if (data.templateId) {
    const template = await prisma.surgicalKitTemplate.findFirst({
      where: { id: data.templateId, tenantId },
      include: { items: true },
    });
    if (!template) throw AppError.notFound('Kit template not found');
    lines = template.items.map((i) => ({ drugFormularyId: i.drugFormularyId, quantity: i.quantity }));
  }
  if (!lines.length) throw AppError.badRequest('A kit issue needs at least one item');

  return prisma.$transaction(async (tx) => {
    const issueItems: any[] = [];
    for (const line of lines) {
      if (line.quantity <= 0) throw AppError.badRequest('Item quantity must be positive');
      // FEFO batch with enough stock for the whole line.
      const batch = await tx.drugBatch.findFirst({
        where: { tenantId, drugId: line.drugFormularyId, isExpired: false, isRecalled: false, quantityInStock: { gte: line.quantity } },
        orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
        include: { drug: { select: { drugName: true, price: true, taxPercent: true } } },
      });
      if (!batch) {
        const drug = await tx.drugFormulary.findUnique({ where: { id: line.drugFormularyId }, select: { drugName: true } });
        throw AppError.badRequest(`Insufficient stock to issue ${line.quantity} of ${drug?.drugName ?? 'a kit item'} from any single batch.`);
      }
      await tx.drugBatch.update({ where: { id: batch.id }, data: { quantityInStock: { decrement: line.quantity } } });
      issueItems.push({
        drugFormularyId: line.drugFormularyId,
        drugBatchId: batch.id,
        issuedQty: line.quantity,
        unitPrice: Number(batch.sellingPrice ?? batch.drug?.price ?? 0),
        taxPercent: batch.drug?.taxPercent != null ? Number(batch.drug.taxPercent) : 0,
      });
    }

    const issue = await tx.otKitIssue.create({
      data: {
        tenantId,
        patientId: data.patientId,
        admissionId: data.admissionId ?? null,
        templateId: data.templateId ?? null,
        surgeryName: data.surgeryName,
        status: 'issued',
        issuedById: userId,
        items: { create: issueItems },
      },
      include: { items: { include: { drug: { select: { drugName: true, strength: true } }, drugBatch: { select: { batchNumber: true, expiryDate: true } } } } },
    });
    logger.info({ tenantId, issueId: issue.id, items: issueItems.length }, 'OT kit issued to Virtual OT Ledger');
    return issue;
  });
}

/**
 * Post-op reconciliation. For each issued item, the returned (sealed) quantity is
 * reversed back into pharmacy stock; the consumed quantity (issued − returned) is
 * billed to the patient's bill in one OT charge. Net billing, net stock reversal.
 */
export async function reconcileKit(
  tenantId: string,
  userId: string,
  roles: string[],
  issueId: string,
  data: { returns?: Array<{ itemId: string; returnedQty: number }> },
) {
  assertOtKit(roles, 'reconcile a surgical kit');
  const issue = await prisma.otKitIssue.findFirst({
    where: { id: issueId, tenantId },
    include: { items: { include: { drug: { select: { drugName: true } }, drugBatch: { select: { batchNumber: true } } } } },
  });
  if (!issue) throw AppError.notFound('Kit issue not found');
  if (issue.status !== 'issued') throw AppError.badRequest(`This kit is already ${issue.status}.`);

  const returnMap = new Map((data.returns ?? []).map((r) => [r.itemId, r.returnedQty]));

  return prisma.$transaction(async (tx) => {
    const billLines: Array<{ description: string; quantity: number; unitPrice: number; taxPercent: number; gross: number; taxAmt: number; itemId: string }> = [];
    for (const item of issue.items) {
      let returnedQty = returnMap.get(item.id) ?? 0;
      returnedQty = Math.max(0, Math.min(returnedQty, item.issuedQty));
      const consumed = item.issuedQty - returnedQty;

      if (returnedQty > 0) {
        await tx.drugBatch.update({ where: { id: item.drugBatchId }, data: { quantityInStock: { increment: returnedQty } } });
      }
      await tx.otKitIssueItem.update({ where: { id: item.id }, data: { returnedQty } });

      if (consumed > 0) {
        const unitPrice = Number(item.unitPrice ?? 0);
        const taxPct = Number(item.taxPercent ?? 0);
        const gross = round2(unitPrice * consumed);
        const taxAmt = round2(gross - gross / (1 + taxPct / 100));
        billLines.push({
          description: `${item.drug?.drugName ?? 'OT item'} (Batch ${item.drugBatch?.batchNumber ?? '-'}) — OT consumed ${consumed}`,
          quantity: consumed,
          unitPrice,
          taxPercent: taxPct,
          gross,
          taxAmt,
          itemId: item.id,
        });
      }
    }

    let billId: string | null = null;
    let billNumber: string | null = null;
    const consumedTotal = round2(billLines.reduce((s, l) => s + l.gross, 0));
    if (billLines.length) {
      let bill = await tx.bill.findFirst({
        where: { tenantId, patientId: issue.patientId, status: { in: ['draft', 'pending', 'partially_paid'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (!bill) {
        bill = await tx.bill.create({
          data: {
            tenantId,
            billNumber: await nextOtBillNumber(tx, tenantId),
            patientId: issue.patientId,
            billDate: new Date(),
            subtotal: 0, discountAmount: 0, taxAmount: 0, totalAmount: 0,
            patientPayableAmount: 0, amountPaid: 0, balanceDue: 0,
            status: 'draft', generatedBy: userId,
          },
        });
      }
      const taxTotal = round2(billLines.reduce((s, l) => s + l.taxAmt, 0));
      for (const l of billLines) {
        await tx.billItem.create({
          data: {
            billId: bill.id,
            description: l.description,
            category: 'pharmacy',
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            taxPercent: l.taxPercent,
            taxAmount: l.taxAmt,
            totalAmount: l.gross,
            referenceType: 'ot_kit',
            referenceId: l.itemId,
            isAutoPulled: true,
          },
        });
      }
      await tx.bill.update({
        where: { id: bill.id },
        data: {
          subtotal: round2(Number(bill.subtotal) + consumedTotal),
          taxAmount: round2(Number(bill.taxAmount) + taxTotal),
          totalAmount: round2(Number(bill.totalAmount) + consumedTotal),
          patientPayableAmount: round2(Number(bill.patientPayableAmount) + consumedTotal),
          balanceDue: round2(Number(bill.balanceDue) + consumedTotal),
        },
      });
      billId = bill.id;
      billNumber = bill.billNumber;
    }

    const updated = await tx.otKitIssue.update({
      where: { id: issueId },
      data: { status: 'reconciled', reconciledById: userId, reconciledAt: new Date(), billId },
      include: { items: true },
    });
    logger.info({ tenantId, issueId, consumedTotal, billId }, 'OT kit reconciled');
    return { issue: updated, consumedTotal, billId, billNumber };
  });
}

/** Cancel an un-reconciled kit issue — reverse all issued stock back. */
export async function cancelKitIssue(tenantId: string, userId: string, roles: string[], issueId: string) {
  assertOtKit(roles, 'cancel a surgical kit');
  const issue = await prisma.otKitIssue.findFirst({ where: { id: issueId, tenantId }, include: { items: true } });
  if (!issue) throw AppError.notFound('Kit issue not found');
  if (issue.status !== 'issued') throw AppError.badRequest(`This kit is already ${issue.status}.`);
  return prisma.$transaction(async (tx) => {
    for (const item of issue.items) {
      await tx.drugBatch.update({ where: { id: item.drugBatchId }, data: { quantityInStock: { increment: item.issuedQty } } });
    }
    return tx.otKitIssue.update({ where: { id: issueId }, data: { status: 'cancelled', reconciledById: userId, reconciledAt: new Date() } });
  });
}

export async function listKitIssues(tenantId: string, query: { status?: string; patientId?: string } = {}) {
  const where: any = { tenantId };
  if (query.status) where.status = query.status;
  if (query.patientId) where.patientId = query.patientId;
  const rows = await prisma.otKitIssue.findMany({
    where,
    orderBy: { issuedAt: 'desc' },
    take: 1000,
    include: {
      patient: { select: { mrn: true, firstName: true, lastName: true } },
      items: { include: { drug: { select: { drugName: true, strength: true } }, drugBatch: { select: { batchNumber: true } } } },
    },
  });
  return {
    items: rows.map((r) => ({
      id: r.id,
      surgeryName: r.surgeryName,
      status: r.status,
      issuedAt: r.issuedAt,
      reconciledAt: r.reconciledAt,
      patient: r.patient ? { mrn: r.patient.mrn, name: `${r.patient.firstName} ${r.patient.lastName ?? ''}`.trim() } : null,
      items: r.items.map((i) => ({
        id: i.id,
        drugName: i.drug?.drugName ?? '-',
        strength: i.drug?.strength ?? null,
        batchNumber: i.drugBatch?.batchNumber ?? null,
        issuedQty: i.issuedQty,
        returnedQty: i.returnedQty,
        consumedQty: i.issuedQty - i.returnedQty,
        unitPrice: i.unitPrice != null ? Number(i.unitPrice) : null,
      })),
    })),
    total: rows.length,
  };
}

export async function getKitIssue(tenantId: string, id: string) {
  const issue = await prisma.otKitIssue.findFirst({
    where: { id, tenantId },
    include: {
      patient: { select: { mrn: true, firstName: true, lastName: true } },
      items: { include: { drug: { select: { drugName: true, strength: true } }, drugBatch: { select: { batchNumber: true, expiryDate: true } } } },
    },
  });
  if (!issue) throw AppError.notFound('Kit issue not found');
  return issue;
}
