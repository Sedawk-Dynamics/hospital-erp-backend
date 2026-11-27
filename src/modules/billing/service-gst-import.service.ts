// ---------------------------------------------------------------------------
// #264 — the hospital's services list, in bulk: SAC, treatment and GST %.
//
// Preview validates every row and writes nothing. Apply takes only the rows the
// admin confirmed and validates each of them again — the browser's word that a
// row was "ready" is not trusted, and the master may have moved since.
//
// It sets the classification of services that ALREADY exist. It never creates a
// service (the file has no price) and never approves one: `gstApproved` is the
// auditor's sign-off, so a changed row comes out unapproved, as any other edit
// to a classification does.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { writeAudit } from '../../shared/audit';
import { describeSlabs, isLegalSlabRate, loadGstSlabs, slabsOn } from '../../shared/gst-slabs';

export interface GstImportRow {
  rowNumber: number;
  serviceCode?: string | null;
  serviceName?: string | null;
  sacCode?: string | null;
  treatment?: string | null;
  gstPercent?: string | number | null;
}

export type GstImportStatus = 'ready' | 'unchanged' | 'error';

export interface GstImportPreviewRow {
  rowNumber: number;
  serviceCode: string | null;
  serviceName: string | null;
  status: GstImportStatus;
  errors: string[];
  warnings: string[];
  tariffId: string | null;
  matchedName: string | null;
  category: string | null;
  current: { sacCode: string | null; treatment: string | null; gstPercent: number; gstApproved: boolean } | null;
  next: { sacCode: string; treatment: string; gstPercent: number } | null;
}

export const GST_IMPORT_COLUMNS = ['Service code', 'Service name', 'SAC', 'Treatment', 'GST %'] as const;

const TREATMENTS: Record<string, string> = {
  taxable: 'taxable',
  exempt: 'exempt',
  exempted: 'exempt',
  nil: 'nil_rated',
  nil_rated: 'nil_rated',
  nilrated: 'nil_rated',
  non_gst: 'non_gst',
  nongst: 'non_gst',
  zero_rated: 'zero_rated',
  zerorated: 'zero_rated',
};

const clean = (v: unknown) => String(v ?? '').trim();
const norm = (v: unknown) => clean(v).toLowerCase().replace(/\s+/g, ' ');

function treatmentOf(v: unknown): string | null {
  return TREATMENTS[norm(v).replace(/[\s-]+/g, '_')] ?? null;
}

/** "18", "18%", 18, 0.18 typed by Excel as a percentage is NOT guessed at. */
function percentOf(v: unknown): number | null {
  const s = clean(v).replace(/%$/, '').trim();
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

type Tariff = {
  id: string; serviceName: string; serviceCode: string | null; category: unknown; sacCode: string | null;
  gstTreatment: string | null; gstRatePercent: unknown; gstApproved: boolean; isCosmetic: boolean; isActive: boolean;
};

const TARIFF_SELECT = {
  id: true, serviceName: true, serviceCode: true, category: true, sacCode: true,
  gstTreatment: true, gstRatePercent: true, gstApproved: true, isCosmetic: true, isActive: true,
} as const;

async function loadTariffs(tenantId: string): Promise<Tariff[]> {
  return prisma.serviceTariff.findMany({ where: { tenantId }, select: TARIFF_SELECT, orderBy: { serviceName: 'asc' } });
}

/** The template: the header, and every service as it stands now to fill in. */
export async function serviceGstTemplate(tenantId: string) {
  const tariffs = (await loadTariffs(tenantId)).filter((t) => t.isActive);
  return {
    columns: [...GST_IMPORT_COLUMNS],
    rows: tariffs.map((t) => [
      t.serviceCode ?? '', t.serviceName, t.sacCode ?? '', t.gstTreatment ?? '',
      t.gstTreatment ? Number(t.gstRatePercent ?? 0) : '',
    ]),
    notes: [
      'One row per service. Match by service code, or by the exact service name when the code is blank.',
      'SAC: 6 digits.',
      'Treatment: taxable, exempt, nil_rated, non_gst or zero_rated.',
      'GST %: a legal slab for a taxable service; 0 for every other treatment.',
      'Only services already in the hospital list are updated. Nothing is approved by the upload.',
    ],
  };
}

function validateRows(
  rows: GstImportRow[],
  tariffs: Tariff[],
  slabs: Awaited<ReturnType<typeof loadGstSlabs>>,
  sacRows: Array<{ sacCode: string }>,
  on: Date,
): GstImportPreviewRow[] {
  const legal = slabsOn(slabs, on);
  const byCode = new Map<string, Tariff[]>();
  const byName = new Map<string, Tariff[]>();
  for (const t of tariffs) {
    if (t.serviceCode) byCode.set(norm(t.serviceCode), [...(byCode.get(norm(t.serviceCode)) ?? []), t]);
    byName.set(norm(t.serviceName), [...(byName.get(norm(t.serviceName)) ?? []), t]);
  }
  const knownSac = new Set(sacRows.map((s) => s.sacCode));
  const firstRowFor = new Map<string, number>();

  return rows.map((row) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const code = clean(row.serviceCode);
    const name = clean(row.serviceName);

    // ── which service ──
    let tariff: Tariff | null = null;
    if (!code && !name) {
      errors.push('Enter the service code or the service name');
    } else if (code) {
      const hits = byCode.get(norm(code)) ?? [];
      if (hits.length === 1) tariff = hits[0]!;
      else if (hits.length > 1) errors.push(`Service code "${code}" is on ${hits.length} services`);
      else errors.push(`No service has the code "${code}"`);
      if (tariff && name && norm(tariff.serviceName) !== norm(name)) {
        errors.push(`Code "${code}" is "${tariff.serviceName}", not "${name}"`);
      }
    } else {
      const hits = byName.get(norm(name)) ?? [];
      if (hits.length === 1) tariff = hits[0]!;
      else if (hits.length > 1) errors.push(`"${name}" is the name of ${hits.length} services — use the service code`);
      else errors.push(`No service is named "${name}"`);
    }
    if (tariff) {
      const seen = firstRowFor.get(tariff.id);
      if (seen !== undefined) errors.push(`The same service is already on row ${seen}`);
      else firstRowFor.set(tariff.id, row.rowNumber);
      if (!tariff.isActive) warnings.push('This service is inactive');
    }

    // ── what it says ──
    const sac = clean(row.sacCode).replace(/\.0$/, '');
    if (!sac) errors.push('SAC is required');
    else if (!/^\d{6}$/.test(sac)) errors.push(`SAC "${sac}" must be 6 digits`);
    else if (!sac.startsWith('99')) errors.push(`"${sac}" is not a SAC: service codes start with 99`);
    else if (knownSac.size && !knownSac.has(sac)) warnings.push(`SAC ${sac} is not in the SAC master — check it`);

    const treatment = treatmentOf(row.treatment);
    if (!clean(row.treatment)) errors.push('Treatment is required');
    else if (!treatment) errors.push(`Treatment "${clean(row.treatment)}" is not one of taxable, exempt, nil_rated, non_gst, zero_rated`);

    const blankPercent = clean(row.gstPercent) === '';
    let percent = blankPercent ? null : percentOf(row.gstPercent);
    if (!blankPercent && percent === null) errors.push(`GST % "${clean(row.gstPercent)}" is not a number`);
    if (treatment === 'taxable') {
      if (blankPercent) errors.push('GST % is required for a taxable service');
      else if (percent !== null && percent <= 0) errors.push('A taxable service needs a GST % above 0');
      else if (percent !== null && !isLegalSlabRate(slabs, percent, on)) {
        errors.push(`${percent}% is not a legal GST slab. Legal rates today are ${describeSlabs(legal)}`);
      }
    } else if (treatment) {
      if (percent !== null && percent > 0) errors.push(`A ${treatment.replace(/_/g, ' ')} service cannot carry GST of ${percent}%`);
      if (blankPercent) percent = 0;
    }
    if (tariff && treatment) {
      if (tariff.isCosmetic && treatment !== 'taxable') {
        errors.push('This service is marked cosmetic / non-medical, which is taxable');
      }
      if (String(tariff.category) === 'radiology' && !tariff.isCosmetic && treatment === 'taxable') {
        errors.push('A diagnostic scan is exempt (0%). Mark it cosmetic / non-medical in Radiology → Settings first');
      }
    }

    const current = tariff
      ? {
          sacCode: tariff.sacCode, treatment: tariff.gstTreatment,
          gstPercent: Number(tariff.gstRatePercent ?? 0), gstApproved: tariff.gstApproved,
        }
      : null;
    const next = errors.length === 0 ? { sacCode: sac, treatment: treatment!, gstPercent: percent ?? 0 } : null;
    const unchanged =
      !!current && !!next && current.sacCode === next.sacCode &&
      current.treatment === next.treatment && current.gstPercent === next.gstPercent;
    if (next && current?.gstApproved && !unchanged) {
      warnings.push('This classification is approved. Applying the change withdraws the approval.');
    }
    return {
      rowNumber: row.rowNumber,
      serviceCode: code || null,
      serviceName: name || null,
      status: errors.length ? 'error' : unchanged ? 'unchanged' : 'ready',
      errors,
      warnings,
      tariffId: tariff?.id ?? null,
      matchedName: tariff?.serviceName ?? null,
      category: tariff ? String(tariff.category) : null,
      current,
      next,
    } satisfies GstImportPreviewRow;
  });
}

async function check(tenantId: string, rows: GstImportRow[]) {
  const [tariffs, slabs, sacRows] = await Promise.all([
    loadTariffs(tenantId),
    loadGstSlabs(),
    prisma.sacCode.findMany({ where: { isActive: true }, select: { sacCode: true } }),
  ]);
  return validateRows(rows, tariffs, slabs, sacRows, new Date());
}

export async function previewServiceGstImport(tenantId: string, rows: GstImportRow[]) {
  const checked = await check(tenantId, rows);
  const count = (s: GstImportStatus) => checked.filter((r) => r.status === s).length;
  return {
    rows: checked,
    summary: { total: checked.length, ready: count('ready'), unchanged: count('unchanged'), errors: count('error') },
  };
}

export async function applyServiceGstImport(tenantId: string, userId: string, rows: GstImportRow[]) {
  const checked = await check(tenantId, rows);
  const results: Array<{ rowNumber: number; serviceName: string | null; applied: boolean; reason: string | null }> = [];
  const { recordItemRateChange } = await import('../gst/gst-rate-log');

  for (const r of checked) {
    if (r.status !== 'ready' || !r.next || !r.tariffId || !r.current) {
      results.push({
        rowNumber: r.rowNumber, serviceName: r.matchedName ?? r.serviceName, applied: false,
        reason: r.status === 'unchanged' ? 'Already set to these values' : r.errors.join('; '),
      });
      continue;
    }
    // Only if the service still says what the preview checked against.
    const done = await prisma.serviceTariff.updateMany({
      where: { id: r.tariffId, tenantId, sacCode: r.current.sacCode, gstTreatment: r.current.treatment },
      data: {
        sacCode: r.next.sacCode,
        gstTreatment: r.next.treatment,
        gstRatePercent: r.next.gstPercent,
        // The auditor has not seen this. Never true from an upload.
        gstApproved: false,
      },
    });
    if (done.count === 0) {
      results.push({ rowNumber: r.rowNumber, serviceName: r.matchedName, applied: false, reason: 'Changed by someone else — upload the file again' });
      continue;
    }
    results.push({ rowNumber: r.rowNumber, serviceName: r.matchedName, applied: true, reason: null });
    await writeAudit({
      tenantId,
      userId,
      action: 'update',
      entityType: 'service_tariff',
      entityId: r.tariffId,
      description: `Services list import (row ${r.rowNumber}): ${r.matchedName} set to SAC ${r.next.sacCode}, ${r.next.treatment}, GST ${r.next.gstPercent}% — awaiting approval`,
      oldValues: r.current,
      newValues: { ...r.next, gstApproved: false },
    });
    void recordItemRateChange({
      tenantId, itemType: 'service', itemId: r.tariffId, itemName: r.matchedName,
      before: { rate: r.current.gstPercent, code: r.current.sacCode, treatment: r.current.treatment },
      after: { rate: r.next.gstPercent, code: r.next.sacCode, treatment: r.next.treatment },
      reason: 'Services list import', changedBy: userId,
    }).catch(() => undefined);
  }

  const applied = results.filter((r) => r.applied).length;
  logger.info({ tenantId, by: userId, applied, total: results.length }, 'Services list GST import applied');
  return { applied, failed: results.length - applied, results };
}
