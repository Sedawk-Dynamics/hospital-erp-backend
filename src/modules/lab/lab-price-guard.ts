// Gap 369: a test on its own must not cost more than an active panel that
// includes it, unless someone with catalogue rights says why. Existing rows are
// only listed for review; no price is ever changed here.
import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { normaliseTestName } from './lab-catalog-quality';

export interface PriceRow {
  id: string;
  testName: string;
  price?: unknown;
  parameters?: unknown;
}

export interface PriceConflict {
  testId: string;
  testName: string;
  price: number;
  panelId: string;
  panelName: string;
  panelPrice: number;
}

export interface PriceConfirmation {
  confirmed: boolean;
  reason: string;
}

const amount = (v: unknown) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const paramNames = (params: unknown): string[] =>
  Array.isArray(params)
    ? params
        .map((p) => (p && typeof p === 'object' ? (p as { name?: unknown }).name : null))
        .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    : [];

const isPanel = (r: PriceRow) => paramNames(r.parameters).length >= 2;

/** Names a single test answers to: its own, and its one parameter's. */
const singleKeys = (r: PriceRow) =>
  new Set([r.testName, ...paramNames(r.parameters)].map(normaliseTestName).filter(Boolean));

function pairConflict(single: PriceRow, panel: PriceRow): PriceConflict | null {
  if (single.id === panel.id || isPanel(single) || !isPanel(panel)) return null;
  const price = amount(single.price);
  const panelPrice = amount(panel.price);
  if (price == null || panelPrice == null || price <= panelPrice) return null;
  const keys = singleKeys(single);
  if (!paramNames(panel.parameters).some((n) => keys.has(normaliseTestName(n)))) return null;
  return {
    testId: single.id,
    testName: single.testName,
    price,
    panelId: panel.id,
    panelName: panel.testName,
    panelPrice,
  };
}

export function allPriceConflicts(rows: PriceRow[]): PriceConflict[] {
  const out: PriceConflict[] = [];
  for (const single of rows) {
    if (amount(single.price) == null || isPanel(single)) continue;
    for (const panel of rows) {
      const hit = pairConflict(single, panel);
      if (hit) out.push(hit);
    }
  }
  return out;
}

/** Conflicts a given row is part of, on either side, against the other rows. */
export function priceConflictsFor(row: PriceRow, others: PriceRow[]): PriceConflict[] {
  return others
    .filter((o) => o.id !== row.id)
    .flatMap((o) => [pairConflict(row, o), pairConflict(o, row)])
    .filter((c): c is PriceConflict => c !== null);
}

const inr = (n: number) =>
  `₹${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`;

export function describeConflict(c: PriceConflict): string {
  return `${c.testName} (${inr(c.price)}) costs more than ${c.panelName} (${inr(c.panelPrice)}), which includes it`;
}

/** Conflicts this save would introduce or re-price. Unchanged old ones stay flags only. */
export async function newPriceConflicts(
  tenantId: string,
  before: (PriceRow & { isActive: boolean }) | null,
  after: PriceRow & { isActive: boolean },
): Promise<PriceConflict[]> {
  if (!after.isActive || amount(after.price) == null) return [];
  const others = await prisma.labTestCatalog.findMany({
    where: { tenantId, isActive: true, id: { not: after.id } },
    select: { id: true, testName: true, price: true, parameters: true },
  });
  const now = priceConflictsFor(after, others);
  if (now.length === 0 || !before?.isActive) return now;
  if (amount(before.price) !== amount(after.price)) return now;
  const had = new Set(priceConflictsFor(before, others).map((c) => `${c.testId}|${c.panelId}`));
  return now.filter((c) => !had.has(`${c.testId}|${c.panelId}`));
}

/**
 * Server-side stop: refuses the save until the caller repeats it with an
 * explicit confirmation and a reason. Returns the columns recording it.
 */
export async function assertPriceConfirmed(params: {
  tenantId: string;
  userId?: string | null;
  before: (PriceRow & { isActive: boolean }) | null;
  after: PriceRow & { isActive: boolean };
  confirmation?: PriceConfirmation | null;
}) {
  const conflicts = await newPriceConflicts(params.tenantId, params.before, params.after);
  if (conflicts.length === 0) return { conflicts, columns: {}, reason: null as string | null };
  const reason = params.confirmation?.reason?.trim() ?? '';
  if (!params.confirmation?.confirmed || reason.length < 5) {
    throw AppError.conflict(
      `${conflicts.map(describeConflict).join('; ')}. Confirm the price and give a reason to save it.`,
      'PRICE_ABOVE_PANEL',
      { conflicts },
    );
  }
  return {
    conflicts,
    reason: reason as string | null,
    columns: {
      priceOverridePrice: amount(params.after.price),
      priceOverrideReason: reason,
      priceOverrideById: params.userId ?? null,
      priceOverrideAt: new Date(),
    },
  };
}

/** The "needs price review" list for the Lab Admin. */
export async function getPriceReview(tenantId: string) {
  const rows = await prisma.labTestCatalog.findMany({
    where: { tenantId, isActive: true },
    select: {
      id: true,
      testName: true,
      testCode: true,
      price: true,
      parameters: true,
      priceOverridePrice: true,
      priceOverrideReason: true,
      priceOverrideAt: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return allPriceConflicts(rows).map((c) => {
    // A confirmation only counts while that row's price is still the one confirmed.
    const ack = [c.testId, c.panelId]
      .map((id) => byId.get(id)!)
      .filter((r) => r.priceOverrideAt != null && amount(r.priceOverridePrice) === amount(r.price))
      .sort((a, b) => b.priceOverrideAt!.getTime() - a.priceOverrideAt!.getTime())[0];
    return {
      ...c,
      message: describeConflict(c),
      confirmed: !!ack,
      confirmedReason: ack?.priceOverrideReason ?? null,
      confirmedAt: ack?.priceOverrideAt ?? null,
    };
  });
}
