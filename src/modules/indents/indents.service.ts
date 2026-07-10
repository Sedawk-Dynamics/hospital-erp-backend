import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPatientCreditStatus } from '../pharmacy/pharmacy.service';

// ============================================================
// IP Medication Indent (design doc I — ward→pharmacy fulfilment lifecycle)
// ============================================================
// raise (ward nurse) → approve (pharmacist, credit-gated) → dispense (FEFO batch,
// posts to the IP bill) → deliver (runner) → acknowledge (ward nurse verifies the
// batch against the indent, then administers). A TTO indent is dispensed in full
// packs and flagged for the final discharge bill.

const PHARMACY_OP_ROLES = new Set(['super_admin', 'admin', 'pharmacy_admin', 'pharmacist']);

function assertPharmacyOperator(roles: string[], action: string) {
  if (!roles.some((r) => PHARMACY_OP_ROLES.has(r))) {
    throw AppError.forbidden(`You do not have permission to ${action}.`);
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function nextIndentNumber(tx: any, tenantId: string): Promise<string> {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const prefix = `IND-${ymd}-`;
  const todays = await tx.medicationIndent.count({ where: { tenantId, indentNumber: { startsWith: prefix } } });
  return `${prefix}${String(todays + 1).padStart(4, '0')}`;
}

async function drugMap(tenantId: string, ids: string[]) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map<string, any>();
  const rows = await prisma.drugFormulary.findMany({
    where: { tenantId, id: { in: uniq } },
    select: { id: true, drugName: true, genericName: true, packSize: true, looseUnitLabel: true, price: true, taxPercent: true, isLifeSaving: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

async function hydrate(tenantId: string, indent: any) {
  const names = await drugMap(tenantId, indent.items.map((i: any) => i.drugFormularyId));
  const patient = await prisma.patient.findFirst({ where: { id: indent.patientId, tenantId }, select: { firstName: true, lastName: true, mrn: true } });
  return {
    ...indent,
    patientName: patient ? `${patient.firstName} ${patient.lastName ?? ''}`.trim() : null,
    patientMrn: patient?.mrn ?? null,
    items: indent.items.map((i: any) => ({
      ...i,
      drugName: names.get(i.drugFormularyId)?.drugName ?? '-',
      looseUnitLabel: names.get(i.drugFormularyId)?.looseUnitLabel ?? null,
      isLifeSaving: names.get(i.drugFormularyId)?.isLifeSaving ?? false,
    })),
  };
}

// ============================================================
// Lifecycle
// ============================================================

interface IndentItemInput { drugFormularyId: string; requestedQty: number; saleUnit?: string; notes?: string }

/** Ward nurse raises an indent to the IP pharmacy (design doc IP Step 2). */
export async function raiseIndent(
  tenantId: string,
  userId: string,
  data: {
    patientId: string;
    admissionId?: string;
    wardId?: string;
    prescriptionId?: string;
    isTto?: boolean;
    priority?: string;
    notes?: string;
    items: IndentItemInput[];
  },
) {
  const patient = await prisma.patient.findFirst({ where: { id: data.patientId, tenantId }, select: { id: true } });
  if (!patient) throw AppError.notFound('Patient not found');
  if (!data.items?.length) throw AppError.badRequest('An indent needs at least one drug line');

  const uniq = [...new Set(data.items.map((i) => i.drugFormularyId))];
  const found = await prisma.drugFormulary.count({ where: { tenantId, id: { in: uniq } } });
  if (found !== uniq.length) throw AppError.badRequest('One or more drugs are not in this hospital formulary');

  // Credit picture at raise time (surfaced to the pharmacist; does not block raising).
  let creditStatus = 'ok';
  try {
    const credit = await getPatientCreditStatus(tenantId, data.patientId);
    if (credit.requiresClearance) creditStatus = 'clearance_required';
  } catch { /* no admission → no credit gate */ }

  const isTto = !!data.isTto;
  const indent = await prisma.$transaction(async (tx) => {
    return tx.medicationIndent.create({
      data: {
        tenantId,
        indentNumber: await nextIndentNumber(tx, tenantId),
        patientId: data.patientId,
        admissionId: data.admissionId || null,
        wardId: data.wardId || null,
        prescriptionId: data.prescriptionId || null,
        status: 'raised',
        creditStatus,
        isTto,
        priority: data.priority || null,
        notes: data.notes?.trim() || null,
        raisedById: userId,
        items: {
          create: data.items.map((i) => ({
            drugFormularyId: i.drugFormularyId,
            requestedQty: Math.max(1, Math.trunc(i.requestedQty)),
            // A TTO indent is always dispensed in full packs.
            saleUnit: isTto ? 'pack' : (i.saleUnit === 'loose' ? 'loose' : 'pack'),
            notes: i.notes?.trim() || null,
          })),
        },
      },
      include: { items: true },
    });
  });
  logger.info({ tenantId, indentId: indent.id, isTto }, 'Medication indent raised');
  return hydrate(tenantId, indent);
}

/**
 * Auto-create a DRAFT indent from a freshly-signed IP prescription (design G1 —
 * the doctor's order pre-fills the pharmacy request instead of the nurse
 * re-typing it). Idempotent per prescription; maps only the Rx lines that resolve
 * to a formulary drug (free-text / PRN lines are skipped); returns null silently
 * when nothing maps. The draft sits in the ward nurse's workspace as a pending
 * request until they confirm it (→ 'raised'). Fire-and-forget safe.
 */
export async function createDraftIndentFromPrescription(tenantId: string, userId: string, prescriptionId: string) {
  const rx = await prisma.prescription.findFirst({
    where: { id: prescriptionId, tenantId },
    include: { prescriptionItems: true },
  });
  if (!rx || rx.prescriptionType !== 'ip') return null;

  // Idempotent: never open a second live indent for the same prescription.
  const existing = await prisma.medicationIndent.findFirst({
    where: { tenantId, prescriptionId, status: { notIn: ['cancelled'] } },
    select: { id: true },
  });
  if (existing) return null;

  // Resolve the active admission (and its ward) from the Rx's visit.
  const admission = await prisma.admission.findFirst({
    where: { tenantId, visitId: rx.visitId, status: 'admitted' },
    select: { id: true, wardId: true },
  });

  // Only lines that resolve to a formulary drug can become indent items.
  const drugIds = [...new Set(rx.prescriptionItems.filter((i) => i.drugId).map((i) => i.drugId as string))];
  if (!drugIds.length) return null;
  const inFormulary = await prisma.drugFormulary.findMany({ where: { tenantId, id: { in: drugIds } }, select: { id: true } });
  const okIds = new Set(inFormulary.map((d) => d.id));

  const lines = rx.prescriptionItems
    .filter((i) => i.drugId && okIds.has(i.drugId) && !i.isPrn)
    .map((i) => ({
      drugFormularyId: i.drugId as string,
      // A daily IP order is sent as loose (unit) doses; requestedQty comes from the
      // Rx's computed dispense quantity. The nurse can trim this before sending.
      requestedQty: Math.max(1, Math.trunc(Number(i.quantity ?? 1))),
      saleUnit: 'loose',
      notes: [i.dosage, i.frequency, i.duration].filter(Boolean).join(' · ') || null,
    }));
  if (!lines.length) return null;

  const indent = await prisma.$transaction(async (tx) =>
    tx.medicationIndent.create({
      data: {
        tenantId,
        indentNumber: await nextIndentNumber(tx, tenantId),
        patientId: rx.patientId,
        admissionId: admission?.id ?? null,
        wardId: admission?.wardId ?? null,
        prescriptionId,
        status: 'draft',
        creditStatus: 'ok',
        raisedById: userId,
        items: { create: lines.map((l) => ({ drugFormularyId: l.drugFormularyId, requestedQty: l.requestedQty, saleUnit: l.saleUnit, notes: l.notes })) },
      },
      include: { items: true },
    }),
  );
  logger.info({ tenantId, indentId: indent.id, prescriptionId }, 'Draft indent auto-created from IP prescription');
  return hydrate(tenantId, indent);
}

/**
 * Ward nurse reviews an auto-created draft and sends it to the IP pharmacy
 * (draft → raised). Optionally replaces the item lines with the nurse's edits.
 * The credit picture is snapshotted here (as in raiseIndent); it does not block.
 */
export async function confirmDraftIndent(
  tenantId: string,
  userId: string,
  id: string,
  data: { items?: IndentItemInput[]; priority?: string; notes?: string } = {},
) {
  const indent = await prisma.medicationIndent.findFirst({ where: { id, tenantId }, include: { items: true } });
  if (!indent) throw AppError.notFound('Indent not found');
  if (indent.status !== 'draft') throw AppError.badRequest(`Only a draft indent can be confirmed (this one is ${indent.status})`);

  const replace = (data.items ?? []).filter((i) => i.drugFormularyId && i.requestedQty > 0);
  if (replace.length) {
    const uniq = [...new Set(replace.map((i) => i.drugFormularyId))];
    const found = await prisma.drugFormulary.count({ where: { tenantId, id: { in: uniq } } });
    if (found !== uniq.length) throw AppError.badRequest('One or more drugs are not in this hospital formulary');
  }

  let creditStatus = 'ok';
  try {
    const credit = await getPatientCreditStatus(tenantId, indent.patientId);
    if (credit.requiresClearance) creditStatus = 'clearance_required';
  } catch { /* no admission → no credit gate */ }

  const updated = await prisma.$transaction(async (tx) => {
    if (replace.length) {
      await tx.medicationIndentItem.deleteMany({ where: { indentId: id } });
      await tx.medicationIndentItem.createMany({
        data: replace.map((i) => ({
          indentId: id,
          drugFormularyId: i.drugFormularyId,
          requestedQty: Math.max(1, Math.trunc(i.requestedQty)),
          saleUnit: i.saleUnit === 'pack' ? 'pack' : 'loose',
          notes: i.notes?.trim() || null,
        })),
      });
    }
    return tx.medicationIndent.update({
      where: { id },
      data: {
        status: 'raised',
        creditStatus,
        priority: data.priority ?? indent.priority,
        notes: data.notes?.trim() ?? indent.notes,
      },
      include: { items: true },
    });
  });
  logger.info({ tenantId, indentId: id }, 'Draft indent confirmed → raised to IP pharmacy');
  return hydrate(tenantId, updated);
}

/**
 * Pharmacist reviews the indent. The IP credit gate fires HERE (before dispensing):
 * a cash patient over deposit is held unless clearance is given (override) or every
 * requested drug is life-saving.
 */
export async function approveIndent(
  tenantId: string,
  userId: string,
  roles: string[],
  id: string,
  data: { approvals?: Array<{ itemId: string; approvedQty: number }>; override?: boolean } = {},
) {
  assertPharmacyOperator(roles, 'approve a medication indent');
  const indent = await prisma.medicationIndent.findFirst({ where: { id, tenantId }, include: { items: true } });
  if (!indent) throw AppError.notFound('Indent not found');
  if (indent.status !== 'raised') throw AppError.badRequest(`Only a raised indent can be approved (this one is ${indent.status})`);

  const names = await drugMap(tenantId, indent.items.map((i) => i.drugFormularyId));
  const allLifeSaving = indent.items.every((i) => names.get(i.drugFormularyId)?.isLifeSaving);

  let creditStatus = indent.creditStatus;
  if (!data.override && !allLifeSaving) {
    const credit = await getPatientCreditStatus(tenantId, indent.patientId);
    if (credit.requiresClearance) {
      throw AppError.badRequest(
        `Credit Limit Exceeded — Clearance Required. Running bill ₹${credit.billed.toFixed(2)} exceeds deposit ₹${credit.deposit.toFixed(2)}. Collect a top-up deposit or approve with clearance.`,
      );
    }
  } else if (data.override) {
    creditStatus = 'cleared';
  }

  const approvalMap = new Map((data.approvals ?? []).map((a) => [a.itemId, Math.max(0, Math.trunc(a.approvedQty))]));
  const updated = await prisma.$transaction(async (tx) => {
    for (const it of indent.items) {
      // Approve at most what was requested (never inflate the quantity).
      const approved = approvalMap.has(it.id) ? Math.min(it.requestedQty, approvalMap.get(it.id)!) : it.requestedQty;
      await tx.medicationIndentItem.update({ where: { id: it.id }, data: { approvedQty: approved } });
    }
    return tx.medicationIndent.update({
      where: { id },
      data: { status: 'approved', creditStatus, approvedById: userId, approvedAt: new Date() },
      include: { items: true },
    });
  });
  logger.info({ tenantId, indentId: id }, 'Medication indent approved');
  return hydrate(tenantId, updated);
}

/**
 * Pharmacist dispenses the approved indent against FEFO batches (or an explicitly
 * scanned batch per line) and posts the charge to the patient's IP bill ledger.
 * TTO indents dispense in full packs.
 */
export async function dispenseIndent(
  tenantId: string,
  userId: string,
  roles: string[],
  id: string,
  data: { batches?: Array<{ itemId: string; drugBatchId: string }> } = {},
) {
  assertPharmacyOperator(roles, 'dispense a medication indent');
  const indent = await prisma.medicationIndent.findFirst({ where: { id, tenantId }, include: { items: true } });
  if (!indent) throw AppError.notFound('Indent not found');
  if (indent.status !== 'approved') throw AppError.badRequest(`Only an approved indent can be dispensed (this one is ${indent.status})`);

  const batchMap = new Map((data.batches ?? []).map((b) => [b.itemId, b.drugBatchId]));

  const result = await prisma.$transaction(async (tx) => {
    // Find/open the patient's IP bill.
    let bill = await tx.bill.findFirst({
      where: { tenantId, patientId: indent.patientId, status: { in: ['draft', 'pending', 'partially_paid'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!bill) {
      const now = new Date();
      const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      const prefix = `IPW-${ymd}-`;
      const seq = await tx.bill.count({ where: { tenantId, billNumber: { startsWith: prefix } } });
      bill = await tx.bill.create({
        data: {
          tenantId,
          billNumber: `${prefix}${String(seq + 1).padStart(4, '0')}`,
          patientId: indent.patientId,
          admissionId: indent.admissionId ?? undefined,
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
    }

    let addedGross = 0;
    let addedTax = 0;

    for (const it of indent.items) {
      const qty = it.approvedQty ?? it.requestedQty;
      if (qty <= 0) continue;
      const drug = await tx.drugFormulary.findFirst({
        where: { id: it.drugFormularyId, tenantId },
        select: { id: true, drugName: true, packSize: true, price: true, taxPercent: true, looseUnitLabel: true, isNarcotic: true },
      });
      if (!drug) throw AppError.badRequest('A drug on this indent is no longer in the formulary');
      // NDPS narcotics never flow through a ward indent — they are vault-controlled
      // and dispensed via the NDPS Form 3E consumption workflow.
      if (drug.isNarcotic) {
        throw AppError.badRequest(`${drug.drugName} is an NDPS narcotic — dispense it via the NDPS (Form 3E) workflow, not a ward indent.`);
      }
      const packSize = drug.packSize && drug.packSize > 0 ? drug.packSize : 1;
      // Base (loose) units to remove from stock. Pack lines multiply by pack size.
      const baseQty = it.saleUnit === 'loose' ? qty : qty * packSize;

      // Batch: explicit scan, else FEFO earliest-expiry with enough stock.
      let batch;
      const chosen = batchMap.get(it.id);
      if (chosen) {
        batch = await tx.drugBatch.findFirst({ where: { id: chosen, tenantId, drugId: drug.id } });
        if (!batch) throw AppError.badRequest(`Scanned batch not found for ${drug.drugName}`);
        if (batch.isExpired || batch.isRecalled) throw AppError.badRequest(`Cannot dispense an expired/recalled batch of ${drug.drugName}`);
        if (batch.quantityInStock < baseQty) throw AppError.badRequest(`Insufficient stock in the scanned batch of ${drug.drugName}`);
      } else {
        batch = await tx.drugBatch.findFirst({
          where: { tenantId, drugId: drug.id, isExpired: false, isRecalled: false, quantityInStock: { gte: baseQty } },
          orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
        });
        if (!batch) throw AppError.badRequest(`Insufficient stock for ${drug.drugName} — need ${baseQty} unit(s) in a single batch`);
      }

      await tx.drugBatch.update({ where: { id: batch.id }, data: { quantityInStock: { decrement: baseQty } } });

      const unitPrice = Number(batch.sellingPrice ?? drug.price ?? batch.purchasePrice ?? 0);
      const taxPct = drug.taxPercent != null ? Number(drug.taxPercent) : 0;
      const gross = round2(unitPrice * baseQty);
      const taxAmt = round2(gross - gross / (1 + taxPct / 100));
      const unitLabel = it.saleUnit === 'loose' ? (drug.looseUnitLabel ?? 'unit') : 'pack';
      const expTag = batch.expiryDate ? `, exp ${new Date(batch.expiryDate).toLocaleDateString('en-GB')}` : '';

      // Create the DispensingRecord FIRST so the BillItem can reference it. The
      // pharmacy charge-pull (billing getPharmacyCharges) dedupes on the
      // 'dispensing_record:<id>' BillItem key — keying the BillItem to the
      // dispense record (like createPharmacySale) prevents the biller from
      // re-pulling this dispense and double-billing it.
      const rec = await tx.dispensingRecord.create({
        data: {
          tenantId,
          patientId: indent.patientId,
          drugBatchId: batch.id,
          quantityDispensed: baseQty,
          dispensedBy: userId,
          saleUnit: it.saleUnit === 'loose' ? 'loose' : 'pack',
          unitPrice,
          taxPercent: taxPct,
          lineTotal: gross,
          isTto: indent.isTto,
          billId: bill.id,
          notes: `IP indent ${indent.indentNumber}`,
        },
      });

      await tx.billItem.create({
        data: {
          billId: bill.id,
          description: `${drug.drugName} (Batch ${batch.batchNumber}${expTag}) — ${indent.isTto ? 'TTO ' : 'ward '}indent ${indent.indentNumber}, ${qty} ${unitLabel}(s)`,
          category: 'pharmacy',
          quantity: baseQty,
          unitPrice,
          taxPercent: taxPct,
          taxAmount: taxAmt,
          totalAmount: gross,
          referenceType: 'dispensing_record',
          referenceId: rec.id,
          isAutoPulled: true,
        },
      });

      await tx.medicationIndentItem.update({
        where: { id: it.id },
        // dispensedQty is in the item's sale unit (packs/loose), consistent with
        // requestedQty/approvedQty; the base-unit count lives on the DispensingRecord.
        // dispensingRecordId is kept so the RTS flow can reverse this exact line.
        data: { dispensedBatchId: batch.id, dispensedQty: qty, unitPrice, lineTotal: gross, dispensingRecordId: rec.id, returnedQty: 0 },
      });

      addedGross = round2(addedGross + gross);
      addedTax = round2(addedTax + taxAmt);
    }

    if (addedGross > 0) {
      await tx.bill.update({
        where: { id: bill.id },
        data: {
          subtotal: round2(Number(bill.subtotal) + addedGross),
          taxAmount: round2(Number(bill.taxAmount) + addedTax),
          totalAmount: round2(Number(bill.totalAmount) + addedGross),
          patientPayableAmount: round2(Number(bill.patientPayableAmount) + addedGross),
          balanceDue: round2(Number(bill.balanceDue) + addedGross),
        },
      });
    }

    return tx.medicationIndent.update({
      where: { id },
      data: { status: 'dispensed', dispensedById: userId, dispensedAt: new Date(), billId: bill.id },
      include: { items: true },
    });
  });

  logger.info({ tenantId, indentId: id, billId: result.billId }, 'Medication indent dispensed to IP bill');
  return hydrate(tenantId, result);
}

/**
 * Return-to-Stock (RTS) — design doc IP feature #2. The ward returns unused /
 * un-administered medicine from a dispensed indent; the pharmacist records it and
 * the system (a) restocks the exact original batch and (b) credits the patient's
 * running IP bill (a negative BillItem + reduced bill totals), while netting the
 * dispense record down so every read-model (bill, TPA split, returnable picker)
 * stays consistent. Returns are in the line's saleUnit and bounded by what the
 * ward still holds (dispensedQty − returnedQty).
 */
export async function returnIndentItems(
  tenantId: string,
  userId: string,
  roles: string[],
  id: string,
  data: { items: Array<{ itemId: string; returnQty: number }>; reason?: string },
) {
  assertPharmacyOperator(roles, 'process an IP drug return');
  const indent = await prisma.medicationIndent.findFirst({ where: { id, tenantId }, include: { items: true } });
  if (!indent) throw AppError.notFound('Indent not found');
  if (!['dispensed', 'delivered', 'acknowledged'].includes(indent.status)) {
    throw AppError.badRequest('Only a dispensed indent can have items returned to pharmacy');
  }
  if (!indent.billId) throw AppError.badRequest('This indent has no bill to credit');
  const reqMap = new Map((data.items ?? []).map((r) => [r.itemId, Math.max(0, Math.trunc(r.returnQty))]));
  if (![...reqMap.values()].some((q) => q > 0)) throw AppError.badRequest('Enter a quantity to return');

  const result = await prisma.$transaction(async (tx) => {
    const bill = await tx.bill.findFirst({ where: { id: indent.billId!, tenantId } });
    if (!bill) throw AppError.badRequest('The billed invoice for this indent no longer exists');

    let creditGross = 0;
    let creditTax = 0;
    const returned: Array<{ itemId: string; drugName: string; qty: number; credit: number }> = [];

    for (const it of indent.items) {
      const want = reqMap.get(it.id) ?? 0;
      if (want <= 0) continue;
      const alreadyReturned = it.returnedQty ?? 0;
      const dispensed = it.dispensedQty ?? 0;
      const remaining = dispensed - alreadyReturned;
      if (remaining <= 0) continue;
      const qty = Math.min(want, remaining);
      if (!it.dispensedBatchId) throw AppError.badRequest('Cannot return a line that was never dispensed against a batch');

      const drug = await tx.drugFormulary.findFirst({
        where: { id: it.drugFormularyId, tenantId },
        select: { id: true, drugName: true, packSize: true, taxPercent: true, looseUnitLabel: true },
      });
      if (!drug) throw AppError.badRequest('A drug on this indent is no longer in the formulary');
      const packSize = drug.packSize && drug.packSize > 0 ? drug.packSize : 1;
      const baseQty = it.saleUnit === 'loose' ? qty : qty * packSize;

      // (a) Restock the exact original batch.
      await tx.drugBatch.update({ where: { id: it.dispensedBatchId }, data: { quantityInStock: { increment: baseQty } } });

      // (b) Credit the running bill — value the return at the price it was billed at
      // (unitPrice is per base unit, GST-inclusive), mirroring the dispense math.
      const unitPrice = Number(it.unitPrice ?? 0);
      const taxPct = drug.taxPercent != null ? Number(drug.taxPercent) : 0;
      const gross = round2(unitPrice * baseQty);
      const taxAmt = round2(gross - gross / (1 + taxPct / 100));
      const unitLabel = it.saleUnit === 'loose' ? (drug.looseUnitLabel ?? 'unit') : 'pack';

      await tx.billItem.create({
        data: {
          billId: bill.id,
          description: `Return credit — ${drug.drugName}, ${qty} ${unitLabel}(s) back to pharmacy (indent ${indent.indentNumber})`,
          category: 'pharmacy',
          quantity: -baseQty,
          unitPrice,
          taxPercent: taxPct,
          taxAmount: round2(-taxAmt),
          totalAmount: round2(-gross),
          referenceType: 'indent_return',
          referenceId: it.id,
          isAutoPulled: true,
        },
      });

      // Net the dispense record down so the TPA reimbursable split and the returnable
      // picker reflect what is actually still with the patient.
      if (it.dispensingRecordId) {
        const rec = await tx.dispensingRecord.findFirst({ where: { id: it.dispensingRecordId, tenantId }, select: { quantityDispensed: true, lineTotal: true } });
        if (rec) {
          await tx.dispensingRecord.update({
            where: { id: it.dispensingRecordId },
            data: {
              quantityDispensed: Math.max(0, rec.quantityDispensed - baseQty),
              lineTotal: round2(Math.max(0, Number(rec.lineTotal ?? 0) - gross)),
            },
          });
        }
      }

      await tx.medicationIndentItem.update({ where: { id: it.id }, data: { returnedQty: alreadyReturned + qty } });

      creditGross = round2(creditGross + gross);
      creditTax = round2(creditTax + taxAmt);
      returned.push({ itemId: it.id, drugName: drug.drugName, qty, credit: gross });
    }

    if (creditGross <= 0) throw AppError.badRequest('Nothing was eligible to return');

    const newTotal = round2(Number(bill.totalAmount) - creditGross);
    const newBalance = Math.max(0, round2(newTotal - Number(bill.amountPaid)));
    await tx.bill.update({
      where: { id: bill.id },
      data: {
        subtotal: round2(Number(bill.subtotal) - creditGross),
        taxAmount: round2(Number(bill.taxAmount) - creditTax),
        totalAmount: newTotal,
        patientPayableAmount: Math.max(0, round2(Number(bill.patientPayableAmount) - creditGross)),
        balanceDue: newBalance,
      },
    });

    const updated = await tx.medicationIndent.update({
      where: { id },
      data: { notes: [indent.notes, `RTS ${new Date().toISOString().slice(0, 10)}: ${returned.map((r) => `${r.qty}× ${r.drugName}`).join(', ')}${data.reason ? ` (${data.reason})` : ''}`].filter(Boolean).join('\n') },
      include: { items: true },
    });
    return { updated, creditGross };
  });

  logger.info({ tenantId, indentId: id, credit: result.creditGross }, 'IP indent items returned to pharmacy (RTS)');
  return hydrate(tenantId, result.updated);
}

/** Runner hand-off — the meds leave the pharmacy for the ward. */
export async function markDelivered(tenantId: string, userId: string, roles: string[], id: string) {
  assertPharmacyOperator(roles, 'mark an indent delivered');
  const indent = await prisma.medicationIndent.findFirst({ where: { id, tenantId } });
  if (!indent) throw AppError.notFound('Indent not found');
  if (indent.status !== 'dispensed') throw AppError.badRequest(`Only a dispensed indent can be marked delivered (this one is ${indent.status})`);
  const updated = await prisma.medicationIndent.update({ where: { id }, data: { status: 'delivered', deliveredAt: new Date() }, include: { items: true } });
  return hydrate(tenantId, updated);
}

/**
 * Ward nurse verifies the received batch against the indent and acknowledges
 * receipt before administering (design doc IP Step 5).
 */
export async function acknowledgeIndent(
  tenantId: string,
  userId: string,
  id: string,
  data: { itemIds?: string[] } = {},
) {
  const indent = await prisma.medicationIndent.findFirst({ where: { id, tenantId }, include: { items: true } });
  if (!indent) throw AppError.notFound('Indent not found');
  if (indent.status !== 'dispensed' && indent.status !== 'delivered') {
    throw AppError.badRequest(`Only a dispensed/delivered indent can be acknowledged (this one is ${indent.status})`);
  }
  const ackAll = !data.itemIds?.length;
  const updated = await prisma.$transaction(async (tx) => {
    for (const it of indent.items) {
      if (ackAll || data.itemIds!.includes(it.id)) {
        await tx.medicationIndentItem.update({ where: { id: it.id }, data: { acknowledged: true } });
      }
    }
    return tx.medicationIndent.update({
      where: { id },
      data: { status: 'acknowledged', acknowledgedById: userId, acknowledgedAt: new Date() },
      include: { items: true },
    });
  });
  logger.info({ tenantId, indentId: id }, 'Medication indent acknowledged by ward');
  return hydrate(tenantId, updated);
}

/** Cancel an indent that has not yet been dispensed. */
export async function cancelIndent(tenantId: string, userId: string, id: string, reason?: string) {
  const indent = await prisma.medicationIndent.findFirst({ where: { id, tenantId } });
  if (!indent) throw AppError.notFound('Indent not found');
  if (['dispensed', 'delivered', 'acknowledged'].includes(indent.status)) {
    throw AppError.badRequest('This indent has already been dispensed; use a drug return instead of cancelling');
  }
  if (indent.status === 'cancelled') return indent;
  const updated = await prisma.medicationIndent.update({
    where: { id },
    data: { status: 'cancelled', cancelledReason: reason?.trim() || null },
    include: { items: true },
  });
  return hydrate(tenantId, updated);
}

// ============================================================
// Reads
// ============================================================

export async function listIndents(
  tenantId: string,
  query: { status?: string; patientId?: string; wardId?: string; isTto?: boolean } = {},
) {
  const where: any = { tenantId };
  if (query.status) where.status = query.status;
  if (query.patientId) where.patientId = query.patientId;
  if (query.wardId) where.wardId = query.wardId;
  if (query.isTto !== undefined) where.isTto = query.isTto;
  const indents = await prisma.medicationIndent.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { items: true },
    take: 300,
  });
  const names = await drugMap(tenantId, indents.flatMap((i) => i.items.map((x) => x.drugFormularyId)));
  const patientIds = [...new Set(indents.map((i) => i.patientId))];
  const patients = await prisma.patient.findMany({ where: { tenantId, id: { in: patientIds } }, select: { id: true, firstName: true, lastName: true, mrn: true } });
  const pMap = new Map(patients.map((p) => [p.id, { name: `${p.firstName} ${p.lastName ?? ''}`.trim(), mrn: p.mrn }]));
  return {
    items: indents.map((i) => ({
      ...i,
      patientName: pMap.get(i.patientId)?.name ?? null,
      patientMrn: pMap.get(i.patientId)?.mrn ?? null,
      items: i.items.map((x) => ({ ...x, drugName: names.get(x.drugFormularyId)?.drugName ?? '-', looseUnitLabel: names.get(x.drugFormularyId)?.looseUnitLabel ?? null })),
    })),
    total: indents.length,
  };
}

export async function getIndentById(tenantId: string, id: string) {
  const indent = await prisma.medicationIndent.findFirst({ where: { id, tenantId }, include: { items: true } });
  if (!indent) throw AppError.notFound('Indent not found');
  return hydrate(tenantId, indent);
}
