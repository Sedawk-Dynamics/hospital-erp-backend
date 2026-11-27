// ---------------------------------------------------------------------------
// 349: the pharmacy stock trail.
//
// Every change to a DrugBatch's `quantityInStock` writes one signed row here,
// inside the same transaction as the stock change. The Pharmacy Stock Ledger
// and the inventory outflow screens read these rows; before this, counter sales
// and received transfers moved stock without leaving any movement behind, so
// the ledger's closing (derived from receipts + dispenses + returns) drifted
// away from live stock.
//
// The table is created by `prisma db push` on the next server start. Until it
// exists a write is skipped rather than attempted: a failing INSERT inside an
// interactive transaction aborts the whole transaction, and a ledger row must
// never be the reason a sale fails. Readiness is probed once on the root client
// (outside any transaction) and cached.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { fullName } from '../../shared/person-name';
import { formatDrugQty, formatQty, qtyUnitsOf, UNIT_SELECT, type QtyUnits } from './pharmacy.units';

export type DrugMovementType =
  | 'receipt'
  | 'sale'
  | 'sale_cancel'
  | 'dispense'
  | 'patient_return'
  | 'counter_return'
  | 'vendor_return'
  | 'adjustment'
  | 'transfer_out'
  | 'transfer_in'
  | 'ward_issue'
  | 'ward_return'
  | 'indent_issue'
  | 'indent_return'
  | 'ot_issue'
  | 'ot_return'
  | 'hold'
  | 'hold_release'
  | 'ndps';

export interface DrugMovementInput {
  tenantId: string;
  drugId: string;
  drugBatchId: string;
  movementType: DrugMovementType;
  /** Signed base units: positive INTO pharmacy stock, negative OUT of it. */
  quantity: number;
  referenceType?: string | null;
  referenceId?: string | null;
  party?: string | null;
  unitCost?: number | null;
  performedBy?: string | null;
  notes?: string | null;
}

/** Movement types that take stock OUT of the pharmacy (used by outflow screens). */
export const OUTFLOW_MOVEMENTS: readonly DrugMovementType[] = [
  'sale', 'dispense', 'vendor_return', 'transfer_out', 'ward_issue',
  'indent_issue', 'ot_issue', 'hold', 'ndps',
];

const RETRY_MS = 60_000;
let ready: boolean | null = null;
let checkedAt = 0;

/** For tests. */
export function resetDrugStockMovementProbe(state: boolean | null = null): void {
  ready = state;
  checkedAt = state === null ? 0 : Date.now();
}

/** Whether the movement table exists yet. Never throws. */
export async function drugStockMovementsReady(): Promise<boolean> {
  if (ready === true) return true;
  if (ready === false && Date.now() - checkedAt < RETRY_MS) return false;
  try {
    await prisma.drugStockMovement.findFirst({ select: { id: true } });
    ready = true;
  } catch (err) {
    ready = false;
    logger.warn({ err }, '349: drug_stock_movements is not available yet — movements are not recorded until `prisma db push` runs');
  }
  checkedAt = Date.now();
  return ready;
}

type MovementClient = { drugStockMovement: { create: (args: any) => Promise<unknown> } };

/**
 * Record one stock movement on the caller's transaction client. A zero
 * quantity is not a movement and is skipped.
 */
export async function recordDrugStockMovement(
  tx: MovementClient | unknown,
  input: DrugMovementInput,
): Promise<void> {
  const qty = Math.trunc(Number(input.quantity) || 0);
  if (qty === 0 || !input.drugId || !input.drugBatchId) return;
  // A real Prisma client always has the delegate; a hand-rolled transaction
  // stub (tests) may not, and a ledger row is never worth throwing for.
  const delegate = (tx as Partial<MovementClient> | null)?.drugStockMovement;
  if (!delegate) return;
  if (!(await drugStockMovementsReady())) return;
  await delegate.create({
    data: {
      tenantId: input.tenantId,
      drugId: input.drugId,
      drugBatchId: input.drugBatchId,
      movementType: input.movementType,
      quantity: qty,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      party: input.party ? String(input.party).slice(0, 255) : null,
      unitCost: input.unitCost != null && Number.isFinite(Number(input.unitCost)) ? Number(input.unitCost) : null,
      performedBy: input.performedBy ?? null,
      notes: input.notes ?? null,
    },
  });
}

// ── Inventory screens (349) ─────────────────────────────────────────────────
//
// The inventory module's screens are built on StockTransaction, which needs an
// InventoryItem — and pharmacy drugs mostly have none. These adapters present
// drug movements in StockTransaction's shape so those screens can fold them in
// with a one-line change instead of a second code path.

type InventoryTxnType = 'stock_in' | 'stock_out' | 'return_stock' | 'adjustment';

/** How a pharmacy movement reads on the inventory side. */
export function inventoryTypeForMovement(movementType: string, quantity: number): InventoryTxnType {
  if (movementType === 'receipt') return 'stock_in';
  if (movementType === 'adjustment') return 'adjustment';
  return quantity < 0 ? 'stock_out' : 'return_stock';
}

const INVENTORY_LABEL: Record<string, string> = {
  sale: 'pharmacy_sale', dispense: 'pharmacy_dispense', transfer_out: 'stock_transfer',
  ward_issue: 'ward_issue', indent_issue: 'ip_indent', ot_issue: 'ot_kit', ndps: 'ndps',
  hold: 'pharmacy_hold', vendor_return: 'vendor_return',
};

/** Drug movements in a window, shaped for the Detailed Analysis rollup. */
export async function drugMovementsAsStockTransactions(tenantId: string, from: Date, to: Date) {
  if (!(await drugStockMovementsReady())) return [];
  const rows = await prisma.drugStockMovement.findMany({
    where: { tenantId, createdAt: { gte: from, lte: to } },
    select: { drugId: true, movementType: true, quantity: true, unitCost: true, createdAt: true },
  });
  if (!rows?.length) return [];
  const drugs = await prisma.drugFormulary.findMany({
    where: { tenantId, id: { in: [...new Set(rows.map((r) => r.drugId))] } },
    select: { id: true, drugName: true, category: true },
  });
  const byId = new Map(drugs.map((d) => [d.id, d]));
  return rows.map((r) => {
    const qty = Math.abs(r.quantity);
    const unit = r.unitCost != null ? Number(r.unitCost) : null;
    const d = byId.get(r.drugId);
    return {
      transactionType: inventoryTypeForMovement(r.movementType, r.quantity),
      quantity: qty,
      unitCost: unit,
      totalCost: unit != null ? Math.round(unit * qty * 100) / 100 : null,
      createdAt: r.createdAt,
      inventoryItem: { id: r.drugId, itemName: d?.drugName ?? 'Medication', category: String(d?.category ?? 'drug') },
    };
  });
}

/**
 * Pharmacy outflow rows for the Inventory "Stock Out" history, newest first,
 * in the same shape as `getStockTransactions` rows. `take` is how many of the
 * newest to return (the caller merges and pages).
 */
export async function drugOutflowAsStockTransactions(
  tenantId: string,
  opts: { take: number; fromDate?: Date; toDate?: Date; search?: string },
): Promise<{ rows: any[]; total: number }> {
  if (!(await drugStockMovementsReady())) return { rows: [], total: 0 };
  const createdAt =
    opts.fromDate || opts.toDate
      ? { ...(opts.fromDate ? { gte: opts.fromDate } : {}), ...(opts.toDate ? { lte: opts.toDate } : {}) }
      : undefined;
  let drugIds: string[] | undefined;
  if (opts.search) {
    const hits = await prisma.drugFormulary.findMany({
      where: { tenantId, drugName: { contains: opts.search, mode: 'insensitive' } },
      select: { id: true },
      take: 500,
    });
    drugIds = hits.map((h) => h.id);
    if (!drugIds.length) return { rows: [], total: 0 };
  }
  const where = {
    tenantId,
    quantity: { lt: 0 },
    ...(createdAt ? { createdAt } : {}),
    ...(drugIds ? { drugId: { in: drugIds } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.drugStockMovement.findMany({ where, orderBy: { createdAt: 'desc' }, take: opts.take }),
    prisma.drugStockMovement.count({ where }),
  ]);
  if (!rows?.length) return { rows: [], total: total ?? 0 };
  const [batches, users] = await Promise.all([
    prisma.drugBatch.findMany({
      where: { tenantId, id: { in: [...new Set(rows.map((r) => r.drugBatchId))] } },
      select: { id: true, batchNumber: true, drug: { select: { id: true, drugName: true, ...UNIT_SELECT } } },
    }),
    prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.performedBy).filter((v): v is string => !!v))] } },
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const userById = new Map(users.map((u) => [u.id, u]));
  return {
    total: total ?? rows.length,
    rows: rows.map((r) => {
      const b = batchById.get(r.drugBatchId);
      return {
        id: r.id,
        source: 'pharmacy',
        transactionType: 'stock_out',
        quantity: Math.abs(r.quantity),
        // 345: the same words the sale's bill line prints.
        quantityText: formatDrugQty(Math.abs(r.quantity), b?.drug),
        batchNumber: b?.batchNumber ?? null,
        referenceType: INVENTORY_LABEL[r.movementType] ?? r.movementType,
        referenceId: r.referenceId,
        unitCost: r.unitCost,
        notes: r.notes ?? r.party ?? null,
        department: r.party ? { id: null, name: r.party } : { id: null, name: 'Pharmacy' },
        performer: r.performedBy ? userById.get(r.performedBy) ?? null : null,
        supplier: null,
        createdAt: r.createdAt,
        inventoryItem: {
          id: r.drugId,
          itemName: b?.drug?.drugName ?? 'Medication',
          itemCode: null,
          unitOfMeasurement: b?.drug?.unitOfMeasurement ?? null,
        },
      };
    }),
  };
}

// ── The Pharmacy Stock Ledger (349) ─────────────────────────────────────────

export type StockLedgerMovement = DrugMovementType;

export interface StockLedgerEntry {
  /** Unique per row (a bill with three lines of one batch is three rows). */
  id: string;
  date: Date;
  movementType: StockLedgerMovement;
  drugId: string;
  drugName: string;
  batchNumber: string;
  quantityIn: number;
  quantityOut: number;
  /** 345: the quantity in words — the unit the bill and the stock list print. */
  quantityText: string;
  /** 345: the running balance in words; null when there is no balance. */
  balanceText: string | null;
  party: string | null;
  /**
   * Gap 347: who made the movement — the pharmacist who sold/dispensed, the
   * user who received, returned or adjusted. Null where it was never recorded.
   */
  by: string | null;
  referenceId: string;
  /** Running balance after this row — only when the ledger is for one drug. */
  balance: number | null;
  /** Rebuilt from source documents because it predates the movement log. */
  reconstructed: boolean;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A date-only bound is an India-time calendar day, inclusive at both ends. */
function ledgerBound(value: string | undefined, end: boolean): Date | null {
  if (!value) return null;
  if (DATE_ONLY.test(value)) {
    return new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}+05:30`);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const stockSum = (agg: any) => Number(agg?._sum?.quantityInStock ?? 0);

/**
 * The ledger for a period, built so its closing balance agrees with live stock.
 *
 * Closing is anchored on live batch quantities and walked BACK through the
 * movements dated after the period; opening is closing less the period's own
 * net movement. For a period ending today closing therefore IS live stock, by
 * construction, rather than a separately-derived figure that drifted.
 *
 * Movements are only logged from the day this shipped. For any part of the
 * period before the first logged row, receipts, dispenses and returns are
 * rebuilt from their source documents and flagged `reconstructed`; transfers
 * and adjustments from that era cannot be itemised, so their effect sits in the
 * opening balance, and `summary.reconstructedBefore` says so.
 */
export async function buildStockLedger(
  tenantId: string,
  query: { fromDate?: string; toDate?: string; drugId?: string; page?: number; limit?: number },
) {
  const toDate = ledgerBound(query.toDate, true) ?? new Date();
  const fromDate =
    ledgerBound(query.fromDate, false) ?? new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  const page = query.page ?? 1;
  const limit = query.limit ?? 50;
  const drugFilter = query.drugId ? { drugId: query.drugId } : {};

  const logged = await drugStockMovementsReady();
  const [moves, afterAgg, firstAgg, liveAgg, expiredAgg] = await Promise.all([
    logged
      ? prisma.drugStockMovement.findMany({
          where: { tenantId, ...drugFilter, createdAt: { gte: fromDate, lte: toDate } },
          orderBy: { createdAt: 'asc' },
        })
      : Promise.resolve([]),
    logged
      ? prisma.drugStockMovement.aggregate({
          where: { tenantId, ...drugFilter, createdAt: { gt: toDate } },
          _sum: { quantity: true },
        })
      : Promise.resolve(null),
    // Tenant-wide on purpose: logging started for every drug at once.
    logged
      ? prisma.drugStockMovement.aggregate({ where: { tenantId }, _min: { createdAt: true } })
      : Promise.resolve(null),
    prisma.drugBatch.aggregate({ where: { tenantId, ...drugFilter }, _sum: { quantityInStock: true } }),
    prisma.drugBatch.aggregate({
      where: { tenantId, ...drugFilter, isExpired: true },
      _sum: { quantityInStock: true },
    }),
  ]);
  const movesList = ((moves ?? []) as unknown) as Array<{
    id: string; drugId: string; drugBatchId: string; movementType: string; quantity: number;
    referenceType: string | null; referenceId: string | null; party: string | null;
    performedBy?: string | null; createdAt: Date;
  }>;
  const trackedSince: Date | null = (firstAgg as any)?._min?.createdAt ?? null;

  // ── Logged rows ──
  const batchIds = [...new Set(movesList.map((m) => m.drugBatchId))];
  const saleBillIds = [
    ...new Set(
      movesList
        .filter((m) => m.referenceType === 'pharmacy_sale' && m.referenceId && !m.party)
        .map((m) => m.referenceId as string),
    ),
  ];
  const performerIds = [
    ...new Set(movesList.map((m) => m.performedBy).filter((v): v is string => !!v)),
  ];
  const [batchRows, saleBills, performers] = await Promise.all([
    batchIds.length
      ? prisma.drugBatch.findMany({
          where: { tenantId, id: { in: batchIds } },
          select: { id: true, batchNumber: true, drug: { select: { id: true, drugName: true, ...UNIT_SELECT } } },
        })
      : Promise.resolve([]),
    saleBillIds.length
      ? prisma.bill.findMany({
          where: { tenantId, id: { in: saleBillIds } },
          select: {
            id: true, billNumber: true,
            patient: { select: { firstName: true, lastName: true, mrn: true } },
          },
        })
      : Promise.resolve([]),
    performerIds.length
      ? prisma.user.findMany({
          where: { id: { in: performerIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : Promise.resolve([]),
  ]);
  const batchById = new Map((batchRows as any[]).map((b) => [b.id, b]));
  const billById = new Map((saleBills as any[]).map((b) => [b.id, b]));
  const performerById = new Map(((performers ?? []) as any[]).map((u) => [u.id, fullName(u)]));

  // 345: one set of unit nouns per drug, for every row and the balance.
  const unitsByDrug = new Map<string, QtyUnits>();
  const qtyWords = (qty: number, drug: any): string => {
    const units = qtyUnitsOf(drug);
    if (drug?.id) unitsByDrug.set(drug.id, units);
    return formatQty(Math.abs(qty), units);
  };

  const entries: StockLedgerEntry[] = movesList.map((m) => {
    const b = batchById.get(m.drugBatchId);
    const bill = m.referenceId ? billById.get(m.referenceId) : null;
    const party =
      m.party ??
      (bill
        ? `${bill.billNumber}${bill.patient ? ` · ${fullName(bill.patient)} (${bill.patient.mrn})` : ''}`
        : null);
    return {
      id: m.id,
      date: m.createdAt,
      movementType: m.movementType as StockLedgerMovement,
      drugId: m.drugId,
      drugName: b?.drug?.drugName ?? 'Medication',
      batchNumber: b?.batchNumber ?? '-',
      quantityIn: m.quantity > 0 ? m.quantity : 0,
      quantityOut: m.quantity < 0 ? -m.quantity : 0,
      quantityText: qtyWords(m.quantity, b?.drug),
      balanceText: null,
      party,
      by: m.performedBy ? performerById.get(m.performedBy) ?? null : null,
      referenceId: m.referenceId ?? m.id,
      balance: null,
      reconstructed: false,
    };
  });

  // ── Rebuilt rows, for whatever part of the window predates the log ──
  let netAfterRebuilt = 0;
  const rebuildTo = trackedSince ?? new Date();
  const rebuilding = rebuildTo > fromDate;
  if (rebuilding) {
    const window = { gte: fromDate, lt: rebuildTo };
    const batchDrugFilter = query.drugId ? { drugBatch: { drugId: query.drugId } } : {};
    const [batches, dispenses, returns] = await Promise.all([
      prisma.drugBatch.findMany({
        where: { tenantId, createdAt: window, ...drugFilter },
        include: { drug: { select: { id: true, drugName: true, ...UNIT_SELECT } }, supplier: { select: { name: true } } },
      }),
      prisma.dispensingRecord.findMany({
        where: { tenantId, cancelledAt: null, dispensedAt: window, ...batchDrugFilter },
        include: {
          drugBatch: { select: { batchNumber: true, drug: { select: { id: true, drugName: true, ...UNIT_SELECT } } } },
          patient: { select: { firstName: true, lastName: true, mrn: true } },
          dispenser: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.drugReturn.findMany({
        where: { tenantId, status: 'processed', createdAt: window, drugBatchId: { not: null }, ...batchDrugFilter },
        include: {
          drugBatch: { select: { batchNumber: true, drug: { select: { id: true, drugName: true, ...UNIT_SELECT } } } },
          drug: { select: { id: true, drugName: true, ...UNIT_SELECT } },
          supplier: { select: { name: true } },
          processor: { select: { firstName: true, lastName: true } },
        },
      }),
    ]);
    const rebuilt: StockLedgerEntry[] = [
      ...(batches as any[]).map((b): StockLedgerEntry => ({
        id: `receipt-${b.id}`, date: b.createdAt, movementType: 'receipt',
        drugId: b.drug?.id ?? b.drugId, drugName: b.drug?.drugName ?? 'Medication',
        batchNumber: b.batchNumber, quantityIn: b.quantityReceived ?? 0, quantityOut: 0,
        quantityText: qtyWords(b.quantityReceived ?? 0, b.drug), balanceText: null,
        // A batch row records no receiving user.
        party: b.supplier?.name ?? null, by: null, referenceId: b.id, balance: null, reconstructed: true,
      })),
      ...(dispenses as any[]).map((d): StockLedgerEntry => ({
        id: `dispense-${d.id}`, date: d.dispensedAt, movementType: d.billId ? 'sale' : 'dispense',
        drugId: d.drugBatch?.drug?.id ?? '', drugName: d.drugBatch?.drug?.drugName ?? 'Medication',
        batchNumber: d.drugBatch?.batchNumber ?? '-', quantityIn: 0, quantityOut: d.quantityDispensed,
        quantityText: qtyWords(d.quantityDispensed, d.drugBatch?.drug), balanceText: null,
        party: d.patient ? `${fullName(d.patient)} (${d.patient.mrn})` : null,
        by: d.dispenser ? fullName(d.dispenser) : null,
        referenceId: d.id, balance: null, reconstructed: true,
      })),
      ...(returns as any[]).map((r): StockLedgerEntry => {
        // A vendor return LEAVES stock; the old ledger listed it as an inflow.
        const out = r.returnType === 'vendor_return';
        return {
          id: `return-${r.id}`, date: r.createdAt,
          movementType: out ? 'vendor_return' : r.returnType === 'counter_return' ? 'counter_return' : 'patient_return',
          drugId: r.drugBatch?.drug?.id ?? r.drug?.id ?? '',
          drugName: r.drugBatch?.drug?.drugName ?? r.drug?.drugName ?? 'Medication',
          batchNumber: r.drugBatch?.batchNumber ?? r.batchNumber ?? '-',
          quantityIn: out ? 0 : r.quantity, quantityOut: out ? r.quantity : 0,
          quantityText: qtyWords(r.quantity, r.drugBatch?.drug ?? r.drug), balanceText: null,
          party: r.supplier?.name ?? null, by: r.processor ? fullName(r.processor) : null,
          referenceId: r.id, balance: null, reconstructed: true,
        };
      }),
    ];
    for (const e of rebuilt) {
      if (e.date > toDate) netAfterRebuilt += e.quantityIn - e.quantityOut;
      else entries.push(e);
    }
  }

  const liveStock = stockSum(liveAgg);
  const expiredOnHand = stockSum(expiredAgg);
  const netAfterLogged = Number((afterAgg as any)?._sum?.quantity ?? 0);
  const totalIn = entries.reduce((s, e) => s + e.quantityIn, 0);
  const totalOut = entries.reduce((s, e) => s + e.quantityOut, 0);
  const netChange = totalIn - totalOut;
  const closingStock = liveStock - netAfterLogged - netAfterRebuilt;
  const openingStock = closingStock - netChange;

  // Ascending for the running balance, then newest first for display.
  entries.sort((a, b) => a.date.getTime() - b.date.getTime());
  if (query.drugId) {
    let bal = openingStock;
    for (const e of entries) {
      bal += e.quantityIn - e.quantityOut;
      e.balance = bal;
      const u = unitsByDrug.get(e.drugId);
      e.balanceText = u ? formatQty(bal, u) : null;
    }
  }
  entries.reverse();

  const total = (pred: (e: StockLedgerEntry) => boolean, f: (e: StockLedgerEntry) => number) =>
    entries.filter(pred).reduce((s, e) => s + f(e), 0);
  const saleLike = (e: StockLedgerEntry) => e.movementType === 'sale' || e.movementType === 'dispense';

  return {
    fromDate: fromDate.toISOString(),
    toDate: toDate.toISOString(),
    entries: entries.slice((page - 1) * limit, page * limit),
    page,
    limit,
    total: entries.length,
    summary: {
      openingStock,
      totalReceived: total((e) => e.movementType === 'receipt', (e) => e.quantityIn - e.quantityOut),
      // Sales and dispenses, net of voided sales put back.
      totalDispensed:
        total(saleLike, (e) => e.quantityOut) -
        total((e) => e.movementType === 'sale_cancel', (e) => e.quantityIn),
      totalReturned: total(
        (e) => e.movementType === 'patient_return' || e.movementType === 'counter_return',
        (e) => e.quantityIn,
      ),
      totalIn,
      totalOut,
      netChange,
      /** Equals live stock for a period ending now. */
      closingStock,
      liveStock,
      expiredOnHand,
      saleableStock: liveStock - expiredOnHand,
      /** When the movement log starts; null until the first movement is written. */
      trackedSince: trackedSince ? trackedSince.toISOString() : null,
      /** Rows before this are rebuilt from source documents (transfers/adjustments not itemised). */
      reconstructedBefore: rebuilding ? rebuildTo.toISOString() : null,
    },
  };
}
