import { prisma } from '../../config/database';
import { taxResolverFor, billItemTaxFields } from '../gst/gst-resolver.service';
import { supplyKindForInventoryCategory } from '../../shared/gst-determination';
import { ACTIVE_ADMISSION_STATUS } from '../../shared/admission-status';
import { findOpenChargeBill } from '../../shared/charge-bill';
import { createBillInSeries } from '../../shared/bill-number';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { checkControlledDispense } from '../pharmacy/controlled-dispense';
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
  // Human-readable bill number for the "Billed to" line (billId is a UUID FK).
  const bill = indent.billId
    ? await prisma.bill.findFirst({ where: { id: indent.billId, tenantId }, select: { billNumber: true } })
    : null;
  return {
    ...indent,
    patientName: patient ? `${patient.firstName} ${patient.lastName ?? ''}`.trim() : null,
    patientMrn: patient?.mrn ?? null,
    billNumber: bill?.billNumber ?? null,
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
 * Build an indent from an IP prescription (shared by the daily-draft path — G1 —
 * and the TTO/discharge path — G5/2.2). Maps only Rx lines that resolve to a
 * formulary drug (free-text / PRN skipped). Idempotent per prescription; returns
 * null when nothing maps. A TTO indent is dispensed in FULL PACKS (requestedQty is
 * converted from the Rx's loose dose-count via the drug's pack size); a daily
 * indent is loose. `status` is 'draft' (nurse reviews) or 'raised' (straight to
 * pharmacy) — a raised indent snapshots the credit picture.
 */
async function buildIndentFromRx(
  tenantId: string,
  userId: string,
  prescriptionId: string,
  opts: { isTto: boolean; status: 'draft' | 'raised' },
) {
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
    where: { tenantId, visitId: rx.visitId, status: ACTIVE_ADMISSION_STATUS },
    select: { id: true, wardId: true },
  });

  // Only lines that resolve to a formulary drug can become indent items.
  const drugIds = [...new Set(rx.prescriptionItems.filter((i) => i.drugId).map((i) => i.drugId as string))];
  if (!drugIds.length) return null;
  const inFormulary = await prisma.drugFormulary.findMany({ where: { tenantId, id: { in: drugIds } }, select: { id: true, packSize: true } });
  const fMap = new Map(inFormulary.map((d) => [d.id, d]));

  const lines = rx.prescriptionItems
    .filter((i) => i.drugId && fMap.has(i.drugId) && !i.isPrn)
    .map((i) => {
      const looseQty = Math.max(1, Math.trunc(Number(i.quantity ?? 1)));
      const notes = [i.dosage, i.frequency, i.duration].filter(Boolean).join(' · ') || null;
      if (opts.isTto) {
        // TTO discharge meds go out in full packs: convert the loose dose-count
        // to whole packs using the drug's pack size (min 1 pack).
        const ps = fMap.get(i.drugId!)!.packSize;
        const packSize = ps && ps > 0 ? ps : 1;
        return { drugFormularyId: i.drugId as string, requestedQty: Math.max(1, Math.ceil(looseQty / packSize)), saleUnit: 'pack', notes };
      }
      return { drugFormularyId: i.drugId as string, requestedQty: looseQty, saleUnit: 'loose', notes };
    });
  if (!lines.length) return null;

  // A raised indent snapshots the credit picture (surfaced to the pharmacist).
  let creditStatus = 'ok';
  if (opts.status === 'raised') {
    try {
      const credit = await getPatientCreditStatus(tenantId, rx.patientId);
      if (credit.requiresClearance) creditStatus = 'clearance_required';
    } catch { /* no admission → no gate */ }
  }

  const indent = await prisma.$transaction(async (tx) =>
    tx.medicationIndent.create({
      data: {
        tenantId,
        indentNumber: await nextIndentNumber(tx, tenantId),
        patientId: rx.patientId,
        admissionId: admission?.id ?? null,
        wardId: admission?.wardId ?? null,
        prescriptionId,
        status: opts.status,
        creditStatus,
        isTto: opts.isTto,
        raisedById: userId,
        items: { create: lines.map((l) => ({ drugFormularyId: l.drugFormularyId, requestedQty: l.requestedQty, saleUnit: l.saleUnit, notes: l.notes })) },
      },
      include: { items: true },
    }),
  );
  logger.info({ tenantId, indentId: indent.id, prescriptionId, isTto: opts.isTto, status: opts.status }, 'Indent built from IP prescription');
  return hydrate(tenantId, indent);
}

/** G1 — auto-pre-fill a DRAFT daily indent from a freshly-signed IP prescription. */
export async function createDraftIndentFromPrescription(tenantId: string, userId: string, prescriptionId: string) {
  return buildIndentFromRx(tenantId, userId, prescriptionId, { isTto: false, status: 'draft' });
}

/**
 * G5/2.2 — TTO (To Take Out) discharge medication. Creates a RAISED, full-pack
 * TTO indent from the discharge prescription so the IP pharmacy packs it and the
 * charge lands on the final hospital bill.
 */
export async function createTtoIndentFromPrescription(tenantId: string, userId: string, prescriptionId: string) {
  const indent = await buildIndentFromRx(tenantId, userId, prescriptionId, { isTto: true, status: 'raised' });
  if (!indent) throw AppError.badRequest('No formulary-linked medicines on this prescription to send as a TTO (or a live indent already exists for it).');
  return indent;
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
 * Settle the bill header from its lines, after the stock transaction has
 * committed.
 *
 * Deliberately outside the transaction, for the reason ot-kit gives: a header
 * recalculation must not hold the stock locks open. And deliberately best
 * effort — the charge IS on the bill either way; only the header figures would
 * be stale, and a failed recalculation must not undo a dispense that has
 * already moved stock.
 */
async function settleBillHeader(billId: string | null | undefined): Promise<void> {
  if (!billId) return;
  try {
    const billing = await import('../billing/billing.service');
    await billing.recalculateBillTotalsPublic(billId);
  } catch (err) {
    logger.warn({ err, billId }, 'Could not settle the bill header after an indent movement');
  }
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

  // Built before the transaction opens: it reads the hospital's GST profile and
  // the rate masters, and those reads must not sit inside a transaction that is
  // holding stock locks.
  const resolver = await taxResolverFor(tenantId);

  const result = await prisma.$transaction(async (tx) => {
    // G2: scope the IP bill to the admission (the indent's, else the patient's
    // active admission) so the running IP ledger is per-stay.
    const admId = indent.admissionId
      ?? (await tx.admission.findFirst({ where: { tenantId, patientId: indent.patientId, status: ACTIVE_ADMISSION_STATUS }, orderBy: { admissionDate: 'desc' }, select: { id: true } }))?.id
      ?? null;

    // Find/open the patient's IP bill. Prefers this stay's running draft and
    // never the `ADV-` advance bucket; see shared/charge-bill.
    let bill = await findOpenChargeBill(tx, { tenantId, patientId: indent.patientId, admissionId: admId });
    if (!bill) {
      bill = await createBillInSeries(tx, 'IPW', {
        tenantId,
        patientId: indent.patientId,
        admissionId: admId ?? undefined,
        billDate: new Date(),
        status: 'draft',
        generatedBy: userId,
      });
    } else if (!bill.admissionId && admId) {
      bill = await tx.bill.update({ where: { id: bill.id }, data: { admissionId: admId } });
    }

    let addedGross = 0;
    let addedTax = 0;

    for (const it of indent.items) {
      const qty = it.approvedQty ?? it.requestedQty;
      if (qty <= 0) continue;
      const drug = await tx.drugFormulary.findFirst({
        where: { id: it.drugFormularyId, tenantId },
        select: {
          id: true, drugName: true, category: true, packSize: true, price: true,
          taxPercent: true, hsnCode: true, gstTreatment: true,
          looseUnitLabel: true, isNarcotic: true, isReimbursable: true,
          // Read by the controlled-drug gate.
          schedule: true, controlledClass: true, vaultControlled: true,
        },
      });
      if (!drug) throw AppError.badRequest('A drug on this indent is no longer in the formulary');
      // Controlled-drug gate. In the hospital's default mode this reproduces the
      // old hard block exactly; in inline mode the ward can complete the indent
      // here once the requirements are met. See pharmacy/controlled-dispense.ts.
      await checkControlledDispense(
        tenantId,
        drug,
        { userId, witnessedById: (data as any)?.witnessedById, witnessPassword: (data as any)?.witnessPassword, fromBatchStock: true },
        'workflow, not a ward indent',
      );
      const packSize = drug.packSize && drug.packSize > 0 ? drug.packSize : 1;
      // Base (loose) units to remove from stock. Pack lines multiply by pack size.
      const baseQty = it.saleUnit === 'loose' ? qty : qty * packSize;

      // Batch: consume available stock across batches (FEFO); an explicit scan is
      // consumed first. The FULL approved quantity is billed to the IP ledger even
      // if ward stock is short — the medicine is prescribed + approved for this
      // admitted patient, so a stock shortage must NOT block delivery/billing
      // (stock reconciliation is a separate ward-stock concern, flagged in notes).
      const chosen = batchMap.get(it.id);
      const usable = await tx.drugBatch.findMany({
        where: { tenantId, drugId: drug.id, isExpired: false, isRecalled: false },
        orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
      });
      const ordered = chosen
        ? [...usable.filter((b) => b.id === chosen), ...usable.filter((b) => b.id !== chosen)]
        : usable;
      if (ordered.length === 0) {
        throw AppError.badRequest(`No usable stock batch for ${drug.drugName} — add a batch (or clear the recall/expiry) first.`);
      }
      const batch = ordered[0]; // representative batch for pricing + traceability

      let remaining = baseQty;
      for (const b of ordered) {
        if (remaining <= 0) break;
        const take = Math.min(b.quantityInStock, remaining);
        if (take > 0) {
          await tx.drugBatch.update({ where: { id: b.id }, data: { quantityInStock: { decrement: take } } });
          remaining -= take;
        }
      }
      const shortfall = remaining; // > 0 = billed beyond on-hand stock

      const unitPrice = Number(batch.sellingPrice ?? drug.price ?? batch.purchasePrice ?? 0);
      const taxPct = drug.taxPercent != null ? Number(drug.taxPercent) : 0;
      // NOTE: taxPct above is still written onto the DispensingRecord, which is
      // the pharmacy's own stock document. What goes on the BILL is resolved.
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
          notes: `IP indent ${indent.indentNumber}${shortfall > 0 ? ` — stock short by ${shortfall}` : ''}`,
        },
      });

      // A medicine issued to an admitted patient is part of a composite supply
      // with their treatment, and the treatment is exempt — so this line is
      // exempt too, unless it is a TTO the patient carries home, which reads as
      // an ordinary sale. The rules decide; this call only supplies the facts.
      const priced = resolver.price(
        {
          kind: supplyKindForInventoryCategory(drug.category),
          hsnCode: drug.hsnCode ?? null,
          itemRatePercent: taxPct,
          itemTreatment: (drug.gstTreatment as any) ?? (!drug.hsnCode && taxPct > 0 ? 'taxable' : null),
          taxInclusive: true,
          patientAdmitted: true,
          issuedForTreatment: true,
          isTakeHome: indent.isTto,
        },
        { unitPrice, quantity: baseQty },
      );

      await tx.billItem.create({
        data: {
          billId: bill.id,
          description: `${drug.drugName} (Batch ${batch.batchNumber}${expTag}) — ${indent.isTto ? 'TTO ' : 'ward '}indent ${indent.indentNumber}, ${qty} ${unitLabel}(s)`,
          category: 'pharmacy',
          quantity: baseQty,
          unitPrice,
          ...billItemTaxFields(priced),
          referenceType: 'dispensing_record',
          referenceId: rec.id,
          isAutoPulled: true,
          // G7 (3.2): TPA line split — the drug's reimbursable flag flows onto the
          // bill line so the billing desk can split covered vs out-of-pocket.
          isReimbursable: drug.isReimbursable ?? null,
        },
      });

      await tx.medicationIndentItem.update({
        where: { id: it.id },
        // dispensedQty is in the item's sale unit (packs/loose), consistent with
        // requestedQty/approvedQty; the base-unit count lives on the DispensingRecord.
        // dispensingRecordId is kept so the RTS flow can reverse this exact line.
        data: { dispensedBatchId: batch.id, dispensedQty: qty, unitPrice, lineTotal: gross, dispensingRecordId: rec.id, returnedQty: 0 },
      });

      // G4 (1.4): stamp the dispensed batch + record onto this drug's pending eMAR
      // doses so the nurse charts "given" against the exact batch that was supplied.
      // Traceability only — eMAR still moves no stock and no money (link, don't
      // double-deduct). Matched via the prescription items that share this drug.
      if (indent.prescriptionId) {
        const rxItems = await tx.prescriptionItem.findMany({
          where: { prescriptionId: indent.prescriptionId, drugId: drug.id },
          select: { id: true },
        });
        if (rxItems.length) {
          await tx.emarSchedule.updateMany({
            where: { tenantId, prescriptionItemId: { in: rxItems.map((r) => r.id) }, status: 'pending', drugBatchId: null },
            data: { drugBatchId: batch.id, dispensingRecordId: rec.id },
          });
        }
      }

      addedGross = round2(addedGross + gross);
      addedTax = round2(addedTax + taxAmt);
    }

    // The header is no longer nudged by hand here. It is derived from the lines
    // after the transaction commits (see below), which is the money rule this
    // module was quietly breaking: a hand-maintained total drifts from the lines
    // it is supposed to summarise, and it cannot carry the GST split at all.

    // Dispensing an IP indent IS the delivery to the ward — one step. The charge
    // is now on the patient's IP bill; the nurse acknowledges receipt next.
    return tx.medicationIndent.update({
      where: { id },
      data: { status: 'delivered', dispensedById: userId, dispensedAt: new Date(), deliveredAt: new Date(), billId: bill.id },
      include: { items: true },
    });
  });

  await settleBillHeader(result.billId);
  logger.info({ tenantId, indentId: id, billId: result.billId }, 'Medication indent dispensed to IP bill + delivered');
  return hydrate(tenantId, result);
}

/**
 * Dispense an IP prescription DIRECTLY from the pharmacy queue (no indent). The
 * doctor's IP Rx flows to the queue; the pharmacist dispenses here and every
 * stocked line is billed to the patient's running IP bill (hospital
 * ledger) — NOT sold at the pharmacy counter. FEFO across batches; a stock
 * shortage doesn't block the (approved) medicine. Marks the Rx pharmacyStatus
 * 'collected'. Idempotent (one dispense per prescription).
 */
export async function dispenseIpPrescription(
  tenantId: string,
  userId: string,
  roles: string[],
  prescriptionId: string,
  data: {
    batches?: Array<{ itemId: string; drugBatchId: string }>;
    witnessedById?: string | null;
    witnessPassword?: string | null;
  } = {},
) {
  assertPharmacyOperator(roles, 'dispense an IP prescription');
  const rx = await prisma.prescription.findFirst({
    where: { id: prescriptionId, tenantId },
    include: { prescriptionItems: true, visit: { select: { admission: { select: { id: true } } } } },
  });
  if (!rx) throw AppError.notFound('Prescription not found');
  if (rx.prescriptionType !== 'ip') {
    throw AppError.badRequest('Only IP prescriptions are billed to the patient IP ledger.');
  }

  const already = await prisma.dispensingRecord.findFirst({ where: { tenantId, prescriptionId, cancelledAt: null }, select: { id: true } });
  if (already) throw AppError.badRequest('This prescription has already been dispensed.');

  // PRN lines still have to leave pharmacy stock before a nurse/doctor can
  // administer a dose. Excluding them here made a PRN-only prescription
  // impossible to issue, and therefore impossible to link to the eMAR/NDPS
  // patient-dose record that accounts for the used and residual quantities.
  const dispensable = rx.prescriptionItems.filter((i) => i.drugId && Number(i.quantity ?? 0) > 0);
  if (dispensable.length === 0) {
    throw AppError.badRequest('No stocked medicine with a quantity to dispense on this prescription.');
  }
  const batchMap = new Map((data.batches ?? []).map((b) => [b.itemId, b.drugBatchId]));

  // Read the profile and masters before the transaction opens; see dispenseIndent.
  const resolver = await taxResolverFor(tenantId);

  const result = await prisma.$transaction(async (tx) => {
    const admId = rx.visit?.admission?.id
      ?? (await tx.admission.findFirst({ where: { tenantId, patientId: rx.patientId, status: ACTIVE_ADMISSION_STATUS }, orderBy: { admissionDate: 'desc' }, select: { id: true } }))?.id
      ?? null;

    // Attach to this stay's running IP bill, else the patient's newest open
    // bill, else open one. Never the `ADV-` advance bucket; see
    // shared/charge-bill.
    let bill = await findOpenChargeBill(tx, { tenantId, patientId: rx.patientId, admissionId: admId });
    if (!bill) {
      bill = await createBillInSeries(tx, 'IPW', {
        tenantId,
        patientId: rx.patientId,
        admissionId: admId ?? undefined,
        billDate: new Date(),
        status: 'draft',
        generatedBy: userId,
      });
    } else if (!bill.admissionId && admId) {
      bill = await tx.bill.update({ where: { id: bill.id }, data: { admissionId: admId } });
    }

    let addedGross = 0;
    let addedTax = 0;

    for (const it of dispensable) {
      const baseQty = Math.max(1, Math.trunc(Number(it.quantity ?? 1)));
      const drug = await tx.drugFormulary.findFirst({
        where: { id: it.drugId as string, tenantId },
        select: {
          id: true, drugName: true, category: true, price: true, taxPercent: true,
          hsnCode: true, gstTreatment: true, looseUnitLabel: true,
          isNarcotic: true, isReimbursable: true,
          // Read by the controlled-drug gate.
          schedule: true, controlledClass: true, vaultControlled: true,
        },
      });
      if (!drug) continue; // free-text / no longer stocked — skip (nothing to draw from stock)
      const controlledDecision = await checkControlledDispense(
        tenantId,
        drug,
        {
          userId,
          prescriptionId,
          witnessedById: data.witnessedById,
          witnessPassword: data.witnessPassword,
          fromBatchStock: true,
        },
        'workflow',
      );

      const chosen = batchMap.get(it.id);
      const usable = await tx.drugBatch.findMany({
        where: { tenantId, drugId: drug.id, isExpired: false, isRecalled: false },
        orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
      });
      const ordered = chosen ? [...usable.filter((b) => b.id === chosen), ...usable.filter((b) => b.id !== chosen)] : usable;
      if (ordered.length === 0) {
        throw AppError.badRequest(`No usable stock batch for ${drug.drugName} — add a batch (or clear the recall/expiry) first.`);
      }
      const batch = ordered[0];

      let remaining = baseQty;
      for (const b of ordered) {
        if (remaining <= 0) break;
        const take = Math.min(b.quantityInStock, remaining);
        if (take > 0) {
          await tx.drugBatch.update({ where: { id: b.id }, data: { quantityInStock: { decrement: take } } });
          remaining -= take;
        }
      }
      const shortfall = remaining;
      // What actually came off the shelf. The ordered quantity is what the
      // doctor asked for; when the shelf cannot meet it, the patient must be
      // billed for what they were handed and the record must say how many units
      // really moved — it used to claim the full order on both counts, so a
      // patient could be charged for thirty capsules after receiving four, and
      // the stock ledger showed twenty-six units leaving that never did.
      const handedOver = baseQty - shortfall;
      if (handedOver <= 0) {
        throw AppError.badRequest(
          `No stock left for ${drug.drugName} — nothing could be dispensed. Restock and try again.`,
        );
      }

      const unitPrice = Number(batch.sellingPrice ?? drug.price ?? batch.purchasePrice ?? 0);
      const taxPct = drug.taxPercent != null ? Number(drug.taxPercent) : 0;
      const gross = round2(unitPrice * handedOver);
      const taxAmt = round2(gross - gross / (1 + taxPct / 100));
      const unitLabel = drug.looseUnitLabel ?? 'unit';
      const expTag = batch.expiryDate ? `, exp ${new Date(batch.expiryDate).toLocaleDateString('en-GB')}` : '';
      const shortTag = shortfall > 0 ? ` — ${shortfall} of ${baseQty} still owed` : '';

      const rec = await tx.dispensingRecord.create({
        data: {
          tenantId, prescriptionId, prescriptionItemId: it.id, patientId: rx.patientId, drugBatchId: batch.id,
          quantityDispensed: handedOver, dispensedBy: userId, saleUnit: 'loose', unitPrice, taxPercent: taxPct,
          lineTotal: gross, isTto: false, billId: bill.id,
          witnessedById: controlledDecision.witnessedById,
          witnessedAt: controlledDecision.witnessedAt,
          notes: `IP Rx dispense${shortfall > 0 ? ` — ordered ${baseQty}, stock short by ${shortfall}` : ''}`,
        },
      });

      // Dispensed to a patient on the ward, so the same composite-supply rule
      // applies as for an indent. Never a TTO — this is the daily queue.
      const priced = resolver.price(
        {
          kind: supplyKindForInventoryCategory(drug.category),
          hsnCode: drug.hsnCode ?? null,
          itemRatePercent: taxPct,
          itemTreatment: (drug.gstTreatment as any) ?? (!drug.hsnCode && taxPct > 0 ? 'taxable' : null),
          taxInclusive: true,
          patientAdmitted: true,
          issuedForTreatment: true,
        },
        { unitPrice, quantity: handedOver },
      );

      await tx.billItem.create({
        data: {
          billId: bill.id,
          // The shortfall is on the bill, not only in a note nobody reads — the
          // ward has to know the rest is still owed.
          description: `${drug.drugName} (Batch ${batch.batchNumber}${expTag}) — IP prescription, ${handedOver} ${unitLabel}(s)${shortTag}`,
          category: 'pharmacy', quantity: handedOver, unitPrice,
          ...billItemTaxFields(priced),
          referenceType: 'dispensing_record', referenceId: rec.id, isAutoPulled: true,
          isReimbursable: drug.isReimbursable ?? null,
        },
      });

      // Stamp the dispensed batch onto this exact Rx line's pending eMAR doses.
      await tx.emarSchedule.updateMany({
        where: { tenantId, prescriptionItemId: it.id, status: 'pending', drugBatchId: null },
        data: { drugBatchId: batch.id, dispensingRecordId: rec.id },
      });

      addedGross = round2(addedGross + gross);
      addedTax = round2(addedTax + taxAmt);
    }

    // Header derived from the lines after commit — see settleBillHeader.

    await tx.prescription.update({ where: { id: prescriptionId }, data: { pharmacyStatus: 'collected' } });
    return { billId: bill.id, dispensedLines: dispensable.length };
  });

  await settleBillHeader(result.billId);
  logger.info({ tenantId, prescriptionId, billId: result.billId }, 'IP prescription dispensed to IP bill (queue)');
  return result;
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
        select: { id: true, drugName: true, packSize: true, taxPercent: true, hsnCode: true, looseUnitLabel: true },
      });
      if (!drug) throw AppError.badRequest('A drug on this indent is no longer in the formulary');
      const packSize = drug.packSize && drug.packSize > 0 ? drug.packSize : 1;
      const baseQty = it.saleUnit === 'loose' ? qty : qty * packSize;

      // (a) Restock the exact original batch.
      await tx.drugBatch.update({ where: { id: it.dispensedBatchId }, data: { quantityInStock: { increment: baseQty } } });

      // (b) Credit the running bill — MIRRORING the line that was actually
      // billed, not recomputing it.
      //
      // This used to re-derive the tax from the drug's CURRENT formulary rate.
      // A credit is a reversal, so it has to undo the exact figures that were
      // charged: if the rate was edited between dispense and return, or if the
      // inpatient exemption was switched on mid-stay, a recomputed credit does
      // not equal its debit and the difference is left behind on the bill as a
      // tax residue nobody can account for.
      //
      // A partial return credits its share of the original line.
      const unitPrice = Number(it.unitPrice ?? 0);
      const gross = round2(unitPrice * baseQty);
      const unitLabel = it.saleUnit === 'loose' ? (drug.looseUnitLabel ?? 'unit') : 'pack';

      const originalLine = it.dispensingRecordId
        ? await tx.billItem.findFirst({
            where: { referenceType: 'dispensing_record', referenceId: it.dispensingRecordId },
          })
        : null;
      const originalQty = Number(originalLine?.quantity ?? 0);
      const share = originalLine && originalQty > 0 ? Math.min(1, baseQty / originalQty) : 1;
      const back = (v: unknown) => round2(-Number(v ?? 0) * share);
      const taxAmt = originalLine
        ? round2(Number(originalLine.taxAmount ?? 0) * share)
        : 0;

      await tx.billItem.create({
        data: {
          billId: bill.id,
          description: `Return credit — ${drug.drugName}, ${qty} ${unitLabel}(s) back to pharmacy (indent ${indent.indentNumber})`,
          category: 'pharmacy',
          quantity: -baseQty,
          unitPrice,
          // Every figure is the original's, scaled by what came back and
          // negated — so the credit and the debit cancel exactly.
          taxPercent: Number(originalLine?.taxPercent ?? 0),
          taxAmount: back(originalLine?.taxAmount),
          totalAmount: originalLine ? back(originalLine.totalAmount) : round2(-gross),
          hsnSacCode: originalLine?.hsnSacCode ?? null,
          gstTreatment: originalLine?.gstTreatment ?? null,
          taxInclusive: originalLine?.taxInclusive ?? true,
          taxableValue: originalLine ? back(originalLine.taxableValue) : round2(-gross),
          cgstRate: Number(originalLine?.cgstRate ?? 0),
          cgstAmount: back(originalLine?.cgstAmount),
          sgstRate: Number(originalLine?.sgstRate ?? 0),
          sgstAmount: back(originalLine?.sgstAmount),
          igstRate: Number(originalLine?.igstRate ?? 0),
          igstAmount: back(originalLine?.igstAmount),
          cessAmount: back(originalLine?.cessAmount),
          rateSource: originalLine?.rateSource ?? null,
          taxReason: originalLine
            ? `Reversal of the line billed at ${Number(originalLine.taxPercent ?? 0)}%`
            : 'Reversal — the original line could not be found',
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

    // Header derived from the lines after commit — see settleBillHeader. The
    // figures below are left in place only so the returned payload still
    // describes the change; they are overwritten by the recalculation.
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
    return { updated, creditGross, billId: bill.id };
  });

  await settleBillHeader(result.billId);
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
