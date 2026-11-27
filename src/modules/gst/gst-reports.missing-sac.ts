// ---------------------------------------------------------------------------
// C-10 — Missing SAC codes (#264).
//
// The client's decision: warn and allow the bill, and show the service here; the
// exception is a service carrying GST above 0%, whose bill is blocked.
//
//   warn     — billed (issued) at 0% with no SAC
//   blocked  — carries GST with no SAC: on a draft that cannot be issued, or
//              issued before the rule existed (said apart, as `issuedTaxedLines`)
//
// A service in the hospital's list with no SAC that has not been billed is
// listed too, so it can be fixed before it warns or blocks anybody.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { r2 } from '../../shared/gst';
import { istDayEnd, istDayStart } from '../../shared/date.utils';
import { isGoodsCategory, lineCarriesGst } from '../billing/billing.gst-checks';
import { DIAGNOSTIC_IMAGING_SAC } from '../../shared/radiology-gst';

/** Where a missing code is set. Paths of the hospital app. */
export type MissingSacFix = 'gst_classification' | 'radiology_settings' | 'registration_fee';

export interface MissingSacRow {
  key: string;
  serviceTariffId: string | null;
  service: string;
  serviceCode: string | null;
  category: string;
  lines: number;
  /** Value of those lines before tax. */
  value: number;
  taxAmount: number;
  maxRatePercent: number;
  lastBillNumber: string | null;
  lastBillDate: Date | null;
  status: 'warn' | 'blocked';
  /** Drafts this service is stopping right now. */
  blockedDrafts: number;
  /** Taxed with no SAC on a document already issued — corrected by credit note. */
  issuedTaxedLines: number;
  fix: MissingSacFix;
}

const n = (v: unknown) => r2(Number(v ?? 0));

function fixFor(category: string): MissingSacFix {
  if (category === 'registration') return 'registration_fee';
  if (category === 'radiology') return 'radiology_settings';
  return 'gst_classification';
}

export async function getMissingSacReport(
  tenantId: string,
  query: { from?: string; to?: string; status?: 'warn' | 'blocked' } = {},
) {
  const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
  const profile = await getGstProfile(tenantId);
  const billDate =
    query.from || query.to
      ? {
          ...(query.from ? { gte: istDayStart(query.from) } : {}),
          ...(query.to ? { lte: istDayEnd(query.to) } : {}),
        }
      : undefined;

  const [items, tariffs] = await Promise.all([
    prisma.billItem.findMany({
      where: {
        OR: [{ hsnSacCode: null }, { hsnSacCode: '' }],
        bill: {
          tenantId,
          status: { not: 'cancelled' },
          NOT: { billNumber: { startsWith: 'ADV-' } },
          ...(billDate ? { billDate } : {}),
        },
      },
      select: {
        id: true, description: true, category: true, serviceTariffId: true, referenceType: true,
        taxPercent: true, taxAmount: true, taxableValue: true, totalAmount: true, gstTreatment: true,
        bill: { select: { id: true, billNumber: true, invoiceNumber: true, billDate: true, status: true } },
      },
    }),
    prisma.serviceTariff.findMany({
      where: { tenantId },
      select: {
        id: true, serviceName: true, serviceCode: true, category: true, sacCode: true, isActive: true,
        gstTreatment: true, gstRatePercent: true, isCosmetic: true,
      },
    }),
  ]);
  const tariffById = new Map(tariffs.map((t) => [t.id, t]));

  const groups = new Map<string, MissingSacRow & { drafts: Set<string> }>();
  for (const it of items) {
    const category = String(it.category);
    if (!it.bill || isGoodsCategory(category)) continue;
    const carriesGst = lineCarriesGst({ ...it, category });
    const isDraft = String(it.bill.status) === 'draft';
    // A draft at 0% is not a warning yet: nothing has been issued.
    if (isDraft && !carriesGst) continue;

    const tariff = it.serviceTariffId ? tariffById.get(it.serviceTariffId) : undefined;
    const key = tariff ? `tariff:${tariff.id}` : `${category}:${it.description.trim().toLowerCase()}`;
    const row = groups.get(key) ?? {
      key,
      serviceTariffId: tariff?.id ?? null,
      service: tariff?.serviceName ?? it.description,
      serviceCode: tariff?.serviceCode ?? null,
      category,
      lines: 0, value: 0, taxAmount: 0, maxRatePercent: 0,
      lastBillNumber: null, lastBillDate: null,
      status: 'warn' as const,
      blockedDrafts: 0, issuedTaxedLines: 0,
      fix: fixFor(category),
      drafts: new Set<string>(),
    };
    row.lines += 1;
    row.value = r2(row.value + n(it.taxableValue));
    row.taxAmount = r2(row.taxAmount + n(it.taxAmount));
    row.maxRatePercent = Math.max(row.maxRatePercent, n(it.taxPercent));
    if (!row.lastBillDate || it.bill.billDate > row.lastBillDate) {
      row.lastBillDate = it.bill.billDate;
      row.lastBillNumber = it.bill.invoiceNumber ?? it.bill.billNumber;
    }
    if (carriesGst) {
      row.status = 'blocked';
      if (isDraft) row.drafts.add(it.bill.id);
      else row.issuedTaxedLines += 1;
    }
    groups.set(key, row);
  }

  const billed = [...groups.values()].map(({ drafts, ...r }) => ({ ...r, blockedDrafts: drafts.size }));

  // Services in the list with no SAC that no bill in this period has shown up.
  const seen = new Set(billed.map((r) => r.serviceTariffId).filter(Boolean));
  const notBilled: MissingSacRow[] = tariffs
    .filter((t) => {
      const category = String(t.category);
      if (!t.isActive || String(t.sacCode ?? '').trim() || seen.has(t.id) || isGoodsCategory(category)) return false;
      // A diagnostic scan and a room take their own code when billed.
      if (category === 'room' || (category === 'radiology' && !t.isCosmetic)) return false;
      return true;
    })
    .map((t) => {
      const category = String(t.category);
      const taxed = t.isCosmetic || (Number(t.gstRatePercent ?? 0) > 0 && (!t.gstTreatment || t.gstTreatment === 'taxable'));
      return {
        key: `tariff:${t.id}`, serviceTariffId: t.id, service: t.serviceName, serviceCode: t.serviceCode, category,
        lines: 0, value: 0, taxAmount: 0, maxRatePercent: n(t.gstRatePercent),
        lastBillNumber: null, lastBillDate: null,
        status: taxed ? ('blocked' as const) : ('warn' as const),
        blockedDrafts: 0, issuedTaxedLines: 0, fix: fixFor(category),
      };
    });

  const all = [...billed, ...notBilled];
  const rows = all
    .filter((r) => !query.status || r.status === query.status)
    .sort((a, b) =>
      (a.status === b.status ? 0 : a.status === 'blocked' ? -1 : 1) || b.lines - a.lines || b.value - a.value ||
      a.service.localeCompare(b.service),
    );

  return {
    period: { from: query.from ?? null, to: query.to ?? null },
    registered: profile.registered,
    rows,
    summary: {
      services: all.length,
      warn: all.filter((r) => r.status === 'warn').length,
      blocked: all.filter((r) => r.status === 'blocked').length,
      blockedDrafts: new Set([...groups.values()].flatMap((g) => [...g.drafts])).size,
      issuedTaxedLines: billed.reduce((t, r) => t + r.issuedTaxedLines, 0),
      lines: billed.reduce((t, r) => t + r.lines, 0),
      value: r2(billed.reduce((t, r) => t + r.value, 0)),
    },
    note: !profile.registered
      ? 'This hospital is not GST registered, so no bill is warned or blocked. These are the services that would be.'
      : 'A service billed at 0% with no SAC is allowed and listed as a warning. One that carries GST with no SAC stops the bill from being issued until the code is set.' +
        ` Diagnostic scans with no code of their own use ${DIAGNOSTIC_IMAGING_SAC}.`,
  };
}
