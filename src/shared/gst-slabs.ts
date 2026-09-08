// ---------------------------------------------------------------------------
// The slab master — the list of rates the law actually recognises.
//
// Everything else in the GST work decides WHICH rate applies to a supply. This
// decides whether that rate is one a hospital may charge at all. They are
// different questions, and only the second one catches the case where a rate
// somebody typed onto a master years ago is still quietly reaching invoices.
//
// This database holds pharmacy lines billed at 10% and at 12%. Neither is a
// slab. Nothing refused them, because until now nothing knew what the slabs
// were.
//
// Date-ranged, because the answer changed. The 56th GST Council retired 12% and
// 28% and introduced 40% with effect from 22 September 2025, so a bill raised
// in June 2025 at 12% was correct and must stay correct while the same rate on
// a bill raised today is not. Every check is made AS AT the document's own
// date — never "now" — for exactly the reason the rate itself is snapshotted
// onto the line: history is not rewritten underneath a filed return.
// ---------------------------------------------------------------------------

import { prisma } from '../config/database';
import { logger } from '../config/logger';

export interface GstSlabWindow {
  ratePercent: number;
  label: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  note: string | null;
}

/**
 * Platform reference data — a dozen rows that change when a super admin edits
 * them and never otherwise. Cached for the same 60s as the HSN/SAC masters, so
 * an edit shows up while the person who made it is still looking at the screen.
 */
const SLAB_TTL_MS = 60_000;
let cache: { rows: GstSlabWindow[]; loadedAt: number } | null = null;

/** Called after any slab edit, and by tests. */
export function clearGstSlabCache(): void {
  cache = null;
}

export async function loadGstSlabs(): Promise<GstSlabWindow[]> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < SLAB_TTL_MS) return cache.rows;
  const rows = await prisma.gstSlab.findMany({
    where: { isActive: true },
    orderBy: [{ effectiveFrom: 'asc' }, { ratePercent: 'asc' }],
  });
  cache = {
    rows: rows.map((r) => ({
      ratePercent: Number(r.ratePercent),
      label: r.label,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      note: r.note,
    })),
    loadedAt: now,
  };
  return cache.rows;
}

/** The rates legal on a given date, lowest first. */
export function slabsOn(rows: GstSlabWindow[], on: Date): number[] {
  const day = new Date(Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), on.getUTCDate()));
  return rows
    .filter((r) => r.effectiveFrom <= day && (r.effectiveTo == null || r.effectiveTo >= day))
    .map((r) => r.ratePercent)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => a - b);
}

/**
 * Whether a rate may legally be charged on a supply made on this date.
 *
 * An EMPTY slab list means the master has not been seeded — on a platform that
 * has not been migrated yet, or where somebody deactivated every row. It
 * returns true in that case, deliberately: a check that cannot be made must not
 * start refusing every bill in the hospital. The absence is logged instead.
 */
export function isLegalSlabRate(rows: GstSlabWindow[], ratePercent: number, on: Date): boolean {
  const legal = slabsOn(rows, on);
  if (legal.length === 0) return true;
  // Compared to the paisa, because a rate is stored as Decimal(5,2) and
  // 5 and 5.00 are the same slab.
  return legal.some((r) => Math.abs(r - ratePercent) < 0.005);
}

/** The same check, for a caller that has no resolver in hand. */
export async function checkSlabRate(
  ratePercent: number,
  on: Date = new Date(),
): Promise<{ legal: boolean; slabs: number[] }> {
  let rows: GstSlabWindow[];
  try {
    rows = await loadGstSlabs();
  } catch (err) {
    // Billing must never fail because a reference table could not be read.
    logger.warn({ err }, 'GST slab master unreadable — the rate check is skipped');
    return { legal: true, slabs: [] };
  }
  return { legal: isLegalSlabRate(rows, ratePercent, on), slabs: slabsOn(rows, on) };
}

/** "5%, 18% or 40%" — for the sentence a refusal shows the person billing. */
export function describeSlabs(slabs: number[]): string {
  if (slabs.length === 0) return 'none configured';
  const parts = slabs.map((s) => `${s}%`);
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}
