// ---------------------------------------------------------------------------
// The tax master's own history.
//
// A rate that moves changes what a bill costs, and nothing recorded that it
// moved. A hospital that starts charging 5% on something it used to charge
// nothing for could not answer "when did that change, and who changed it" —
// which is the first question asked when two bills for the same service carry
// different tax.
//
// Best effort, and deliberately so: failing to write the log must never stop
// the change itself. A super admin correcting a wrong rate being blocked by the
// audit trail meant to explain the correction is the worst possible trade.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { logger } from '../../config/logger';

export type RateCodeType = 'hsn' | 'sac';
export type RateChangeAction = 'create' | 'update' | 'deactivate';

export interface RateChangeInput {
  codeType: RateCodeType;
  code: string;
  description?: string | null;
  previousRate?: number | null;
  newRate?: number | null;
  previousTreatment?: string | null;
  newTreatment?: string | null;
  action: RateChangeAction;
  changedBy?: string | null;
}

const same = (a: unknown, b: unknown) => Number(a ?? -1) === Number(b ?? -1);

/**
 * Record a change to a tax master.
 *
 * An update that moved neither the rate nor the treatment is not logged: a
 * corrected spelling is not a rate change, and a log full of them is a log
 * nobody reads.
 */
export async function recordRateChange(input: RateChangeInput): Promise<void> {
  try {
    if (
      input.action === 'update' &&
      same(input.previousRate, input.newRate) &&
      (input.previousTreatment ?? null) === (input.newTreatment ?? null)
    ) {
      return;
    }
    await prisma.gstRateChange.create({
      data: {
        codeType: input.codeType,
        code: input.code,
        description: input.description ?? null,
        previousRate: input.previousRate ?? null,
        newRate: input.newRate ?? null,
        previousTreatment: input.previousTreatment ?? null,
        newTreatment: input.newTreatment ?? null,
        action: input.action,
        changedBy: input.changedBy ?? null,
      },
    });
  } catch (err) {
    logger.error(
      { err, code: input.code, codeType: input.codeType },
      'Could not log a tax master change — the change itself stands',
    );
  }
}

// ---------------------------------------------------------------------------
// Item-level history (gap item 279).
//
// The log above records the PLATFORM masters (HSN / SAC). C-5 and C-8 always
// read 0 because what a hospital actually edits is its own ITEM — a service
// tariff's rate, SAC and treatment, a formulary drug's rate, HSN and treatment
// — and none of those edits left a trace. This is that trace: old and new
// values, who, when and why, one row per change.
//
// Its own table rather than new columns on gst_rate_changes, so a database that
// has not been migrated keeps answering C-8 from the old table. The table is
// created on first use, like the OT schedule columns.
// ---------------------------------------------------------------------------

export type ItemKind = 'service' | 'drug';

export interface ItemTaxState {
  rate: number | null;
  code: string | null;
  treatment: string | null;
}

let itemTableReady: Promise<void> | null = null;

/** Create gst_item_rate_changes if this database predates it. Idempotent. */
export function ensureItemRateChangeTable(): Promise<void> {
  if (!itemTableReady) {
    itemTableReady = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS gst_item_rate_changes (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          item_type VARCHAR(20) NOT NULL,
          item_id TEXT NOT NULL,
          item_name VARCHAR(255),
          previous_rate DECIMAL(5,2),
          new_rate DECIMAL(5,2),
          previous_code VARCHAR(20),
          new_code VARCHAR(20),
          previous_treatment VARCHAR(20),
          new_treatment VARCHAR(20),
          action VARCHAR(12) NOT NULL,
          reason VARCHAR(500),
          changed_by TEXT,
          changed_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
      await prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS gst_item_rate_changes_tenant_id_changed_at_idx ON gst_item_rate_changes (tenant_id, changed_at)',
      );
      await prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS gst_item_rate_changes_tenant_id_item_type_item_id_idx ON gst_item_rate_changes (tenant_id, item_type, item_id)',
      );
    })().catch((err) => {
      itemTableReady = null;
      throw err;
    });
  }
  return itemTableReady;
}

const sameRate = (a: number | null | undefined, b: number | null | undefined) =>
  (a == null && b == null) || (a != null && b != null && Number(a) === Number(b));
const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').trim().toUpperCase() === (b ?? '').trim().toUpperCase();

/**
 * Record a change to one item's GST rate, HSN/SAC or taxability.
 *
 * Called from the item's own save path with the state before and after. A save
 * that moved none of the three is not logged. The user comes from the request
 * context when the caller does not pass one, so a save path needs no new
 * parameter. Best effort: a failed write never blocks the save.
 */
export async function recordItemRateChange(input: {
  tenantId: string;
  itemType: ItemKind;
  itemId: string;
  itemName?: string | null;
  before: ItemTaxState | null;
  after: ItemTaxState;
  reason?: string | null;
  changedBy?: string | null;
}): Promise<void> {
  try {
    const { before, after } = input;
    if (
      before &&
      sameRate(before.rate, after.rate) &&
      sameText(before.code, after.code) &&
      sameText(before.treatment, after.treatment)
    ) {
      return;
    }
    let changedBy = input.changedBy ?? null;
    if (!changedBy) {
      const { getRequestContext } = await import('../../config/request-context');
      changedBy = getRequestContext()?.userId ?? null;
    }
    await ensureItemRateChangeTable();
    await prisma.gstItemRateChange.create({
      data: {
        tenantId: input.tenantId,
        itemType: input.itemType,
        itemId: input.itemId,
        itemName: input.itemName?.slice(0, 255) ?? null,
        previousRate: before?.rate ?? null,
        newRate: after.rate ?? null,
        previousCode: before?.code ?? null,
        newCode: after.code ?? null,
        previousTreatment: before?.treatment ?? null,
        newTreatment: after.treatment ?? null,
        action: before ? 'update' : 'create',
        reason: input.reason?.slice(0, 500) ?? null,
        changedBy,
      },
    });
  } catch (err) {
    logger.error(
      { err, itemId: input.itemId, itemType: input.itemType },
      'Could not log an item GST change — the change itself stands',
    );
  }
}

/**
 * The reason to record against an item's GST change (gap items 263 / 279).
 *
 * Two names reach the save paths for the same thing: the GST classification
 * page sends `gstChangeReason`, while the drug, product and unified-item forms
 * send `gstRateReason` (stored on the drug as why its rate differs from HSN).
 * Reading only the first meant every form-typed reason was lost and C-5 / C-8
 * showed the generic fallback. Prefer the explicit change reason, then the
 * rate reason, then the fallback.
 */
export function pickRateChangeReason(data: unknown, fallback: string): string {
  const d = (data ?? {}) as { gstChangeReason?: unknown; gstRateReason?: unknown };
  for (const v of [d.gstChangeReason, d.gstRateReason]) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return fallback;
}
