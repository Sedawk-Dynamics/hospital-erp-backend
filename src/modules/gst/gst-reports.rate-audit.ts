// ---------------------------------------------------------------------------
// The item-level rate findings behind C-5 (Rate Override Log) and C-8 (Rate
// Change Impact) — gap item 279.
//
// Both reports always read 0. C-5 only counted lines flagged
// `requiresTaxResolution`, which the finalisation gate now blocks, and C-8 only
// read the PLATFORM master log, which a hospital never writes to. What a
// hospital actually changes is its own items, and where rates go wrong is in
// three places this module looks at:
//
//   1. item changes   — the audit row written on every change to a service
//                       tariff's or formulary drug's rate, code or treatment;
//   2. item vs master — an item whose own rate differs from its HSN/SAC master;
//   3. billed vs item — a bill line whose rate differs from the item it billed.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { r2 } from '../../shared/gst';
import { fullName } from '../../shared/person-name';
import { ensureItemRateChangeTable } from './gst-rate-log';

const num = (v: unknown) => (v == null ? null : Number(v));

function dateRange(query: { from?: string; to?: string }) {
  return {
    from: query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined,
    to: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined,
  };
}

/** Longest master code that the item's code starts with, down to 4 digits. */
function masterFor<T>(code: string | null | undefined, masters: Map<string, T>): { code: string; row: T } | null {
  const digits = (code ?? '').replace(/\D/g, '');
  for (let len = digits.length; len >= 4; len -= 1) {
    const hit = masters.get(digits.slice(0, len));
    if (hit) return { code: digits.slice(0, len), row: hit };
  }
  return null;
}

export interface ItemChangeRow {
  id: string;
  changedAt: Date;
  changedBy: string | null;
  itemType: string;
  itemId: string;
  itemName: string | null;
  previousRate: number | null;
  newRate: number | null;
  previousCode: string | null;
  newCode: string | null;
  previousTreatment: string | null;
  newTreatment: string | null;
  action: string;
  reason: string | null;
}

/** 1. Logged changes to the hospital's own items in the period. */
export async function getItemRateChanges(
  tenantId: string,
  query: { from?: string; to?: string } = {},
): Promise<ItemChangeRow[]> {
  const { from, to } = dateRange(query);
  try {
    await ensureItemRateChangeTable();
    const rows = await prisma.gstItemRateChange.findMany({
      where: {
        tenantId,
        ...(from || to ? { changedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      orderBy: { changedAt: 'desc' },
    });
    const userIds = [...new Set(rows.map((r) => r.changedBy).filter((x): x is string => !!x))];
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, fullName(u)]));
    return rows.map((r) => ({
      id: r.id,
      changedAt: r.changedAt,
      changedBy: r.changedBy ? (nameOf.get(r.changedBy) ?? null) : null,
      itemType: r.itemType,
      itemId: r.itemId,
      itemName: r.itemName,
      previousRate: num(r.previousRate),
      newRate: num(r.newRate),
      previousCode: r.previousCode,
      newCode: r.newCode,
      previousTreatment: r.previousTreatment,
      newTreatment: r.newTreatment,
      action: r.action,
      reason: r.reason,
    }));
  } catch (err) {
    logger.warn({ err, tenantId }, 'Could not read the item GST change log');
    return [];
  }
}

export interface ItemMasterDifference {
  itemType: 'service' | 'drug';
  itemId: string;
  itemName: string;
  code: string | null;
  masterCode: string;
  itemRate: number;
  masterRate: number;
  itemTreatment: string | null;
  masterTreatment: string | null;
  approved: boolean;
}

/** 2. Items whose own rate or treatment differs from their HSN / SAC master. */
export async function getItemVsMasterDifferences(tenantId: string): Promise<ItemMasterDifference[]> {
  const [tariffs, drugs, sacs, hsns] = await Promise.all([
    prisma.serviceTariff.findMany({
      where: { tenantId, isActive: true, sacCode: { not: null } },
      select: { id: true, serviceName: true, sacCode: true, gstRatePercent: true, gstTreatment: true, gstApproved: true },
    }),
    prisma.drugFormulary.findMany({
      where: { tenantId, isActive: true, hsnCode: { not: null } },
      select: { id: true, drugName: true, hsnCode: true, taxPercent: true, gstTreatment: true },
    }),
    prisma.sacCode.findMany({ where: { isActive: true }, select: { sacCode: true, gstRate: true, treatment: true } }),
    prisma.hsnGstRate.findMany({ where: { isActive: true }, select: { hsnCode: true, gstRate: true, treatment: true } }),
  ]);
  const sacMap = new Map((sacs ?? []).map((s) => [s.sacCode, s]));
  const hsnMap = new Map((hsns ?? []).map((h) => [h.hsnCode, h]));
  const out: ItemMasterDifference[] = [];

  for (const t of tariffs ?? []) {
    const m = masterFor(t.sacCode, sacMap);
    if (!m) continue;
    const itemRate = Number(t.gstRatePercent ?? 0);
    const masterRate = Number(m.row.gstRate ?? 0);
    const differs = itemRate !== masterRate
      || (!!t.gstTreatment && !!m.row.treatment && t.gstTreatment !== m.row.treatment);
    if (!differs) continue;
    out.push({
      itemType: 'service', itemId: t.id, itemName: t.serviceName, code: t.sacCode, masterCode: m.code,
      itemRate, masterRate, itemTreatment: t.gstTreatment, masterTreatment: m.row.treatment, approved: t.gstApproved,
    });
  }
  for (const d of drugs ?? []) {
    const m = masterFor(d.hsnCode, hsnMap);
    if (!m || d.taxPercent == null) continue;
    const itemRate = Number(d.taxPercent);
    const masterRate = Number(m.row.gstRate ?? 0);
    const differs = itemRate !== masterRate
      || (!!d.gstTreatment && !!m.row.treatment && d.gstTreatment !== m.row.treatment);
    if (!differs) continue;
    out.push({
      itemType: 'drug', itemId: d.id, itemName: d.drugName, code: d.hsnCode, masterCode: m.code,
      itemRate, masterRate, itemTreatment: d.gstTreatment, masterTreatment: m.row.treatment, approved: false,
    });
  }
  return out.sort((a, b) => a.itemName.localeCompare(b.itemName));
}

export interface BilledVsItemRow {
  billNumber: string;
  invoiceNumber: string | null;
  billDate: Date;
  description: string;
  itemType: 'service' | 'drug';
  itemId: string;
  billedRate: number;
  itemRate: number;
  billedTreatment: string | null;
  itemTreatment: string | null;
  taxAmount: number;
  rateSource: string | null;
  raisedBy: string | null;
}

/**
 * 3. Bill lines in the period whose rate differs from the item they billed, as
 * the item stands today. A difference is either a change made since (see the
 * change log) or a rate typed at the counter — both are what C-5 is for.
 */
export async function getBilledVsItemDifferences(
  tenantId: string,
  query: { from?: string; to?: string } = {},
): Promise<BilledVsItemRow[]> {
  const { from, to } = dateRange(query);
  const lines = await prisma.billItem.findMany({
    where: {
      bill: {
        tenantId,
        status: { not: 'draft' },
        ...(from || to ? { billDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      OR: [{ serviceTariffId: { not: null } }, { referenceType: 'dispensing_record' }],
    },
    select: {
      description: true, taxPercent: true, taxAmount: true, gstTreatment: true, rateSource: true,
      serviceTariffId: true, referenceType: true, referenceId: true,
      serviceTariff: { select: { id: true, gstRatePercent: true, gstTreatment: true } },
      bill: {
        select: {
          billNumber: true, invoiceNumber: true, billDate: true,
          generator: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  // Pharmacy lines point at a dispensing record; the record names the batch,
  // and the batch names the formulary drug.
  const recIds = (lines ?? [])
    .filter((l) => l.referenceType === 'dispensing_record' && l.referenceId)
    .map((l) => l.referenceId!) ;
  const recs = recIds.length
    ? await prisma.dispensingRecord.findMany({
        where: { id: { in: recIds } },
        select: { id: true, drugBatch: { select: { drugId: true } } },
      })
    : [];
  const drugIdOf = new Map((recs ?? []).map((r) => [r.id, r.drugBatch?.drugId ?? null]));
  const drugIds = [...new Set([...drugIdOf.values()].filter((x): x is string => !!x))];
  const drugs = drugIds.length
    ? await prisma.drugFormulary.findMany({
        where: { id: { in: drugIds } },
        select: { id: true, taxPercent: true, gstTreatment: true },
      })
    : [];
  const drugMap = new Map((drugs ?? []).map((d) => [d.id, d]));

  const out: BilledVsItemRow[] = [];
  for (const l of lines ?? []) {
    let itemType: 'service' | 'drug';
    let itemId: string;
    let itemRate: number | null;
    let itemTreatment: string | null;
    if (l.serviceTariff) {
      itemType = 'service';
      itemId = l.serviceTariff.id;
      itemRate = Number(l.serviceTariff.gstRatePercent ?? 0);
      itemTreatment = l.serviceTariff.gstTreatment;
    } else {
      const drugId = l.referenceId ? drugIdOf.get(l.referenceId) : null;
      const d = drugId ? drugMap.get(drugId) : null;
      if (!d || d.taxPercent == null) continue;
      itemType = 'drug';
      itemId = d.id;
      itemRate = Number(d.taxPercent);
      itemTreatment = d.gstTreatment;
    }
    const billedRate = Number(l.taxPercent ?? 0);
    // An item with no treatment of its own is resolved by the engine (IP
    // composite, category default…), so only a stated treatment is compared.
    const treatmentDiffers = !!itemTreatment && !!l.gstTreatment && itemTreatment !== l.gstTreatment;
    // A non-taxable billed line at 0% against a taxable item is the composite
    // rule doing its job, not an override.
    const compositeExempt = l.gstTreatment !== 'taxable' && billedRate === 0
      && (l.rateSource ?? '').includes('composite');
    if (compositeExempt) continue;
    if (billedRate === itemRate && !treatmentDiffers) continue;
    out.push({
      billNumber: l.bill?.billNumber ?? '',
      invoiceNumber: l.bill?.invoiceNumber ?? null,
      billDate: l.bill?.billDate ?? new Date(0),
      description: l.description,
      itemType,
      itemId,
      billedRate,
      itemRate,
      billedTreatment: l.gstTreatment,
      itemTreatment,
      taxAmount: r2(Number(l.taxAmount ?? 0)),
      rateSource: l.rateSource,
      raisedBy: l.bill?.generator ? fullName(l.bill.generator) : null,
    });
  }
  return out.sort((a, b) => a.billDate.getTime() - b.billDate.getTime());
}
