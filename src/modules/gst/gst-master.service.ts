// ---------------------------------------------------------------------------
// The GST rate masters — the platform reference data every tax decision reads.
//
// Two tables, one idea. `hsn_gst_rates` classifies GOODS and already existed;
// `sac_codes` classifies SERVICES and is new. Both are matched by LONGEST
// PREFIX so a specific code beats its chapter heading — 30049010 (oral
// rehydration salts, nil) beats 3004 (medicaments, 5%), and 999312 (medical and
// dental services) beats 9993 (human health services).
//
// Platform data, so no tenantId: one hospital's auditor does not get to change
// what an HSN code means for everyone else. A hospital that genuinely needs a
// different answer records it on its own item, and that override is visible.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { isGstTreatment, normalizeHsnSac, type GstTreatment } from '../../shared/gst';
import type { MasterMatch } from '../../shared/gst-determination';
import { recordRateChange } from './gst-rate-log';

/**
 * What a master row's treatment is, tolerating a row saved before the column
 * existed. A positive rate can only be taxable; a zero with nothing recorded
 * reads as nil-rated, which reports to the same return line as exempt and so
 * cannot put the money wrong.
 */
export function readTreatment(raw: string | null | undefined, rate: number): GstTreatment {
  if (isGstTreatment(raw)) return raw;
  return rate > 0 ? 'taxable' : 'nil_rated';
}

interface CodeRow {
  code: string;
  gstRate: unknown;
  treatment: string | null;
  description: string | null;
}

/**
 * Longest-prefix match over a preloaded row set.
 *
 * Pure, so a bill with forty lines matches all forty against one set of rows
 * rather than issuing forty queries.
 */
export function matchLongestPrefix(
  code: string | null | undefined,
  rows: CodeRow[],
): (MasterMatch & { description: string | null }) | null {
  const input = normalizeHsnSac(code);
  if (!input) return null;
  let best: CodeRow | null = null;
  for (const r of rows) {
    if (input === r.code || input.startsWith(r.code)) {
      if (!best || r.code.length > best.code.length) best = r;
    }
  }
  if (!best) return null;
  const ratePercent = Number(best.gstRate);
  return {
    code: best.code,
    ratePercent,
    treatment: readTreatment(best.treatment, ratePercent),
    description: best.description,
  };
}

// ── Loading the masters ────────────────────────────────────────────────────

export async function getHsnRows(): Promise<CodeRow[]> {
  const rows = await prisma.hsnGstRate.findMany({
    where: { isActive: true },
    select: { hsnCode: true, gstRate: true, treatment: true, description: true },
  });
  return rows.map((r) => ({
    code: r.hsnCode,
    gstRate: r.gstRate,
    treatment: r.treatment ?? null,
    description: r.description,
  }));
}

export async function getSacRows(): Promise<CodeRow[]> {
  const rows = await prisma.sacCode.findMany({
    where: { isActive: true },
    select: { sacCode: true, gstRate: true, treatment: true, description: true },
  });
  return rows.map((r) => ({
    code: r.sacCode,
    gstRate: r.gstRate,
    treatment: r.treatment ?? null,
    description: r.description,
  }));
}

/** One lookup, its own query. For a loop, preload the rows instead. */
export async function resolveSac(code: string | null | undefined) {
  return matchLongestPrefix(code, await getSacRows());
}

// ── Super-admin management of the SAC reference ────────────────────────────

function assertCanManage(roles: string[]): void {
  if (!roles.includes('super_admin')) {
    throw AppError.forbidden('Only a super admin can change the platform tax masters');
  }
}

/** Full list including inactive rows, for the management table. */
export async function listSacCodes() {
  const rows = await prisma.sacCode.findMany({ orderBy: { sacCode: 'asc' } });
  return rows.map((r) => ({
    ...r,
    gstRate: Number(r.gstRate),
    treatment: readTreatment(r.treatment, Number(r.gstRate)),
  }));
}

export interface SacCodeInput {
  sacCode: string;
  description?: string | null;
  gstRate: number;
  treatment?: GstTreatment;
  category?: string | null;
  isActive?: boolean;
}

/**
 * A treatment and a rate have to agree, or the row says two different things.
 * Anything but `taxable` is a zero rate by definition; a positive rate that
 * claims to be exempt is a typo, not a position.
 */
function reconcile(rate: number, treatment: GstTreatment | undefined): {
  gstRate: number;
  treatment: GstTreatment;
} {
  const t = treatment ?? (rate > 0 ? 'taxable' : 'nil_rated');
  if (t !== 'taxable') return { gstRate: 0, treatment: t };
  return { gstRate: Math.max(0, rate), treatment: 'taxable' };
}

export async function createSacCode(roles: string[], data: SacCodeInput, changedBy?: string | null) {
  assertCanManage(roles);
  const sacCode = normalizeHsnSac(data.sacCode);
  if (!sacCode) throw AppError.badRequest('SAC code must contain digits');
  const { gstRate, treatment } = reconcile(data.gstRate, data.treatment);

  const existing = await prisma.sacCode.findUnique({ where: { sacCode } });
  if (existing) throw AppError.conflict(`A SAC entry for "${sacCode}" already exists`);

  const row = await prisma.sacCode.create({
    data: {
      sacCode,
      description: data.description ?? null,
      gstRate,
      treatment,
      category: data.category ?? null,
      isActive: data.isActive ?? true,
    },
  });
  logger.info({ sacCodeId: row.id, sacCode }, 'SAC → GST rate created');
  await recordRateChange({
    codeType: 'sac',
    code: sacCode,
    description: row.description,
    previousRate: null,
    newRate: gstRate,
    previousTreatment: null,
    newTreatment: treatment,
    action: 'create',
    changedBy,
  });
  return { ...row, gstRate: Number(row.gstRate) };
}

export async function updateSacCode(
  roles: string[],
  id: string,
  data: Partial<SacCodeInput>,
  changedBy?: string | null,
) {
  assertCanManage(roles);
  const existing = await prisma.sacCode.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('SAC entry not found');

  const nextRate = data.gstRate ?? Number(existing.gstRate);
  const nextTreatment =
    data.treatment ?? readTreatment(existing.treatment, Number(existing.gstRate));
  const { gstRate, treatment } = reconcile(nextRate, nextTreatment);

  const row = await prisma.sacCode.update({
    where: { id },
    data: {
      ...(data.sacCode !== undefined
        ? { sacCode: normalizeHsnSac(data.sacCode) ?? existing.sacCode }
        : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.category !== undefined ? { category: data.category } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      gstRate,
      treatment,
    },
  });
  logger.info({ sacCodeId: id }, 'SAC → GST rate updated');
  await recordRateChange({
    codeType: 'sac',
    code: row.sacCode,
    description: row.description,
    previousRate: Number(existing.gstRate),
    newRate: Number(row.gstRate),
    previousTreatment: readTreatment(existing.treatment, Number(existing.gstRate)),
    newTreatment: treatment,
    action: 'update',
    changedBy,
  });
  return { ...row, gstRate: Number(row.gstRate) };
}

/**
 * Deactivated, never deleted. A code that priced a bill last year has to stay
 * resolvable, or that bill can no longer be explained.
 */
export async function deactivateSacCode(roles: string[], id: string, changedBy?: string | null) {
  assertCanManage(roles);
  const existing = await prisma.sacCode.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('SAC entry not found');
  await prisma.sacCode.update({ where: { id }, data: { isActive: false } });
  logger.info({ sacCodeId: id }, 'SAC → GST rate deactivated');
  // A deactivation changes what an item resolves to as surely as a re-rating
  // does — the engine falls through to the next rule — so it is logged too.
  await recordRateChange({
    codeType: 'sac',
    code: existing.sacCode,
    description: existing.description,
    previousRate: Number(existing.gstRate),
    newRate: null,
    previousTreatment: readTreatment(existing.treatment, Number(existing.gstRate)),
    newTreatment: null,
    action: 'deactivate',
    changedBy,
  });
  return { id };
}
