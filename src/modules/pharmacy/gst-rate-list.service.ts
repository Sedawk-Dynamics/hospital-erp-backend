// ---------------------------------------------------------------------------
// Gap #262 — medicines on a retired GST rate, and loading the corrected rates.
//
// "No medicine is at 12% any more — use the attached list." The list had not
// arrived when this was written, so nothing here knows a replacement rate. It
// finds the items, and it loads whatever rates the hospital supplies:
//
//   listRetiredGstRates   what is still on a rate the law no longer recognises
//   previewGstRateList    validate a file, write nothing, list what did not match
//   applyGstRateList      write only the rows the user confirmed, each re-checked
//
// The rate changed is the medicine's CURRENT rate. Bills already issued, the
// lines on them, and every return against them keep the rate they carry: they
// store their own, and credit notes mirror the stored line.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { writeAudit } from '../../shared/audit';
import { itemTaxContext, supplyKindForInventoryCategory } from '../../shared/gst-determination';
import { describeSlabs, isLegalSlabRate, loadGstSlabs, slabsOn, type GstSlabWindow } from '../../shared/gst-slabs';
import { getHsnGstRows, matchHsnGst, normalizeHsn } from '../drug-master/drug-master.service';
import { recordItemRateChange } from '../gst/gst-rate-log';
import { GST_RATE_EDIT_ROLES, rateSourceLabel } from '../gst/gst-retired-rate';
import { gtinVariants } from './pharmacy.barcode';
import { formatDrugQty, UNIT_SELECT } from './pharmacy.units';

export function assertGstRateEditor(roles: string[]): void {
  if (!roles.some((r) => (GST_RATE_EDIT_ROLES as readonly string[]).includes(r))) {
    throw AppError.forbidden(
      'Only a pharmacy admin, inventory manager, hospital admin or billing admin can change medicine GST rates.',
    );
  }
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** Today as an India calendar date, "2026-11-25". */
const todayIst = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
const asDay = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const ddmmyyyy = (ymd: string) => ymd.split('-').reverse().join('/');
const clean = (v: unknown) => String(v ?? '').trim();
const norm = (v: unknown) => clean(v).toLowerCase().replace(/\s+/g, ' ');

/** "Retired — last legal on 21/09/2025", or that it was never a slab. */
function whyIllegal(slabs: GstSlabWindow[], rate: number): string {
  const ended = slabs
    .filter((s) => Math.abs(s.ratePercent - rate) < 0.005 && s.effectiveTo != null)
    .map((s) => s.effectiveTo as Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return ended ? `Retired — last legal on ${ddmmyyyy(ended.toISOString().slice(0, 10))}` : 'Not a GST rate';
}

const DRUG_SELECT = {
  id: true, drugName: true, strength: true, manufacturer: true, category: true,
  hsnCode: true, taxPercent: true, gstTreatment: true, gtin: true, casePackGtin: true,
  manufacturerCode: true, isActive: true, ...UNIT_SELECT,
} as const;

async function loadDrugs(tenantId: string) {
  return prisma.drugFormulary.findMany({
    where: { tenantId },
    select: DRUG_SELECT,
    orderBy: { drugName: 'asc' },
  });
}
type DrugRow = Awaited<ReturnType<typeof loadDrugs>>[number];

async function loadContext(tenantId: string) {
  const [slabs, hsnRows, defaults, drugs] = await Promise.all([
    loadGstSlabs(),
    getHsnGstRows(),
    prisma.gstCategoryDefault.findMany({ where: { isActive: true } }),
    loadDrugs(tenantId),
  ]);
  return { slabs, hsnRows, defaults, drugs };
}
type Ctx = Awaited<ReturnType<typeof loadContext>>;

/**
 * The rate a counter sale of this item resolves to, and what set it — the same
 * precedence the resolver uses (own rate, HSN default, category default), but
 * without the hospital's registration, so the list is the same before and after
 * a hospital starts charging GST.
 */
function masterRate(drug: DrugRow, ctx: Ctx): { rate: number; source: string; matchedCode: string | null } {
  const own = itemTaxContext(drug);
  if (own.itemTreatment) {
    return {
      rate: own.itemTreatment === 'taxable' ? Number(own.itemRatePercent ?? 0) : 0,
      source: 'item_master',
      matchedCode: null,
    };
  }
  const hsn = drug.hsnCode ? matchHsnGst(drug.hsnCode, ctx.hsnRows) : null;
  if (hsn) {
    return { rate: hsn.treatment === 'taxable' ? hsn.gstRate : 0, source: 'hsn_master', matchedCode: hsn.matchedCode };
  }
  const kind = supplyKindForInventoryCategory(drug.category);
  const d = ctx.defaults.find((x) => x.supplyKind === kind);
  return { rate: d && d.treatment === 'taxable' ? Number(d.ratePercent) : 0, source: 'category_default', matchedCode: null };
}

async function stockByDrug(tenantId: string, drugIds: string[]): Promise<Map<string, number>> {
  if (!drugIds.length) return new Map();
  const rows = await prisma.drugBatch.groupBy({
    by: ['drugId'],
    where: { tenantId, drugId: { in: drugIds } },
    _sum: { quantityInStock: true },
  });
  return new Map(rows.map((r) => [r.drugId, Number(r._sum?.quantityInStock ?? 0)]));
}

// ── The list ────────────────────────────────────────────────────────────────

export async function listRetiredGstRates(tenantId: string, roles: string[]) {
  assertGstRateEditor(roles);
  const ctx = await loadContext(tenantId);
  const today = todayIst();
  const legal = slabsOn(ctx.slabs, asDay(today));

  const hits = ctx.drugs
    .map((drug) => ({ drug, at: masterRate(drug, ctx) }))
    .filter(({ at }) => at.rate > 0 && !isLegalSlabRate(ctx.slabs, at.rate, asDay(today)));
  const stock = await stockByDrug(tenantId, hits.map((h) => h.drug.id));

  const items = hits.map(({ drug, at }) => {
    const onHand = stock.get(drug.id) ?? 0;
    return {
      drugId: drug.id,
      drugName: drug.drugName,
      strength: drug.strength,
      manufacturer: drug.manufacturer,
      hsnCode: drug.hsnCode,
      ratePercent: at.rate,
      /** 'item_master' | 'hsn_master' | 'category_default'. */
      source: at.source,
      sourceLabel:
        at.source === 'item_master'
          ? 'Set on the medicine'
          : at.source === 'hsn_master'
            ? `HSN default (${at.matchedCode ?? drug.hsnCode})`
            : 'Category default',
      /** An HSN / category default is platform data — the super admin corrects it. */
      fixedBy:
        at.source === 'item_master'
          ? 'Set a rate on the medicine, or use the rate list'
          : 'Set a rate on the medicine here, or ask the platform admin to correct the default',
      reason: whyIllegal(ctx.slabs, at.rate),
      stockOnHand: onHand,
      stockText: formatDrugQty(onHand, drug),
      isActive: drug.isActive,
    };
  });
  // What is on the shelf cannot be sold today, so it comes first.
  items.sort((a, b) => Number(b.stockOnHand > 0) - Number(a.stockOnHand > 0) || a.drugName.localeCompare(b.drugName));

  return {
    asOf: today,
    allowedRates: legal,
    allowed: describeSlabs(legal),
    /** False when the slab master is empty: then nothing can be judged retired. */
    slabsConfigured: legal.length > 0,
    items,
    total: items.length,
    inStock: items.filter((i) => i.stockOnHand > 0).length,
  };
}

// ── The rate-list import ────────────────────────────────────────────────────

export const GST_RATE_LIST_COLUMNS = ['Drug code', 'Drug name', 'HSN', 'GST %', 'Effective from'] as const;

export interface RateListRow {
  rowNumber: number;
  drugCode?: string | null;
  drugName?: string | null;
  hsnCode?: string | null;
  gstPercent?: string | number | null;
  effectiveFrom?: string | null;
}

export type RateListStatus = 'ready' | 'unchanged' | 'not_due' | 'unmatched' | 'error';

export interface RateListChange {
  drugId: string;
  drugName: string;
  strength: string | null;
  hsnCode: string | null;
  currentRate: number | null;
  currentTreatment: string | null;
  /** What the sale resolves to now, and from where. */
  currentSourceLabel: string;
  newRate: number;
  newTreatment: string | null;
  stockText: string;
}

export interface RateListPreviewRow {
  rowNumber: number;
  drugCode: string | null;
  drugName: string | null;
  hsnCode: string | null;
  gstPercent: string | null;
  effectiveFrom: string | null;
  status: RateListStatus;
  message: string;
  matchedBy: 'code' | 'name' | 'hsn' | null;
  changes: RateListChange[];
}

/** "5", "5%", "Nil" → a number; anything else → null. */
export function parseRate(v: unknown): number | null {
  const s = clean(v).replace(/%$/, '').trim();
  if (!s) return null;
  if (/^nil$/i.test(s)) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= 100 ? n : null;
}

/** ISO, dd/mm/yyyy or dd-mm-yyyy → "yyyy-mm-dd"; blank → today; bad → null. */
export function parseEffectiveFrom(v: unknown): string | null {
  const s = clean(v);
  if (!s) return todayIst();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const ind = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : ind ? [ind[3], ind[2], ind[1]] : ['', '', ''];
  if (!y) return null;
  const ymd = `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  const date = asDay(ymd);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === ymd ? ymd : null;
}

const FUTURE_MESSAGE = (ymd: string) =>
  `Starts on ${ddmmyyyy(ymd)}. The medicine master holds one current rate with no start date, so a future rate ` +
  'cannot be stored ahead of time. Import this row again on or after that date.';

/** The classification a new rate implies, or why it cannot be applied. */
function nextTreatment(drug: DrugRow, rate: number): { treatment: string | null; error?: string } {
  const current = drug.gstTreatment ?? null;
  if (rate > 0) {
    if (current && current !== 'taxable') {
      return {
        treatment: current,
        error: `${drug.drugName} is marked ${current.replace(/_/g, ' ')}. Change its tax treatment on the medicine first.`,
      };
    }
    return { treatment: current };
  }
  // A bare 0 says nothing (the HSN default would decide), so a nil rate is
  // recorded as what it is. An item already exempt stays exempt.
  return { treatment: current && current !== 'taxable' ? current : 'nil_rated' };
}

const sameRate = (a: unknown, b: number) => a != null && Math.abs(Number(a) - b) < 0.005;

export async function previewGstRateList(tenantId: string, roles: string[], input: { rows: RateListRow[] }) {
  assertGstRateEditor(roles);
  const ctx = await loadContext(tenantId);
  const today = todayIst();
  const legalToday = slabsOn(ctx.slabs, asDay(today));
  const stock = await stockByDrug(tenantId, ctx.drugs.map((d) => d.id));

  // Lookups. A key held by more than one medicine is ambiguous, never guessed.
  const add = (m: Map<string, DrugRow[]>, key: string, d: DrugRow) => {
    if (!key) return;
    const list = m.get(key) ?? [];
    if (!list.some((x) => x.id === d.id)) list.push(d);
    m.set(key, list);
  };
  const byCode = new Map<string, DrugRow[]>();
  const byName = new Map<string, DrugRow[]>();
  for (const d of ctx.drugs) {
    add(byCode, d.id.toLowerCase(), d);
    add(byCode, norm(d.manufacturerCode), d);
    for (const g of [...gtinVariants(d.gtin), ...gtinVariants(d.casePackGtin)]) add(byCode, g.toLowerCase(), d);
    add(byName, norm(d.drugName), d);
    if (d.strength) add(byName, norm(`${d.drugName} ${d.strength}`), d);
  }

  const changeFor = (d: DrugRow, rate: number, treatment: string | null): RateListChange => {
    const at = masterRate(d, ctx);
    return {
      drugId: d.id,
      drugName: d.drugName,
      strength: d.strength,
      hsnCode: d.hsnCode,
      currentRate: d.taxPercent == null ? null : Number(d.taxPercent),
      currentTreatment: d.gstTreatment ?? null,
      currentSourceLabel: `${at.rate}% from ${rateSourceLabel(at.source, at.matchedCode ?? d.hsnCode)}`,
      newRate: rate,
      newTreatment: treatment,
      stockText: formatDrugQty(stock.get(d.id) ?? 0, d),
    };
  };
  const candidates = (list: DrugRow[]) =>
    list.slice(0, 4).map((d) => [d.drugName, d.strength, d.manufacturer && `(${d.manufacturer})`].filter(Boolean).join(' ')).join('; ');

  type Work = { out: RateListPreviewRow; rate: number; from: string; hsn: string };
  const hsnWork: Work[] = [];
  // Which row claimed a medicine, so two rows cannot set two different rates.
  const claimed = new Map<string, { rowNumber: number; rate: number }>();

  /** Decide one medicine for one row. Returns its change, or why not. */
  const decide = (d: DrugRow, rate: number): { change?: RateListChange; unchanged?: boolean; error?: string } => {
    const t = nextTreatment(d, rate);
    if (t.error) return { error: t.error };
    const same = sameRate(d.taxPercent, rate) && (t.treatment ?? null) === (d.gstTreatment ?? null);
    // A medicine already at 0% by its own exempt/nil treatment is unchanged too.
    const alreadyNil = rate === 0 && d.gstTreatment != null && d.gstTreatment !== 'taxable';
    if (same || alreadyNil) return { unchanged: true };
    return { change: changeFor(d, rate, t.treatment) };
  };

  const rows: RateListPreviewRow[] = input.rows.map((r) => {
    const out: RateListPreviewRow = {
      rowNumber: r.rowNumber,
      drugCode: clean(r.drugCode) || null,
      drugName: clean(r.drugName) || null,
      hsnCode: clean(r.hsnCode) || null,
      gstPercent: clean(r.gstPercent) || null,
      effectiveFrom: clean(r.effectiveFrom) || null,
      status: 'error',
      message: '',
      matchedBy: null,
      changes: [],
    };
    const hsn = normalizeHsn(out.hsnCode);
    if (!out.drugCode && !out.drugName && !hsn) {
      out.message = 'Give a drug code, a drug name or an HSN code.';
      return out;
    }
    const rate = parseRate(r.gstPercent);
    if (rate == null) {
      out.message = out.gstPercent ? `"${out.gstPercent}" is not a GST %.` : 'GST % is blank.';
      return out;
    }
    const from = parseEffectiveFrom(r.effectiveFrom);
    if (!from) {
      out.message = `"${out.effectiveFrom}" is not a date. Use dd/mm/yyyy.`;
      return out;
    }
    for (const day of from < today ? [from, today] : [from]) {
      if (!isLegalSlabRate(ctx.slabs, rate, asDay(day))) {
        // A past start date is judged on that date AND today: the rate written
        // is the one every sale uses from now on.
        out.message =
          `${rate}% is not a legal GST rate on ${ddmmyyyy(day)}. ` +
          `Allowed: ${describeSlabs(slabsOn(ctx.slabs, asDay(day)))}.`;
        return out;
      }
    }

    // ── A named medicine ──
    if (out.drugCode || out.drugName) {
      let found: DrugRow[] = [];
      if (out.drugCode) {
        found = byCode.get(norm(out.drugCode)) ?? [];
        // A GTIN in its 13- or 14-digit form. Digits only: "ABC12" is not GTIN 12.
        if (!found.length && /^\d{8,14}$/.test(out.drugCode)) {
          found = gtinVariants(out.drugCode).flatMap((g) => byCode.get(g) ?? []);
        }
        found = found.filter((d, i) => found.findIndex((x) => x.id === d.id) === i);
        if (found.length) out.matchedBy = 'code';
      }
      if (!found.length && out.drugName) {
        found = byName.get(norm(out.drugName)) ?? [];
        if (found.length) out.matchedBy = 'name';
      }
      if (!found.length) {
        out.status = 'unmatched';
        out.message = `No medicine in this hospital's list matches ${out.drugCode ? `code "${out.drugCode}"` : ''}${
          out.drugCode && out.drugName ? ' or ' : ''
        }${out.drugName ? `name "${out.drugName}"` : ''}.`;
        return out;
      }
      if (found.length > 1) {
        out.status = 'unmatched';
        out.message = `${found.length} medicines match: ${candidates(found)}. Give the drug code (GTIN) to say which.`;
        return out;
      }
      const d = found[0]!;
      const own = normalizeHsn(d.hsnCode);
      if (hsn && own && !own.startsWith(hsn) && !hsn.startsWith(own)) {
        out.message = `${d.drugName} has HSN ${d.hsnCode}, the file says ${out.hsnCode}. Correct one of them first.`;
        return out;
      }
      const prior = claimed.get(d.id);
      if (prior) {
        out.message =
          prior.rate === rate
            ? `Same medicine as row ${prior.rowNumber}.`
            : `Row ${prior.rowNumber} sets ${d.drugName} to ${prior.rate}%. Remove one of the two rows.`;
        out.status = prior.rate === rate ? 'unchanged' : 'error';
        return out;
      }
      claimed.set(d.id, { rowNumber: r.rowNumber, rate });
      if (from > today) {
        out.status = 'not_due';
        out.message = FUTURE_MESSAGE(from);
        return out;
      }
      const verdict = decide(d, rate);
      if (verdict.error) out.message = verdict.error;
      else if (verdict.unchanged) {
        out.status = 'unchanged';
        out.message = `${d.drugName} is already at ${rate}%.`;
      } else {
        out.status = 'ready';
        out.message = `${verdict.change!.currentSourceLabel} → ${rate}%${rate === 0 ? ' (nil-rated)' : ''}`;
        out.changes = [verdict.change!];
      }
      return out;
    }

    hsnWork.push({ out, rate, from, hsn });
    return out;
  });

  // ── HSN rows, after every named row, longest code first ──
  // An HSN row only reaches medicines that are ON a retired rate. A medicine
  // the hospital deliberately keeps at another legal rate under the same
  // heading (18% with a reason) is never moved by a heading row.
  hsnWork.sort((a, b) => b.hsn.length - a.hsn.length || a.out.rowNumber - b.out.rowNumber);
  const hsnSeen = new Map<string, { rowNumber: number; rate: number }>();
  for (const w of hsnWork) {
    const { out, rate, from, hsn } = w;
    const prior = hsnSeen.get(hsn);
    if (prior) {
      out.status = prior.rate === rate ? 'unchanged' : 'error';
      out.message =
        prior.rate === rate ? `Same HSN as row ${prior.rowNumber}.` : `Row ${prior.rowNumber} sets HSN ${hsn} to ${prior.rate}%. Remove one of the two rows.`;
      continue;
    }
    hsnSeen.set(hsn, { rowNumber: out.rowNumber, rate });
    const under = ctx.drugs.filter((d) => {
      if (!normalizeHsn(d.hsnCode).startsWith(hsn) || claimed.has(d.id)) return false;
      const at = masterRate(d, ctx);
      return at.rate > 0 && !isLegalSlabRate(ctx.slabs, at.rate, asDay(today));
    });
    if (!under.length) {
      out.status = 'unmatched';
      out.message = `No medicine under HSN ${hsn} is on a retired rate (or each has its own row in this file).`;
      continue;
    }
    out.matchedBy = 'hsn';
    under.forEach((d) => claimed.set(d.id, { rowNumber: out.rowNumber, rate }));
    if (from > today) {
      out.status = 'not_due';
      out.message = FUTURE_MESSAGE(from);
      continue;
    }
    const errors: string[] = [];
    for (const d of under) {
      const v = decide(d, rate);
      if (v.error) errors.push(v.error);
      else if (v.change) out.changes.push(v.change);
    }
    out.status = out.changes.length ? 'ready' : errors.length ? 'error' : 'unchanged';
    out.message = [
      out.changes.length ? `${out.changes.length} medicine(s) on a retired rate → ${rate}%${rate === 0 ? ' (nil-rated)' : ''}` : null,
      ...errors,
    ].filter(Boolean).join(' ');
  }

  const count = (s: RateListStatus) => rows.filter((r) => r.status === s).length;
  const changing = new Set(rows.flatMap((r) => r.changes.map((c) => c.drugId)));
  // Still on a retired rate after this file would be applied.
  const remaining = ctx.drugs
    .filter((d) => {
      const at = masterRate(d, ctx);
      return at.rate > 0 && !isLegalSlabRate(ctx.slabs, at.rate, asDay(today)) && !changing.has(d.id);
    })
    .map((d) => ({ drugId: d.id, drugName: d.drugName, hsnCode: d.hsnCode, ratePercent: masterRate(d, ctx).rate }));

  return {
    today,
    allowed: describeSlabs(legalToday),
    rows,
    summary: {
      total: rows.length,
      ready: count('ready'),
      medicines: changing.size,
      unchanged: count('unchanged'),
      notDue: count('not_due'),
      unmatched: count('unmatched'),
      errors: count('error'),
    },
    /** Medicines on a retired rate that this file does not cover. */
    notCovered: remaining,
    effectiveDateNote:
      'A medicine holds one current rate. A row with a past or today date changes the rate for every sale from now; ' +
      'a row with a future date is not stored. Bills already issued keep their rate.',
  };
}

export interface ApplyRateListInput {
  reason: string;
  rows: Array<{
    drugId: string;
    gstPercent: number;
    /** The rate the preview showed — the row is skipped if it moved since. */
    expectedRate: number | null;
    effectiveFrom?: string | null;
    rowNumber?: number | null;
  }>;
}

export async function applyGstRateList(
  tenantId: string,
  userId: string,
  roles: string[],
  input: ApplyRateListInput,
) {
  assertGstRateEditor(roles);
  const reason = clean(input.reason);
  if (!reason) throw AppError.badRequest('Give the reason for the rate change (for example the circular or list it comes from).');
  if (!input.rows.length) throw AppError.badRequest('Choose at least one row to apply.');

  const slabs = await loadGstSlabs();
  const today = todayIst();
  const applied: Array<{ drugId: string; drugName: string; from: number | null; to: number }> = [];
  const skipped: Array<{ drugId: string; drugName: string | null; rowNumber: number | null; reason: string }> = [];
  const seen = new Set<string>();

  for (const row of input.rows) {
    const skip = (why: string, name: string | null = null) =>
      skipped.push({ drugId: row.drugId, drugName: name, rowNumber: row.rowNumber ?? null, reason: why });
    if (seen.has(row.drugId)) { skip('Listed twice.'); continue; }
    seen.add(row.drugId);

    const drug = await prisma.drugFormulary.findFirst({ where: { id: row.drugId, tenantId }, select: DRUG_SELECT });
    if (!drug) { skip('No longer in the medicine list.'); continue; }
    const rate = parseRate(row.gstPercent);
    const from = parseEffectiveFrom(row.effectiveFrom);
    if (rate == null) { skip('Not a GST %.', drug.drugName); continue; }
    if (!from) { skip('Not a valid effective date.', drug.drugName); continue; }
    if (from > today) { skip(FUTURE_MESSAGE(from), drug.drugName); continue; }
    const badDay = [from, today].find((d) => !isLegalSlabRate(slabs, rate, asDay(d)));
    if (badDay) {
      skip(`${rate}% is not a legal GST rate on ${ddmmyyyy(badDay)}. Allowed: ${describeSlabs(slabsOn(slabs, asDay(badDay)))}.`, drug.drugName);
      continue;
    }
    const current = drug.taxPercent == null ? null : Number(drug.taxPercent);
    if ((current ?? null) !== (row.expectedRate ?? null)) {
      skip(`Changed to ${current == null ? 'no rate' : `${current}%`} since the preview. Preview again.`, drug.drugName);
      continue;
    }
    const t = nextTreatment(drug, rate);
    if (t.error) { skip(t.error, drug.drugName); continue; }

    const movedTreatment = (t.treatment ?? null) !== (drug.gstTreatment ?? null);
    // Conditional on the rate it was previewed at, so a concurrent edit wins.
    const res = await prisma.drugFormulary.updateMany({
      where: { id: drug.id, tenantId, taxPercent: drug.taxPercent },
      data: {
        taxPercent: rate,
        ...(movedTreatment ? { gstTreatment: t.treatment, gstTreatmentSource: 'manual' } : {}),
        // Why the rate differs from HSN is kept on the medicine (G-2).
        gstRateReason: reason.slice(0, 255),
      },
    });
    if (res.count !== 1) { skip('Edited by somebody else just now. Preview again.', drug.drugName); continue; }

    const fullReason = `${reason} (rate list, effective from ${ddmmyyyy(from)})`;
    await recordItemRateChange({
      tenantId, itemType: 'drug', itemId: drug.id, itemName: drug.drugName,
      before: { rate: current, code: drug.hsnCode, treatment: drug.gstTreatment ?? null },
      after: { rate, code: drug.hsnCode, treatment: t.treatment },
      reason: fullReason, changedBy: userId,
    });
    await writeAudit({
      tenantId, userId, action: 'update', entityType: 'drug_formulary', entityId: drug.id,
      description: `GST rate of ${drug.drugName} changed by rate list: ${current == null ? 'not set' : `${current}%`} → ${rate}%`,
      reason: fullReason,
      oldValues: { taxPercent: current, gstTreatment: drug.gstTreatment ?? null },
      newValues: { taxPercent: rate, gstTreatment: t.treatment, effectiveFrom: from, rowNumber: row.rowNumber ?? null },
    });
    applied.push({ drugId: drug.id, drugName: drug.drugName, from: current, to: rate });
  }

  logger.info({ tenantId, userId, applied: applied.length, skipped: skipped.length }, 'GST rate list applied');
  return { applied, skipped, appliedCount: applied.length, skippedCount: skipped.length };
}
