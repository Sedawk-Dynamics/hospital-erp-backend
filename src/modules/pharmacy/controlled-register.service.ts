import { prisma } from '../../config/database';

// ---------------------------------------------------------------------------
// Controlled-Drug Register — the audit view a drug inspector reads.
//
// Every movement of a scheduled or narcotic medicine, from every path it can
// take, in one chronological ledger with a running balance. Until the narcotic
// stock was unified onto DrugBatch this report was impossible: half the
// movements lived in a ledger with no batch, no expiry and no link to a GRN.
//
// SEVEN SOURCES, each the canonical record of its own movement:
//   in   DrugBatch          a receipt — vendor GRN and Form 3C inward alike
//   in   DrugReturn         stock handed back and actually restocked
//   out  DispensingRecord   counter, ward and IP dispensing
//   out  NdpsTransaction    'dispense'  bedside Form 3E administration
//   out  NdpsTransaction    'disposal'  breakage, spillage, destruction
//   move NdpsTransaction    'transfer'  vault → sub-store custody hand-off
//   adj  AuditLog           deliberate stock-count corrections
//
// Form 3C inward is deliberately NOT read from NdpsTransaction: since
// unification it creates a DrugBatch, so counting both would double every
// narcotic receipt.
// ---------------------------------------------------------------------------

export type RegisterReportType = 'all' | 'inward' | 'outward' | 'transfer';

export interface RegisterQuery {
  fromDate?: string;
  toDate?: string;
  /** 'all' | 'inward' | 'outward' | 'transfer' */
  reportType?: RegisterReportType;
  /** 'NDPS' for the narcotic list, or a schedule code (X/H1/H/H2/G). */
  scheduleType?: string;
  /** One or more formulary drug ids. Empty = every controlled drug. */
  drugIds?: string[];
  /** Batch number, patient MRN or invoice number — the needle-in-a-haystack box. */
  search?: string;
  /** Narrow to one prescriber's registration number. */
  doctorRegNo?: string;
  /** Narrow to one NDPS sub-store. Also switches the balance to that location. */
  locationId?: string;
}

export interface RegisterRow {
  occurredAt: Date;
  /** Human-facing transaction id — the bill number, batch number or txn id. */
  txnId: string;
  txnType: string;
  drugId: string;
  itemName: string;
  /** The active ingredient(s) and strength — the register's "API & Strength". */
  apiStrength: string | null;
  batchNumber: string | null;
  expiryDate: Date | null;
  qtyIn: number;
  qtyOut: number;
  transferQty: number;
  /** Filled by the running-balance pass. */
  opening: number;
  closing: number;
  patientOrDept: string | null;
  prescriber: string | null;
  verification: string | null;
  schedule: string | null;
  /** Why this schedule — the badge tooltip answers "why is this controlled?". */
  scheduleReason: string | null;
  controlledClass: string | null;
}

const inWindow = (from: Date, to: Date) => ({ gte: from, lte: to });

/**
 * Batches the NDPS unification created to represent stock the hospital ALREADY
 * held. They are dated the day the migration ran, so without excluding them the
 * balance walk-back reads them as receipts inside the window and the opening
 * balance comes out negative — which is nonsense on a register and would be the
 * first thing an inspector queried. Opening stock is not a movement.
 */
const OPENING_BALANCE_PREFIX = 'NDPS-OPENING-';
/**
 * A quarantined controlled-drug return is held in its own batch. It is not a
 * receipt — the return row already records the movement — so counting the batch
 * too would show the stock coming back twice.
 */
const QUARANTINE_PREFIX = 'QUAR-';
const notSyntheticBatch = {
  NOT: { OR: [
    { batchNumber: { startsWith: OPENING_BALANCE_PREFIX } },
    { batchNumber: { startsWith: QUARANTINE_PREFIX } },
  ] },
};

/** Default window is the last month, matching the report's own default. */
function resolveWindow(q: RegisterQuery) {
  const to = q.toDate ? new Date(q.toDate) : new Date();
  to.setHours(23, 59, 59, 999);
  const from = q.fromDate ? new Date(q.fromDate) : new Date(to);
  if (!q.fromDate) from.setMonth(from.getMonth() - 1);
  from.setHours(0, 0, 0, 0);
  return { from, to };
}

/** Which drugs this report covers. Controlled by default, narrowed on request. */
async function resolveDrugs(tenantId: string, q: RegisterQuery) {
  const where: Record<string, unknown> = { tenantId };
  if (q.drugIds?.length) {
    where.id = { in: q.drugIds };
  } else if (q.scheduleType === 'NDPS') {
    where.OR = [{ controlledClass: { not: null } }, { isNarcotic: true }, { vaultControlled: true }];
  } else if (q.scheduleType) {
    where.schedule = q.scheduleType;
  } else {
    // The register's whole point is controlled stock, so an unfiltered run means
    // "everything that is scheduled or narcotic" — never the entire formulary.
    where.OR = [
      { controlledClass: { not: null } },
      { isNarcotic: true },
      { vaultControlled: true },
      { schedule: { in: ['X', 'H1'] } },
    ];
  }
  return prisma.drugFormulary.findMany({
    where: where as never,
    select: {
      id: true, drugName: true, composition: true, genericName: true, strength: true,
      schedule: true, scheduleReason: true, controlledClass: true,
    },
  });
}

const personName = (u?: { firstName?: string | null; lastName?: string | null } | null) =>
  u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || null : null;

export async function getControlledRegister(tenantId: string, q: RegisterQuery) {
  const { from, to } = resolveWindow(q);
  const drugs = await resolveDrugs(tenantId, q);
  if (!drugs.length) {
    return { rows: [], summary: emptySummary(), drugs: [], window: { from, to } };
  }
  const drugIds = drugs.map((d) => d.id);
  const drugById = new Map(drugs.map((d) => [d.id, d]));
  // The register prints the active ingredient, not the brand — that is what an
  // inspector cross-references. composition was backfilled from the parsed
  // salts, with the generic name as the fallback.
  const api = (id: string) => {
    const d = drugById.get(id);
    if (!d) return null;
    const base = d.composition || d.genericName || null;
    return [base, d.strength].filter(Boolean).join(' ') || null;
  };

  const [batches, returns, dispenses, ndpsTxns, adjustments] = await Promise.all([
    prisma.drugBatch.findMany({
      where: {
        tenantId, drugId: { in: drugIds }, createdAt: inWindow(from, to),
        ...notSyntheticBatch,
      },
      include: { supplier: { select: { name: true } } },
    }),
    prisma.drugReturn.findMany({
      where: {
        tenantId, status: 'processed', drugBatchId: { not: null },
        createdAt: inWindow(from, to), drugBatch: { drugId: { in: drugIds } },
      },
      include: {
        drugBatch: { select: { batchNumber: true, expiryDate: true, drugId: true } },
        patient: { select: { mrn: true, firstName: true, lastName: true } },
      },
    }),
    prisma.dispensingRecord.findMany({
      where: {
        tenantId, dispensedAt: inWindow(from, to), drugBatch: { drugId: { in: drugIds } },
      },
      include: {
        drugBatch: { select: { batchNumber: true, expiryDate: true, drugId: true } },
        patient: { select: { mrn: true, firstName: true, lastName: true } },
        dispenser: { select: { firstName: true, lastName: true } },
        witness: { select: { firstName: true, lastName: true } },
        externalPrescription: { select: { prescriberName: true, prescriberRegNo: true } },
        prescription: {
          select: { doctor: { select: { licenseNumber: true, user: { select: { firstName: true, lastName: true } } } } },
        },
      },
    }),
    prisma.ndpsTransaction.findMany({
      where: {
        tenantId, drugFormularyId: { in: drugIds }, occurredAt: inWindow(from, to),
        // Form 3C inward already appears via the batch it creates.
        entryType: { in: ['dispense', 'disposal', 'transfer'] },
      },
    }),
    prisma.auditLog.findMany({
      where: {
        tenantId, entityType: 'drug_batch', createdAt: inWindow(from, to),
        newValues: { path: ['type'], equals: 'stock_adjustment' },
      },
    }),
  ]);

  // Resolve the people named on NDPS rows and the batches those rows touched.
  const userIds = [...new Set(ndpsTxns.flatMap((t) => [t.recordedById, t.counterpartyId, t.coSignById]).filter(Boolean))] as string[];
  const patientIds = [...new Set(ndpsTxns.map((t) => t.patientId).filter(Boolean))] as string[];
  const locationIds = [...new Set(ndpsTxns.flatMap((t) => [t.fromLocationId, t.toLocationId]).filter(Boolean))] as string[];
  const adjBatchIds = [...new Set(adjustments.map((a) => a.entityId).filter(Boolean))] as string[];

  const [users, patients, locations, adjBatches] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } }) : [],
    patientIds.length ? prisma.patient.findMany({ where: { id: { in: patientIds } }, select: { id: true, mrn: true, firstName: true, lastName: true } }) : [],
    locationIds.length ? prisma.ndpsLocation.findMany({ where: { id: { in: locationIds } }, select: { id: true, name: true } }) : [],
    adjBatchIds.length ? prisma.drugBatch.findMany({ where: { id: { in: adjBatchIds }, drugId: { in: drugIds } }, select: { id: true, batchNumber: true, expiryDate: true, drugId: true } }) : [],
  ]);
  const userName = new Map(users.map((u) => [u.id, personName(u)]));
  const patientById = new Map(patients.map((p) => [p.id, p]));
  const locName = new Map(locations.map((l) => [l.id, l.name]));
  const adjBatchById = new Map(adjBatches.map((b) => [b.id, b]));

  const rows: RegisterRow[] = [];
  const base = (drugId: string) => ({
    drugId,
    itemName: drugById.get(drugId)?.drugName ?? '—',
    apiStrength: api(drugId),
    schedule: drugById.get(drugId)?.schedule ?? null,
    scheduleReason: drugById.get(drugId)?.scheduleReason ?? null,
    controlledClass: drugById.get(drugId)?.controlledClass ?? null,
    opening: 0,
    closing: 0,
    qtyIn: 0,
    qtyOut: 0,
    transferQty: 0,
  });

  for (const b of batches) {
    rows.push({
      ...base(b.drugId),
      occurredAt: b.createdAt,
      txnId: b.batchNumber,
      txnType: b.batchNumber.startsWith('3C-') ? 'Form 3C Inward' : 'Receipt (GRN)',
      batchNumber: b.batchNumber,
      expiryDate: b.expiryDate,
      qtyIn: b.quantityReceived ?? b.quantityInStock,
      patientOrDept: b.supplier?.name ?? null,
      prescriber: null,
      verification: null,
    });
  }

  for (const r of returns) {
    const p = r.patient;
    rows.push({
      ...base(r.drugBatch!.drugId),
      occurredAt: r.createdAt,
      txnId: r.id.slice(0, 8),
      txnType: 'Return',
      batchNumber: r.drugBatch?.batchNumber ?? null,
      expiryDate: r.drugBatch?.expiryDate ?? null,
      qtyIn: r.quantity,
      patientOrDept: p ? `${personName(p)} (${p.mrn})` : null,
      prescriber: null,
      verification: null,
    });
  }

  for (const d of dispenses) {
    const p = d.patient;
    const doc = d.prescription?.doctor;
    const prescriber = d.externalPrescription
      ? `${d.externalPrescription.prescriberName}${d.externalPrescription.prescriberRegNo ? `, ${d.externalPrescription.prescriberRegNo}` : ''}`
      : doc
        ? `${personName(doc.user) ?? ''}${doc.licenseNumber ? `, ${doc.licenseNumber}` : ''}`.trim() || null
        : null;
    rows.push({
      ...base(d.drugBatch!.drugId),
      occurredAt: d.dispensedAt,
      txnId: d.billId ? d.billId.slice(0, 8) : d.id.slice(0, 8),
      txnType: 'Patient Disp.',
      batchNumber: d.drugBatch?.batchNumber ?? null,
      expiryDate: d.drugBatch?.expiryDate ?? null,
      qtyOut: d.quantityDispensed,
      patientOrDept: p ? `${personName(p)} (${p.mrn})` : null,
      prescriber,
      // The witness is the statutory signature; the dispenser is who handed it
      // over. Both matter, and the register shows whichever exists.
      verification: personName(d.witness) ?? personName(d.dispenser),
    });
  }

  for (const t of ndpsTxns) {
    const p = t.patientId ? patientById.get(t.patientId) : null;
    const isTransfer = t.entryType === 'transfer';
    rows.push({
      ...base(t.drugFormularyId),
      occurredAt: t.occurredAt,
      txnId: t.id.slice(0, 8),
      txnType:
        t.entryType === 'dispense' ? 'Form 3E Admin.' : t.entryType === 'disposal' ? 'Disposal' : 'Internal Transfer',
      batchNumber: t.batchNumber,
      expiryDate: t.expiryDate,
      qtyOut: isTransfer ? 0 : t.quantity,
      transferQty: isTransfer ? t.quantity : 0,
      patientOrDept: p
        ? `${personName(p)} (${p.mrn})`
        : isTransfer
          ? `${t.fromLocationId ? locName.get(t.fromLocationId) ?? '?' : '?'} → ${t.toLocationId ? locName.get(t.toLocationId) ?? '?' : '?'}`
          : t.fromLocationId
            ? locName.get(t.fromLocationId) ?? null
            : null,
      prescriber: t.doctorRegNo,
      verification:
        userName.get(t.counterpartyId ?? '') ??
        userName.get(t.coSignById ?? '') ??
        userName.get(t.recordedById) ??
        null,
    });
  }

  for (const a of adjustments) {
    const batch = a.entityId ? adjBatchById.get(a.entityId) : null;
    if (!batch) continue; // an adjustment on a drug outside this report
    const nv = (a.newValues ?? {}) as Record<string, unknown>;
    const delta = Number(nv.delta ?? nv.change ?? 0);
    rows.push({
      ...base(batch.drugId),
      occurredAt: a.createdAt,
      txnId: a.id.slice(0, 8),
      txnType: 'Adjustment',
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      qtyIn: delta > 0 ? delta : 0,
      qtyOut: delta < 0 ? -delta : 0,
      patientOrDept: typeof nv.reason === 'string' ? nv.reason : null,
      prescriber: null,
      verification: null,
    });
  }

  // ── free-text + prescriber + location filters ────────────────────────────
  let filtered = rows;
  if (q.search?.trim()) {
    const s = q.search.trim().toLowerCase();
    filtered = filtered.filter((r) =>
      [r.batchNumber, r.txnId, r.patientOrDept, r.itemName]
        .some((v) => v?.toLowerCase().includes(s)),
    );
  }
  if (q.doctorRegNo?.trim()) {
    const s = q.doctorRegNo.trim().toLowerCase();
    filtered = filtered.filter((r) => r.prescriber?.toLowerCase().includes(s));
  }
  if (q.reportType && q.reportType !== 'all') {
    filtered = filtered.filter((r) =>
      q.reportType === 'inward' ? r.qtyIn > 0
        : q.reportType === 'outward' ? r.qtyOut > 0
          : r.transferQty > 0,
    );
  }

  filtered.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  // ── running balance ──────────────────────────────────────────────────────
  // There is no stock snapshot to read from, so the opening balance is derived:
  // today's stock, less everything that has moved since the window opened.
  // A transfer never changes hospital-wide stock, so it is reported in its own
  // column and left out of the running total — see the note on the report page.
  const [{ live }] = await prisma.$queryRawUnsafe<Array<{ live: number }>>(`
    SELECT COALESCE(SUM(quantity_in_stock), 0)::int AS live
      FROM drug_batches
     WHERE tenant_id = $1 AND drug_id = ANY($2::text[])`, tenantId, drugIds);

  const movedSinceWindowStart = await netMovementSince(tenantId, drugIds, from);
  let running = live - movedSinceWindowStart;
  const opening = running;
  for (const r of filtered) {
    r.opening = running;
    running += r.qtyIn - r.qtyOut;
    r.closing = running;
  }

  const summary = {
    openingStock: opening,
    inward: filtered.reduce((s, r) => s + r.qtyIn, 0),
    outward: filtered.reduce((s, r) => s + r.qtyOut, 0),
    internalTransfer: filtered.reduce((s, r) => s + r.transferQty, 0),
    closingBalance: running,
  };

  return {
    rows: filtered,
    summary,
    drugs: drugs.map((d) => ({ id: d.id, drugName: d.drugName, schedule: d.schedule })),
    window: { from, to },
  };
}

const emptySummary = () => ({
  openingStock: 0, inward: 0, outward: 0, internalTransfer: 0, closingBalance: 0,
});

/**
 * Net stock movement for these drugs from `since` until now — used to walk the
 * live balance backwards to the start of the window. Transfers are excluded
 * because they move stock between locations without changing the total.
 */
async function netMovementSince(tenantId: string, drugIds: string[], since: Date): Promise<number> {
  const [received, dispensed, returned, ndpsOut] = await Promise.all([
    prisma.drugBatch.aggregate({
      where: {
        tenantId, drugId: { in: drugIds }, createdAt: { gte: since },
        ...notSyntheticBatch,
      },
      _sum: { quantityReceived: true },
    }),
    prisma.dispensingRecord.aggregate({
      where: { tenantId, dispensedAt: { gte: since }, drugBatch: { drugId: { in: drugIds } } },
      _sum: { quantityDispensed: true },
    }),
    prisma.drugReturn.aggregate({
      where: {
        tenantId, status: 'processed', createdAt: { gte: since },
        drugBatchId: { not: null }, drugBatch: { drugId: { in: drugIds } },
      },
      _sum: { quantity: true },
    }),
    prisma.ndpsTransaction.aggregate({
      where: {
        tenantId, drugFormularyId: { in: drugIds }, occurredAt: { gte: since },
        entryType: { in: ['dispense', 'disposal'] },
      },
      _sum: { quantity: true },
    }),
  ]);
  return (
    (received._sum.quantityReceived ?? 0) +
    (returned._sum.quantity ?? 0) -
    (dispensed._sum.quantityDispensed ?? 0) -
    (ndpsOut._sum.quantity ?? 0)
  );
}
