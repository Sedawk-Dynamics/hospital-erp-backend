import { prisma } from '../../config/database';

// ---------------------------------------------------------------------------
// Controlled-Drug Register — the audit view a drug inspector reads.
//
// Every movement of a scheduled or narcotic medicine, from every path it can
// take, in one chronological ledger with a running balance. Until the narcotic
// stock was unified onto DrugBatch this report was impossible: half the
// movements lived in a ledger with no batch, no expiry and no link to a GRN.
//
// NINE SOURCES, each the canonical record of its own movement:
//   in   DrugBatch          a receipt — vendor GRN and Form 3C inward alike
//   in   DrugReturn         stock handed back and actually restocked
//   out  DispensingRecord   counter and IP dispensing
//   out  NdpsTransaction    'dispense'  bedside Form 3E administration
//   out  NdpsTransaction    'disposal'  breakage, spillage, destruction
//   move NdpsTransaction    'transfer'  vault → sub-store custody hand-off
//   move StockTransfer      the transfer board, for every drug alike
//   both WardStockLedger    a ward shelf issuing and giving out doses
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
  /**
   * What this row did to the pharmacy's dispensable batch stock.
   *
   * Normally qtyIn - qtyOut. A transfer is the exception, and there are two
   * kinds that behave differently: an NDPS challan moved NdpsStockBalance and
   * never touched a batch, so it is 0; a stock-transfer dispatch decrements
   * quantityInStock, so it is negative. Collapsing them would put the opening
   * balance out by exactly the amount transferred — it came out NEGATIVE on a
   * real run, which is indefensible on a register.
   */
  stockDelta: number;
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

  const [batches, returns, dispenses, ndpsTxns, adjustments, stockTransfers, wardMoves] = await Promise.all([
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
    // The EIGHTH source. Narcotic transfers used to happen only on the NDPS
    // challan screen and were read from NdpsTransaction. Now that the transfer
    // board handles every drug, a controlled move recorded there has to appear
    // here too — otherwise merging the two screens would quietly delete
    // transfers from the inspector's ledger.
    prisma.stockTransfer.findMany({
      where: {
        tenantId,
        status: { in: ['dispatched', 'received'] },
        dispatchedAt: inWindow(from, to),
        drugBatch: { drugId: { in: drugIds } },
      },
      include: {
        drugBatch: { select: { drugId: true, batchNumber: true, expiryDate: true } },
        fromDepartment: { select: { name: true } },
        toDepartment: { select: { name: true } },
        custodian: { select: { firstName: true, lastName: true } },
        dispatcher: { select: { firstName: true, lastName: true } },
      },
    }),
    // The NINTH source. A ward shelf is a second inventory: stock leaves the
    // pharmacy's batch and is given to patients from the ward, and none of it
    // writes a DispensingRecord. So a Schedule H1 psychotropic could be handed
    // to a patient at a bedside and appear nowhere on this register — the one
    // document that is supposed to account for every movement of it.
    //
    // A vault narcotic never reaches here (the controlled gate sends it to the
    // Form 3E workflow), which is why this went unnoticed: the tier the
    // register was built for was never the tier that leaked.
    // WardStockLedger carries scalar FKs and no Prisma relations, by design —
    // the ward-stock sub-module resolves them in the service, and so does this.
    prisma.wardStockLedger.findMany({
      where: { tenantId, createdAt: inWindow(from, to), drugId: { in: drugIds } },
    }),
  ]);

  // Resolve the people named on NDPS rows and the batches those rows touched.
  const userIds = [...new Set([
    ...ndpsTxns.flatMap((t) => [t.recordedById, t.counterpartyId, t.coSignById]),
    ...wardMoves.map((w) => w.performedBy),
  ].filter(Boolean))] as string[];
  const patientIds = [...new Set([
    ...ndpsTxns.map((t) => t.patientId),
    ...wardMoves.map((w) => w.patientId),
  ].filter(Boolean))] as string[];
  const wardIds = [...new Set(wardMoves.map((w) => w.wardId))];
  const wardBatchIds = [...new Set(wardMoves.map((w) => w.drugBatchId))];
  const locationIds = [...new Set(ndpsTxns.flatMap((t) => [t.fromLocationId, t.toLocationId]).filter(Boolean))] as string[];
  const adjBatchIds = [...new Set(adjustments.map((a) => a.entityId).filter(Boolean))] as string[];

  const [users, patients, locations, adjBatches, wards, wardBatches] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } }) : [],
    patientIds.length ? prisma.patient.findMany({ where: { id: { in: patientIds } }, select: { id: true, mrn: true, firstName: true, lastName: true } }) : [],
    locationIds.length ? prisma.ndpsLocation.findMany({ where: { id: { in: locationIds } }, select: { id: true, name: true } }) : [],
    adjBatchIds.length ? prisma.drugBatch.findMany({ where: { id: { in: adjBatchIds }, drugId: { in: drugIds } }, select: { id: true, batchNumber: true, expiryDate: true, drugId: true } }) : [],
    wardIds.length ? prisma.ward.findMany({ where: { id: { in: wardIds } }, select: { id: true, name: true } }) : [],
    wardBatchIds.length ? prisma.drugBatch.findMany({ where: { id: { in: wardBatchIds } }, select: { id: true, batchNumber: true, expiryDate: true } }) : [],
  ]);
  const userName = new Map(users.map((u) => [u.id, personName(u)]));
  const patientById = new Map(patients.map((p) => [p.id, p]));
  const locName = new Map(locations.map((l) => [l.id, l.name]));
  const adjBatchById = new Map(adjBatches.map((b) => [b.id, b]));
  const wardNameById = new Map(wards.map((w) => [w.id, w.name]));
  const wardBatchById = new Map(wardBatches.map((b) => [b.id, b]));

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
    // Every row states this explicitly. It used to default to 0 and be read as
    // `stockDelta || qtyIn - qtyOut`, which cannot tell "not set" from a real
    // zero — and a ward dose is a real zero with a non-zero qtyOut, so it was
    // taken off the balance a second time.
    stockDelta: 0,
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
      stockDelta: b.quantityReceived ?? b.quantityInStock,
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
      stockDelta: r.quantity,
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
      stockDelta: -d.quantityDispensed,
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
      // A challan moved NdpsStockBalance between locations and never touched a
      // batch, so hospital-wide it weighs nothing. A 3E administration or a
      // disposal does spend the stock.
      stockDelta: isTransfer ? 0 : -t.quantity,
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

  for (const t of stockTransfers) {
    if (!t.drugBatch) continue;
    const fromName = t.fromDepartment?.name ?? t.fromLocation ?? 'Pharmacy store';
    const toName = t.toDepartment?.name ?? t.toLocation ?? '?';
    rows.push({
      ...base(t.drugBatch.drugId),
      occurredAt: t.dispatchedAt ?? t.createdAt,
      txnId: t.transferNumber,
      txnType: 'Internal Transfer',
      batchNumber: t.drugBatch.batchNumber,
      expiryDate: t.drugBatch.expiryDate,
      // A transfer is custody moving, not stock leaving the hospital — it is
      // shown for the chain of custody and nets to zero hospital-wide, exactly
      // like the NDPS challan rows above.
      transferQty: t.quantityTransferred || t.quantityRequested,
      // Unlike an NDPS challan, this dispatch decremented the batch — so the
      // balance has to see it leave even though it is displayed as custody.
      stockDelta: -(t.quantityTransferred || t.quantityRequested),
      patientOrDept: `${fromName} → ${toName}`,
      // A custody move has no prescriber — nobody prescribed it.
      prescriber: null,
      verification: personName(t.custodian) ?? personName(t.dispatcher),
    });
  }

  for (const w of wardMoves) {
    const wardName = wardNameById.get(w.wardId) ?? 'Ward';
    const pt = w.patientId ? patientById.get(w.patientId) : null;
    const wb = wardBatchById.get(w.drugBatchId);
    // What each movement did to the PHARMACY's dispensable stock, which is what
    // the running balance is over:
    //   received  the batch was decremented when it was issued, so -qty
    //   returned  it goes back into the batch, so +qty
    //   dispensed the stock left the batch when it was issued to the ward, so 0
    //   adjusted  a ward-only correction; the batch is untouched, so 0
    // The quantity columns describe what happened on the ward; stockDelta
    // describes what happened to the pharmacy. They differ here, and conflating
    // them would double-count every ward dose.
    const isIssue = w.movementType === 'received';
    const isReturn = w.movementType === 'returned';
    const isDose = w.movementType === 'dispensed';
    rows.push({
      ...base(w.drugId),
      occurredAt: w.createdAt,
      txnId: w.id.slice(0, 8),
      txnType:
        isDose ? 'Ward Admin.'
          : isIssue ? 'Ward Issue'
            : isReturn ? 'Ward Return'
              : 'Ward Adjustment',
      batchNumber: wb?.batchNumber ?? null,
      expiryDate: wb?.expiryDate ?? null,
      qtyIn: isReturn ? w.quantity : w.movementType === 'adjusted' && w.quantity > 0 ? w.quantity : 0,
      qtyOut: isDose ? w.quantity : w.movementType === 'adjusted' && w.quantity < 0 ? -w.quantity : 0,
      // An issue is custody moving to the ward, not stock leaving the hospital
      // — the same treatment the transfer board's dispatches get.
      transferQty: isIssue ? w.quantity : 0,
      stockDelta: isIssue ? -w.quantity : isReturn ? w.quantity : 0,
      patientOrDept: pt
        ? `${personName(pt)} (${pt.mrn})`
        : isIssue
          ? `Pharmacy store → ${wardName}`
          : isReturn
            ? `${wardName} → Pharmacy store`
            : `${wardName}${w.reason ? ` — ${w.reason}` : ''}`,
      prescriber: null,
      verification: w.performedBy ? userName.get(w.performedBy) ?? null : null,
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
      stockDelta: delta,
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
  if (q.locationId) {
    // A sub-store is an NDPS location, and only NDPS rows carry one. Receipts,
    // counter dispensing, transfer-board moves and ward issues all happen in
    // the main store and have no location at all, so narrowing to one safe
    // means "the movements in and out of that safe" — which is the question an
    // inspector standing in front of it is asking.
    //
    // This was accepted by the API, shown as a chip on the screen, and never
    // read: picking a safe changed nothing at all.
    const loc = q.locationId;
    // A challan nets to zero across the hospital — which is why its stockDelta
    // is 0 — but it is emphatically not zero for the safe it left or arrived
    // in. Scoped to one location, the delta has to be read from that safe's
    // point of view, or the running balance sits still while the cupboard
    // fills up.
    const deltaHere = new Map<string, number>();
    for (const t of ndpsTxns) {
      if (t.fromLocationId !== loc && t.toLocationId !== loc) continue;
      const key = t.id.slice(0, 8);
      if (t.entryType === 'transfer') {
        deltaHere.set(key, t.toLocationId === loc ? t.quantity : -t.quantity);
      } else {
        // A Form 3E administration or a disposal spends the safe it came from.
        deltaHere.set(key, t.fromLocationId === loc ? -t.quantity : 0);
      }
    }
    filtered = filtered
      .filter((r) => deltaHere.has(r.txnId))
      .map((r) => ({ ...r, stockDelta: deltaHere.get(r.txnId) ?? 0 }));
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
  // Narrowed to one safe, the balance is that safe's — the pharmacy-wide figure
  // would be nonsense next to rows that only cover one location. NdpsStockBalance
  // is the per-location count the NDPS module keeps.
  let live: number;
  if (q.locationId) {
    const bal = await prisma.ndpsStockBalance.aggregate({
      where: { tenantId, locationId: q.locationId, drugFormularyId: { in: drugIds } },
      _sum: { quantity: true },
    });
    live = bal._sum.quantity ?? 0;
  } else {
    const [row] = await prisma.$queryRawUnsafe<Array<{ live: number }>>(`
      SELECT COALESCE(SUM(quantity_in_stock), 0)::int AS live
        FROM drug_batches
       WHERE tenant_id = $1 AND drug_id = ANY($2::text[])`, tenantId, drugIds);
    live = row.live;
  }

  const movedSinceWindowStart = q.locationId
    ? await netMovementAtLocation(tenantId, drugIds, from, q.locationId)
    : await netMovementSince(tenantId, drugIds, from);
  let running = live - movedSinceWindowStart;
  const opening = running;
  for (const r of filtered) {
    r.opening = running;
    // Always stockDelta. What a row DISPLAYS and what it did to the pharmacy's
    // stock are different questions: a transfer-board dispatch shows in the
    // transfer column but really left the batches, and a ward dose shows a
    // quantity out but spent stock that had already left when it was issued.
    running += r.stockDelta;
    r.closing = running;
  }

  const summary = {
    openingStock: opening,
    inward: filtered.reduce((s, r) => s + r.qtyIn, 0),
    outward: filtered.reduce((s, r) => s + r.qtyOut, 0),
    internalTransfer: filtered.reduce((s, r) => s + r.transferQty, 0),
    // The part of that which actually left the pharmacy's dispensable stock.
    // A challan move between NDPS locations contributes 0; a stock-transfer
    // dispatch contributes what it took.
    transferredOut: filtered.reduce((s, r) => s + Math.max(0, -r.stockDelta - r.qtyOut), 0),
    // The part of `outward` that spent stock the pharmacy had already parted
    // with — a dose given from a ward shelf. It is genuinely outward, and it
    // belongs on the register as such, but the pharmacy's balance lost it when
    // the stock was ISSUED to the ward. Without this the printed sum
    // (opening + inward − outward − transferredOut) does not reach the closing
    // balance, and the report contradicts itself in the one place a person is
    // most likely to check it with a pen.
    outwardAlreadyIssued: filtered.reduce((s, r) => s + (r.stockDelta === 0 && r.qtyOut > 0 ? r.qtyOut : 0), 0),
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
  openingStock: 0, inward: 0, outward: 0, internalTransfer: 0, transferredOut: 0,
  outwardAlreadyIssued: 0, closingBalance: 0,
});

/**
 * Net stock movement for these drugs from `since` until now — used to walk the
 * live balance backwards to the start of the window.
 *
 * NDPS challan transfers are excluded because they moved NdpsStockBalance
 * between locations without touching a batch. Stock-transfer DISPATCHES are
 * not: they decrement quantityInStock, so the stock genuinely left the pool
 * this balance is over. Leaving them out made the opening balance come out
 * NEGATIVE — the live total had lost the stock while the walk-back had not.
 */
async function netMovementSince(tenantId: string, drugIds: string[], since: Date): Promise<number> {
  const [received, dispensed, returned, ndpsOut, transferredOut, wardMoved, adjusted] = await Promise.all([
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
    prisma.stockTransfer.aggregate({
      where: {
        tenantId,
        status: { in: ['dispatched', 'received'] },
        dispatchedAt: { gte: since },
        drugBatch: { drugId: { in: drugIds } },
      },
      _sum: { quantityTransferred: true },
    }),
    // Stock issued to, or returned from, a ward shelf. Issuing decrements the
    // pharmacy's batch and returning restores it, so both belong in the pool
    // this balance is over. Leaving them out meant a transfer made TODAY moved
    // the opening balance of a window that closed last week — the live total
    // had lost the stock while the walk-back had not.
    //
    // Doses given from the shelf are NOT counted: that stock left the batch
    // when it was issued, and counting it again would remove it twice.
    prisma.wardStockLedger.groupBy({
      by: ['movementType'],
      where: {
        tenantId, drugId: { in: drugIds }, createdAt: { gte: since },
        movementType: { in: ['received', 'returned'] },
      },
      _sum: { quantity: true },
    }),
    // Count corrections. They appear on the register as rows, so leaving them
    // out here put the two halves of the report at odds: the walk-back reached
    // an opening balance the rows then moved off by exactly the net correction,
    // and the closing balance did not match the stock on the shelf.
    prisma.auditLog.findMany({
      where: {
        tenantId, entityType: 'drug_batch', createdAt: { gte: since },
        newValues: { path: ['type'], equals: 'stock_adjustment' },
      },
      select: { entityId: true, newValues: true },
    }),
  ]);

  // An audit row names a batch, not a drug, and this balance is over a specific
  // set of drugs — so resolve the batches before counting any of it.
  const adjBatchIds = [...new Set(adjusted.map((a) => a.entityId).filter(Boolean))] as string[];
  const inScope = adjBatchIds.length
    ? new Set(
        (
          await prisma.drugBatch.findMany({
            where: { id: { in: adjBatchIds }, drugId: { in: drugIds } },
            select: { id: true },
          })
        ).map((b) => b.id),
      )
    : new Set<string>();
  const adjustedNet = adjusted.reduce((sum, a) => {
    if (!a.entityId || !inScope.has(a.entityId)) return sum;
    const nv = (a.newValues ?? {}) as Record<string, unknown>;
    return sum + Number(nv.delta ?? nv.change ?? 0);
  }, 0);

  const issuedToWards = wardMoved.find((g) => g.movementType === 'received')?._sum.quantity ?? 0;
  const returnedFromWards = wardMoved.find((g) => g.movementType === 'returned')?._sum.quantity ?? 0;

  return (
    (received._sum.quantityReceived ?? 0) +
    (returned._sum.quantity ?? 0) +
    returnedFromWards +
    adjustedNet -
    (dispensed._sum.quantityDispensed ?? 0) -
    (ndpsOut._sum.quantity ?? 0) -
    (transferredOut._sum.quantityTransferred ?? 0) -
    issuedToWards
  );
}

/**
 * The same walk-back, for one sub-store.
 *
 * A safe's stock only changes through NDPS transactions: a challan brings it in
 * or takes it out, and a Form 3E administration or a disposal spends it. The
 * pharmacy-wide movements — GRNs, counter sales, the transfer board, ward
 * shelves — never touch a safe, so counting them here would walk this balance
 * back over stock that was never in it.
 */
async function netMovementAtLocation(
  tenantId: string,
  drugIds: string[],
  since: Date,
  locationId: string,
): Promise<number> {
  const txns = await prisma.ndpsTransaction.findMany({
    where: {
      tenantId, drugFormularyId: { in: drugIds }, occurredAt: { gte: since },
      OR: [{ fromLocationId: locationId }, { toLocationId: locationId }],
    },
    select: { entryType: true, quantity: true, fromLocationId: true, toLocationId: true },
  });
  return txns.reduce((sum, t) => {
    if (t.entryType === 'transfer') {
      // One challan, two effects — it leaves one safe and arrives in another.
      if (t.toLocationId === locationId) return sum + t.quantity;
      if (t.fromLocationId === locationId) return sum - t.quantity;
      return sum;
    }
    if (t.entryType === 'inward') return t.toLocationId === locationId ? sum + t.quantity : sum;
    // dispense and disposal both spend the safe they came out of.
    return t.fromLocationId === locationId ? sum - t.quantity : sum;
  }, 0);
}

/**
 * Every controlled drug the hospital stocks, for the register's item picker.
 *
 * The report already returns the drugs it covered, but once a filter is applied
 * that list narrows to the filtered set — which would make the picker forget
 * the options the moment you used it. This is the unfiltered list.
 */
export async function listControlledDrugs(tenantId: string) {
  const drugs = await resolveDrugs(tenantId, {});
  return drugs
    .map((d) => ({
      id: d.id,
      drugName: d.drugName,
      schedule: d.schedule,
      controlledClass: d.controlledClass,
      apiStrength: [d.composition || d.genericName, d.strength].filter(Boolean).join(' ') || null,
    }))
    .sort((a, b) => a.drugName.localeCompare(b.drugName));
}
