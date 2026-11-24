import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { getRequestContext } from '../../config/request-context';
import { STOCK_VALUATION_BASIS } from '../inventory/stock-valuation.service';

// Best-effort audit for pharmacy stock actions (mirrors inventory.audit.ts).
// Every movement of drug stock — batch receipt, dispense, counter sale,
// return, restock-on-approval, formulary mapping/approval — lands in AuditLog
// so the pharmacy audit-trail report shows a single register across the
// hospital. The acting IP + user-agent (the "Machine") come from the
// per-request context automatically — no service signature changes needed.

export type PharmacyAuditAction = 'create' | 'update' | 'delete' | 'merge' | 'adjust';

export async function safePharmacyAudit(params: {
  tenantId: string;
  /** Acting user. Falls back to the request-context user when omitted. */
  userId?: string;
  action: PharmacyAuditAction;
  entityType:
    | 'drug_batch'
    | 'dispensing_record'
    | 'pharmacy_sale'
    | 'drug_return'
    | 'drug_formulary'
    | 'inward_invoice'
    | 'gst_exception';
  entityId: string;
  description?: string;
  /** Human reason/justification — appended to the description when both given. */
  reason?: string;
  oldValues?: unknown;
  newValues?: unknown;
}) {
  try {
    // The AuditLog.action column is a fixed DB enum (create/read/update/delete).
    // Richer pharmacy verbs (merge/adjust) are stored as 'update' with the real
    // verb preserved in the description so the audit-logs report still reads well.
    const storedAction =
      params.action === 'merge' || params.action === 'adjust' ? 'update' : params.action;
    const ctx = getRequestContext();
    const userId = params.userId || ctx?.userId;
    if (!userId) return; // no actor to attribute (e.g. a system job) — skip.
    const description =
      [params.description, params.reason && `Reason: ${params.reason}`].filter(Boolean).join(' — ') || undefined;
    await prisma.auditLog.create({
      data: {
        tenantId: params.tenantId,
        userId,
        action: storedAction,
        entityType: params.entityType,
        entityId: params.entityId,
        description,
        oldValues: (params.oldValues as object | null) ?? undefined,
        newValues: (params.newValues as object | null) ?? undefined,
        ipAddress: ctx?.ipAddress,
        userAgent: ctx?.userAgent,
      },
    });
  } catch (err) {
    logger.warn({ err, ...params }, 'Failed to write pharmacy audit log');
  }
}

// ── Gap 303: before/after quantity AND value on every drug-stock audit row ──
//
// QA found a batch adjustment 8 → 7 audited with quantity only, and pharmacy
// sales with oldValues: null. Every drug-stock action (receipt, sale, sale
// cancel, adjustment / write-off, transfer, return, dispense) now records the
// same shape:
//   oldValues: { qty, unitCost?, value, lines? }
//   newValues: { qty, unitCost?, value, delta, valueDelta, valuationBasis,
//                movementType, documentNumber, source: { type, id }, lines? }
// `value` is at PURCHASE COST — batch purchasePrice × units — the basis of the
// shared stock valuation service (stock-valuation.service.ts). The actor and
// timestamp are the AuditLog row's own userId / createdAt.


export interface DrugStockAuditLine {
  drugBatchId: string;
  batchNumber?: string | null;
  drugName?: string | null;
  before: number;
  after: number;
  /** Batch purchase price (cost basis). Null/absent reads as ₹0. */
  unitCost?: unknown;
  /** When the cost basis itself changed (a batch price edit). Defaults to unitCost. */
  unitCostBefore?: unknown;
}

export interface DrugStockAuditSource {
  movementType: string;
  /** Human document number — PH-… bill, transfer no., invoice no., return id. */
  documentNumber?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
}

const money = (n: number) => Math.round(n * 100) / 100;
const costOf = (v: unknown) => {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : 0;
};

export function drugStockAuditValues(lines: DrugStockAuditLine[], source: DrugStockAuditSource) {
  const rows = lines.map((l) => {
    const costAfter = costOf(l.unitCost);
    const costBefore = l.unitCostBefore !== undefined ? costOf(l.unitCostBefore) : costAfter;
    return {
      drugBatchId: l.drugBatchId,
      batchNumber: l.batchNumber ?? null,
      drugName: l.drugName ?? null,
      before: { qty: l.before, unitCost: costBefore, value: money(l.before * costBefore) },
      after: { qty: l.after, unitCost: costAfter, value: money(l.after * costAfter) },
    };
  });
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  const qtyBefore = sum((r) => r.before.qty);
  const qtyAfter = sum((r) => r.after.qty);
  const valueBefore = money(sum((r) => r.before.value));
  const valueAfter = money(sum((r) => r.after.value));
  const single = rows.length === 1 ? rows[0] : null;
  const lineList = (side: 'before' | 'after') =>
    rows.map((r) => ({ drugBatchId: r.drugBatchId, batchNumber: r.batchNumber, drugName: r.drugName, ...r[side] }));

  return {
    oldValues: {
      qty: qtyBefore,
      ...(single ? { unitCost: single.before.unitCost } : {}),
      value: valueBefore,
      ...(single
        ? { drugBatchId: single.drugBatchId, batchNumber: single.batchNumber }
        : { lines: lineList('before') }),
    },
    newValues: {
      qty: qtyAfter,
      ...(single ? { unitCost: single.after.unitCost } : {}),
      value: valueAfter,
      delta: qtyAfter - qtyBefore,
      valueDelta: money(valueAfter - valueBefore),
      valuationBasis: STOCK_VALUATION_BASIS,
      movementType: source.movementType,
      documentNumber: source.documentNumber ?? null,
      source: { type: source.referenceType ?? null, id: source.referenceId ?? null },
      ...(single
        ? { drugBatchId: single.drugBatchId, batchNumber: single.batchNumber }
        : { lines: lineList('after') }),
    },
  };
}

/**
 * Before/after for movements that already committed: read each batch's live
 * quantity now (= after) and walk back the movement's signed delta (= before).
 * Several deltas on one batch (two lines of one batch on a bill) are summed.
 * Used where the write path does not hold the before figure itself.
 */
export async function drugStockAuditLinesAfterCommit(
  tenantId: string,
  deltas: Array<{ drugBatchId: string; delta: number }>,
): Promise<DrugStockAuditLine[]> {
  const byBatch = new Map<string, number>();
  for (const d of deltas) {
    if (!d.drugBatchId) continue;
    byBatch.set(d.drugBatchId, (byBatch.get(d.drugBatchId) ?? 0) + (Number(d.delta) || 0));
  }
  if (byBatch.size === 0) return [];
  try {
    const batches = await prisma.drugBatch.findMany({
      where: { tenantId, id: { in: [...byBatch.keys()] } },
      select: { id: true, batchNumber: true, quantityInStock: true, purchasePrice: true, drug: { select: { drugName: true } } },
    });
    return (batches ?? []).map((b: any) => {
      const delta = byBatch.get(b.id) ?? 0;
      return {
        drugBatchId: b.id,
        batchNumber: b.batchNumber ?? null,
        drugName: b.drug?.drugName ?? null,
        before: b.quantityInStock - delta,
        after: b.quantityInStock,
        unitCost: b.purchasePrice,
      };
    });
  } catch (err) {
    logger.warn({ err, tenantId }, '303: could not read batches for the stock audit snapshot');
    return [];
  }
}

/** `drugStockAuditValues` over `drugStockAuditLinesAfterCommit` — one call for post-commit audits. */
export async function drugStockAuditAfterCommit(
  tenantId: string,
  deltas: Array<{ drugBatchId: string; delta: number }>,
  source: DrugStockAuditSource,
) {
  return drugStockAuditValues(await drugStockAuditLinesAfterCommit(tenantId, deltas), source);
}
