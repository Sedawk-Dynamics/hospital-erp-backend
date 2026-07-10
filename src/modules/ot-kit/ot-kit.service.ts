import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';

// ============================================================
// OT Kit — "Issue Bulk, Reconcile Net" surgical consumables (design doc III)
// ============================================================
// A hospital pre-defines surgeon-preference kit bundles (SurgicalTemplate). Pre-op
// the OT nurse requests a template for a scheduled patient; the pharmacy issues
// the whole bundle — FEFO batches leave active pharmacy stock into a transit
// bucket bound to the OT session (NOT billed yet). Post-op the crate of unused
// items is scanned back and the system nets Issued − Returned = Consumed: only
// the consumed cost is posted to the patient's bill and the unused units are
// reversed into active pharmacy stock.

const PHARMACY_OP_ROLES = new Set(['super_admin', 'admin', 'pharmacy_admin', 'pharmacist']);

// Surgical preference-card templates are shared OT + pharmacy MASTER DATA: both
// the pharmacy (admin) and the OT nurse maintain them. Any authenticated staff
// member who can reach the OT-Kit / Pharmacy module may manage them — access is
// scoped by the module navigation, not a hard role check here. Kept as a hook so
// a tenant can re-tighten it later without touching the call sites.
function assertTemplateManager(_roles: string[], _action: string): void {
  /* intentionally permissive — OT nurse + pharmacy both manage templates */
}

function assertPharmacyOperator(roles: string[], action: string) {
  if (!roles.some((r) => PHARMACY_OP_ROLES.has(r))) {
    throw AppError.forbidden(`You do not have permission to ${action}.`);
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Next OT-kit issue number (OTK-YYYYMMDD-####). */
async function nextIssueNumber(tx: any, tenantId: string): Promise<string> {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const prefix = `OTK-${ymd}-`;
  const todays = await tx.otKitIssue.count({ where: { tenantId, issueNumber: { startsWith: prefix } } });
  return `${prefix}${String(todays + 1).padStart(4, '0')}`;
}

/** Resolve formulary names/pricing for a set of drug ids (for list hydration). */
async function drugMap(tenantId: string, ids: string[]) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map<string, { drugName: string; genericName: string | null; looseUnitLabel: string | null; price: number | null; taxPercent: number | null }>();
  const rows = await prisma.drugFormulary.findMany({
    where: { tenantId, id: { in: uniq } },
    select: { id: true, drugName: true, genericName: true, looseUnitLabel: true, price: true, taxPercent: true },
  });
  return new Map(rows.map((r) => [r.id, {
    drugName: r.drugName,
    genericName: r.genericName,
    looseUnitLabel: r.looseUnitLabel,
    price: r.price != null ? Number(r.price) : null,
    taxPercent: r.taxPercent != null ? Number(r.taxPercent) : null,
  }]));
}

async function patientLabel(tenantId: string, patientId: string) {
  const p = await prisma.patient.findFirst({ where: { id: patientId, tenantId }, select: { firstName: true, lastName: true, mrn: true } });
  return p ? { name: `${p.firstName} ${p.lastName ?? ''}`.trim(), mrn: p.mrn } : { name: patientId, mrn: null };
}

// ============================================================
// Surgical Template Master (preference cards)
// ============================================================

export async function listTemplates(
  tenantId: string,
  query: { search?: string; doctorId?: string; includeInactive?: boolean } = {},
) {
  const where: any = { tenantId };
  if (!query.includeInactive) where.isActive = true;
  if (query.doctorId) where.doctorId = query.doctorId;
  if (query.search?.trim()) {
    const s = query.search.trim();
    where.OR = [
      { name: { contains: s, mode: 'insensitive' } },
      { procedureName: { contains: s, mode: 'insensitive' } },
      { kitBarcode: { equals: s } },
    ];
  }
  const templates = await prisma.surgicalTemplate.findMany({
    where,
    orderBy: { name: 'asc' },
    include: { items: true },
    take: 500,
  });
  const names = await drugMap(tenantId, templates.flatMap((t) => t.items.map((i) => i.drugFormularyId)));
  return {
    items: templates.map((t) => ({
      ...t,
      items: t.items.map((i) => ({
        ...i,
        drugName: names.get(i.drugFormularyId)?.drugName ?? '-',
        looseUnitLabel: names.get(i.drugFormularyId)?.looseUnitLabel ?? null,
      })),
    })),
    total: templates.length,
  };
}

export async function getTemplateById(tenantId: string, id: string) {
  const t = await prisma.surgicalTemplate.findFirst({ where: { id, tenantId }, include: { items: true } });
  if (!t) throw AppError.notFound('Surgical template not found');
  const names = await drugMap(tenantId, t.items.map((i) => i.drugFormularyId));
  return {
    ...t,
    items: t.items.map((i) => ({
      ...i,
      drugName: names.get(i.drugFormularyId)?.drugName ?? '-',
      genericName: names.get(i.drugFormularyId)?.genericName ?? null,
      looseUnitLabel: names.get(i.drugFormularyId)?.looseUnitLabel ?? null,
    })),
  };
}

interface TemplateItemInput { drugFormularyId: string; defaultQuantity: number; notes?: string }
interface TemplateInput {
  name: string;
  procedureName?: string;
  doctorId?: string;
  kitBarcode?: string;
  notes?: string;
  items: TemplateItemInput[];
}

async function assertDrugsExist(tenantId: string, ids: string[]) {
  const uniq = [...new Set(ids)];
  const found = await prisma.drugFormulary.count({ where: { tenantId, id: { in: uniq } } });
  if (found !== uniq.length) throw AppError.badRequest('One or more kit items are not in this hospital formulary');
}

export async function createTemplate(tenantId: string, userId: string, roles: string[], data: TemplateInput) {
  assertTemplateManager(roles, 'manage surgical templates');
  if (!data.items?.length) throw AppError.badRequest('A kit template needs at least one item');
  await assertDrugsExist(tenantId, data.items.map((i) => i.drugFormularyId));
  if (data.kitBarcode) {
    const dup = await prisma.surgicalTemplate.findFirst({ where: { tenantId, kitBarcode: data.kitBarcode } });
    if (dup) throw AppError.conflict('That kit barcode is already used by another template');
  }
  const created = await prisma.surgicalTemplate.create({
    data: {
      tenantId,
      name: data.name.trim(),
      procedureName: data.procedureName?.trim() || null,
      doctorId: data.doctorId || null,
      kitBarcode: data.kitBarcode?.trim() || null,
      notes: data.notes?.trim() || null,
      createdById: userId,
      items: {
        create: data.items.map((i) => ({
          drugFormularyId: i.drugFormularyId,
          defaultQuantity: Math.max(1, Math.trunc(i.defaultQuantity)),
          notes: i.notes?.trim() || null,
        })),
      },
    },
    include: { items: true },
  });
  logger.info({ tenantId, templateId: created.id }, 'Surgical template created');
  return created;
}

export async function updateTemplate(tenantId: string, roles: string[], id: string, data: Partial<TemplateInput>) {
  assertTemplateManager(roles, 'manage surgical templates');
  const existing = await prisma.surgicalTemplate.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Surgical template not found');
  if (data.kitBarcode) {
    const dup = await prisma.surgicalTemplate.findFirst({ where: { tenantId, kitBarcode: data.kitBarcode, id: { not: id } } });
    if (dup) throw AppError.conflict('That kit barcode is already used by another template');
  }
  if (data.items) await assertDrugsExist(tenantId, data.items.map((i) => i.drugFormularyId));

  return prisma.$transaction(async (tx) => {
    await tx.surgicalTemplate.update({
      where: { id },
      data: {
        name: data.name?.trim() ?? undefined,
        procedureName: data.procedureName !== undefined ? (data.procedureName?.trim() || null) : undefined,
        doctorId: data.doctorId !== undefined ? (data.doctorId || null) : undefined,
        kitBarcode: data.kitBarcode !== undefined ? (data.kitBarcode?.trim() || null) : undefined,
        notes: data.notes !== undefined ? (data.notes?.trim() || null) : undefined,
      },
    });
    if (data.items) {
      await tx.surgicalTemplateItem.deleteMany({ where: { templateId: id } });
      await tx.surgicalTemplateItem.createMany({
        data: data.items.map((i) => ({
          templateId: id,
          drugFormularyId: i.drugFormularyId,
          defaultQuantity: Math.max(1, Math.trunc(i.defaultQuantity)),
          notes: i.notes?.trim() || null,
        })),
      });
    }
    return tx.surgicalTemplate.findUnique({ where: { id }, include: { items: true } });
  });
}

export async function deleteTemplate(tenantId: string, roles: string[], id: string) {
  assertTemplateManager(roles, 'manage surgical templates');
  const existing = await prisma.surgicalTemplate.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Surgical template not found');
  // Soft-retire (kit issues reference it by id; keep for history).
  await prisma.surgicalTemplate.update({ where: { id }, data: { isActive: false } });
  return { id, isActive: false };
}

// ============================================================
// Kit issue lifecycle — request → issue (transit lock) → reconcile (net bill)
// ============================================================

/** Expand a template into a list of {drugFormularyId, quantity} lines. */
async function expandTemplate(tenantId: string, templateId: string) {
  const t = await prisma.surgicalTemplate.findFirst({ where: { id: templateId, tenantId }, include: { items: true } });
  if (!t) throw AppError.notFound('Surgical template not found');
  return t.items.map((i) => ({ drugFormularyId: i.drugFormularyId, quantity: i.defaultQuantity }));
}

/** Pre-op: OT nurse requests a kit template for a scheduled patient (no stock moves yet). */
export async function requestKit(
  tenantId: string,
  userId: string,
  data: { otRequestId?: string; patientId: string; visitId?: string; templateId?: string; notes?: string },
) {
  const patient = await prisma.patient.findFirst({ where: { id: data.patientId, tenantId }, select: { id: true } });
  if (!patient) throw AppError.notFound('Patient not found');
  if (data.templateId) {
    const t = await prisma.surgicalTemplate.findFirst({ where: { id: data.templateId, tenantId }, select: { id: true } });
    if (!t) throw AppError.notFound('Surgical template not found');
  }
  const issue = await prisma.$transaction(async (tx) => {
    return tx.otKitIssue.create({
      data: {
        tenantId,
        issueNumber: await nextIssueNumber(tx, tenantId),
        otRequestId: data.otRequestId || null,
        patientId: data.patientId,
        visitId: data.visitId || null,
        templateId: data.templateId || null,
        status: 'requested',
        requestedById: userId,
        notes: data.notes?.trim() || null,
      },
    });
  });
  logger.info({ tenantId, issueId: issue.id }, 'OT kit requested');
  return issue;
}

/**
 * Pharmacy: bulk-issue a kit into the transit bucket bound to the OT session. FEFO
 * batches leave active pharmacy stock but are NOT billed. Accepts either an
 * existing `issueId` (a nurse request to fulfil), an explicit `items[]`, a
 * `templateId`, or a `kitBarcode` (one scan expands the whole bundle).
 */
export async function issueKit(
  tenantId: string,
  userId: string,
  roles: string[],
  data: {
    issueId?: string;
    otRequestId?: string;
    patientId?: string;
    visitId?: string;
    templateId?: string;
    kitBarcode?: string;
    items?: Array<{ drugFormularyId: string; quantity: number }>;
    notes?: string;
  },
) {
  assertPharmacyOperator(roles, 'issue an OT kit');

  // Resolve the target issue row (an existing request, or a fresh direct issue).
  let issueRow = data.issueId
    ? await prisma.otKitIssue.findFirst({ where: { id: data.issueId, tenantId } })
    : null;
  if (data.issueId && !issueRow) throw AppError.notFound('OT kit request not found');
  if (issueRow && issueRow.status !== 'requested') {
    throw AppError.badRequest(`This kit is already ${issueRow.status}; it cannot be issued again`);
  }

  const patientId = issueRow?.patientId ?? data.patientId;
  if (!patientId) throw AppError.badRequest('patientId is required to issue a kit');

  // Resolve the line list: explicit items > barcode > template (from data or request).
  let lines = data.items?.length ? data.items : null;
  let templateId = data.templateId ?? issueRow?.templateId ?? null;
  if (!lines && data.kitBarcode) {
    const t = await prisma.surgicalTemplate.findFirst({ where: { tenantId, kitBarcode: data.kitBarcode.trim() }, select: { id: true } });
    if (!t) throw AppError.notFound('No kit template matches that barcode');
    templateId = t.id;
  }
  if (!lines && templateId) lines = await expandTemplate(tenantId, templateId);
  if (!lines?.length) throw AppError.badRequest('Nothing to issue — provide items, a template, or a kit barcode');

  const result = await prisma.$transaction(async (tx) => {
    // Create/reuse the issue header.
    let issue = issueRow;
    if (!issue) {
      issue = await tx.otKitIssue.create({
        data: {
          tenantId,
          issueNumber: await nextIssueNumber(tx, tenantId),
          otRequestId: data.otRequestId || null,
          patientId,
          visitId: data.visitId || null,
          templateId,
          status: 'requested',
          requestedById: userId,
          notes: data.notes?.trim() || null,
        },
      });
    }

    for (const line of lines!) {
      const qty = Math.trunc(line.quantity);
      if (qty <= 0) continue;
      const drug = await tx.drugFormulary.findFirst({
        where: { id: line.drugFormularyId, tenantId },
        select: { id: true, drugName: true, price: true, taxPercent: true, isNarcotic: true },
      });
      if (!drug) throw AppError.badRequest('A kit item is not in this hospital formulary');
      // NDPS narcotics are vault-controlled and cannot ride in an OT kit — they go
      // through the NDPS transfer + Form 3E workflow.
      if (drug.isNarcotic) {
        throw AppError.badRequest(`${drug.drugName} is an NDPS narcotic and cannot be issued in an OT kit — use the NDPS workflow.`);
      }

      const taxPct = drug.taxPercent != null ? Number(drug.taxPercent) : 0;

      // FEFO across ALL available batches: draw the requested quantity from the
      // earliest-expiring batches first, one issue line per batch used. Any
      // shortfall — a consumable with no/low stock, e.g. not yet inward-ed — is
      // still issued as a batch-less line so the physical crate is fully tracked
      // and can be reconciled/billed. Issuing therefore never fails on stock.
      let remaining = qty;
      const batches = await tx.drugBatch.findMany({
        where: { tenantId, drugId: drug.id, isExpired: false, isRecalled: false, quantityInStock: { gt: 0 } },
        orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
      });
      for (const b of batches) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, b.quantityInStock);
        if (take <= 0) continue;
        await tx.drugBatch.update({ where: { id: b.id }, data: { quantityInStock: { decrement: take } } });
        await tx.otKitIssueItem.create({
          data: {
            issueId: issue.id,
            drugFormularyId: drug.id,
            drugBatchId: b.id,
            issuedQty: take,
            returnedQty: 0,
            unitPrice: Number(b.sellingPrice ?? drug.price ?? b.purchasePrice ?? 0),
            taxPercent: taxPct,
          },
        });
        remaining -= take;
      }
      if (remaining > 0) {
        // Not enough stock on hand — issue the remainder without a batch link so
        // the crate reflects the full quantity (no stock movement for this part).
        await tx.otKitIssueItem.create({
          data: {
            issueId: issue.id,
            drugFormularyId: drug.id,
            drugBatchId: null,
            issuedQty: remaining,
            returnedQty: 0,
            unitPrice: Number(drug.price ?? 0),
            taxPercent: taxPct,
          },
        });
      }
    }

    return tx.otKitIssue.update({
      where: { id: issue.id },
      data: { status: 'issued', issuedById: userId, issuedAt: new Date() },
      include: { items: true },
    });
  });

  logger.info({ tenantId, issueId: result.id, items: result.items.length }, 'OT kit issued (transit lock)');
  return result;
}

/**
 * Post-op: reconcile net. Staff scan the returned/unused items. For each line
 * consumed = issued − returned; the returned units are reversed into active
 * pharmacy stock, and ONLY the consumed cost is posted to the patient's bill.
 */
export async function reconcileKit(
  tenantId: string,
  userId: string,
  roles: string[],
  data: { issueId: string; returns?: Array<{ itemId: string; returnedQty: number }>; notes?: string },
) {
  assertPharmacyOperator(roles, 'reconcile an OT kit');

  const issue = await prisma.otKitIssue.findFirst({ where: { id: data.issueId, tenantId }, include: { items: true } });
  if (!issue) throw AppError.notFound('OT kit issue not found');
  if (issue.status !== 'issued') throw AppError.badRequest(`Only an issued kit can be reconciled (this one is ${issue.status})`);

  const returnMap = new Map((data.returns ?? []).map((r) => [r.itemId, Math.max(0, Math.trunc(r.returnedQty))]));
  // Validate returns don't exceed issued.
  for (const it of issue.items) {
    const ret = returnMap.get(it.id) ?? 0;
    if (ret > it.issuedQty) throw AppError.badRequest(`Returned quantity exceeds issued for one line (${ret} > ${it.issuedQty})`);
  }

  const drugNames = await drugMap(tenantId, issue.items.map((i) => i.drugFormularyId));

  const result = await prisma.$transaction(async (tx) => {
    let consumedTotal = 0;
    let consumedTax = 0;
    const consumedLines: Array<{ drugName: string; consumedQty: number; unitPrice: number; taxPct: number; gross: number }> = [];

    for (const it of issue.items) {
      const ret = returnMap.get(it.id) ?? 0;
      const consumed = it.issuedQty - ret;
      const unitPrice = Number(it.unitPrice ?? 0);
      const taxPct = Number(it.taxPercent ?? 0);
      const gross = round2(unitPrice * consumed);
      const taxAmt = round2(gross - gross / (1 + taxPct / 100));

      // Reverse unused units into active stock (the exact batch they left).
      if (ret > 0 && it.drugBatchId) {
        await tx.drugBatch.update({ where: { id: it.drugBatchId }, data: { quantityInStock: { increment: ret } } });
      }
      await tx.otKitIssueItem.update({
        where: { id: it.id },
        data: { returnedQty: ret, consumedQty: consumed, lineTotal: gross },
      });
      if (consumed > 0) {
        consumedTotal = round2(consumedTotal + gross);
        consumedTax = round2(consumedTax + taxAmt);
        consumedLines.push({ drugName: drugNames.get(it.drugFormularyId)?.drugName ?? 'Item', consumedQty: consumed, unitPrice, taxPct, gross });
      }
    }

    // Net-bill: post the consumed cost to the patient's open bill (or a draft IP bill).
    let billId: string | null = null;
    if (consumedTotal > 0) {
      // G2: scope the OT bill to the patient's active admission so the running IP
      // ledger is per-stay (an OT case for an admitted patient bills to that stay).
      const admId = (await tx.admission.findFirst({ where: { tenantId, patientId: issue.patientId, status: 'admitted' }, orderBy: { admissionDate: 'desc' }, select: { id: true } }))?.id ?? null;
      let bill = await tx.bill.findFirst({
        where: { tenantId, patientId: issue.patientId, status: { in: ['draft', 'pending', 'partially_paid'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (!bill) {
        const now = new Date();
        const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
        const prefix = `OTK-${ymd}-`;
        const seq = await tx.bill.count({ where: { tenantId, billNumber: { startsWith: prefix } } });
        bill = await tx.bill.create({
          data: {
            tenantId,
            billNumber: `${prefix}${String(seq + 1).padStart(4, '0')}`,
            patientId: issue.patientId,
            visitId: issue.visitId ?? undefined,
            admissionId: admId ?? undefined,
            billDate: new Date(),
            subtotal: 0,
            taxAmount: 0,
            totalAmount: 0,
            patientPayableAmount: 0,
            balanceDue: 0,
            status: 'draft',
            generatedBy: userId,
          },
        });
      } else if (!bill.admissionId && admId) {
        bill = await tx.bill.update({ where: { id: bill.id }, data: { admissionId: admId } });
      }

      for (const line of consumedLines) {
        const taxAmt = round2(line.gross - line.gross / (1 + line.taxPct / 100));
        await tx.billItem.create({
          data: {
            billId: bill.id,
            description: `${line.drugName} — OT kit consumed (${line.consumedQty} unit(s), Kit ${issue.issueNumber})`,
            category: 'pharmacy',
            quantity: line.consumedQty,
            unitPrice: line.unitPrice,
            taxPercent: line.taxPct,
            taxAmount: taxAmt,
            totalAmount: line.gross,
            referenceType: 'ot_kit_issue',
            referenceId: issue.id,
            isAutoPulled: true,
          },
        });
      }
      await tx.bill.update({
        where: { id: bill.id },
        data: {
          subtotal: round2(Number(bill.subtotal) + consumedTotal),
          taxAmount: round2(Number(bill.taxAmount) + consumedTax),
          totalAmount: round2(Number(bill.totalAmount) + consumedTotal),
          patientPayableAmount: round2(Number(bill.patientPayableAmount) + consumedTotal),
          balanceDue: round2(Number(bill.balanceDue) + consumedTotal),
        },
      });
      billId = bill.id;
    }

    return tx.otKitIssue.update({
      where: { id: issue.id },
      data: {
        status: 'reconciled',
        reconciledById: userId,
        reconciledAt: new Date(),
        billId,
        notes: data.notes?.trim() ? `${issue.notes ? issue.notes + ' | ' : ''}${data.notes.trim()}` : issue.notes,
      },
      include: { items: true },
    });
  });

  logger.info({ tenantId, issueId: issue.id, billId: result.billId }, 'OT kit reconciled (net billed)');
  return result;
}

/** Cancel a kit. An issued kit reverses ALL issued stock back into active inventory. */
export async function cancelKit(tenantId: string, userId: string, roles: string[], id: string, reason?: string) {
  assertPharmacyOperator(roles, 'cancel an OT kit');
  const issue = await prisma.otKitIssue.findFirst({ where: { id, tenantId }, include: { items: true } });
  if (!issue) throw AppError.notFound('OT kit issue not found');
  if (issue.status === 'reconciled') throw AppError.badRequest('A reconciled kit cannot be cancelled');
  if (issue.status === 'cancelled') return issue;

  const result = await prisma.$transaction(async (tx) => {
    if (issue.status === 'issued') {
      for (const it of issue.items) {
        if (it.drugBatchId && it.issuedQty > 0) {
          await tx.drugBatch.update({ where: { id: it.drugBatchId }, data: { quantityInStock: { increment: it.issuedQty } } });
        }
        await tx.otKitIssueItem.update({ where: { id: it.id }, data: { returnedQty: it.issuedQty, consumedQty: 0 } });
      }
    }
    return tx.otKitIssue.update({
      where: { id },
      data: { status: 'cancelled', notes: reason ? `${issue.notes ? issue.notes + ' | ' : ''}Cancelled: ${reason}` : issue.notes },
      include: { items: true },
    });
  });
  logger.info({ tenantId, issueId: id }, 'OT kit cancelled (stock reversed)');
  return result;
}

// ============================================================
// Reads
// ============================================================

/** Resolve batch numbers for a set of batch ids (issue lines can span batches). */
async function batchNumberMap(tenantId: string, ids: Array<string | null | undefined>) {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map<string, string>();
  const rows = await prisma.drugBatch.findMany({ where: { tenantId, id: { in: uniq } }, select: { id: true, batchNumber: true } });
  return new Map(rows.map((r) => [r.id, r.batchNumber]));
}

export async function listIssues(
  tenantId: string,
  query: { status?: string; patientId?: string; otRequestId?: string } = {},
) {
  const where: any = { tenantId };
  if (query.status) where.status = query.status;
  if (query.patientId) where.patientId = query.patientId;
  if (query.otRequestId) where.otRequestId = query.otRequestId;
  const issues = await prisma.otKitIssue.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { items: true },
    take: 300,
  });
  const names = await drugMap(tenantId, issues.flatMap((i) => i.items.map((x) => x.drugFormularyId)));
  const batchNos = await batchNumberMap(tenantId, issues.flatMap((i) => i.items.map((x) => x.drugBatchId)));
  const patientIds = [...new Set(issues.map((i) => i.patientId))];
  const patients = await prisma.patient.findMany({ where: { tenantId, id: { in: patientIds } }, select: { id: true, firstName: true, lastName: true, mrn: true } });
  const pMap = new Map(patients.map((p) => [p.id, { name: `${p.firstName} ${p.lastName ?? ''}`.trim(), mrn: p.mrn }]));
  return {
    items: issues.map((i) => ({
      ...i,
      patientName: pMap.get(i.patientId)?.name ?? null,
      patientMrn: pMap.get(i.patientId)?.mrn ?? null,
      items: i.items.map((x) => ({
        ...x,
        drugName: names.get(x.drugFormularyId)?.drugName ?? '-',
        looseUnitLabel: names.get(x.drugFormularyId)?.looseUnitLabel ?? null,
        batchNumber: x.drugBatchId ? (batchNos.get(x.drugBatchId) ?? null) : null,
      })),
    })),
    total: issues.length,
  };
}

export async function getIssueById(tenantId: string, id: string) {
  const issue = await prisma.otKitIssue.findFirst({ where: { id, tenantId }, include: { items: true } });
  if (!issue) throw AppError.notFound('OT kit issue not found');
  const names = await drugMap(tenantId, issue.items.map((i) => i.drugFormularyId));
  const batchNos = await batchNumberMap(tenantId, issue.items.map((i) => i.drugBatchId));
  const patient = await patientLabel(tenantId, issue.patientId);
  return {
    ...issue,
    patientName: patient.name,
    patientMrn: patient.mrn,
    items: issue.items.map((x) => ({
      ...x,
      drugName: names.get(x.drugFormularyId)?.drugName ?? '-',
      looseUnitLabel: names.get(x.drugFormularyId)?.looseUnitLabel ?? null,
      batchNumber: x.drugBatchId ? (batchNos.get(x.drugBatchId) ?? null) : null,
    })),
  };
}
