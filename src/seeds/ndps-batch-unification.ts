/**
 * Bring narcotic stock onto DrugBatch, where every other medicine already lives.
 *
 * Narcotic quantity used to sit in NdpsStockBalance — a ledger of its own with
 * no batch behind it, invisible to stock valuation, expiry alerts, recalls, the
 * GST report and the stock ledger. After this, DrugBatch owns the quantity and
 * NdpsStockBalance describes only WHERE that quantity physically sits.
 *
 * THE INVARIANT, per (tenant, drug): Σ location balances == Σ batch stock.
 *
 * WHAT THIS DOES AUTOMATICALLY, and what it deliberately refuses to.
 *
 * A drug with stock on ONE side only is unambiguous: either the NDPS ledger
 * knows about stock that has no batch (create an opening batch), or batches
 * hold stock with no location (put it in the vault). Both are done here.
 *
 * A drug with stock on BOTH sides is NOT. The two ledgers were independent and
 * nothing can tell whether those are the same physical units counted twice or
 * two genuinely separate lots. Totalling them inflates stock; picking one
 * destroys it. So this leaves them alone and logs them by name for a person to
 * settle with `npm run db:unify-ndps`, which reports each one and unions them
 * only on an operator's say-so.
 *
 * Safe to run on every boot: a drug whose two sides already agree is the
 * migrated steady state and is skipped, which is what makes this idempotent.
 * (An earlier version lacked that guard, saw the now-matching sides as "stock
 * in both ledgers", and doubled every quantity on the second run.)
 */

import { PrismaClient } from '@prisma/client';

/** Marks a batch this migration created, so it can be told from a real receipt. */
export const OPENING_PREFIX = 'NDPS-OPENING-';

export function openingBatchNumber(date = new Date()): string {
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
    date.getDate(),
  ).padStart(2, '0')}`;
  return `${OPENING_PREFIX}${ymd}`;
}

export interface UnifyRow {
  id: string;
  tenant_id: string;
  drug_name: string;
  ndps_qty: number;
  batch_qty: number;
}

export interface UnifyPlan {
  /** NDPS ledger only — an opening batch is created. */
  ndpsOnly: UnifyRow[];
  /** Batch stock only — a vault location is assigned. */
  batchOnly: UnifyRow[];
  /** Stock on both sides — left for a human, never guessed at. */
  ambiguous: UnifyRow[];
  /** Already reconciled, or empty on both sides. */
  settled: UnifyRow[];
}

export async function planUnification(
  prisma: PrismaClient,
  tenantId?: string,
): Promise<UnifyPlan> {
  const rows = await prisma.$queryRawUnsafe<UnifyRow[]>(`
    SELECT df.id, df.tenant_id, df.drug_name,
           COALESCE(nb.q, 0)::int AS ndps_qty,
           COALESCE(b.q, 0)::int  AS batch_qty
    FROM drug_formulary df
    LEFT JOIN (SELECT drug_formulary_id, SUM(quantity) q
                 FROM ndps_stock_balances GROUP BY 1) nb ON nb.drug_formulary_id = df.id
    LEFT JOIN (SELECT drug_id, SUM(quantity_in_stock) q
                 FROM drug_batches GROUP BY 1) b ON b.drug_id = df.id
    WHERE (df.is_narcotic = true OR df.vault_controlled = true OR nb.q IS NOT NULL)
      ${tenantId ? `AND df.tenant_id = '${tenantId}'` : ''}
  `);

  const plan: UnifyPlan = { ndpsOnly: [], batchOnly: [], ambiguous: [], settled: [] };
  for (const r of rows) {
    // Equal totals ARE the migrated steady state — this is the idempotency guard.
    if (r.ndps_qty === r.batch_qty) plan.settled.push(r);
    else if (r.ndps_qty > 0 && r.batch_qty > 0) plan.ambiguous.push(r);
    else if (r.ndps_qty > 0) plan.ndpsOnly.push(r);
    else plan.batchOnly.push(r);
  }
  return plan;
}

/** The tenant's Central Vault, created on demand — narcotic stock belongs in it. */
async function vaultFor(prisma: PrismaClient, tenantId: string): Promise<string> {
  const existing = await prisma.ndpsLocation.findFirst({
    where: { tenantId, type: 'main_vault' },
    select: { id: true },
  });
  if (existing) return existing.id;
  const made = await prisma.ndpsLocation.create({
    data: { tenantId, name: 'Central Vault', type: 'main_vault' },
  });
  return made.id;
}

export interface UnifyResult {
  openingBatchesCreated: number;
  drugsLocated: number;
  ambiguousSkipped: UnifyRow[];
}

/**
 * Apply the unambiguous half of the plan.
 *
 * @param includeAmbiguous when true, a drug holding stock on both sides has the
 *   two sides UNIONED. Only the operator CLI passes this, and only after
 *   showing the affected drugs — it is never done unattended.
 */
export async function applyUnification(
  prisma: PrismaClient,
  plan: UnifyPlan,
  includeAmbiguous = false,
): Promise<UnifyResult> {
  const batchNumber = openingBatchNumber();
  const result: UnifyResult = {
    openingBatchesCreated: 0, drugsLocated: 0,
    ambiguousSkipped: includeAmbiguous ? [] : plan.ambiguous,
  };

  const needBatch = [...plan.ndpsOnly, ...(includeAmbiguous ? plan.ambiguous : [])];
  const needLocation = [...plan.batchOnly, ...(includeAmbiguous ? plan.ambiguous : [])];

  for (const r of needBatch) {
    const vault = await vaultFor(prisma, r.tenant_id);
    if (!vault) continue;
    const already = await prisma.drugBatch.findFirst({
      where: { tenantId: r.tenant_id, drugId: r.id, batchNumber },
      select: { id: true },
    });
    if (already) continue; // re-run of the same day
    // Opening stock the hospital already held, so there is no purchase history.
    // The expiry is a placeholder to be corrected at the next physical count —
    // the column is required and inventing a date is better than refusing to
    // account for stock that exists.
    const expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + 2);
    await prisma.drugBatch.create({
      data: {
        tenantId: r.tenant_id, drugId: r.id, batchNumber, expiryDate: expiry,
        quantityInStock: r.ndps_qty, quantityReceived: r.ndps_qty,
      },
    });
    result.openingBatchesCreated += 1;
  }

  for (const r of needLocation) {
    const vault = await vaultFor(prisma, r.tenant_id);
    if (!vault) continue;
    const bal = await prisma.ndpsStockBalance.findFirst({
      where: { tenantId: r.tenant_id, drugFormularyId: r.id, locationId: vault },
    });
    if (bal) {
      await prisma.ndpsStockBalance.update({
        where: { id: bal.id }, data: { quantity: bal.quantity + r.batch_qty },
      });
    } else {
      await prisma.ndpsStockBalance.create({
        data: {
          tenantId: r.tenant_id, drugFormularyId: r.id,
          locationId: vault, quantity: r.batch_qty,
        },
      });
    }
    result.drugsLocated += 1;
  }

  return result;
}

/**
 * The auto-seed entry point. Does the unambiguous work and names anything it
 * refuses to guess at, so a deployment never silently invents or destroys
 * narcotic stock.
 */
export async function seedNdpsBatchUnification(client?: PrismaClient): Promise<void> {
  const owns = !client;
  const prisma = client ?? new PrismaClient();
  try {
    const plan = await planUnification(prisma);
    const work = plan.ndpsOnly.length + plan.batchOnly.length;
    if (work === 0 && plan.ambiguous.length === 0) return;

    if (work > 0) {
      const r = await applyUnification(prisma, plan, false);
      // eslint-disable-next-line no-console
      console.log(
        `  narcotic stock unified: ${r.openingBatchesCreated} opening batch(es), ` +
          `${r.drugsLocated} drug(s) placed in the vault`,
      );
    }

    if (plan.ambiguous.length) {
      // Named rather than guessed at. Totalling would inflate stock and picking
      // a side would destroy it, so this waits for a person.
      // eslint-disable-next-line no-console
      console.warn(
        `  ⚠ ${plan.ambiguous.length} narcotic drug(s) hold stock in BOTH ledgers and were left ` +
          'untouched — settle them with `npm run db:unify-ndps` (run --dry-run first):',
      );
      for (const a of plan.ambiguous) {
        // eslint-disable-next-line no-console
        console.warn(`      ${a.drug_name}: NDPS ${a.ndps_qty} vs batches ${a.batch_qty}`);
      }
    }
  } finally {
    if (owns) await prisma.$disconnect();
  }
}
