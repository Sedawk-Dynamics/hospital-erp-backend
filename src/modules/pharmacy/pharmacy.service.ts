import { randomUUID } from 'crypto';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { isEmergencyMrn } from '../../shared/emergency';
import { resolvePackSize, inferLooseUnitLabel } from '../drug-master/drug-master.dataset';
import { resolveHsnGst, getHsnGstRows, matchHsnGst } from '../drug-master/drug-master.service';
import { getInventorySettingsSafe } from '../inventory/inventory.settings.service';
import { notifyInventoryRecipients, hasOpenInventoryAlert } from '../inventory/inventory.notify';
import {
  createItem as createInventoryItem,
  createStockTransaction as createInventoryStockTransaction,
} from '../inventory/inventory.service';
import { safePharmacyAudit } from './pharmacy.audit';
import {
  scoreMatch,
  normalizeDrugName,
  MATCH_SUGGEST_THRESHOLD,
  MATCH_BLOCK_THRESHOLD,
} from './pharmacy.matching';
import { parseGs1, makeInternalBarcode, isInternalBarcode, gtinVariants } from './pharmacy.barcode';
import type {
  CreateFormularyInput,
  UpdateFormularyInput,
  ImportFormularyInput,
  GetFormularyQuery,
  CreateBatchInput,
  UpdateBatchInput,
  GetBatchesQuery,
  GetExpiringBatchesQuery,
  CreateDispenseInput,
  CreatePharmacySaleInput,
  GetPharmacySalesQuery,
  CancelSaleInput,
  GetDispenseQuery,
  CreateReturnInput,
  GetReturnsQuery,
  ProcessReturnInput,
  RecallBatchInput,
  GetRecalledItemsQuery,
  GetGstReportQuery,
  GetStockLedgerQuery,
  CommitInwardInput,
  StockTakeReconcileInput,
} from './pharmacy.validation';

// ============================================================
// Role guard — master/stock management is pharmacy_admin only
// ============================================================
// pharmacist holds pharmacy:create/update so it can DISPENSE and take patient
// RETURNS, but those same perms must not let it manage the formulary, drug
// categories or stock batches. This service-level guard enforces the 2-role
// split (mirrors lab's assertCanCloneTemplates). admin/super_admin always pass.
// inventory_manager is included because the drug-stock pages (formulary,
// batches, catalog, GST) now live under the Inventory module and that role
// owns inventory management across drugs + consumables.
const PHARMACY_ADMIN_ROLES = new Set(['super_admin', 'admin', 'pharmacy_admin', 'inventory_manager']);

function assertPharmacyAdmin(roles: string[], action = 'manage pharmacy master data'): void {
  if (!roles.some((r) => PHARMACY_ADMIN_ROLES.has(r))) {
    throw AppError.forbidden(`Only a pharmacy admin can ${action}.`);
  }
}

// A batch counts as expired if explicitly flagged OR its expiry date has
// already passed. The live date check means a freshly-expired batch is blocked
// from dispensing/sale even before the maintenance sweep flips `isExpired`
// (matches flagExpiredBatches' "expiryDate < start-of-today" semantics).
function isBatchExpired(batch: { isExpired: boolean; expiryDate: Date | string }): boolean {
  if (batch.isExpired) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(batch.expiryDate) < today;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * G2: derive the purchase economics for a batch from its stored fields so the
 * UI/reports show them consistently. Purchase rate is gross (per unit); net is
 * rate after the purchase discount; landing cost folds in GST; margin compares
 * the selling price against the per-unit landing cost. Free units count toward
 * stock but not toward the purchase value (they dilute the landing cost).
 */
export function batchPurchaseEconomics(b: {
  mrp?: unknown;
  purchasePrice?: unknown;
  purchaseDiscountPercent?: unknown;
  gstPercent?: unknown;
  sellingPrice?: unknown;
  quantityReceived?: number;
  freeQuantity?: number | null;
}) {
  const numOrNull = (v: unknown): number | null =>
    v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  const rate = numOrNull(b.purchasePrice);
  const disc = numOrNull(b.purchaseDiscountPercent) ?? 0;
  const gst = numOrNull(b.gstPercent);
  const sell = numOrNull(b.sellingPrice);
  const totalQty = b.quantityReceived ?? 0;
  const paidQty = Math.max(0, totalQty - (b.freeQuantity ?? 0));

  const netRate = rate != null ? r2(rate * (1 - disc / 100)) : null;
  const netPurchaseValue = netRate != null ? r2(netRate * paidQty) : null;
  const taxAmount =
    netPurchaseValue != null && gst != null ? r2(netPurchaseValue * (gst / 100)) : null;
  const landingTotal =
    netPurchaseValue != null ? r2(netPurchaseValue + (taxAmount ?? 0)) : null;
  // Spread landing cost over ALL received units (incl. free) → true unit cost.
  const landingPerUnit = landingTotal != null && totalQty > 0 ? r2(landingTotal / totalQty) : null;
  const marginPerUnit = sell != null && landingPerUnit != null ? r2(sell - landingPerUnit) : null;
  const marginPercent =
    marginPerUnit != null && landingPerUnit ? r2((marginPerUnit / landingPerUnit) * 100) : null;

  return { netRate, netPurchaseValue, taxAmount, landingPerUnit, marginPerUnit, marginPercent };
}

// ============================================================
// Formulary
// ============================================================

/**
 * Find existing formulary rows that look like the same drug as `params` (G1 —
 * fuzzy inward matching). Pre-filters candidates in SQL by the first name token
 * / prefix / generic / manufacturer so we never score the whole formulary, then
 * blends a character + token similarity in JS (see pharmacy.matching). Returns
 * the top suggestions above MATCH_SUGGEST_THRESHOLD with a live stock rollup so
 * the UI can show a side-by-side "existing vs incoming" comparison.
 */
export async function findFormularyMatches(
  tenantId: string,
  params: {
    name: string;
    genericName?: string | null;
    manufacturer?: string | null;
    strength?: string | null;
    dosageForm?: string | null;
    excludeId?: string;
  },
) {
  const name = params.name?.trim();
  if (!name) return { matches: [] as any[] };

  const norm = normalizeDrugName(name);
  const firstToken = norm.split(' ').filter(Boolean)[0] || name.trim().toLowerCase();
  const prefix = firstToken.slice(0, 4);
  const genericFirst = params.genericName
    ? normalizeDrugName(params.genericName).split(' ').filter(Boolean)[0]
    : '';

  const or: any[] = [];
  if (firstToken) or.push({ drugName: { contains: firstToken, mode: 'insensitive' } });
  if (prefix && prefix !== firstToken) or.push({ drugName: { startsWith: prefix, mode: 'insensitive' } });
  if (genericFirst) or.push({ genericName: { contains: genericFirst, mode: 'insensitive' } });
  if (params.manufacturer) or.push({ manufacturer: { contains: params.manufacturer, mode: 'insensitive' } });

  const where: any = { tenantId, isActive: true };
  if (params.excludeId) where.id = { not: params.excludeId };
  if (or.length) where.OR = or;

  const candidates = await prisma.drugFormulary.findMany({
    where,
    take: 500,
    select: {
      id: true,
      drugName: true,
      genericName: true,
      manufacturer: true,
      dosageForm: true,
      strength: true,
      packSize: true,
      price: true,
      drugMasterId: true,
      drugBatches: {
        where: { isExpired: false, isRecalled: false, quantityInStock: { gt: 0 } },
        select: { quantityInStock: true },
      },
    },
  });

  const incoming = {
    drugName: name,
    genericName: params.genericName,
    manufacturer: params.manufacturer,
    strength: params.strength,
    dosageForm: params.dosageForm,
  };
  const matches = candidates
    .map((c) => {
      const { drugBatches, ...rest } = c;
      return {
        ...rest,
        totalStock: drugBatches.reduce((s, b) => s + b.quantityInStock, 0),
        score: scoreMatch(incoming, c as any),
      };
    })
    .filter((c) => c.score >= MATCH_SUGGEST_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  return { matches };
}

// Catalog suggestions are a fallback, so we surface "most similar" a bit more
// generously than formulary near-duplicates (which gate a hard block).
const CATALOG_SUGGEST_THRESHOLD = 45;

/**
 * When the hospital's own formulary has no confident match for an incoming line,
 * fall back to the platform-wide DrugMaster catalog (lakhs of Indian drugs) and
 * surface the MOST SIMILAR entries. Picking one seeds/import the formulary row
 * from the catalog and stocks it — so OCR / inward never dead-ends on "create
 * from blank" when a near-identical drug is one click away in the catalog.
 *
 * Pre-filters in SQL by the first name token (prefix index + denormalised
 * searchTokens) so we never scan the whole 254K-row catalog, then blends the
 * same character + token similarity used for the formulary.
 */
export async function findDrugMasterMatches(
  params: {
    name: string;
    genericName?: string | null;
    manufacturer?: string | null;
    strength?: string | null;
    dosageForm?: string | null;
  },
  limit = 5,
) {
  const name = params.name?.trim();
  if (!name) return [] as any[];

  const norm = normalizeDrugName(name);
  const firstToken = norm.split(' ').filter(Boolean)[0] || name.trim().toLowerCase();
  const prefix = firstToken.slice(0, 4);
  const genericFirst = params.genericName
    ? normalizeDrugName(params.genericName).split(' ').filter(Boolean)[0]
    : '';

  const or: any[] = [];
  if (prefix) or.push({ name: { startsWith: prefix, mode: 'insensitive' } }); // uses @@index([name])
  if (firstToken) or.push({ searchTokens: { contains: firstToken, mode: 'insensitive' } });
  if (genericFirst) or.push({ genericName: { contains: genericFirst, mode: 'insensitive' } });
  if (!or.length) return [];

  const rows = await prisma.drugMaster.findMany({
    where: { OR: or },
    take: 400,
    select: {
      id: true, name: true, genericName: true, manufacturer: true,
      dosageForm: true, strength: true, packSize: true, hsnCode: true, gtin: true,
    },
  });

  const incoming = {
    drugName: name,
    genericName: params.genericName,
    manufacturer: params.manufacturer,
    strength: params.strength,
    dosageForm: params.dosageForm,
  };
  return rows
    .map((m) => ({
      // No formulary row yet — drugMasterId + source tell the UI/commit to
      // create-from-catalog rather than map to an existing formulary id.
      id: '',
      drugMasterId: m.id,
      source: 'catalog' as const,
      drugName: m.name,
      genericName: m.genericName,
      manufacturer: m.manufacturer,
      dosageForm: m.dosageForm,
      strength: m.strength,
      packSize: m.packSize,
      hsnCode: m.hsnCode,
      gtin: m.gtin,
      price: null as number | null,
      totalStock: 0,
      score: scoreMatch(incoming, {
        drugName: m.name,
        genericName: m.genericName,
        manufacturer: m.manufacturer,
        strength: m.strength,
        dosageForm: m.dosageForm,
      }),
    }))
    .filter((c) => c.score >= CATALOG_SUGGEST_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// The DosageForm enum only has 8 lowercase values. Inward sources (OCR / CSV /
// distributor text) hand us free-form strings like "Tablet", "INJ", "Suspension"
// — map them to a valid enum (case-insensitive + common synonyms), else 'other',
// so a create never blows up on an unrecognised form. undefined stays undefined.
const DOSAGE_FORM_SYNONYMS: Record<string, string> = {
  tab: 'tablet', tabs: 'tablet', tablets: 'tablet',
  cap: 'capsule', caps: 'capsule', capsules: 'capsule',
  syp: 'syrup', syr: 'syrup', suspension: 'syrup', susp: 'syrup',
  solution: 'syrup', soln: 'syrup', sol: 'syrup', elixir: 'syrup', liquid: 'syrup',
  inj: 'injection', injections: 'injection', vial: 'injection', amp: 'injection', ampoule: 'injection',
  ointment: 'cream', oint: 'cream', gel: 'cream', lotion: 'cream', paste: 'cream',
  drop: 'drops', eyedrops: 'drops', 'eye drops': 'drops',
  rotacap: 'inhaler', respules: 'inhaler', inhalation: 'inhaler', mdi: 'inhaler',
};
const DOSAGE_FORM_VALUES = new Set(['tablet', 'capsule', 'syrup', 'injection', 'cream', 'drops', 'inhaler', 'other']);

export function normalizeDosageForm(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (DOSAGE_FORM_VALUES.has(s)) return s;
  if (DOSAGE_FORM_SYNONYMS[s]) return DOSAGE_FORM_SYNONYMS[s];
  return 'other';
}

export async function createFormularyItem(
  tenantId: string,
  roles: string[],
  data: CreateFormularyInput & { force?: boolean },
) {
  assertPharmacyAdmin(roles, 'add formulary drugs');
  // G1 duplicate guard: unless the user explicitly forced creation, refuse to
  // silently add a new row when a high-confidence near-duplicate already exists
  // (e.g. "Telmac 40 Tab" when "Telmac 40" is on file). The caller gets the
  // suggestions back and re-submits with force=true to create anyway, or maps
  // the inward stock onto the existing drug instead.
  if (!data.force) {
    const { matches } = await findFormularyMatches(tenantId, {
      name: data.drugName,
      genericName: data.genericName,
      manufacturer: data.manufacturer,
      strength: data.strength,
      dosageForm: data.dosageForm,
    });
    if (matches.length && matches[0].score >= MATCH_BLOCK_THRESHOLD) {
      return { status: 'duplicate_suspected' as const, matches };
    }
  }

  const formularyItem = await prisma.drugFormulary.create({
    data: {
      tenantId,
      drugName: data.drugName,
      genericName: data.genericName,
      manufacturer: data.manufacturer,
      // Coerce free-form inward/OCR forms ("Tablet", "INJ", …) to the enum.
      dosageForm: normalizeDosageForm(data.dosageForm) as any,
      strength: data.strength,
      unitOfMeasurement: data.unitOfMeasurement,
      price: data.price,
      packSize: data.packSize,
      looseUnitLabel: data.looseUnitLabel,
      taxPercent: data.taxPercent,
      minStock: (data as any).minStock,
      // Product Resolution Engine identity (carried from the catalog or typed).
      gtin: (data as any).gtin ?? undefined,
      casePackGtin: (data as any).casePackGtin ?? undefined,
      unitsPerCase: (data as any).unitsPerCase ?? undefined,
      hsnCode: (data as any).hsnCode ?? undefined,
      manufacturerCode: (data as any).manufacturerCode ?? undefined,
      // Link to the platform catalog drug when the row was seeded from it.
      drugMasterId: (data as any).drugMasterId ?? undefined,
      indications: data.indications,
      contraindications: data.contraindications,
      isLifeSaving: (data as any).isLifeSaving ?? false,
      isNarcotic: (data as any).isNarcotic ?? false,
      isReimbursable: (data as any).isReimbursable ?? true,
      isActive: data.isActive ?? true,
    },
  });

  logger.info({ tenantId, formularyId: formularyItem.id }, 'Formulary item created');
  void safePharmacyAudit({
    tenantId,
    action: 'create',
    entityType: 'drug_formulary',
    entityId: formularyItem.id,
    description: `Master drug mapped/created: ${formularyItem.drugName}${formularyItem.strength ? ' ' + formularyItem.strength : ''}`,
    newValues: {
      drugName: formularyItem.drugName,
      genericName: formularyItem.genericName,
      manufacturer: formularyItem.manufacturer,
      strength: formularyItem.strength,
      gtin: formularyItem.gtin,
      hsnCode: formularyItem.hsnCode,
      taxPercent: formularyItem.taxPercent,
      price: formularyItem.price,
    },
  });
  return { status: 'created' as const, item: formularyItem };
}

/**
 * Merge a duplicate formulary row (`sourceId`) into the canonical one
 * (`targetId`): repoint all batches, prescription items and returns onto the
 * target, then delete the now-empty source. This is the cure for stock that has
 * already split across two near-duplicate entries ("Telmac 40" + "Telmac 40
 * Tab" each showing 100 → one entry showing 200). DrugBatch has no DB-level
 * (drugId, batchNumber) unique, so repointing never collides.
 */
export async function mergeFormularyItems(
  tenantId: string,
  userId: string,
  roles: string[],
  targetId: string,
  sourceId: string,
) {
  assertPharmacyAdmin(roles, 'merge formulary drugs');
  if (targetId === sourceId) {
    throw AppError.badRequest('Cannot merge a drug into itself');
  }

  const [target, source] = await Promise.all([
    prisma.drugFormulary.findFirst({ where: { id: targetId, tenantId } }),
    prisma.drugFormulary.findFirst({ where: { id: sourceId, tenantId } }),
  ]);
  if (!target) throw AppError.notFound('Target formulary item not found');
  if (!source) throw AppError.notFound('Source formulary item not found');

  const result = await prisma.$transaction(async (tx) => {
    const batches = await tx.drugBatch.updateMany({
      where: { drugId: sourceId, tenantId },
      data: { drugId: targetId },
    });
    const rxItems = await tx.prescriptionItem.updateMany({
      where: { drugId: sourceId },
      data: { drugId: targetId },
    });
    const returns = await tx.drugReturn.updateMany({
      where: { drugId: sourceId, tenantId },
      data: { drugId: targetId },
    });
    await tx.drugFormulary.delete({ where: { id: sourceId } });
    return {
      batchesMoved: batches.count,
      prescriptionItemsMoved: rxItems.count,
      returnsMoved: returns.count,
    };
  });

  await safePharmacyAudit({
    tenantId,
    userId,
    action: 'merge',
    entityType: 'drug_formulary',
    entityId: targetId,
    description: `Merged duplicate drug "${source.drugName}" into "${target.drugName}"`,
    oldValues: { sourceId, sourceName: source.drugName },
    newValues: { targetId, targetName: target.drugName, ...result },
  });

  logger.info({ tenantId, targetId, sourceId, ...result }, 'Formulary items merged');
  return { target, ...result };
}

// ============================================================
// G1 — Bulk stock inward (CSV / OCR / manual multi-row)
// ============================================================
// The single-drug add path (createFormularyItem) already blocks a near-duplicate
// when one drug is typed at a time. But the field pain is at BULK inward: a
// distributor invoice — keyed in by hand, photographed for OCR, or imported as a
// CSV — carries 20-40 lines whose names drift from the formulary ("Telmac 40 Tab"
// vs the on-file "Telmac 40"), and every mismatch silently creates a new row that
// splits the stock. These two functions drive a review-then-commit flow:
//   1. matchInwardLines scores every incoming line against the formulary and
//      recommends map-vs-create (so the UI can show a side-by-side comparison).
//   2. commitInward applies the user's per-line decision — reuse an existing drug
//      (no split) or create a new one — and posts the received stock as batches.
// Both reuse the same matching engine and batch path as the single-add flow, so
// behaviour is identical; only the fan-out is new.

export interface InwardLineInput {
  drugName: string;
  genericName?: string | null;
  manufacturer?: string | null;
  strength?: string | null;
  dosageForm?: string | null;
  // Product Resolution Engine inputs: the GTIN scanned/parsed off the invoice and
  // the supplier the goods came from (drives the learned distributor mapping).
  gtin?: string | null;
  supplierId?: string | null;
  // A line can be a medicine (default) or any other stock item; items are matched
  // against inventory_items rather than the formulary.
  kind?: 'drug' | 'item' | null;
  category?: string | null;
}

export type InwardRecommendation = 'map' | 'review' | 'create';

/** How an inward line was resolved to a formulary drug, highest-confidence first. */
export type ResolveVia = 'gtin' | 'similarity' | 'none';

/**
 * Product Resolution Engine (design-doc Section 2). Resolve a single incoming
 * inward line to a formulary drug using the documented confidence hierarchy:
 *   1. GTIN match (consumer GTIN-13 or outer-case GTIN-14) — highest confidence.
 *   2. Multi-factor similarity — the existing fuzzy engine (name/strength/form/…).
 *   3. None — nothing close; a new drug is expected (goes to the review queue).
 * A GTIN-14 case hit also returns caseMultiplier = unitsPerCase so a scanned outer
 * box can be translated into N consumer units upstream.
 */
export async function resolveInwardLine(
  tenantId: string,
  line: InwardLineInput,
) {
  // Tier 1 — GTIN (consumer unit or outer case), matched in either 13/14-digit form.
  const gtin = line.gtin?.trim();
  if (gtin) {
    const variants = gtinVariants(gtin);
    const byGtin = await prisma.drugFormulary.findFirst({
      where: { tenantId, isActive: true, OR: [{ gtin: { in: variants } }, { casePackGtin: { in: variants } }] },
      select: {
        id: true, drugName: true, genericName: true, manufacturer: true,
        dosageForm: true, strength: true, packSize: true, price: true,
        gtin: true, casePackGtin: true, unitsPerCase: true,
      },
    });
    if (byGtin) {
      const isCase = byGtin.casePackGtin != null && variants.includes(byGtin.casePackGtin)
        && !(byGtin.gtin != null && variants.includes(byGtin.gtin));
      return {
        resolvedVia: 'gtin' as ResolveVia,
        recommendation: 'map' as InwardRecommendation,
        confidence: 100,
        suggestedFormularyId: byGtin.id,
        caseMultiplier: isCase ? Math.max(1, byGtin.unitsPerCase ?? 1) : 1,
        matches: [{ ...byGtin, totalStock: 0, score: 100 }],
      };
    }
  }

  // Tier 2 — multi-factor similarity against THIS hospital's formulary.
  const { matches: formularyMatches } = await findFormularyMatches(tenantId, {
    name: line.drugName,
    genericName: line.genericName,
    manufacturer: line.manufacturer,
    strength: line.strength,
    dosageForm: line.dosageForm,
  });
  const top = formularyMatches[0];
  let recommendation: InwardRecommendation;
  if (top && top.score >= MATCH_BLOCK_THRESHOLD) recommendation = 'map';
  else if (top && top.score >= MATCH_SUGGEST_THRESHOLD) recommendation = 'review';
  else recommendation = 'create';

  // Tag formulary matches so the UI can tell them apart from catalog suggestions.
  let matches: any[] = formularyMatches.map((m) => ({ ...m, source: 'formulary' as const }));

  // Tier 3 — catalog fallback. When the formulary has no confident map (nothing,
  // or only a weak suggestion), search the platform DrugMaster catalog for the
  // most similar drugs so the user can pick one (→ import + stock) instead of
  // typing a brand-new drug from scratch. Skip catalog drugs already represented
  // by a formulary match.
  if (!top || top.score < MATCH_BLOCK_THRESHOLD) {
    const catalog = await findDrugMasterMatches({
      name: line.drugName,
      genericName: line.genericName,
      manufacturer: line.manufacturer,
      strength: line.strength,
      dosageForm: line.dosageForm,
    });
    const haveMaster = new Set(matches.map((m) => m.drugMasterId).filter(Boolean));
    matches = [...matches, ...catalog.filter((c) => !haveMaster.has(c.drugMasterId))];
  }

  return {
    resolvedVia: (top ? 'similarity' : 'none') as ResolveVia,
    recommendation,
    confidence: top?.score ?? 0,
    suggestedFormularyId: recommendation === 'create' ? null : top?.id ?? null,
    caseMultiplier: 1,
    matches,
  };
}

/**
 * Backfill GTIN / HSN / manufacturer-code onto a formulary drug only where the
 * field is currently empty (the invoice is the source of truth for identity the
 * drug doesn't yet have, but never overwrites a curated value). Best-effort.
 */
async function backfillFormularyIdentity(
  tenantId: string,
  formularyId: string,
  ids: { gtin?: string | null; hsnCode?: string | null; manufacturerCode?: string | null },
) {
  try {
    const f = await prisma.drugFormulary.findFirst({
      where: { id: formularyId, tenantId },
      select: { gtin: true, hsnCode: true, manufacturerCode: true },
    });
    if (!f) return;
    const data: any = {};
    if (ids.gtin?.trim() && !f.gtin) data.gtin = ids.gtin.trim();
    if (ids.hsnCode?.trim() && !f.hsnCode) data.hsnCode = ids.hsnCode.trim();
    if (ids.manufacturerCode?.trim() && !f.manufacturerCode) data.manufacturerCode = ids.manufacturerCode.trim();
    if (Object.keys(data).length) {
      await prisma.drugFormulary.update({ where: { id: formularyId }, data });
    }
  } catch (err) {
    logger.warn({ tenantId, formularyId, err: err instanceof Error ? err.message : err }, 'backfillFormularyIdentity skipped');
  }
}

/**
 * Score each incoming inward line against the existing formulary and recommend an
 * action. 'map' — confidence high enough (≥ BLOCK) that it is almost certainly the
 * same SKU, so default to linking the stock onto the existing drug; 'review' — a
 * plausible match exists (≥ SUGGEST) but a human should confirm the side-by-side;
 * 'create' — nothing looks close, so a new formulary row is expected. The full
 * candidate list (with live stock + score) rides along so the UI can render the
 * "existing vs incoming" comparison without a second round-trip per line.
 */
// Match a non-drug inward line against existing inventory items by name, returned
// in the SAME shape as the formulary matcher so the review UI is uniform.
async function matchInventoryItemLine(tenantId: string, name: string) {
  const q = name.trim();
  const items = q
    ? await prisma.inventoryItem.findMany({
        where: { tenantId, isActive: true, itemName: { contains: q, mode: 'insensitive' } },
        take: 6,
        select: { id: true, itemName: true, category: true, unitOfMeasurement: true, currentStock: true },
      })
    : [];
  const lower = q.toLowerCase();
  const matches = items
    .map((it) => {
      const n = it.itemName.toLowerCase();
      const score = n === lower ? 100 : n.startsWith(lower) ? 90 : 75;
      return {
        id: it.id,
        drugName: it.itemName,
        genericName: null as string | null,
        manufacturer: null as string | null,
        strength: null as string | null,
        totalStock: it.currentStock,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);
  const top = matches[0];
  const recommendation: InwardRecommendation =
    top && top.score >= MATCH_BLOCK_THRESHOLD
      ? 'map'
      : top && top.score >= MATCH_SUGGEST_THRESHOLD
        ? 'review'
        : 'create';
  return {
    matches,
    recommendation,
    confidence: top?.score ?? 0,
    suggestedId: recommendation === 'create' ? null : top?.id ?? null,
  };
}

export async function matchInwardLines(
  tenantId: string,
  lines: InwardLineInput[],
  headerSupplierId?: string | null,
) {
  const results = await Promise.all(
    lines.map(async (line, index) => {
      // Non-drug items resolve against inventory_items, not the formulary.
      if (line.kind === 'item') {
        const m = await matchInventoryItemLine(tenantId, line.drugName);
        return {
          index,
          incoming: line,
          matches: m.matches,
          recommendation: m.recommendation,
          resolvedVia: (m.suggestedId ? 'similarity' : 'none') as ResolveVia,
          confidence: m.confidence,
          caseMultiplier: 1,
          // Reused field — carries the suggested target id (item) for the UI.
          suggestedFormularyId: m.suggestedId,
        };
      }
      // Header supplier falls through to every line (for the distributor mapping
      // lookup) unless the line overrides it.
      const resolved = await resolveInwardLine(tenantId, {
        ...line,
        supplierId: line.supplierId ?? headerSupplierId ?? null,
      });
      return {
        index,
        incoming: line,
        matches: resolved.matches,
        recommendation: resolved.recommendation,
        // How the line resolved (gtin / similarity / none) + the confidence, so
        // the UI can label "GTIN match", "96% — confirm" or "New — review", and a
        // GTIN-14 case multiplier.
        resolvedVia: resolved.resolvedVia,
        confidence: resolved.confidence,
        caseMultiplier: resolved.caseMultiplier,
        // Pre-select the resolved match as the map target unless a brand-new row
        // is expected. The UI can still override (pick a different drug / create).
        suggestedFormularyId: resolved.suggestedFormularyId,
      };
    }),
  );
  return { lines: results };
}

/** How an inward scan was resolved, highest-confidence first. */
export type InwardScanVia = 'formulary_gtin' | 'drugmaster_gtin' | 'gs1' | 'none';

/**
 * Resolve a scan taken at STOCK ENTRY (goods inward) — distinct from the POS
 * resolveScan because here the batch does not exist yet and the drug may not be
 * in the formulary at all. We:
 *   1. parse the GS1 DataMatrix for GTIN + batch + expiry + mfg date;
 *   2. resolve the GTIN against the tenant formulary (→ suggest 'map' onto it);
 *   3. else against the platform DrugMaster catalog (→ pre-fill a 'create');
 *   4. and always hand back the batch/expiry parsed off the pack so the inward
 *      line is filled in with one scan.
 * A GTIN-14 outer-case hit also returns caseMultiplier = unitsPerCase so the
 * scanned case can be expanded to consumer units upstream.
 */
export async function resolveInwardScan(tenantId: string, code: string) {
  const raw = (code ?? '').trim();
  if (!raw) throw AppError.badRequest('No barcode provided');

  const gs1 = parseGs1(raw);
  let gtin = gs1?.gtin;
  // A bare 8–14 digit string with no GS1 AIs is a plain GTIN/EAN.
  if (!gtin && !gs1 && /^\d{8,14}$/.test(raw)) gtin = raw;

  const parsed = {
    gtin: gtin ?? null,
    batchNumber: gs1?.batchNumber ?? null,
    expiryDate: gs1?.expiryDate ?? null,
    manufacturingDate: gs1?.manufactureDate ?? null,
    serial: gs1?.serial ?? null,
  };

  let via: InwardScanVia = gs1 ? 'gs1' : 'none';
  let caseMultiplier = 1;
  let suggestedFormularyId: string | null = null;

  // The DraftLine seed the UI merges into the inward grid.
  const line: Record<string, unknown> = {
    drugName: '',
    genericName: null,
    manufacturer: null,
    strength: null,
    dosageForm: null,
    gtin: gtin ?? null,
    hsnCode: null,
    packSize: null,
    batchNumber: parsed.batchNumber,
    expiryDate: parsed.expiryDate,
    manufacturingDate: parsed.manufacturingDate,
  };

  if (gtin) {
    // Match the GTIN in either its 13- or 14-digit form (a GS1 code is 14-digit,
    // a typed/EAN one usually 13 — the same product).
    const variants = gtinVariants(gtin);
    // Tier 1 — already in this hospital's formulary.
    const f = await prisma.drugFormulary.findFirst({
      where: { tenantId, OR: [{ gtin: { in: variants } }, { casePackGtin: { in: variants } }] },
      select: {
        id: true, drugName: true, genericName: true, manufacturer: true,
        strength: true, dosageForm: true, packSize: true, hsnCode: true,
        gtin: true, casePackGtin: true, unitsPerCase: true,
      },
    });
    if (f) {
      via = 'formulary_gtin';
      suggestedFormularyId = f.id;
      const isCase = f.casePackGtin != null && variants.includes(f.casePackGtin);
      const isConsumer = f.gtin != null && variants.includes(f.gtin);
      caseMultiplier = isCase && !isConsumer ? Math.max(1, f.unitsPerCase ?? 1) : 1;
      Object.assign(line, {
        drugName: f.drugName,
        genericName: f.genericName,
        manufacturer: f.manufacturer,
        strength: f.strength,
        dosageForm: f.dosageForm,
        packSize: f.packSize,
        hsnCode: f.hsnCode,
      });
    } else {
      // Tier 2 — known in the platform catalog; pre-fill so the user can create
      // (or import) the formulary row with correct identity in one step.
      const m = await prisma.drugMaster.findFirst({
        where: { OR: [{ gtin: { in: variants } }, { casePackGtin: { in: variants } }] },
        select: {
          name: true, genericName: true, manufacturer: true, strength: true,
          dosageForm: true, packSize: true, hsnCode: true,
          gtin: true, casePackGtin: true, unitsPerCase: true,
        },
      });
      if (m) {
        via = 'drugmaster_gtin';
        const isCase = m.casePackGtin != null && variants.includes(m.casePackGtin);
        const isConsumer = m.gtin != null && variants.includes(m.gtin);
        caseMultiplier = isCase && !isConsumer ? Math.max(1, m.unitsPerCase ?? 1) : 1;
        Object.assign(line, {
          drugName: m.name,
          genericName: m.genericName,
          manufacturer: m.manufacturer,
          strength: m.strength,
          dosageForm: m.dosageForm,
          packSize: m.packSize,
          hsnCode: m.hsnCode,
        });
      }
    }
  }

  return { resolvedVia: via, gtin: gtin ?? null, caseMultiplier, parsed, suggestedFormularyId, line };
}

/**
 * Remember a barcode → drug mapping. Used by the stock-entry fallback: when a
 * scanned 1D/2D barcode resolves to nothing, the admin picks the medicine and we
 * persist the GTIN so future scans auto-resolve. The consumer GTIN is backfilled
 * onto the formulary drug when empty (so the POS scan also benefits).
 */
export async function attachBarcodeToDrug(
  tenantId: string,
  userId: string,
  data: { gtin: string; drugId: string },
) {
  const gtin = (data.gtin ?? '').trim();
  if (!gtin) throw AppError.badRequest('No barcode provided');
  const drug = await prisma.drugFormulary.findFirst({
    where: { id: data.drugId, tenantId },
    select: { id: true, drugName: true },
  });
  if (!drug) throw AppError.notFound('Drug not found in formulary');

  await backfillFormularyIdentity(tenantId, drug.id, { gtin });
  void safePharmacyAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'drug_formulary',
    entityId: drug.id,
    description: `Barcode ${gtin} mapped to ${drug.drugName}`,
    newValues: { gtin },
  });
  return { ok: true, gtin, drugId: drug.id };
}

/**
 * Apply a reviewed bulk inward. Each line is processed independently so a single
 * bad row (e.g. a clashing batch number) does not void a 40-line invoice — the
 * row is recorded as an error and the rest still post. For a 'map' line the stock
 * is added against the chosen existing drug (the cure for split stock); for a
 * 'create' line a new formulary row is minted (force=true — the user already saw
 * and dismissed the duplicate suggestions) before its batch is received. Header
 * supplier/invoice values fall through to every line unless the line overrides.
 */
export async function commitInward(
  tenantId: string,
  userId: string,
  roles: string[],
  data: CommitInwardInput,
) {
  assertPharmacyAdmin(roles, 'receive stock inward');

  // G2 purchase-side TOTAL-BILL discount. The distributor may discount the whole
  // invoice on top of per-line discounts. We resolve it to ONE effective percent
  // (a flat ₹ amount is converted against the post-line-discount net) and fold it
  // into each line's purchaseDiscountPercent — so net purchase value, landing
  // cost, GST and the purchase reports all reflect both discounts, while MRP and
  // the gross purchase rate stay exactly as printed on the invoice. Apportioning
  // a flat discount by net value yields the SAME percent for every line, so a
  // single uniform bill percent is mathematically exact, not an approximation.
  const paidUnits = (l: CommitInwardInput['lines'][number]) =>
    Math.max(0, (l.quantityReceived ?? 0) - (l.freeQuantity ?? 0));
  const lineNetValue = (l: CommitInwardInput['lines'][number]) =>
    (l.purchasePrice ?? 0) * (1 - (l.purchaseDiscountPercent ?? 0) / 100) * paidUnits(l);
  const grossValue = r2(
    data.lines.reduce((s, l) => s + (l.purchasePrice ?? 0) * paidUnits(l), 0),
  );
  const invoiceNet = r2(data.lines.reduce((s, l) => s + lineNetValue(l), 0));
  const billPct = Math.min(
    100,
    Math.max(
      0,
      (data.invoiceDiscountPercent ?? 0) +
        (invoiceNet > 0 ? ((data.invoiceDiscountAmount ?? 0) / invoiceNet) * 100 : 0),
    ),
  );
  // Combine the line discount and the bill discount multiplicatively (a 10% line
  // + 5% bill ⇒ 14.5% off, not 15%) — i.e. the bill discount applies to the
  // already-line-discounted price, which is how distributor invoices total up.
  const effectiveDiscount = (lineDisc: number | undefined) =>
    billPct > 0
      ? r2((1 - (1 - (lineDisc ?? 0) / 100) * (1 - billPct / 100)) * 100)
      : lineDisc;
  const invoiceDiscountValue = r2(invoiceNet * (billPct / 100));

  let createdDrugs = 0;
  let mappedDrugs = 0;
  let batchesIn = 0;
  let failed = 0;
  const results: Array<{
    index: number;
    drugName: string;
    action: 'map' | 'create';
    status: 'ok' | 'error';
    formularyId?: string;
    batchId?: string;
    message?: string;
  }> = [];

  // Preload the HSN → GST tax master once so each medicine line can auto-fill a
  // blank GST from its HSN code (longest-prefix match) with no query per line.
  const hsnRows = await getHsnGstRows();

  for (let i = 0; i < data.lines.length; i++) {
    const line = data.lines[i];
    try {
      // ── Non-drug item line ────────────────────────────────────────────────
      // Find/create the generic inventory item, then post a stock-in. No batch
      // entity — expiry/batch (if given) ride on the stock transaction.
      if (line.kind === 'item') {
        let itemId: string;
        let itemName: string;
        if (line.action === 'map') {
          if (!line.targetInventoryItemId) {
            throw AppError.badRequest('A mapped item line needs a target item');
          }
          const existing = await prisma.inventoryItem.findFirst({
            where: { id: line.targetInventoryItemId, tenantId },
            select: { id: true, itemName: true },
          });
          if (!existing) throw AppError.notFound('Mapped item not found in inventory');
          itemId = existing.id;
          itemName = existing.itemName;
          mappedDrugs++;
        } else {
          const created = await createInventoryItem(tenantId, {
            itemName: line.drugName,
            itemCode: line.gtin ?? undefined,
            category: (line.category as 'consumable') ?? 'other',
            unitOfMeasurement: line.looseUnitLabel ?? undefined,
            costPerUnit: line.purchasePrice,
            sellingPricePerUnit: line.sellingPrice,
            minimumStockThreshold: line.minStock,
            description: line.description ?? undefined,
            currentStock: 0,
            isActive: true,
          });
          itemId = created.id;
          itemName = created.itemName;
          createdDrugs++;
        }
        // Only post stock when a quantity is given — qty 0/absent just registers
        // the item (the old "New Item" behaviour).
        const itemQty = line.quantityReceived ?? 0;
        if (itemQty > 0) {
          const eff = effectiveDiscount(line.purchaseDiscountPercent) ?? 0;
          const netUnit =
            line.purchasePrice != null ? r2(line.purchasePrice * (1 - eff / 100)) : undefined;
          await createInventoryStockTransaction(tenantId, userId, {
            inventoryItemId: itemId,
            transactionType: 'stock_in',
            quantity: itemQty,
            batchNumber: line.batchNumber || undefined,
            expiryDate: line.expiryDate || undefined,
            supplierId: line.supplierId ?? data.supplierId,
            unitCost: netUnit,
            referenceType: 'bulk_inward',
            notes: data.invoiceNumber ? `Bulk inward · invoice ${data.invoiceNumber}` : 'Bulk inward',
          });
          batchesIn++;
        }
        results.push({ index: i, drugName: itemName, action: line.action, status: 'ok', formularyId: itemId });
        continue;
      }

      // ── Medicine line ─────────────────────────────────────────────────────
      const drugQty = line.quantityReceived ?? 0;
      let drugId: string;
      let drugName: string;

      // In India GST is decided by the HSN code, so a line that carries an HSN
      // but no explicit GST auto-fills its rate from the HSN → GST tax master.
      // Feeds both the drug-level tax (formulary) and the batch's GST.
      const lineGst = line.gstPercent ?? matchHsnGst(line.hsnCode, hsnRows)?.gstRate;

      if (line.action === 'map') {
        // Reuse an existing formulary row — this is what keeps the 200 tablets
        // under ONE entry instead of splitting into two 100s.
        if (!line.targetFormularyId) {
          throw AppError.badRequest('A mapped line needs a target drug');
        }
        const existing = await prisma.drugFormulary.findFirst({
          where: { id: line.targetFormularyId, tenantId },
          select: { id: true, drugName: true },
        });
        if (!existing) throw AppError.notFound('Mapped drug not found in formulary');
        drugId = existing.id;
        drugName = existing.drugName;
        mappedDrugs++;
        // Persist any GTIN / HSN / manufacturer code this receiving line carries
        // onto the existing drug (fills only empty fields), so a barcode entered
        // while restocking a known drug makes future scans + GST auto-fill resolve
        // it instantly. Best-effort — never blocks the inward.
        await backfillFormularyIdentity(tenantId, existing.id, {
          gtin: line.gtin,
          hsnCode: line.hsnCode,
          manufacturerCode: line.manufacturerCode,
        });
      } else {
        // Genuinely new drug — create it (force past the duplicate guard since the
        // user reviewed the suggestions and chose "create new").
        const created = await createFormularyItem(tenantId, roles, {
          drugName: line.drugName,
          genericName: line.genericName ?? undefined,
          manufacturer: line.manufacturer ?? undefined,
          dosageForm: line.dosageForm as CreateFormularyInput['dosageForm'],
          strength: line.strength ?? undefined,
          packSize: line.packSize,
          looseUnitLabel: line.looseUnitLabel,
          minStock: line.minStock,
          taxPercent: lineGst,
          // Carry the invoice's GTIN / HSN / manufacturer code onto the new drug
          // so subsequent imports resolve it via GTIN (Product Resolution Engine).
          gtin: line.gtin ?? undefined,
          hsnCode: line.hsnCode ?? undefined,
          manufacturerCode: line.manufacturerCode ?? undefined,
          // When the line was seeded from the DrugMaster catalog, link the new
          // formulary row back to the catalog drug.
          drugMasterId: line.drugMasterId ?? undefined,
          // Default selling price per base unit; MRP (per pack) is kept on the batch.
          price: line.sellingPrice,
          isActive: true,
          force: true,
        } as CreateFormularyInput & { force: boolean });
        const item = (created as { item: { id: string; drugName: string } }).item;
        drugId = item.id;
        drugName = item.drugName;
        createdDrugs++;
      }

      // Only receive a batch when a quantity is given — qty 0/absent just
      // registers the medicine in the formulary (the old "New Item" behaviour).
      let batchId: string | undefined;
      if (drugQty > 0) {
        if (!line.batchNumber || !line.expiryDate) {
          throw AppError.badRequest('Batch number and expiry date are required when receiving a medicine');
        }
        const batch = await createBatch(tenantId, userId, roles, {
          drugId,
          batchNumber: line.batchNumber,
          expiryDate: line.expiryDate,
          manufacturingDate: line.manufacturingDate,
          quantityReceived: drugQty,
          freeQuantity: line.freeQuantity,
          mrp: line.mrp,
          purchasePrice: line.purchasePrice,
          // Per-line discount combined with the apportioned total-bill discount.
          purchaseDiscountPercent: effectiveDiscount(line.purchaseDiscountPercent),
          gstPercent: lineGst,
          sellingPrice: line.sellingPrice,
          supplierId: line.supplierId ?? data.supplierId,
          invoiceNumber: line.invoiceNumber ?? data.invoiceNumber,
          invoiceDate: line.invoiceDate ?? data.invoiceDate,
          // Scanned pack barcode carries through; absent barcode is minted
          // internally by createBatch.
          barcode: line.barcode,
          addToExisting: line.addToExisting ?? data.addToExisting,
        } as CreateBatchInput);
        batchId = batch.id;
        batchesIn++;
      }

      // Backfill GTIN/HSN/manufacturer-code onto the drug if the invoice carried
      // them — so future scans/imports resolve. Best-effort; never voids a line.
      if (line.gtin || line.hsnCode || line.manufacturerCode) {
        await backfillFormularyIdentity(tenantId, drugId, {
          gtin: line.gtin,
          hsnCode: line.hsnCode,
          manufacturerCode: line.manufacturerCode,
        });
      }

      results.push({
        index: i,
        drugName,
        action: line.action,
        status: 'ok',
        formularyId: drugId,
        batchId,
      });
    } catch (err) {
      failed++;
      results.push({
        index: i,
        drugName: line.drugName,
        action: line.action,
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to post this line',
      });
    }
  }

  logger.info(
    { tenantId, total: data.lines.length, createdDrugs, mappedDrugs, batchesIn, failed, billPct },
    'Bulk stock inward committed',
  );
  // Top-level invoice audit (the "Invoice Import / Inventory Creation" event) —
  // the per-drug mapping + per-batch receipts are already audited individually.
  void safePharmacyAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'inward_invoice',
    entityId: data.invoiceNumber || `inward-${data.lines.length}-lines`,
    description: `Stock inwarded${data.invoiceNumber ? ` · invoice ${data.invoiceNumber}` : ''}: ${data.lines.length} line(s) — ${createdDrugs} created, ${mappedDrugs} mapped, ${batchesIn} batch(es)${failed ? `, ${failed} failed` : ''}`,
    newValues: {
      invoiceNumber: data.invoiceNumber ?? null,
      invoiceDate: data.invoiceDate ?? null,
      supplierId: data.supplierId ?? null,
      totalLines: data.lines.length,
      createdDrugs,
      mappedDrugs,
      batchesIn,
      failed,
      grossValue,
      netValue: r2(invoiceNet - invoiceDiscountValue),
    },
  });
  return {
    total: data.lines.length,
    createdDrugs,
    mappedDrugs,
    batchesIn,
    failed,
    results,
    // G2: purchase economics for the whole invoice (gross → −line disc → −bill
    // disc → net) so the UI can confirm both discounts were applied.
    purchaseSummary: {
      grossValue,
      lineDiscount: r2(grossValue - invoiceNet),
      invoiceDiscountPercent: r2(billPct),
      invoiceDiscount: invoiceDiscountValue,
      netValue: r2(invoiceNet - invoiceDiscountValue),
    },
  };
}

/**
 * Convert a catalog MRP into the tenant's per-BASE-UNIT price. Catalog MRP is
 * the price of the whole pack/strip (e.g. ₹30 for a strip of 10), but stock and
 * billing are tracked per base unit, so a strip of 10 @ ₹30 is ₹3.00 / tablet.
 * packSize ≤ 1 (or null) → the MRP already is the unit price. Hoisted function
 * declaration so it's usable by the import paths above the `round2` const.
 */
function perBaseUnitPrice(
  mrp: number | string | { toString(): string } | null | undefined,
  packSize?: number | null,
): number | undefined {
  if (mrp == null) return undefined;
  const m = Number(mrp);
  if (!Number.isFinite(m)) return undefined;
  const ps = packSize && packSize > 1 ? packSize : 1;
  return Math.round((m / ps + Number.EPSILON) * 100) / 100;
}

/**
 * Import a drug from the platform-wide DrugMaster catalog into this tenant's
 * formulary (the "clone" step — mirrors lab template -> catalog cloning). If
 * the tenant already imported the same catalog entry, the existing formulary
 * row is returned instead of creating a duplicate.
 */
export async function importFormularyItem(
  tenantId: string,
  roles: string[],
  data: ImportFormularyInput,
) {
  assertPharmacyAdmin(roles, 'import drugs into the formulary');
  const master = await prisma.drugMaster.findUnique({ where: { id: data.drugMasterId } });
  if (!master) throw AppError.notFound('Drug not found in catalog');
  if (!master.isPublished) throw AppError.badRequest('Drug is not published in the catalog');

  // Dedupe: a tenant should only have one formulary row per catalog entry.
  const existing = await prisma.drugFormulary.findFirst({
    where: { tenantId, drugMasterId: master.id },
  });
  if (existing) return { item: existing, status: 'already_imported' as const };

  // Prefer the catalog's stored numeric pack size; fall back to resolving it
  // from the free-text label (with a sensible strip default for solids) so the
  // drug is sellable as loose sub-units (e.g. 3 tablets out of a strip of 10)
  // right after import.
  const packSize = master.packSize ?? resolvePackSize(master.dosageForm, master.packSizeLabel);
  const looseUnitLabel =
    packSize && packSize > 1 ? inferLooseUnitLabel(master.dosageForm, master.name) : null;

  const item = await prisma.drugFormulary.create({
    data: {
      tenantId,
      drugMasterId: master.id,
      drugName: master.name,
      // Catalog columns are wider than the formulary's — clamp to the formulary
      // column widths (genericName 255, unitOfMeasurement 20) to avoid overflow.
      genericName: master.genericName?.slice(0, 255) ?? null,
      manufacturer: master.manufacturer,
      dosageForm: master.dosageForm,
      strength: master.strength,
      unitOfMeasurement: master.packSizeLabel?.slice(0, 20) ?? null,
      packSize: packSize ?? undefined,
      looseUnitLabel: looseUnitLabel ?? undefined,
      // Carry the catalog's GTIN / case-pack / HSN / GST / manufacturer code so
      // the imported drug resolves by GTIN at inward and bills with the right HSN
      // + GST out of the box (Product Resolution Engine + compliance fields).
      gtin: master.gtin ?? undefined,
      casePackGtin: master.casePackGtin ?? undefined,
      unitsPerCase: master.unitsPerCase ?? undefined,
      hsnCode: master.hsnCode ?? undefined,
      manufacturerCode: master.manufacturerCode ?? undefined,
      taxPercent: master.gstRate ?? undefined,
      // Default selling price from the catalog MRP, converted to PER BASE UNIT
      // (MRP ÷ packSize) so a strip-of-10 @ ₹30 stores ₹3/tablet. An explicit
      // import price is taken as-is (already per unit). Hospital can edit later.
      price: data.price ?? perBaseUnitPrice(master.mrp, packSize),
      isActive: true,
    },
  });

  logger.info(
    { tenantId, formularyId: item.id, drugMasterId: master.id },
    'Formulary item imported from catalog',
  );
  return { item, status: 'created' as const };
}

/**
 * Bulk import — copy many catalog drugs into the tenant formulary in one call.
 * Dedupes against already-imported entries (by drugMasterId) so re-running is
 * safe. MRP becomes the default selling price; the hospital edits prices after.
 */
export async function importFormularyItemsBulk(
  tenantId: string,
  roles: string[],
  data: { drugMasterIds: string[] },
) {
  assertPharmacyAdmin(roles, 'import drugs into the formulary');
  const ids = Array.from(new Set(data.drugMasterIds));

  const [masters, already] = await Promise.all([
    prisma.drugMaster.findMany({ where: { id: { in: ids }, isPublished: true } }),
    prisma.drugFormulary.findMany({
      where: { tenantId, drugMasterId: { in: ids } },
      select: { drugMasterId: true },
    }),
  ]);

  const importedSet = new Set(already.map((a) => a.drugMasterId));
  const toCreate = masters.filter((m) => !importedSet.has(m.id));

  if (toCreate.length) {
    await prisma.drugFormulary.createMany({
      data: toCreate.map((m) => {
        // Numeric pack size + loose-unit label so imported strips are sellable
        // as loose sub-units straight away (see importFormularyItem). Prefer the
        // stored numeric size; fall back to resolving from the label.
        const packSize = m.packSize ?? resolvePackSize(m.dosageForm, m.packSizeLabel);
        const looseUnitLabel =
          packSize && packSize > 1 ? inferLooseUnitLabel(m.dosageForm, m.name) : null;
        return {
          tenantId,
          drugMasterId: m.id,
          drugName: m.name,
          // Clamp to the formulary column widths (catalog columns are wider):
          // genericName 255 (catalog 500), unitOfMeasurement 20 (packSizeLabel 255).
          genericName: m.genericName?.slice(0, 255) ?? null,
          manufacturer: m.manufacturer,
          dosageForm: m.dosageForm,
          strength: m.strength,
          unitOfMeasurement: m.packSizeLabel?.slice(0, 20) ?? null,
          packSize: packSize ?? undefined,
          looseUnitLabel: looseUnitLabel ?? undefined,
          // Per BASE UNIT (MRP ÷ packSize) — see importFormularyItem.
          price: perBaseUnitPrice(m.mrp, packSize),
          isActive: true,
        };
      }),
    });
  }

  logger.info(
    { tenantId, requested: ids.length, created: toCreate.length },
    'Bulk formulary import from catalog',
  );
  return {
    requested: ids.length,
    created: toCreate.length,
    skipped: ids.length - toCreate.length,
  };
}

/**
 * Tenant-facing catalog browse — paginated view of the platform DrugMaster with
 * an `imported` flag per row (and the tenant formularyId when already copied), so
 * a hospital can browse the full catalog and see what it has / hasn't imported.
 * Supports text search, dosage-form / schedule filters, and an imported filter.
 */
export async function getTenantCatalog(tenantId: string, query: any) {
  const { skip, take, page, limit } = getPaginationParams(query);

  // The tenant's already-imported catalog ids → drives the flag + filter.
  const importedRows = await prisma.drugFormulary.findMany({
    where: { tenantId, drugMasterId: { not: null } },
    select: { id: true, drugMasterId: true },
  });
  const importedMap = new Map<string, string>(); // drugMasterId → formularyId
  for (const r of importedRows) if (r.drugMasterId) importedMap.set(r.drugMasterId, r.id);
  const importedIds = [...importedMap.keys()];

  const where: any = { isPublished: true, isDiscontinued: false };
  if (query.search) {
    const terms = String(query.search)
      .toLowerCase()
      .split(/\s+/)
      .map((t: string) => t.trim())
      .filter(Boolean);
    where.AND = terms.map((term: string) => ({
      searchTokens: { contains: term, mode: 'insensitive' as const },
    }));
  }
  if (query.dosageForm) where.dosageForm = query.dosageForm;
  if (query.schedule) where.schedule = query.schedule;
  if (query.imported === 'yes') {
    where.id = { in: importedIds }; // empty → no rows, which is correct
  } else if (query.imported === 'no' && importedIds.length) {
    where.id = { notIn: importedIds };
  }

  const [rows, total] = await Promise.all([
    prisma.drugMaster.findMany({
      where,
      skip,
      take,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        genericName: true,
        manufacturer: true,
        dosageForm: true,
        strength: true,
        packSizeLabel: true,
        packSize: true,
        mrp: true,
        schedule: true,
      },
    }),
    prisma.drugMaster.count({ where }),
  ]);

  const items = rows.map((r) => ({
    ...r,
    imported: importedMap.has(r.id),
    formularyId: importedMap.get(r.id) ?? null,
  }));

  return { items, total, page, limit };
}

export async function getFormulary(tenantId: string, query: GetFormularyQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.dosageForm) where.dosageForm = query.dosageForm;
  if (query.isActive !== undefined) where.isActive = query.isActive;
  // NDPS narcotic-only filter (feeds the narcotic drug pickers server-side).
  if ((query as any).isNarcotic !== undefined) where.isNarcotic = (query as any).isNarcotic;

  // Stock filter — derived from available (non-expired, non-recalled, qty>0)
  // batches via a relation filter so the pharmacy can see what is / isn't stocked.
  const availableBatchFilter = {
    isExpired: false,
    isRecalled: false,
    quantityInStock: { gt: 0 },
  };
  if ((query as any).stockStatus === 'in') {
    where.drugBatches = { some: availableBatchFilter };
  } else if ((query as any).stockStatus === 'out') {
    where.drugBatches = { none: availableBatchFilter };
  }

  if (query.search) {
    where.OR = [
      { drugName: { contains: query.search, mode: 'insensitive' } },
      { genericName: { contains: query.search, mode: 'insensitive' } },
      { manufacturer: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.drugFormulary.findMany({
      where,
      skip,
      take,
      include: {
        // Only the in-stock batches — drives the per-row stock summary.
        drugBatches: {
          where: availableBatchFilter,
          select: { quantityInStock: true, expiryDate: true },
        },
      },
      orderBy: { drugName: 'asc' },
    }),
    prisma.drugFormulary.count({ where }),
  ]);

  // Roll batch rows up into a stock summary so the formulary list can show
  // In Stock (qty) / Out of Stock without a second round-trip.
  const shaped = items.map((it) => {
    const { drugBatches, ...rest } = it;
    const totalStock = drugBatches.reduce((s, b) => s + b.quantityInStock, 0);
    const nearestExpiry = drugBatches.length
      ? drugBatches
          .map((b) => b.expiryDate)
          .reduce((min, d) => (d < min ? d : min))
      : null;
    return {
      ...rest,
      totalStock,
      batchCount: drugBatches.length,
      inStock: totalStock > 0,
      nearestExpiry,
    };
  });

  return { items: shaped, total, page, limit };
}

export async function getFormularyItemById(tenantId: string, id: string) {
  const item = await prisma.drugFormulary.findFirst({
    where: { id, tenantId },
    include: {
      drugBatches: {
        where: { isExpired: false, isRecalled: false, quantityInStock: { gt: 0 } },
        select: {
          id: true,
          batchNumber: true,
          expiryDate: true,
          quantityInStock: true,
          sellingPrice: true,
        },
        orderBy: { expiryDate: 'asc' },
      },
    },
  });

  if (!item) {
    throw AppError.notFound('Formulary item not found');
  }

  return item;
}

/**
 * G8: alternative brands that share this drug's composition (generic name).
 * Lets the counter offer an in-stock substitute when the requested brand is out
 * of stock — e.g. searching "Crocin" surfaces other paracetamol brands on hand.
 * In-stock items are returned first.
 */
export async function getFormularyAlternatives(tenantId: string, id: string) {
  const item = await prisma.drugFormulary.findFirst({
    where: { id, tenantId },
    select: { id: true, genericName: true, strength: true, dosageForm: true },
  });
  if (!item) throw AppError.notFound('Formulary item not found');
  if (!item.genericName) {
    return { composition: null, alternatives: [] as any[] };
  }

  const rows = await prisma.drugFormulary.findMany({
    where: {
      tenantId,
      isActive: true,
      id: { not: id },
      genericName: { equals: item.genericName, mode: 'insensitive' },
    },
    select: {
      id: true,
      drugName: true,
      genericName: true,
      manufacturer: true,
      dosageForm: true,
      strength: true,
      price: true,
      packSize: true,
      looseUnitLabel: true,
      drugBatches: {
        where: { isExpired: false, isRecalled: false, quantityInStock: { gt: 0 } },
        select: { quantityInStock: true, expiryDate: true },
      },
    },
    orderBy: { drugName: 'asc' },
    take: 50,
  });

  const alternatives = rows
    .map((r) => {
      const { drugBatches, ...rest } = r;
      const totalStock = drugBatches.reduce((s, b) => s + b.quantityInStock, 0);
      const nearestExpiry = drugBatches.length
        ? drugBatches.map((b) => b.expiryDate).reduce((min, d) => (d < min ? d : min))
        : null;
      return { ...rest, totalStock, inStock: totalStock > 0, nearestExpiry };
    })
    // In-stock brands first, then by name.
    .sort((a, b) => Number(b.inStock) - Number(a.inStock) || a.drugName.localeCompare(b.drugName));

  return { composition: item.genericName, alternatives };
}

export async function updateFormularyItem(
  tenantId: string,
  roles: string[],
  id: string,
  data: UpdateFormularyInput,
) {
  assertPharmacyAdmin(roles, 'edit formulary drugs');
  const existing = await prisma.drugFormulary.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Formulary item not found');
  }

  const updateData: any = {};
  if (data.drugName !== undefined) updateData.drugName = data.drugName;
  if (data.genericName !== undefined) updateData.genericName = data.genericName;
  if (data.manufacturer !== undefined) updateData.manufacturer = data.manufacturer;
  if (data.dosageForm !== undefined) updateData.dosageForm = data.dosageForm;
  if (data.strength !== undefined) updateData.strength = data.strength;
  if (data.unitOfMeasurement !== undefined) updateData.unitOfMeasurement = data.unitOfMeasurement;
  if (data.price !== undefined) updateData.price = data.price;
  if (data.packSize !== undefined) updateData.packSize = data.packSize;
  if (data.looseUnitLabel !== undefined) updateData.looseUnitLabel = data.looseUnitLabel;
  if (data.taxPercent !== undefined) updateData.taxPercent = data.taxPercent;
  if ((data as any).minStock !== undefined) updateData.minStock = (data as any).minStock;
  if ((data as any).gtin !== undefined) updateData.gtin = (data as any).gtin;
  if ((data as any).casePackGtin !== undefined) updateData.casePackGtin = (data as any).casePackGtin;
  if ((data as any).unitsPerCase !== undefined) updateData.unitsPerCase = (data as any).unitsPerCase;
  if ((data as any).hsnCode !== undefined) updateData.hsnCode = (data as any).hsnCode;
  if ((data as any).manufacturerCode !== undefined) updateData.manufacturerCode = (data as any).manufacturerCode;
  if (data.indications !== undefined) updateData.indications = data.indications;
  if (data.contraindications !== undefined) updateData.contraindications = data.contraindications;
  if ((data as any).isLifeSaving !== undefined) updateData.isLifeSaving = (data as any).isLifeSaving;
  if ((data as any).isNarcotic !== undefined) updateData.isNarcotic = (data as any).isNarcotic;
  if ((data as any).isReimbursable !== undefined) updateData.isReimbursable = (data as any).isReimbursable;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;

  const item = await prisma.drugFormulary.update({
    where: { id },
    data: updateData,
  });

  logger.info({ tenantId, formularyId: id }, 'Formulary item updated');
  void safePharmacyAudit({
    tenantId,
    action: 'update',
    entityType: 'drug_formulary',
    entityId: id,
    description: `Master drug edited: ${item.drugName}`,
    // Only the fields that actually changed, old → new.
    oldValues: Object.fromEntries(Object.keys(updateData).map((k) => [k, (existing as any)[k]])),
    newValues: updateData,
  });
  return item;
}

export async function deleteFormularyItem(tenantId: string, id: string) {
  const existing = await prisma.drugFormulary.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Formulary item not found');
  }

  // Check if any batches reference this drug
  const batchCount = await prisma.drugBatch.count({
    where: { drugId: id },
  });

  if (batchCount > 0) {
    throw AppError.badRequest(
      `Cannot delete formulary item. ${batchCount} batch(es) are linked to this drug.`,
    );
  }

  await prisma.drugFormulary.delete({ where: { id } });

  logger.info({ tenantId, formularyId: id }, 'Formulary item deleted');
  void safePharmacyAudit({
    tenantId,
    action: 'delete',
    entityType: 'drug_formulary',
    entityId: id,
    description: `Master drug deleted: ${existing.drugName}`,
    oldValues: {
      drugName: existing.drugName,
      genericName: existing.genericName,
      manufacturer: existing.manufacturer,
      strength: existing.strength,
    },
  });
}

// ============================================================
// Batches
// ============================================================

export async function createBatch(tenantId: string, userId: string, roles: string[], data: CreateBatchInput) {
  assertPharmacyAdmin(roles, 'add stock batches');
  // Validate drug exists
  const drug = await prisma.drugFormulary.findFirst({
    where: { id: data.drugId, tenantId },
  });

  if (!drug) {
    throw AppError.notFound('Drug not found in formulary');
  }

  // Auto-apply GST from the drug's HSN code when the caller didn't specify one.
  // In India the rate is decided by the HSN, so a blank GST at stock-in resolves
  // from the HSN → GST tax master (longest-prefix match).
  let gstPercent = data.gstPercent;
  if (gstPercent == null && drug.hsnCode) {
    const hit = await resolveHsnGst(drug.hsnCode);
    if (hit) gstPercent = hit.gstRate;
  }

  // Validate supplier if provided
  if (data.supplierId) {
    const supplier = await prisma.supplier.findFirst({
      where: { id: data.supplierId, tenantId },
    });
    if (!supplier) {
      throw AppError.notFound('Supplier not found');
    }
  }

  // Pricing sanity (manual GRN Step 8 — flag abnormal pricing). A purchase rate
  // above the printed MRP is almost always a data-entry error; block it.
  if (data.mrp != null && data.purchasePrice != null && Number(data.purchasePrice) > Number(data.mrp)) {
    throw AppError.badRequest('Purchase rate cannot exceed MRP — please re-check the pricing.');
  }

  // Free units count toward stock but not toward purchase value. quantityReceived
  // is the TOTAL received (paid + free); freeQuantity records the free portion.
  const freeQty = data.freeQuantity ?? 0;

  // Check for duplicate batch number within the same drug (manual GRN Step 6).
  const existingBatch = await prisma.drugBatch.findFirst({
    where: { tenantId, drugId: data.drugId, batchNumber: data.batchNumber },
  });

  if (existingBatch) {
    // "Increase Quantity": fold the received qty into the existing batch instead
    // of erroring (prevents duplicate-batch fragmentation). Only when the caller
    // explicitly opted in after reviewing the existing batch.
    if (!(data as any).addToExisting) {
      throw AppError.conflict('A batch with this number already exists for this drug');
    }
    const merged = await prisma.drugBatch.update({
      where: { id: existingBatch.id },
      data: {
        quantityInStock: { increment: data.quantityReceived },
        quantityReceived: { increment: data.quantityReceived },
        freeQuantity: { increment: freeQty },
        // Refresh pricing / invoice metadata from the latest receipt when given.
        mrp: data.mrp ?? existingBatch.mrp,
        purchasePrice: data.purchasePrice ?? existingBatch.purchasePrice,
        purchaseDiscountPercent: data.purchaseDiscountPercent ?? existingBatch.purchaseDiscountPercent,
        gstPercent: gstPercent ?? existingBatch.gstPercent,
        sellingPrice: data.sellingPrice ?? existingBatch.sellingPrice,
        invoiceNumber: (data as any).invoiceNumber ?? existingBatch.invoiceNumber,
        invoiceDate: (data as any).invoiceDate ? new Date((data as any).invoiceDate) : existingBatch.invoiceDate,
        supplierId: data.supplierId ?? existingBatch.supplierId,
      },
      include: {
        drug: { select: { id: true, drugName: true, genericName: true } },
        supplier: { select: { id: true, name: true } },
      },
    });
    void safePharmacyAudit({
      tenantId,
      userId,
      action: 'update',
      entityType: 'drug_batch',
      entityId: merged.id,
      description: `Stock in (merged): +${data.quantityReceived} base unit(s) of ${drug.drugName} into existing batch ${data.batchNumber}`,
      oldValues: { quantityInStock: existingBatch.quantityInStock },
      newValues: { quantityInStock: merged.quantityInStock, addedQuantity: data.quantityReceived },
    });
    logger.info({ tenantId, batchId: merged.id, drugId: data.drugId }, 'Drug batch quantity increased');
    return merged;
  }

  // Pre-mint the batch id so the internal barcode (spec Section 2) can be derived
  // from it in a single insert — packs without a GS1 DataMatrix still get a stable
  // scannable Code-128; a scanned/known pack barcode is stored as-is.
  const batchId = randomUUID();
  const batch = await prisma.drugBatch.create({
    data: {
      id: batchId,
      tenantId,
      drugId: data.drugId,
      batchNumber: data.batchNumber,
      manufacturingDate: data.manufacturingDate ? new Date(data.manufacturingDate) : undefined,
      expiryDate: new Date(data.expiryDate),
      supplierId: data.supplierId,
      mrp: data.mrp,
      purchasePrice: data.purchasePrice,
      purchaseDiscountPercent: data.purchaseDiscountPercent,
      gstPercent,
      freeQuantity: freeQty,
      sellingPrice: data.sellingPrice,
      invoiceNumber: (data as any).invoiceNumber ?? null,
      invoiceDate: (data as any).invoiceDate ? new Date((data as any).invoiceDate) : null,
      quantityReceived: data.quantityReceived,
      quantityInStock: data.quantityReceived,
      serialNumber: (data as any).serialNumber ?? null,
      barcode: ((data as any).barcode as string | undefined)?.trim() || makeInternalBarcode(batchId),
    },
    include: {
      drug: { select: { id: true, drugName: true, genericName: true } },
      supplier: { select: { id: true, name: true } },
    },
  });
  const finalBatch = batch;

  void safePharmacyAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'drug_batch',
    entityId: batch.id,
    description: `Stock in: ${data.quantityReceived} base unit(s) of ${drug.drugName} (batch ${data.batchNumber})`,
    newValues: {
      batchNumber: data.batchNumber,
      quantityReceived: data.quantityReceived,
      expiryDate: data.expiryDate,
      // Vendor linkage captured on the audit trail per batch so a stock movement
      // can always be traced back to its supplier.
      supplierId: data.supplierId ?? null,
      supplierName: finalBatch.supplier?.name ?? null,
      invoiceNumber: (data as any).invoiceNumber ?? null,
    },
  });

  logger.info({ tenantId, batchId: batch.id, drugId: data.drugId }, 'Drug batch created');
  return finalBatch;
}

export async function getBatches(tenantId: string, query: GetBatchesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.drugId) where.drugId = query.drugId;
  if ((query as any).availableOnly) {
    where.isExpired = false;
    where.isRecalled = false;
    where.quantityInStock = { gt: 0 };
  } else if (query.isExpired !== undefined) {
    where.isExpired = query.isExpired;
  }
  // Recall filter (independent of expiry) — drives the "Recalled" view.
  if (!(query as any).availableOnly && (query as any).isRecalled !== undefined) {
    where.isRecalled = (query as any).isRecalled;
  }

  if (query.search) {
    where.OR = [
      { batchNumber: { contains: query.search, mode: 'insensitive' } },
      { drug: { drugName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [batches, total] = await Promise.all([
    prisma.drugBatch.findMany({
      where,
      skip,
      take,
      include: {
        drug: {
          select: {
            id: true,
            drugName: true,
            genericName: true,
            dosageForm: true,
            strength: true,
            packSize: true,
            looseUnitLabel: true,
            taxPercent: true,
          },
        },
        supplier: { select: { id: true, name: true } },
      },
      // G6: the POS / dispensing picker requests availableOnly batches — those
      // MUST come back FEFO (earliest expiry first, oldest receipt as tie-break)
      // so the default selection is the soonest-to-expire batch and a `take`
      // limit never truncates the earliest-expiry batch out of the list. The
      // management view keeps newest-received-first.
      orderBy: (query as any).availableOnly
        ? [{ expiryDate: 'asc' as const }, { createdAt: 'asc' as const }]
        : { createdAt: 'desc' as const },
    }),
    prisma.drugBatch.count({ where }),
  ]);

  // Decorate each row with derived purchase economics (G2).
  const shaped = batches.map((b) => ({ ...b, economics: batchPurchaseEconomics(b as any) }));
  return { batches: shaped, total, page, limit };
}

export async function getBatchById(tenantId: string, id: string) {
  const batch = await prisma.drugBatch.findFirst({
    where: { id, tenantId },
    include: {
      drug: { select: { id: true, drugName: true, genericName: true, strength: true, dosageForm: true } },
      supplier: { select: { id: true, name: true } },
    },
  });

  if (!batch) {
    throw AppError.notFound('Drug batch not found');
  }

  return { ...batch, economics: batchPurchaseEconomics(batch as any) };
}

export async function updateBatch(
  tenantId: string,
  roles: string[],
  id: string,
  data: UpdateBatchInput,
) {
  assertPharmacyAdmin(roles, 'edit stock batches');
  const existing = await prisma.drugBatch.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Drug batch not found');
  }

  // Validate supplier if being changed
  if (data.supplierId) {
    const supplier = await prisma.supplier.findFirst({
      where: { id: data.supplierId, tenantId },
    });
    if (!supplier) {
      throw AppError.notFound('Supplier not found');
    }
  }

  const updateData: any = {};
  if (data.batchNumber !== undefined) updateData.batchNumber = data.batchNumber;
  if (data.manufacturingDate !== undefined) {
    updateData.manufacturingDate = data.manufacturingDate ? new Date(data.manufacturingDate) : null;
  }
  if (data.expiryDate !== undefined) updateData.expiryDate = new Date(data.expiryDate);
  if (data.supplierId !== undefined) updateData.supplierId = data.supplierId;
  if ((data as any).mrp !== undefined) updateData.mrp = (data as any).mrp;
  if (data.purchasePrice !== undefined) updateData.purchasePrice = data.purchasePrice;
  if ((data as any).purchaseDiscountPercent !== undefined) updateData.purchaseDiscountPercent = (data as any).purchaseDiscountPercent;
  if ((data as any).gstPercent !== undefined) updateData.gstPercent = (data as any).gstPercent;
  if (data.sellingPrice !== undefined) updateData.sellingPrice = data.sellingPrice;
  if ((data as any).invoiceNumber !== undefined) updateData.invoiceNumber = (data as any).invoiceNumber;
  if ((data as any).invoiceDate !== undefined) {
    updateData.invoiceDate = (data as any).invoiceDate ? new Date((data as any).invoiceDate) : null;
  }
  if (data.quantityInStock !== undefined) updateData.quantityInStock = data.quantityInStock;
  if (data.isExpired !== undefined) updateData.isExpired = data.isExpired;
  if (data.isRecalled !== undefined) updateData.isRecalled = data.isRecalled;
  if (data.recallReason !== undefined) updateData.recallReason = data.recallReason;

  const batch = await prisma.drugBatch.update({
    where: { id },
    data: updateData,
    include: {
      drug: { select: { id: true, drugName: true, genericName: true } },
      supplier: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, batchId: id }, 'Drug batch updated');
  void safePharmacyAudit({
    tenantId,
    action: 'update',
    entityType: 'drug_batch',
    entityId: id,
    description: `Batch modified: ${batch.drug?.drugName ?? 'drug'} (batch ${batch.batchNumber})`,
    // Only the fields that changed, old → new.
    oldValues: Object.fromEntries(Object.keys(updateData).map((k) => [k, (existing as any)[k]])),
    newValues: updateData,
  });
  return batch;
}

/**
 * G4: deliberate manual stock-count correction on a batch, with a full audit
 * trail (who, from-value, to-value, reason, optional physical count). Distinct
 * from updateBatch so corrections are intentional and always reason-stamped —
 * the AuditLog entry is tagged type:'stock_adjustment' so the discrepancy report
 * can pull exactly these events.
 */
export async function adjustBatchStock(
  tenantId: string,
  userId: string,
  roles: string[],
  id: string,
  data: { newQuantity?: number; physicalCount?: number; reason: string },
) {
  assertPharmacyAdmin(roles, 'adjust stock counts');
  const batch = await prisma.drugBatch.findFirst({
    where: { id, tenantId },
    include: { drug: { select: { id: true, drugName: true } } },
  });
  if (!batch) throw AppError.notFound('Drug batch not found');

  const target = data.newQuantity ?? data.physicalCount;
  if (target == null) throw AppError.badRequest('Provide the corrected quantity (newQuantity or physicalCount)');
  if (target < 0) throw AppError.badRequest('Corrected quantity cannot be negative');

  const from = batch.quantityInStock;
  const delta = target - from;

  const updated = await prisma.drugBatch.update({
    where: { id },
    data: { quantityInStock: target },
    include: {
      drug: { select: { id: true, drugName: true } },
      supplier: { select: { id: true, name: true } },
    },
  });

  await safePharmacyAudit({
    tenantId,
    userId,
    action: 'adjust',
    entityType: 'drug_batch',
    entityId: id,
    description: `Stock adjustment: ${batch.drug?.drugName ?? 'drug'} (batch ${batch.batchNumber}) ${from} → ${target} (${delta >= 0 ? '+' : ''}${delta})`,
    oldValues: { quantityInStock: from },
    newValues: {
      type: 'stock_adjustment',
      from,
      to: target,
      delta,
      reason: data.reason,
      physicalCount: data.physicalCount ?? null,
      drugName: batch.drug?.drugName ?? null,
      batchNumber: batch.batchNumber,
    },
  });

  logger.info({ tenantId, batchId: id, from, to: target, delta }, 'Drug batch stock adjusted');
  return { batch: updated, from, to: target, delta };
}

/**
 * G4: stock discrepancy report — every manual count correction in the window,
 * filterable by date range and drug. Reads the tagged AuditLog rows so it shows
 * who changed what, from/to and why.
 */
export async function getStockAdjustments(
  tenantId: string,
  query: { fromDate?: string; toDate?: string; drugId?: string; page?: number; limit?: number },
) {
  const page = query.page && query.page > 0 ? query.page : 1;
  const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 200) : 50;
  const skip = (page - 1) * limit;

  const where: any = {
    tenantId,
    entityType: 'drug_batch',
    newValues: { path: ['type'], equals: 'stock_adjustment' },
  };
  if (query.fromDate || query.toDate) {
    where.createdAt = {};
    if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
    if (query.toDate) where.createdAt.lte = new Date(query.toDate);
  }

  // Optional drug filter: restrict to batches of that drug.
  if (query.drugId) {
    const batchIds = await prisma.drugBatch.findMany({
      where: { tenantId, drugId: query.drugId },
      select: { id: true },
    });
    where.entityId = { in: batchIds.map((b) => b.id) };
  }

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);

  const items = rows.map((row) => {
    const nv = (row.newValues ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      batchId: row.entityId,
      drugName: (nv.drugName as string) ?? null,
      batchNumber: (nv.batchNumber as string) ?? null,
      from: (nv.from as number) ?? null,
      to: (nv.to as number) ?? null,
      delta: (nv.delta as number) ?? null,
      physicalCount: (nv.physicalCount as number | null) ?? null,
      reason: (nv.reason as string) ?? null,
      user: row.user ? `${row.user.firstName} ${row.user.lastName ?? ''}`.trim() : null,
      createdAt: row.createdAt,
    };
  });

  return { items, total, page, limit };
}

/**
 * G4: reconcile a physical stock-take. Staff submit the physically counted
 * quantity for a set of batches; for each batch where the count differs from the
 * system quantity the variance is applied as a normal audited stock adjustment
 * (so it appears in the same discrepancy report and carries who / from → to /
 * reason / timestamp). Batches whose count matches are left untouched. Processing
 * is per-line resilient — one bad batch never aborts the whole count sheet — and
 * the response summarises matched vs adjusted, the net unit delta and the value
 * impact (delta × selling price) so the shrinkage/surplus is visible at a glance.
 */
export async function reconcileStockTake(
  tenantId: string,
  userId: string,
  roles: string[],
  data: StockTakeReconcileInput,
) {
  assertPharmacyAdmin(roles, 'reconcile a physical stock-take');

  const batchIds = data.lines.map((l) => l.batchId);
  const batches = await prisma.drugBatch.findMany({
    where: { id: { in: batchIds }, tenantId },
    include: { drug: { select: { drugName: true } } },
  });
  const byId = new Map(batches.map((b) => [b.id, b]));

  let matched = 0;
  let adjusted = 0;
  let failed = 0;
  let netDelta = 0;
  let valueDelta = 0;
  const results: Array<{
    batchId: string;
    drugName: string | null;
    batchNumber: string | null;
    system: number;
    counted: number;
    delta: number;
    valueDelta: number;
    status: 'matched' | 'adjusted' | 'error';
    message?: string;
  }> = [];

  for (const line of data.lines) {
    const b = byId.get(line.batchId);
    if (!b) {
      failed++;
      results.push({
        batchId: line.batchId,
        drugName: null,
        batchNumber: null,
        system: 0,
        counted: line.countedQuantity,
        delta: 0,
        valueDelta: 0,
        status: 'error',
        message: 'Batch not found',
      });
      continue;
    }

    const system = b.quantityInStock;
    const counted = line.countedQuantity;
    const delta = counted - system;
    const lineValueDelta = r2(delta * Number(b.sellingPrice ?? 0));
    const base = {
      batchId: b.id,
      drugName: b.drug?.drugName ?? null,
      batchNumber: b.batchNumber,
      system,
      counted,
      delta,
      valueDelta: lineValueDelta,
    };

    // No variance → nothing to correct, but it counts as verified.
    if (delta === 0) {
      matched++;
      results.push({ ...base, status: 'matched' });
      continue;
    }

    try {
      // Reuse the single-batch path so every variance is audited identically and
      // shows up in the existing stock-adjustment / discrepancy report.
      await adjustBatchStock(tenantId, userId, roles, b.id, {
        physicalCount: counted,
        reason: line.reason?.trim() || `${data.reason.trim()} (stock-take)`,
      });
      adjusted++;
      netDelta += delta;
      valueDelta += lineValueDelta;
      results.push({ ...base, status: 'adjusted' });
    } catch (err) {
      failed++;
      results.push({
        ...base,
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to apply this correction',
      });
    }
  }

  logger.info(
    { tenantId, total: data.lines.length, matched, adjusted, failed, netDelta },
    'Physical stock-take reconciled',
  );
  return {
    total: data.lines.length,
    matched,
    adjusted,
    failed,
    netDelta,
    valueDelta: r2(valueDelta),
    results,
  };
}

/**
 * G12: advance an IP prescription through the ward→pharmacy fulfilment
 * lifecycle (ordered → preparing → ready → collected). Independent of the
 * clinical dispensing status so the ward can track "is my order ready yet".
 */
export async function setPrescriptionPharmacyStatus(
  tenantId: string,
  userId: string,
  prescriptionId: string,
  status: 'ordered' | 'preparing' | 'ready' | 'collected',
) {
  const rx = await prisma.prescription.findFirst({
    where: { id: prescriptionId, tenantId },
    select: { id: true, pharmacyStatus: true },
  });
  if (!rx) throw AppError.notFound('Prescription not found');

  const updated = await prisma.prescription.update({
    where: { id: prescriptionId },
    data: { pharmacyStatus: status },
    select: { id: true, pharmacyStatus: true },
  });

  void safePharmacyAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'dispensing_record',
    entityId: prescriptionId,
    description: `Pharmacy order status: ${rx.pharmacyStatus ?? 'ordered'} → ${status}`,
    oldValues: { pharmacyStatus: rx.pharmacyStatus },
    newValues: { pharmacyStatus: status },
  });

  return updated;
}

/**
 * All medicines dispensed to IP (admitted) patients — i.e. billed onto a
 * hospital IP bill (admission-scoped), NOT sold at the pharmacy counter. This is
 * the ward-wide "medicines sent to IP" list. Backed by DispensingRecord whose
 * billId points to an admission bill.
 */
export async function getIpDispensedMedicines(
  tenantId: string,
  query: { patientId?: string; wardId?: string; fromDate?: string; toDate?: string; limit?: number },
) {
  const take = Math.min(query.limit ?? 200, 500);
  const dispensedAt: any = {};
  if (query.fromDate) dispensedAt.gte = new Date(query.fromDate);
  if (query.toDate) dispensedAt.lte = new Date(query.toDate);

  const records = await prisma.dispensingRecord.findMany({
    where: {
      tenantId,
      billId: { not: null },
      ...(query.patientId ? { patientId: query.patientId } : {}),
      ...(query.fromDate || query.toDate ? { dispensedAt } : {}),
    },
    select: {
      id: true, quantityDispensed: true, saleUnit: true, unitPrice: true, lineTotal: true,
      isTto: true, dispensedAt: true, billId: true,
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      drugBatch: { select: { batchNumber: true, drug: { select: { drugName: true, dosageForm: true, looseUnitLabel: true } } } },
      dispenser: { select: { firstName: true, lastName: true } },
    },
    orderBy: { dispensedAt: 'desc' },
    take: take * 2, // over-fetch; we filter to IP (admission) bills next
  });

  // Keep only records billed to an IP (admission-scoped) bill.
  const billIds = [...new Set(records.map((r) => r.billId).filter(Boolean) as string[])];
  const bills = billIds.length
    ? await prisma.bill.findMany({
        where: {
          id: { in: billIds },
          admissionId: { not: null },
          ...(query.wardId ? { admission: { wardId: query.wardId } } : {}),
        },
        select: {
          id: true, billNumber: true, status: true,
          admission: { select: { id: true, ward: { select: { name: true } }, bed: { select: { bedNumber: true } }, status: true } },
        },
      })
    : [];
  const billMap = new Map(bills.map((b) => [b.id, b]));

  const rows = records
    .filter((r) => r.billId && billMap.has(r.billId))
    .slice(0, take)
    .map((r) => {
      const bill = billMap.get(r.billId!)!;
      return {
        id: r.id,
        dispensedAt: r.dispensedAt.toISOString(),
        drugName: r.drugBatch.drug?.drugName ?? 'Drug',
        dosageForm: r.drugBatch.drug?.dosageForm ?? null,
        looseUnitLabel: r.drugBatch.drug?.looseUnitLabel ?? null,
        batchNumber: r.drugBatch.batchNumber,
        quantity: r.quantityDispensed,
        saleUnit: r.saleUnit ?? 'loose',
        unitPrice: Number(r.unitPrice ?? 0),
        lineTotal: Number(r.lineTotal ?? 0),
        isTto: r.isTto,
        patient: r.patient,
        dispensedBy: r.dispenser ? `${r.dispenser.firstName} ${r.dispenser.lastName ?? ''}`.trim() : null,
        bill: { id: bill.id, billNumber: bill.billNumber, status: bill.status },
        ward: bill.admission?.ward?.name ?? null,
        bed: bill.admission?.bed?.bedNumber ?? null,
      };
    });

  const totalAmount = Math.round(rows.reduce((s, r) => s + r.lineTotal, 0) * 100) / 100;
  return { rows, count: rows.length, totalAmount };
}

export async function getExpiringBatches(tenantId: string, query: GetExpiringBatchesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const days = query.days ?? 30;
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() + days);

  const where: any = {
    tenantId,
    isExpired: false,
    isRecalled: false,
    quantityInStock: { gt: 0 },
    expiryDate: { lte: thresholdDate },
  };

  const [batches, total] = await Promise.all([
    prisma.drugBatch.findMany({
      where,
      skip,
      take,
      include: {
        drug: { select: { id: true, drugName: true, genericName: true, strength: true } },
        supplier: { select: { id: true, name: true } },
      },
      orderBy: { expiryDate: 'asc' },
    }),
    prisma.drugBatch.count({ where }),
  ]);

  return { batches, total, page, limit };
}

// ============================================================
// Dispensing
// ============================================================

// Best-effort notification helper (failures must not break dispense)
async function safePharmacyNotify(params: {
  tenantId: string;
  userId: string;
  title: string;
  message: string;
  referenceType?: string;
  referenceId?: string;
}) {
  try {
    await prisma.notification.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        title: params.title,
        message: params.message,
        notificationType: 'general',
        channel: 'in_app',
        referenceType: params.referenceType,
        referenceId: params.referenceId,
      },
    });
  } catch (err) {
    logger.warn({ err, ...params }, 'Failed to dispatch pharmacy notification');
  }
}

// Recomputes a prescription's status based on its items' dispensed totals.
// Called from inside the dispense transaction so the queue is always coherent.
async function recomputePrescriptionStatus(
  tx: typeof prisma,
  prescriptionId: string,
) {
  const rx = await tx.prescription.findUnique({
    where: { id: prescriptionId },
    include: {
      prescriptionItems: {
        include: {
          dispensingRecords: { select: { quantityDispensed: true } },
        },
      },
    },
  });
  if (!rx || rx.status === 'cancelled') return;

  let totalOrderedItems = 0;
  let fullyDispensedItems = 0;
  let anyDispensed = false;

  for (const it of rx.prescriptionItems) {
    totalOrderedItems += 1;
    const dispensed = it.dispensingRecords.reduce(
      (sum, r) => sum + r.quantityDispensed,
      0,
    );
    if (dispensed > 0) anyDispensed = true;
    // Only "fully" dispensed if the prescription item has an explicit quantity
    // and dispensed total >= ordered quantity.
    if (it.quantity != null && dispensed >= it.quantity) {
      fullyDispensedItems += 1;
    } else if (it.quantity == null && dispensed > 0) {
      // No explicit quantity means PRN / continuous — treat any dispense as
      // fulfilled for queue-clearing purposes.
      fullyDispensedItems += 1;
    }
  }

  let nextStatus: 'active' | 'partially_dispensed' | 'dispensed' = 'active';
  if (totalOrderedItems > 0 && fullyDispensedItems === totalOrderedItems) {
    nextStatus = 'dispensed';
  } else if (anyDispensed) {
    nextStatus = 'partially_dispensed';
  }

  if (nextStatus !== rx.status) {
    await tx.prescription.update({
      where: { id: prescriptionId },
      data: { status: nextStatus },
    });
  }

  return { nextStatus, prev: rx.status };
}

// Resolves the unit price to bill for a dispense. Strictly the HOSPITAL's own
// price — never the platform catalog MRP. Preference order, all tenant-owned:
//   1. the batch's selling price (the real price for the stock actually used),
//   2. the hospital's formulary default price,
//   3. the batch purchase price (cost) as a last resort.
// This keeps every hospital's pricing independent (1000+ tenants can each price
// the same drug differently) and unaffected by catalog refreshes.
function pickDispenseUnitPrice(batch: {
  sellingPrice: any;
  purchasePrice: any;
  drug?: { price?: any } | null;
}) {
  const formularyPrice = batch.drug?.price;
  return Number(batch.sellingPrice ?? formularyPrice ?? batch.purchasePrice ?? 0);
}

// Auto-link a dispense to the patient's draft bill on the same visit. Idempotent
// on (billId, referenceType, referenceId).
export async function autoLinkDispenseToBill(
  tx: typeof prisma,
  tenantId: string,
  dispensingId: string,
) {
  try {
    const record = await tx.dispensingRecord.findFirst({
      where: { id: dispensingId, tenantId },
      include: {
        prescription: { select: { visitId: true } },
        drugBatch: {
          select: {
            drug: { select: { drugName: true, price: true, isReimbursable: true } },
            sellingPrice: true,
            purchasePrice: true,
            batchNumber: true,
          },
        },
      },
    });
    if (!record || !record.prescription?.visitId) return;
    const visitId = record.prescription.visitId;
    // G2: scope the IP ledger to the admission (Visit 1:1 Admission). OP visits
    // have no admission → stays null.
    const adm = await tx.admission.findFirst({ where: { tenantId, visitId }, orderBy: { admissionDate: 'desc' }, select: { id: true } });

    let bill = await tx.bill.findFirst({
      where: { tenantId, visitId, status: 'draft' },
    });
    if (!bill) {
      const billNumber = `BILL-${Date.now()}`;
      bill = await tx.bill.create({
        data: {
          tenantId,
          billNumber,
          patientId: record.patientId,
          visitId,
          admissionId: adm?.id ?? null,
          billDate: new Date(),
          status: 'draft',
        },
      });
    } else if (!bill.admissionId && adm) {
      bill = await tx.bill.update({ where: { id: bill.id }, data: { admissionId: adm.id } });
    }

    const existing = await tx.billItem.findFirst({
      where: {
        billId: bill.id,
        referenceType: 'dispensing_record',
        referenceId: dispensingId,
      },
    });
    if (existing) return;

    const unit = pickDispenseUnitPrice(record.drugBatch as any);
    const total = unit * record.quantityDispensed;
    const drugName = (record.drugBatch as any)?.drug?.drugName ?? 'Medication';
    const batchTag = (record.drugBatch as any)?.batchNumber ? ` (Batch ${(record.drugBatch as any).batchNumber})` : '';

    await tx.billItem.create({
      data: {
        billId: bill.id,
        description: `${drugName}${batchTag}`,
        category: 'pharmacy',
        quantity: record.quantityDispensed,
        unitPrice: unit,
        totalAmount: total,
        referenceType: 'dispensing_record',
        referenceId: dispensingId,
        isAutoPulled: true,
        isReimbursable: (record.drugBatch as any)?.drug?.isReimbursable ?? null,
      },
    });

    const items = await tx.billItem.findMany({ where: { billId: bill.id } });
    const subtotal = items.reduce((sum, x) => sum + Number(x.totalAmount ?? 0), 0);
    await tx.bill.update({
      where: { id: bill.id },
      data: {
        subtotal,
        totalAmount: subtotal,
        patientPayableAmount: subtotal,
        balanceDue: subtotal - Number(bill.amountPaid ?? 0),
      },
    });
  } catch (err) {
    logger.warn({ err, dispensingId }, 'Failed to auto-link dispense to bill');
  }
}

export async function createDispense(tenantId: string, userId: string, data: CreateDispenseInput) {
  // Validate the drug batch exists and has enough stock.
  const drugBatch = await prisma.drugBatch.findFirst({
    where: { id: data.drugBatchId, tenantId },
    include: {
      drug: {
        select: {
          drugName: true,
          price: true,
          isNarcotic: true,
          isLifeSaving: true,
        },
      },
    },
  });

  if (!drugBatch) {
    throw AppError.notFound('Drug batch not found');
  }

  if (isBatchExpired(drugBatch)) {
    throw AppError.badRequest('Cannot dispense from an expired batch');
  }

  if (drugBatch.isRecalled) {
    throw AppError.badRequest('Cannot dispense from a recalled batch');
  }

  // NDPS "Locked in Main Safe": narcotics route through the NDPS Form 3E workflow.
  if (drugBatch.drug?.isNarcotic) {
    throw AppError.badRequest(
      `${drugBatch.drug.drugName} is an NDPS narcotic — dispense it via the NDPS (Form 3E) consumption workflow.`,
    );
  }

  // The hospital dispenses at its own price (operational truth).
  if (drugBatch.quantityInStock < data.quantityDispensed) {
    throw AppError.badRequest(
      `Insufficient stock. Available: ${drugBatch.quantityInStock}, Requested: ${data.quantityDispensed}`,
    );
  }

  // Validate patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });

  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // G7/3.3: IP credit gate on the ordinary dispense path too — an admitted cash
  // patient over deposit is held unless the drug is life-saving or clearance was
  // given. No-ops for OP/non-admitted patients (requiresClearance is false).
  if (!(data as any).override && !drugBatch.drug?.isLifeSaving) {
    const credit = await getPatientCreditStatus(tenantId, data.patientId);
    if (credit.requiresClearance) {
      throw AppError.badRequest(
        `Credit Limit Exceeded — Clearance Required. Running bill ₹${credit.billed.toFixed(2)} exceeds deposit ₹${credit.deposit.toFixed(2)}. Collect a top-up deposit or dispense with clearance.`,
      );
    }
  }

  // Create dispensing record, decrement stock, recompute Rx status, and
  // auto-link to the patient bill — all in one transaction so the queue,
  // inventory, prescription, and billing surfaces stay consistent.
  const result = await prisma.$transaction(async (tx) => {
    const record = await tx.dispensingRecord.create({
      data: {
        tenantId,
        prescriptionId: data.prescriptionId,
        prescriptionItemId: data.prescriptionItemId,
        patientId: data.patientId,
        drugBatchId: data.drugBatchId,
        quantityDispensed: data.quantityDispensed,
        dispensedBy: userId,
        notes: data.notes,
      },
      include: {
        patient: { select: { id: true, firstName: true, lastName: true } },
        drugBatch: {
          select: {
            id: true,
            batchNumber: true,
            drug: { select: { id: true, drugName: true } },
          },
        },
      },
    });

    // Decrement stock
    await tx.drugBatch.update({
      where: { id: data.drugBatchId },
      data: {
        quantityInStock: { decrement: data.quantityDispensed },
      },
    });

    // Mark prescription as partially_dispensed / dispensed based on totals
    await recomputePrescriptionStatus(tx as any, data.prescriptionId);

    // Auto-add a line item to the patient's draft bill
    await autoLinkDispenseToBill(tx as any, tenantId, record.id);

    return record;
  });

  // Post-commit notifications — never inside the transaction
  try {
    const rx = await prisma.prescription.findUnique({
      where: { id: data.prescriptionId },
      include: {
        patient: { select: { firstName: true, lastName: true, userId: true } },
        doctor: { select: { userId: true } },
      },
    });
    if (rx?.doctor?.userId) {
      const patientName = rx.patient ? `${rx.patient.firstName} ${rx.patient.lastName ?? ''}`.trim() : 'Patient';
      void safePharmacyNotify({
        tenantId,
        userId: rx.doctor.userId,
        title: 'Medication dispensed',
        message: `${result.drugBatch.drug.drugName} (${result.quantityDispensed}) dispensed to ${patientName}.`,
        referenceType: 'dispensing_record',
        referenceId: result.id,
      });
    }
    if (rx?.patient?.userId) {
      void safePharmacyNotify({
        tenantId,
        userId: rx.patient.userId,
        title: 'Your medication is ready',
        message: `${result.drugBatch.drug.drugName} (${result.quantityDispensed}) has been dispensed at the pharmacy.`,
        referenceType: 'dispensing_record',
        referenceId: result.id,
      });
    }
  } catch (err) {
    logger.warn({ err, dispensingId: result.id }, 'Pharmacy post-dispense notify failed');
  }

  void safePharmacyAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'dispensing_record',
    entityId: result.id,
    description: `Dispensed ${data.quantityDispensed} × ${drugBatch.drug.drugName} (batch ${drugBatch.batchNumber})`,
    newValues: { quantityDispensed: data.quantityDispensed, drugBatchId: data.drugBatchId },
  });

  logger.info(
    { tenantId, dispensingId: result.id, drugBatchId: data.drugBatchId, quantity: data.quantityDispensed },
    'Drug dispensed',
  );
  return result;
}

// ============================================================
// Counter billing (POS sale) — the "proper" pharmacy bill
// ============================================================
// Bills an entire cart as ONE invoice (Bill + BillItems + Payment) inside a
// single transaction. Supports:
//   • partial-of-prescription (sell fewer units than ordered),
//   • loose / sub-unit sales (break a strip — saleUnit='loose'),
//   • walk-in / OTC (no prescriptionId),
//   • free-typed quantities,
//   • GST-inclusive pricing with a per-item tax breakup,
//   • payment capture (amount tendered → change/balance).
// Stock and price are tracked per BASE unit; packSize converts packs→base units.

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Human-friendly, collision-free pharmacy invoice number: PH-YYYYMMDD-#### per
// tenant per day. Counter throughput is low enough that a count+1 is safe.
async function nextPharmacyInvoiceNumber(tx: typeof prisma, tenantId: string, attempt = 0) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const prefix = `PH-${y}${m}${d}-`;
  // Base the next suffix on the HIGHEST existing number (not count()): count()+1
  // silently repeats a number the moment there is any gap in the sequence, and
  // the zero-padded suffix sorts lexicographically so `desc` gives us the max.
  const latest = await tx.bill.findFirst({
    where: { tenantId, billNumber: { startsWith: prefix } },
    orderBy: { billNumber: 'desc' },
    select: { billNumber: true },
  });
  const lastSeq = latest?.billNumber
    ? parseInt(latest.billNumber.split('-').pop() || '0', 10)
    : 0;
  // `attempt` steps the candidate forward on each retry so a collision against
  // the GLOBAL bill_number unique constraint (another tenant, or a concurrent
  // counter sale) is resolved by moving to the next free slot — a plain re-read
  // would keep proposing the same number because the count is tenant-scoped.
  return `${prefix}${String(lastSeq + 1 + attempt).padStart(4, '0')}`;
}

// Reusable per-tenant "Walk-in" customer so OTC sales (no patient selected)
// still attach to a Bill. Idempotent on the (tenantId, mrn) unique key.
const WALK_IN_MRN = 'WALK-IN';
async function getOrCreateWalkInPatient(tenantId: string): Promise<string> {
  const existing = await prisma.patient.findFirst({
    where: { tenantId, mrn: WALK_IN_MRN },
    select: { id: true },
  });
  if (existing) return existing.id;
  try {
    const created = await prisma.patient.create({
      data: { tenantId, mrn: WALK_IN_MRN, firstName: 'Walk-in', lastName: 'Customer', isNew: false },
      select: { id: true },
    });
    return created.id;
  } catch {
    // Lost a race on the unique key — re-read the row the other request created.
    const again = await prisma.patient.findFirst({
      where: { tenantId, mrn: WALK_IN_MRN },
      select: { id: true },
    });
    if (again) return again.id;
    throw AppError.badRequest('Could not resolve a walk-in customer for this sale');
  }
}


export async function createPharmacySale(
  tenantId: string,
  userId: string,
  data: CreatePharmacySaleInput,
) {
  // Resolve the patient. A Bill is always patient-scoped, so a walk-in / OTC
  // sale (no patientId) is billed against the tenant's reusable "Walk-in" patient.
  let patientId: string;
  if (data.patientId) {
    const patient = await prisma.patient.findFirst({
      where: { id: data.patientId, tenantId },
      select: { id: true },
    });
    if (!patient) throw AppError.notFound('Patient not found');
    patientId = patient.id;
  } else {
    patientId = await getOrCreateWalkInPatient(tenantId);
  }

  if (data.prescriptionId) {
    const rx = await prisma.prescription.findFirst({
      where: { id: data.prescriptionId, tenantId },
      select: { id: true, prescriptionType: true },
    });
    if (!rx) throw AppError.notFound('Prescription not found');
    // IP medicines are billed to the hospital (IP) bill via the ward indent —
    // never sold/settled at the pharmacy counter (that would double-bill the
    // patient, once on the IP bill and once on a PH- invoice).
    if (rx.prescriptionType === 'ip') {
      throw AppError.badRequest(
        'IP medicines are billed to the patient\'s hospital (IP) bill, not at the pharmacy counter. Dispense this order from the Ward Indents queue — the charge is added to the IP bill automatically.',
      );
    }
  }

  // Automated compliance validation (spec Section 2) — hard-block a sale that
  // violates a Schedule rule (e.g. Schedule X with no prescription) before any
  // stock or money moves. Soft warnings (HSN/GST/Schedule H/H1) are surfaced by
  // the dedicated pre-check endpoint the POS calls.
  const compliance = await checkSaleCompliance(tenantId, {
    items: data.items.map((i) => ({ drugBatchId: i.drugBatchId })),
    prescriptionId: data.prescriptionId,
  });
  if (!compliance.ok) {
    throw AppError.badRequest(compliance.blockers.join(' '));
  }

  // G7/3.3: IP credit gate for a counter sale billed to a named, admitted cash
  // patient over deposit — held unless EVERY line is life-saving or clearance was
  // given. Walk-in / OTC sales (no patientId) are exempt (never admitted).
  if (data.patientId && !(data as any).override) {
    const credit = await getPatientCreditStatus(tenantId, data.patientId);
    if (credit.requiresClearance) {
      const batchDrugs = await prisma.drugBatch.findMany({
        where: { tenantId, id: { in: data.items.map((i) => i.drugBatchId) } },
        select: { drug: { select: { isLifeSaving: true } } },
      });
      const allLifeSaving = batchDrugs.length > 0 && batchDrugs.every((b) => b.drug?.isLifeSaving);
      if (!allLifeSaving) {
        throw AppError.badRequest(
          `Credit Limit Exceeded — Clearance Required. Running bill ₹${credit.billed.toFixed(2)} exceeds deposit ₹${credit.deposit.toFixed(2)}. Collect a top-up deposit or sell with clearance.`,
        );
      }
    }
  }

  // G7: advance-deduction tender (IP only). Validate the patient has an active
  // admission with enough prepaid advance BEFORE settling part of the bill
  // against it. The actual deposit decrement happens inside the transaction.
  let advanceAdmissionId: string | null = null;
  if ((data.payments ?? []).some((p) => p.method === 'advance')) {
    if (!data.patientId) {
      throw AppError.badRequest('Advance deduction is only available for an admitted IP patient.');
    }
    const credit = await getPatientCreditStatus(tenantId, data.patientId);
    if (!credit.hasAdmission) {
      throw AppError.badRequest('Advance deduction requires an active IP admission.');
    }
    const requestedAdvance = round2(
      (data.payments ?? [])
        .filter((p) => p.method === 'advance')
        .reduce((s, p) => s + p.amount, 0),
    );
    if (requestedAdvance > credit.available + 0.01) {
      throw AppError.badRequest(
        `Insufficient advance balance. Available ₹${credit.available.toFixed(2)}.`,
      );
    }
    advanceAdmissionId = credit.admissionId;
  }

  const runSaleTx = (attempt: number) => prisma.$transaction(async (tx) => {
    // 1. Validate every line and pre-compute its economics.
    const lines = [] as Array<{
      batchId: string;
      batchNumber: string;
      drugName: string;
      prescriptionItemId: string | null;
      saleUnit: 'pack' | 'loose';
      baseQty: number;
      packSize: number;
      looseUnit: string;
      unitPrice: number;
      discPct: number;
      discAmt: number;
      net: number;
      taxPct: number;
      taxAmt: number;
      nonReturnable: boolean;
      expiry: Date | null;
    }>;

    for (const item of data.items) {
      const batch = await tx.drugBatch.findFirst({
        where: { id: item.drugBatchId, tenantId },
        include: {
          drug: {
            select: {
              drugName: true,
              price: true,
              packSize: true,
              looseUnitLabel: true,
              dosageForm: true,
              taxPercent: true,
              isNarcotic: true,
            },
          },
        },
      });
      if (!batch) throw AppError.notFound(`Drug batch ${item.drugBatchId} not found`);
      if (isBatchExpired(batch)) throw AppError.badRequest('Cannot sell from an expired batch');
      if (batch.isRecalled) throw AppError.badRequest('Cannot sell from a recalled batch');
      // NDPS "Locked in Main Safe": an Essential Narcotic Drug can never be issued
      // through the ordinary counter — it must go through the NDPS vault custody +
      // Form 3E consumption workflow so the statutory register stays complete.
      if (batch.drug?.isNarcotic) {
        throw AppError.badRequest(
          `${batch.drug.drugName} is an NDPS narcotic — it must be dispensed via the NDPS (Form 3E) consumption workflow, not the counter.`,
        );
      }

      const packSize = batch.drug?.packSize && batch.drug.packSize > 0 ? batch.drug.packSize : 1;
      const saleUnit = item.saleUnit ?? 'pack';
      // Loose sales must be whole sub-units; pack sales convert packs→base units.
      const baseQty = saleUnit === 'loose'
        ? Math.round(item.quantity)
        : Math.round(item.quantity) * packSize;
      if (baseQty <= 0) throw AppError.badRequest('Quantity must be at least one unit');
      if (batch.quantityInStock < baseQty) {
        throw AppError.badRequest(
          `Insufficient stock for ${batch.drug?.drugName ?? 'drug'}. Available: ${batch.quantityInStock}, requested: ${baseQty}`,
        );
      }

      const unitPrice = item.unitPrice != null
        ? item.unitPrice
        : pickDispenseUnitPrice(batch as any);
      const gross = round2(unitPrice * baseQty);
      const discPct = item.discountPercent ?? 0;
      const discAmt = round2(gross * (discPct / 100));
      const net = round2(gross - discAmt);
      // Prices are MRP (tax-inclusive) → derive the embedded GST for the breakup.
      const taxPct = batch.drug?.taxPercent != null ? Number(batch.drug.taxPercent) : 12;
      const taxAmt = round2(net - net / (1 + taxPct / 100));

      lines.push({
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        drugName: batch.drug?.drugName ?? 'Medication',
        prescriptionItemId: item.prescriptionItemId ?? null,
        saleUnit,
        baseQty,
        packSize,
        looseUnit:
          batch.drug?.looseUnitLabel?.trim() ||
          inferLooseUnitLabel(batch.drug?.dosageForm, batch.drug?.drugName) ||
          'unit',
        unitPrice,
        discPct,
        discAmt,
        net,
        taxPct,
        taxAmt,
        nonReturnable: item.nonReturnable ?? false,
        expiry: batch.expiryDate ?? null,
      });
    }

    // 2. Roll up the invoice totals.
    const subtotal = round2(lines.reduce((s, l) => s + l.unitPrice * l.baseQty, 0));
    const itemDiscount = round2(lines.reduce((s, l) => s + l.discAmt, 0));
    const itemTotal = round2(lines.reduce((s, l) => s + l.net, 0));

    // G2 sale-side: apply a bill-level discount on top of per-item discounts.
    // Percent is taken on the post-item-discount total, plus any flat amount,
    // capped at the total. GST is tax-inclusive in MRP, so scale the embedded
    // tax proportionally once the bill is discounted.
    const billDiscPct = (data as any).billDiscountPercent ?? 0;
    const billDiscFlat = (data as any).billDiscountAmount ?? 0;
    const billDiscount = round2(
      Math.min(itemTotal, round2(itemTotal * (billDiscPct / 100)) + billDiscFlat),
    );
    const totalAmount = round2(itemTotal - billDiscount);
    const discountAmount = round2(itemDiscount + billDiscount);
    const ratio = itemTotal > 0 ? totalAmount / itemTotal : 1;
    const taxAmount = round2(lines.reduce((s, l) => s + l.taxAmt, 0) * ratio);

    // Resolve the tender(s). G7 split payment: when `payments[]` is given each
    // entry becomes its own Payment row (cash + UPI + card…). Otherwise fall
    // back to the single-mode path — pay-in-full unless an explicit amount.
    let paymentLines: Array<{ method: string; amount: number; reference?: string }>;
    if (data.payments && data.payments.length) {
      paymentLines = data.payments
        .filter((p) => p.amount > 0)
        .map((p) => ({ method: p.method, amount: round2(p.amount), reference: p.reference }));
    } else {
      const single =
        data.amountPaid != null ? round2(Math.min(data.amountPaid, totalAmount)) : totalAmount;
      paymentLines = single > 0 ? [{ method: data.paymentMethod ?? 'cash', amount: single }] : [];
    }
    const rawPaid = round2(paymentLines.reduce((s, p) => s + p.amount, 0));
    // Cap the bill's settled amount at the total — extra cash tendered is change,
    // not a credit balance.
    const applied = round2(Math.min(rawPaid, totalAmount));
    // Trim any change off the last tender (usually cash) so the recorded payment
    // rows sum exactly to `applied` rather than to the raw cash handed over.
    let excess = round2(rawPaid - applied);
    for (let i = paymentLines.length - 1; i >= 0 && excess > 0; i--) {
      const cut = Math.min(paymentLines[i].amount, excess);
      paymentLines[i].amount = round2(paymentLines[i].amount - cut);
      excess = round2(excess - cut);
    }
    paymentLines = paymentLines.filter((p) => p.amount > 0);
    const balanceDue = round2(totalAmount - applied);
    const status: any = balanceDue <= 0 ? 'paid' : applied > 0 ? 'partially_paid' : 'pending';

    // G7: consume the IP advance for the advance tender actually applied (post
    // change-trim). Re-check the live deposit inside the transaction so a
    // concurrent spend can't push it negative.
    const appliedAdvance = round2(
      paymentLines.filter((p) => p.method === 'advance').reduce((s, p) => s + p.amount, 0),
    );
    if (appliedAdvance > 0 && advanceAdmissionId) {
      const adm = await tx.admission.findUnique({
        where: { id: advanceAdmissionId },
        select: { depositAmount: true },
      });
      if (!adm || Number(adm.depositAmount) < appliedAdvance) {
        throw AppError.badRequest('Insufficient advance balance to settle this bill.');
      }
      await tx.admission.update({
        where: { id: advanceAdmissionId },
        data: { depositAmount: { decrement: appliedAdvance } },
      });
    }

    let visitId: string | null = null;
    if (data.prescriptionId) {
      const rx = await tx.prescription.findUnique({
        where: { id: data.prescriptionId },
        select: { visitId: true },
      });
      visitId = rx?.visitId ?? null;
    }

    const billNumber = await nextPharmacyInvoiceNumber(tx as any, tenantId, attempt);
    const bill = await tx.bill.create({
      data: {
        tenantId,
        billNumber,
        patientId,
        visitId,
        billDate: new Date(),
        subtotal,
        discountAmount,
        taxAmount,
        totalAmount,
        patientPayableAmount: totalAmount,
        amountPaid: applied,
        balanceDue,
        status,
        generatedBy: userId,
      },
    });

    // 3. One DispensingRecord + BillItem per line; decrement stock.
    for (const l of lines) {
      const rec = await tx.dispensingRecord.create({
        data: {
          tenantId,
          prescriptionId: data.prescriptionId ?? null,
          prescriptionItemId: l.prescriptionItemId,
          patientId,
          drugBatchId: l.batchId,
          quantityDispensed: l.baseQty,
          dispensedBy: userId,
          notes: data.notes,
          saleUnit: l.saleUnit,
          unitPrice: l.unitPrice,
          discountPercent: l.discPct,
          taxPercent: l.taxPct,
          lineTotal: l.net,
          nonReturnable: l.nonReturnable,
          // TTO (To Take Out) — discharge medication dispensed in full packs.
          isTto: data.isTto ?? false,
          billId: bill.id,
        },
      });

      await tx.drugBatch.update({
        where: { id: l.batchId },
        data: { quantityInStock: { decrement: l.baseQty } },
      });

      // Spell out what the count means on the invoice: loose lines bill the
      // exact number of base units (e.g. "10 tablet, loose"); pack lines note
      // how many packs of N were sold. `quantity` itself is always base units.
      const unitDetail =
        l.saleUnit === 'loose'
          ? `${l.baseQty} ${l.looseUnit}, loose`
          : l.packSize > 1
            ? `${l.baseQty / l.packSize} pack of ${l.packSize} ${l.looseUnit}`
            : `${l.baseQty} ${l.looseUnit}`;
      // Print batch AND expiry on the receipt line (design doc OP Step 5 requires
      // "batch/expiry details" on the printed bill). dd/MM/yyyy per house style.
      const expTag = l.expiry
        ? `, Exp ${new Date(l.expiry).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}`
        : '';
      await tx.billItem.create({
        data: {
          billId: bill.id,
          description: `${l.drugName} (Batch ${l.batchNumber}${expTag}) — ${unitDetail}`,
          category: 'pharmacy',
          quantity: l.baseQty,
          unitPrice: l.unitPrice,
          discountPercent: l.discPct,
          discountAmount: l.discAmt,
          taxPercent: l.taxPct,
          taxAmount: l.taxAmt,
          totalAmount: l.net,
          referenceType: 'dispensing_record',
          referenceId: rec.id,
          isAutoPulled: true,
        },
      });
    }

    // 4. Record the payment(s) taken at the counter — one row per tender so a
    // split bill (cash + UPI) shows each mode on the receipt and in reports.
    for (const p of paymentLines) {
      await tx.payment.create({
        data: {
          tenantId,
          billId: bill.id,
          patientId,
          paymentDate: new Date(),
          amount: p.amount,
          paymentMethod: p.method as any,
          paymentSource: 'frontdesk',
          status: 'completed',
          processedBy: userId,
          transactionId: p.reference,
          notes: 'Pharmacy counter sale',
        },
      });
    }

    // 5. Keep the prescription queue coherent for Rx-linked sales.
    if (data.prescriptionId) {
      await recomputePrescriptionStatus(tx as any, data.prescriptionId);
    }

    return bill.id;
  });

  // The generated bill_number can still lose a race against the GLOBAL unique
  // constraint (a concurrent counter sale, or another tenant's first sale of the
  // day landing on the same PH-YYYYMMDD-#### slot). Retry the whole transaction —
  // it rolls back cleanly on failure — advancing the candidate number each time
  // via `attempt` until we claim a free number, so the POS never sees a 409.
  let billId: string;
  for (let attempt = 0; ; attempt++) {
    try {
      billId = await runSaleTx(attempt);
      break;
    } catch (err) {
      const billNumberClash =
        (err as any)?.code === 'P2002' &&
        String((err as any)?.meta?.target ?? '').includes('bill_number');
      if (billNumberClash && attempt < 5) continue;
      throw err;
    }
  }

  void safePharmacyAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'pharmacy_sale',
    entityId: billId,
    description: `Counter sale: ${data.items.length} line item(s) billed`,
    newValues: { items: data.items.map((i) => ({ drugBatchId: i.drugBatchId, quantity: i.quantity })) },
  });

  logger.info({ tenantId, billId, items: data.items.length }, 'Pharmacy counter sale billed');
  return getPharmacySale(tenantId, billId);
}

// Full invoice payload for the POS receipt / reprint.
export async function getPharmacySale(tenantId: string, billId: string) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
    include: {
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          gender: true,
          dateOfBirth: true,
          phone: true,
        },
      },
      billItems: { orderBy: { createdAt: 'asc' } },
      payments: {
        select: { id: true, amount: true, paymentMethod: true, paymentDate: true },
        orderBy: { paymentDate: 'asc' },
      },
      generator: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  if (!bill) throw AppError.notFound('Bill not found');

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      name: true,
      logoUrl: true,
      address: true,
      city: true,
      state: true,
      phone: true,
      email: true,
    },
  });

  return { bill, hospital: tenant };
}

// Paginated list of pharmacy counter-sale bills (PH- invoices) for the
// Transactions page, plus a period summary (sales total / paid / cancelled).
export async function getPharmacySales(tenantId: string, query: GetPharmacySalesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  // Base filter: this tenant's pharmacy invoices in the date / search window.
  // Status is applied to the LIST only, so the summary cards stay stable as the
  // user flips between the Sales / Cancelled tabs.
  const baseWhere: any = { tenantId, billNumber: { startsWith: 'PH-' } };
  if (query.fromDate) baseWhere.billDate = { ...baseWhere.billDate, gte: new Date(query.fromDate) };
  if (query.toDate) baseWhere.billDate = { ...baseWhere.billDate, lte: new Date(query.toDate) };
  if (query.search) {
    baseWhere.OR = [
      { billNumber: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const listWhere: any = { ...baseWhere };
  if (query.status) listWhere.status = query.status;

  const [bills, total, salesAgg, cancelledCount, grandTotal] = await Promise.all([
    prisma.bill.findMany({
      where: listWhere,
      skip,
      take,
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        generator: { select: { id: true, firstName: true, lastName: true } },
        _count: { select: { billItems: true } },
      },
      orderBy: { billDate: query.sortOrder || 'desc' },
    }),
    prisma.bill.count({ where: listWhere }),
    prisma.bill.aggregate({
      where: { ...baseWhere, status: { not: 'cancelled' } },
      _sum: { totalAmount: true, amountPaid: true },
      _count: true,
    }),
    prisma.bill.count({ where: { ...baseWhere, status: 'cancelled' } }),
    prisma.bill.count({ where: baseWhere }),
  ]);

  const summary = {
    totalBills: grandTotal,
    salesCount: salesAgg._count,
    totalAmount: Number(salesAgg._sum.totalAmount ?? 0),
    totalPaid: Number(salesAgg._sum.amountPaid ?? 0),
    cancelledCount,
  };

  return { bills, total, page, limit, summary };
}

// Void a pharmacy counter sale: restore the dispensed stock, drop the dispense
// + bill-item lines (so reports / cash-counter totals exclude the void), reverse
// the counter payment, and revert the linked prescription's queue status. The
// Bill row is kept as the cancelled audit record.
export async function cancelPharmacySale(
  tenantId: string,
  userId: string,
  billId: string,
  data: CancelSaleInput,
) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId, billNumber: { startsWith: 'PH-' } },
    select: { id: true, status: true },
  });
  if (!bill) throw AppError.notFound('Pharmacy bill not found');
  if (bill.status === 'cancelled') throw AppError.badRequest('Bill is already cancelled');

  // Returns recorded against this sale already adjusted stock / refunds — a void
  // on top would double-count, so block it.
  const returnCount = await prisma.drugReturn.count({ where: { billId } });
  if (returnCount > 0) {
    throw AppError.badRequest(
      'This bill has returns recorded against it. Reverse the returns before cancelling.',
    );
  }

  const records = await prisma.dispensingRecord.findMany({
    where: { billId, tenantId },
    select: { id: true, drugBatchId: true, quantityDispensed: true, prescriptionId: true },
  });
  const rxIds = [...new Set(records.map((r) => r.prescriptionId).filter((v): v is string => !!v))];

  await prisma.$transaction(async (tx) => {
    // 1. Put the dispensed units back into their batches.
    for (const rec of records) {
      await tx.drugBatch.update({
        where: { id: rec.drugBatchId },
        data: { quantityInStock: { increment: rec.quantityDispensed } },
      });
    }
    // 2. Drop the sale lines (keep the Bill as the cancelled record).
    await tx.dispensingRecord.deleteMany({ where: { billId } });
    await tx.billItem.deleteMany({ where: { billId } });
    // 3. Reverse the counter payment (cash handed back).
    await tx.payment.updateMany({
      where: { billId, status: 'completed' },
      data: { status: 'reversed' },
    });
    // 4. Mark the bill cancelled.
    await tx.bill.update({
      where: { id: billId },
      data: {
        status: 'cancelled',
        cancelledBy: userId,
        cancellationReason: data.reason,
        amountPaid: 0,
        balanceDue: 0,
      },
    });
    // 5. Revert any Rx-linked prescription back toward active.
    for (const rxId of rxIds) {
      await recomputePrescriptionStatus(tx as any, rxId);
    }
  });

  void safePharmacyAudit({
    tenantId,
    userId,
    action: 'delete',
    entityType: 'pharmacy_sale',
    entityId: billId,
    description: `Counter sale cancelled — ${data.reason}`,
    newValues: { reason: data.reason, restoredLines: records.length },
  });

  logger.info({ tenantId, billId, lines: records.length }, 'Pharmacy counter sale cancelled');
  return getPharmacySale(tenantId, billId);
}

export async function getDispenseRecords(tenantId: string, query: GetDispenseQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;

  if (query.fromDate) {
    where.dispensedAt = { ...where.dispensedAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.dispensedAt = { ...where.dispensedAt, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { drugBatch: { drug: { drugName: { contains: query.search, mode: 'insensitive' } } } },
    ];
  }

  const [records, total] = await Promise.all([
    prisma.dispensingRecord.findMany({
      where,
      skip,
      take,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true } },
        drugBatch: {
          select: {
            id: true,
            batchNumber: true,
            drug: { select: { id: true, drugName: true, genericName: true } },
          },
        },
        dispenser: { select: { id: true, firstName: true, lastName: true } },
        verifier: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { dispensedAt: 'desc' },
    }),
    prisma.dispensingRecord.count({ where }),
  ]);

  return { records, total, page, limit };
}

export async function getDispenseById(tenantId: string, id: string) {
  const record = await prisma.dispensingRecord.findFirst({
    where: { id, tenantId },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      drugBatch: {
        select: {
          id: true,
          batchNumber: true,
          expiryDate: true,
          drug: { select: { id: true, drugName: true, genericName: true, strength: true, dosageForm: true } },
        },
      },
      dispenser: { select: { id: true, firstName: true, lastName: true } },
      verifier: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  if (!record) {
    throw AppError.notFound('Dispensing record not found');
  }

  return record;
}

export async function verifyDispense(tenantId: string, id: string, verifiedBy: string) {
  const record = await prisma.dispensingRecord.findFirst({
    where: { id, tenantId },
  });

  if (!record) {
    throw AppError.notFound('Dispensing record not found');
  }

  if (record.verifiedBy) {
    throw AppError.badRequest('This dispensing record has already been verified');
  }

  if (record.dispensedBy === verifiedBy) {
    throw AppError.badRequest('The dispenser cannot verify their own dispensing record');
  }

  const updated = await prisma.dispensingRecord.update({
    where: { id },
    data: { verifiedBy },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      drugBatch: {
        select: {
          id: true,
          batchNumber: true,
          drug: { select: { id: true, drugName: true } },
        },
      },
      dispenser: { select: { id: true, firstName: true, lastName: true } },
      verifier: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, dispensingId: id, verifiedBy }, 'Dispensing record verified');
  return updated;
}

// ============================================================
// Returns
// ============================================================

export async function createReturn(tenantId: string, userId: string, roles: string[], data: CreateReturnInput) {
  // Patient returns are an everyday counter task (pharmacist). Vendor returns
  // (damaged/unsold stock back to the supplier) are a stock-management action,
  // so they're restricted to pharmacy_admin.
  if (data.returnType === 'vendor_return') {
    assertPharmacyAdmin(roles, 'record vendor returns');
  }

  // Counter (walk-in / over-the-counter) return — NOT tied to a patient record
  // or bill. The pharmacist just records the medicine, quantity and, optionally,
  // a batch number / expiry the customer brought back. No refund is computed;
  // stock is restored on approval (to a matching or created batch when known).
  if (data.returnType === 'counter_return') {
    if (!data.drugId) {
      throw AppError.badRequest('A medicine is required for a counter return');
    }
    const drug = await prisma.drugFormulary.findFirst({
      where: { id: data.drugId, tenantId },
      select: { id: true, drugName: true },
    });
    if (!drug) throw AppError.notFound('Medicine not found in the formulary');

    // If a tracked batch was picked, it must belong to this tenant + medicine.
    let counterBatchId: string | null = null;
    if (data.drugBatchId) {
      const batch = await prisma.drugBatch.findFirst({
        where: { id: data.drugBatchId, tenantId, drugId: drug.id },
        select: { id: true },
      });
      if (!batch) throw AppError.notFound('Drug batch not found for this medicine');
      counterBatchId = batch.id;
    }

    const counterReturn = await prisma.drugReturn.create({
      data: {
        tenantId,
        returnType: 'counter_return',
        drugId: drug.id,
        drugBatchId: counterBatchId,
        batchNumber: data.batchNumber || null,
        expiryDate: data.expiryDate ?? null,
        saleUnit: data.saleUnit ?? 'pack',
        quantity: data.quantity,
        reason: data.reason,
        // Optional money given back to the walk-in customer. A counter return has
        // no original bill, so this is just recorded on the return + its receipt.
        refundAmount: (data as any).refundAmount != null ? round2(Number((data as any).refundAmount)) : null,
        status: 'pending',
      },
      include: {
        drug: { select: { id: true, drugName: true } },
        drugBatch: {
          select: { id: true, batchNumber: true, drug: { select: { id: true, drugName: true } } },
        },
      },
    });

    void safePharmacyAudit({
      tenantId,
      userId,
      action: 'create',
      entityType: 'drug_return',
      entityId: counterReturn.id,
      description: `Counter return recorded: ${data.quantity} × ${drug.drugName}${data.batchNumber ? ` (batch ${data.batchNumber})` : ''}`,
      newValues: { quantity: data.quantity, returnType: 'counter_return', drugId: drug.id },
    });

    logger.info(
      { tenantId, returnId: counterReturn.id, returnType: 'counter_return' },
      'Counter drug return created',
    );
    // Returns apply immediately — no separate approve step. Restock now.
    return processReturn(tenantId, counterReturn.id, userId, { status: 'processed' });
  }

  // Patient returns can be anchored to the original sale line. When they are,
  // the batch + patient are taken from that record, the quantity is bounded by
  // what is still returnable, and a refund amount is computed from the billed
  // price so approving the return pays the patient back the right money.
  let batchId = data.drugBatchId;
  let patientId = data.patientId ?? null;
  let dispensingRecordId: string | null = null;
  let billId: string | null = null;
  let saleUnit: string | null = null;
  let unitPrice: number | null = null;
  let refundAmount: number | null = null;

  if (data.returnType === 'patient_return' && data.dispensingRecordId) {
    const record = await prisma.dispensingRecord.findFirst({
      where: { id: data.dispensingRecordId, tenantId },
    });
    if (!record) throw AppError.notFound('Original dispensing record not found');
    // §4.4: an item marked non-returnable on the bill can never be taken back.
    if (record.nonReturnable) {
      throw AppError.badRequest('This item was marked non-returnable on the bill and cannot be returned.');
    }

    dispensingRecordId = record.id;
    batchId = record.drugBatchId;
    patientId = record.patientId;
    billId = record.billId ?? null;
    saleUnit = record.saleUnit ?? 'pack';

    // Non-rejected returns already booked against this sale line cap the return.
    const prior = await prisma.drugReturn.aggregate({
      where: { dispensingRecordId: record.id, status: { not: 'rejected' } },
      _sum: { quantity: true },
    });
    const alreadyReturned = prior._sum.quantity ?? 0;
    const remaining = record.quantityDispensed - alreadyReturned;
    if (data.quantity > remaining) {
      throw AppError.badRequest(
        `Cannot return ${data.quantity} unit(s) — only ${Math.max(0, remaining)} of ${record.quantityDispensed} dispensed are still returnable`,
      );
    }

    // unitPrice on the record is per BASE unit and MRP (tax-inclusive); refund
    // the returned quantity net of the line discount that was applied at sale.
    unitPrice = record.unitPrice != null ? Number(record.unitPrice) : null;
    const discPct = record.discountPercent != null ? Number(record.discountPercent) : 0;
    if (unitPrice != null) {
      refundAmount = round2(unitPrice * data.quantity * (1 - discPct / 100));
    }
    // The staff-entered "money given" wins over the auto-computed billed price.
    if ((data as any).refundAmount != null) {
      refundAmount = round2(Number((data as any).refundAmount));
    }
  }

  if (!batchId) {
    throw AppError.badRequest('A drug batch or dispensing record is required');
  }

  // Validate drug batch exists
  const drugBatch = await prisma.drugBatch.findFirst({
    where: { id: batchId, tenantId },
  });

  if (!drugBatch) {
    throw AppError.notFound('Drug batch not found');
  }

  // Validate patient if patient return
  if (data.returnType === 'patient_return') {
    if (!patientId) {
      throw AppError.badRequest('Patient ID is required for patient returns');
    }
    const patient = await prisma.patient.findFirst({
      where: { id: patientId, tenantId },
    });
    if (!patient) {
      throw AppError.notFound('Patient not found');
    }
  }

  // Validate supplier if vendor return
  let creditNoteNumber: string | null = null;
  let creditAmount: number | null = null;
  if (data.returnType === 'vendor_return') {
    if (!data.supplierId) {
      throw AppError.badRequest('Supplier ID is required for vendor returns');
    }
    const supplier = await prisma.supplier.findFirst({
      where: { id: data.supplierId, tenantId },
    });
    if (!supplier) {
      throw AppError.notFound('Supplier not found');
    }
    // G5: credited value = explicit amount, else the returned stock at its
    // purchase price (what the distributor should credit back).
    creditNoteNumber = (data as any).creditNoteNumber ?? null;
    if ((data as any).creditAmount != null) {
      creditAmount = round2(Number((data as any).creditAmount));
    } else if (drugBatch.purchasePrice != null) {
      creditAmount = round2(Number(drugBatch.purchasePrice) * data.quantity);
    }
  }

  const drugReturn = await prisma.drugReturn.create({
    data: {
      tenantId,
      returnType: data.returnType as any,
      drugBatchId: batchId,
      patientId,
      supplierId: data.supplierId,
      quantity: data.quantity,
      reason: data.reason,
      status: 'pending',
      dispensingRecordId,
      billId,
      saleUnit,
      unitPrice,
      refundAmount,
      creditNoteNumber,
      creditAmount,
    },
    include: {
      drugBatch: {
        select: {
          id: true,
          batchNumber: true,
          drug: { select: { id: true, drugName: true } },
        },
      },
      drug: { select: { id: true, drugName: true } },
      patient: { select: { id: true, firstName: true, lastName: true } },
      supplier: { select: { id: true, name: true } },
    },
  });

  void safePharmacyAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'drug_return',
    entityId: drugReturn.id,
    description: `${data.returnType === 'vendor_return' ? 'Vendor' : 'Patient'} return recorded: ${data.quantity} × ${drugReturn.drugBatch?.drug?.drugName ?? 'drug'} (batch ${drugReturn.drugBatch?.batchNumber ?? '-'})`,
    newValues: { quantity: data.quantity, returnType: data.returnType, refundAmount },
  });

  logger.info(
    { tenantId, returnId: drugReturn.id, returnType: data.returnType, refundAmount },
    'Drug return created',
  );
  // Returns apply immediately — no separate approve step. This restocks the
  // batch and, for a patient return, books the refund against the bill so it
  // shows there straight away.
  return processReturn(tenantId, drugReturn.id, userId, {
    status: 'processed',
    ...((data as any).refundMode ? { refundMode: (data as any).refundMode } : {}),
  });
}

// ============================================================
// G13 — Ward stock sub-module
// ============================================================

// Generator for ward-charge bill numbers (IP Ward) when a patient has no open
// bill to post the ward dispense onto.
async function nextWardBillNumber(tx: any, tenantId: string): Promise<string> {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const prefix = `IPW-${ymd}-`;
  const todays = await tx.bill.count({ where: { tenantId, billNumber: { startsWith: prefix } } });
  return `${prefix}${String(todays + 1).padStart(4, '0')}`;
}

/** G13: move stock from the central pharmacy into a ward's own stock. */
export async function transferToWard(
  tenantId: string,
  userId: string,
  roles: string[],
  data: { wardId: string; drugBatchId: string; quantity: number },
) {
  assertPharmacyAdmin(roles, 'transfer stock to wards');
  if (data.quantity <= 0) throw AppError.badRequest('Quantity must be positive');

  const ward = await prisma.ward.findFirst({ where: { id: data.wardId, tenantId }, select: { id: true } });
  if (!ward) throw AppError.notFound('Ward not found');

  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.drugBatch.findFirst({ where: { id: data.drugBatchId, tenantId } });
    if (!batch) throw AppError.notFound('Drug batch not found');
    if (isBatchExpired(batch)) throw AppError.badRequest('Cannot transfer an expired batch');
    if (batch.isRecalled) throw AppError.badRequest('Cannot transfer a recalled batch');
    if (batch.quantityInStock < data.quantity) {
      throw AppError.badRequest(`Insufficient central stock (have ${batch.quantityInStock}, need ${data.quantity})`);
    }

    await tx.drugBatch.update({
      where: { id: batch.id },
      data: { quantityInStock: { decrement: data.quantity } },
    });

    const existing = await tx.wardStock.findFirst({
      where: { tenantId, wardId: data.wardId, drugBatchId: data.drugBatchId },
    });
    const wardStock = existing
      ? await tx.wardStock.update({ where: { id: existing.id }, data: { quantityInStock: { increment: data.quantity } } })
      : await tx.wardStock.create({
          data: { tenantId, wardId: data.wardId, drugId: batch.drugId, drugBatchId: batch.id, quantityInStock: data.quantity },
        });

    await tx.wardStockLedger.create({
      data: {
        tenantId,
        wardId: data.wardId,
        drugId: batch.drugId,
        drugBatchId: batch.id,
        movementType: 'received',
        quantity: data.quantity,
        performedBy: userId,
      },
    });

    return wardStock;
  });

  logger.info({ tenantId, wardId: data.wardId, drugBatchId: data.drugBatchId, qty: data.quantity }, 'Stock transferred to ward');
  return result;
}

/** G13: current on-hand ward stock (qty > 0) with drug + batch detail. */
export async function getWardStock(tenantId: string, wardId: string) {
  const rows = await prisma.wardStock.findMany({
    where: { tenantId, wardId, quantityInStock: { gt: 0 } },
    orderBy: { updatedAt: 'desc' },
    take: 2000,
  });
  const batchIds = rows.map((r) => r.drugBatchId);
  const batches = batchIds.length
    ? await prisma.drugBatch.findMany({
        where: { id: { in: batchIds } },
        select: { id: true, batchNumber: true, expiryDate: true, sellingPrice: true, drug: { select: { id: true, drugName: true, looseUnitLabel: true } } },
      })
    : [];
  const byId = new Map(batches.map((b) => [b.id, b]));
  const items = rows.map((r) => {
    const b = byId.get(r.drugBatchId);
    return {
      id: r.id,
      drugId: r.drugId,
      drugBatchId: r.drugBatchId,
      drugName: b?.drug?.drugName ?? '-',
      looseUnitLabel: b?.drug?.looseUnitLabel ?? null,
      batchNumber: b?.batchNumber ?? null,
      expiryDate: b?.expiryDate ?? null,
      sellingPrice: b?.sellingPrice != null ? Number(b.sellingPrice) : null,
      quantityInStock: r.quantityInStock,
    };
  });
  return { items, total: items.length };
}

/** G13: ward medicine ledger (received / dispensed / returned / adjusted). */
export async function getWardLedger(
  tenantId: string,
  query: { wardId: string; fromDate?: string; toDate?: string },
) {
  const where: any = { tenantId, wardId: query.wardId };
  if (query.fromDate || query.toDate) {
    where.createdAt = {};
    if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
    if (query.toDate) where.createdAt.lte = new Date(query.toDate);
  }
  const rows = await prisma.wardStockLedger.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 2000,
  });
  const batchIds = [...new Set(rows.map((r) => r.drugBatchId))];
  const patientIds = [...new Set(rows.map((r) => r.patientId).filter((x): x is string => !!x))];
  const [batches, patients] = await Promise.all([
    batchIds.length
      ? prisma.drugBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, batchNumber: true, drug: { select: { drugName: true } } } })
      : Promise.resolve([]),
    patientIds.length
      ? prisma.patient.findMany({ where: { id: { in: patientIds } }, select: { id: true, mrn: true, firstName: true, lastName: true } })
      : Promise.resolve([]),
  ]);
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const patientById = new Map(patients.map((p) => [p.id, p]));
  const items = rows.map((r) => {
    const b = batchById.get(r.drugBatchId);
    const p = r.patientId ? patientById.get(r.patientId) : null;
    return {
      id: r.id,
      date: r.createdAt,
      movementType: r.movementType,
      drugName: b?.drug?.drugName ?? '-',
      batchNumber: b?.batchNumber ?? null,
      quantity: r.quantity,
      patient: p ? `${p.firstName} ${p.lastName ?? ''}`.trim() : null,
      patientMrn: p?.mrn ?? null,
      reason: r.reason,
    };
  });
  return { items, total: items.length };
}

/**
 * IP design doc (Step 3 — Credit & Clearance Check). Before dispensing routine
 * drugs to a CASH IP patient, the system must confirm the running bill hasn't
 * outrun the deposit. Returns the patient's live credit picture so the UI can
 * show a "Credit Limit Exceeded — Clearance Required" warning. Package /
 * insurance / corporate patients settle against advance / TPA and are never
 * gated here; life-saving drugs bypass the gate entirely.
 */
export async function getPatientCreditStatus(tenantId: string, patientId: string) {
  const [admission, patient] = await Promise.all([
    prisma.admission.findFirst({
      where: { tenantId, patientId, status: 'admitted' },
      orderBy: { admissionDate: 'desc' },
      select: { id: true, billingCategory: true, depositAmount: true },
    }),
    prisma.patient.findFirst({ where: { id: patientId, tenantId }, select: { mrn: true } }),
  ]);
  const category = (admission?.billingCategory ?? 'cash').toLowerCase();
  const deposit = admission ? Number(admission.depositAmount) : 0;
  // G6 (2.3): an Emergency/Casualty temp patient (TEMP-ER-…) is in the Golden-Hour
  // bypass — never held by the credit gate, even though it may now carry a
  // pending-placement admission with a zero deposit.
  const isEmergency = isEmergencyMrn(patient?.mrn);

  // Running bill = the patient's currently-open (unsettled) bills.
  const agg = await prisma.bill.aggregate({
    where: { tenantId, patientId, status: { in: ['draft', 'pending', 'partially_paid'] } },
    _sum: { totalAmount: true, balanceDue: true },
  });
  const billed = round2(Number(agg._sum.totalAmount ?? 0));
  const balanceDue = round2(Number(agg._sum.balanceDue ?? 0));
  const available = round2(deposit - billed);
  const exceeded = billed > deposit;
  // Only cash IP patients are held; everyone else (and emergency) settles elsewhere.
  const requiresClearance = !isEmergency && !!admission && category === 'cash' && exceeded;

  return {
    patientId,
    hasAdmission: !!admission,
    admissionId: admission?.id ?? null,
    category,
    deposit,
    billed,
    balanceDue,
    available,
    exceeded,
    requiresClearance,
  };
}

/**
 * §4.1 Flow 2 — consolidated IP billing summary for a patient: every non-cancelled
 * bill, charges grouped by service category, deposit / paid / balance, and (for
 * insurance / corporate patients) the insurer + TPA + policy header. This is the
 * TPA-format summary the hospital submits for cashless settlement; for cash /
 * package patients it doubles as a plain running statement.
 */
export async function getIpBillingSummary(tenantId: string, patientId: string) {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
    select: { id: true, mrn: true, firstName: true, lastName: true, phone: true, gender: true, dateOfBirth: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');

  const admission = await prisma.admission.findFirst({
    where: { tenantId, patientId, status: 'admitted' },
    orderBy: { admissionDate: 'desc' },
    select: { id: true, billingCategory: true, depositAmount: true, admissionDate: true },
  });
  const category = (admission?.billingCategory ?? 'cash').toLowerCase();
  const isTpa = category === 'insurance' || category === 'corporate';

  // Insurer / TPA header for a cashless submission.
  let insurance:
    | { insurer: string | null; tpa: string | null; policyNumber: string; planName: string | null }
    | null = null;
  if (isTpa) {
    const policy = await prisma.insurancePolicy.findFirst({
      where: { tenantId, patientId },
      orderBy: { createdAt: 'desc' },
      select: {
        policyNumber: true,
        planName: true,
        insurer: { select: { name: true } },
        tpa: { select: { name: true } },
      },
    });
    if (policy) {
      insurance = {
        insurer: policy.insurer?.name ?? null,
        tpa: policy.tpa?.name ?? null,
        policyNumber: policy.policyNumber,
        planName: policy.planName ?? null,
      };
    }
  }

  const bills = await prisma.bill.findMany({
    where: { tenantId, patientId, status: { not: 'cancelled' } },
    orderBy: { billDate: 'asc' },
    select: {
      id: true,
      billNumber: true,
      billDate: true,
      totalAmount: true,
      amountPaid: true,
      balanceDue: true,
      status: true,
      billItems: {
        orderBy: { createdAt: 'asc' },
        select: { description: true, category: true, quantity: true, unitPrice: true, totalAmount: true },
      },
    },
  });

  // Group charges by service category (pharmacy / lab / radiology / procedure / …)
  // for the TPA breakup line.
  const byCategory: Record<string, number> = {};
  for (const b of bills) {
    for (const it of b.billItems) {
      const c = String(it.category);
      byCategory[c] = round2((byCategory[c] ?? 0) + Number(it.totalAmount));
    }
  }
  const categoryTotals = Object.entries(byCategory)
    .map(([cat, amount]) => ({ category: cat, amount }))
    .sort((a, b) => b.amount - a.amount);

  const totalBilled = round2(bills.reduce((s, b) => s + Number(b.totalAmount), 0));
  const totalPaid = round2(bills.reduce((s, b) => s + Number(b.amountPaid), 0));
  const balanceDue = round2(bills.reduce((s, b) => s + Number(b.balanceDue), 0));
  const deposit = admission ? Number(admission.depositAmount) : 0;

  // TPA reimbursable split (spec — Cashless/TPA): a cashless insurer pays for the
  // reimbursable drugs but not certain disposables/consumables, which the patient
  // settles out-of-pocket. Plus the take-home (TTO) discharge meds total. Derived
  // from this patient's pharmacy dispenses via each drug's isReimbursable flag.
  const dispenses = (await prisma.dispensingRecord.findMany({
    where: { tenantId, patientId },
    select: {
      lineTotal: true,
      isTto: true,
      drugBatch: { select: { drug: { select: { isReimbursable: true } } } },
    },
  })) ?? [];
  let reimbursable = 0;
  let nonReimbursable = 0;
  let takeHome = 0;
  for (const d of dispenses) {
    const amt = Number(d.lineTotal ?? 0);
    if (d.drugBatch?.drug?.isReimbursable === false) nonReimbursable += amt;
    else reimbursable += amt;
    if (d.isTto) takeHome += amt;
  }

  return {
    patient,
    admission: admission ? { ...admission, billingCategory: category } : null,
    category,
    isTpa,
    insurance,
    bills,
    categoryTotals,
    // Reimbursable = claim from TPA; non-reimbursable = collect from patient.
    pharmacySplit: {
      reimbursable: round2(reimbursable),
      nonReimbursable: round2(nonReimbursable),
      takeHome: round2(takeHome),
    },
    totals: { totalBilled, totalPaid, balanceDue, deposit, available: round2(deposit - balanceDue) },
  };
}

// ============================================================
// OP pre-packing — "Stock Hold" / "Pre-Packed" (spec OP Step 1)
// ============================================================

/**
 * Pre-pack a prescription before the patient arrives: reserve each line from its
 * chosen batch (deducting it from the Available-to-Sell pool) WITHOUT billing.
 * Quantities are in BASE (loose) units. The hold sits until it is collected
 * (converted to a paid sale) or released (returned to the pool).
 */
export async function prePackHold(
  tenantId: string,
  userId: string,
  data: {
    patientId?: string;
    prescriptionId?: string;
    notes?: string;
    items: Array<{ drugBatchId: string; quantity: number }>;
  },
) {
  if (!data.items?.length) throw AppError.badRequest('Add at least one item to pre-pack');
  if (data.patientId) {
    const p = await prisma.patient.findFirst({ where: { id: data.patientId, tenantId }, select: { id: true } });
    if (!p) throw AppError.notFound('Patient not found');
  }

  return prisma.$transaction(async (tx) => {
    const holdItems: any[] = [];
    for (const item of data.items) {
      if (item.quantity <= 0) throw AppError.badRequest('Quantity must be positive');
      const batch = await tx.drugBatch.findFirst({
        where: { id: item.drugBatchId, tenantId },
        include: { drug: { select: { drugName: true, price: true, taxPercent: true } } },
      });
      if (!batch) throw AppError.notFound(`Drug batch ${item.drugBatchId} not found`);
      if (isBatchExpired(batch)) throw AppError.badRequest('Cannot pre-pack from an expired batch');
      if (batch.isRecalled) throw AppError.badRequest('Cannot pre-pack from a recalled batch');
      if (batch.quantityInStock < item.quantity) {
        throw AppError.badRequest(`Insufficient stock for ${batch.drug?.drugName ?? 'drug'} (have ${batch.quantityInStock}, need ${item.quantity})`);
      }
      await tx.drugBatch.update({ where: { id: batch.id }, data: { quantityInStock: { decrement: item.quantity } } });
      holdItems.push({
        drugFormularyId: batch.drugId,
        drugBatchId: batch.id,
        quantity: item.quantity,
        saleUnit: 'loose',
        unitPrice: pickDispenseUnitPrice(batch as any),
        taxPercent: batch.drug?.taxPercent != null ? Number(batch.drug.taxPercent) : 0,
      });
    }
    const hold = await tx.pharmacyStockHold.create({
      data: {
        tenantId,
        patientId: data.patientId ?? null,
        prescriptionId: data.prescriptionId ?? null,
        status: 'held',
        createdById: userId,
        notes: data.notes ?? null,
        items: { create: holdItems },
      },
      include: { items: { include: { drug: { select: { drugName: true, strength: true } }, drugBatch: { select: { batchNumber: true } } } } },
    });
    logger.info({ tenantId, holdId: hold.id, items: holdItems.length }, 'Pharmacy stock pre-packed (held)');
    return hold;
  });
}

/**
 * Collect a pre-packed hold when the patient arrives: convert it into a paid
 * sale. The held stock is restored and then billed through the normal sale path
 * (one invoice, dispensing records, payment) so the receipt/GST/returns all work
 * identically. On any sale failure the stock is re-held so the invariant holds.
 */
export async function collectHold(
  tenantId: string,
  userId: string,
  holdId: string,
  extras: { payments?: any[]; billDiscountPercent?: number; billDiscountAmount?: number } = {},
) {
  const hold = await prisma.pharmacyStockHold.findFirst({ where: { id: holdId, tenantId }, include: { items: true } });
  if (!hold) throw AppError.notFound('Stock hold not found');
  if (hold.status !== 'held') throw AppError.badRequest(`This hold is already ${hold.status}.`);

  // Restore the reserved stock so the normal sale can deduct + bill it.
  await prisma.$transaction(async (tx) => {
    for (const it of hold.items) {
      await tx.drugBatch.update({ where: { id: it.drugBatchId }, data: { quantityInStock: { increment: it.quantity } } });
    }
  });

  try {
    const sale = await createPharmacySale(tenantId, userId, {
      patientId: hold.patientId ?? undefined,
      prescriptionId: hold.prescriptionId ?? undefined,
      items: hold.items.map((i) => ({ drugBatchId: i.drugBatchId, quantity: i.quantity, saleUnit: 'loose' as const })),
      payments: extras.payments,
      billDiscountPercent: extras.billDiscountPercent,
      billDiscountAmount: extras.billDiscountAmount,
    } as CreatePharmacySaleInput);
    const updated = await prisma.pharmacyStockHold.update({
      where: { id: holdId },
      data: { status: 'collected', collectedAt: new Date(), billId: sale.bill.id },
    });
    return { hold: updated, sale };
  } catch (err) {
    // Sale failed — re-hold the stock so the reservation invariant is preserved.
    await prisma.$transaction(async (tx) => {
      for (const it of hold.items) {
        await tx.drugBatch.update({ where: { id: it.drugBatchId }, data: { quantityInStock: { decrement: it.quantity } } });
      }
    });
    throw err;
  }
}

/** Release a hold the patient never collected — return all reserved stock. */
export async function releaseHold(tenantId: string, userId: string, holdId: string) {
  const hold = await prisma.pharmacyStockHold.findFirst({ where: { id: holdId, tenantId }, include: { items: true } });
  if (!hold) throw AppError.notFound('Stock hold not found');
  if (hold.status !== 'held') throw AppError.badRequest(`This hold is already ${hold.status}.`);
  return prisma.$transaction(async (tx) => {
    for (const it of hold.items) {
      await tx.drugBatch.update({ where: { id: it.drugBatchId }, data: { quantityInStock: { increment: it.quantity } } });
    }
    return tx.pharmacyStockHold.update({ where: { id: holdId }, data: { status: 'released', releasedAt: new Date() } });
  });
}

export async function listStockHolds(tenantId: string, query: { status?: string; patientId?: string } = {}) {
  const where: any = { tenantId };
  if (query.status) where.status = query.status;
  if (query.patientId) where.patientId = query.patientId;
  const rows = await prisma.pharmacyStockHold.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 1000,
    include: {
      patient: { select: { mrn: true, firstName: true, lastName: true } },
      items: { include: { drug: { select: { drugName: true, strength: true } }, drugBatch: { select: { batchNumber: true } } } },
    },
  });
  return {
    items: rows.map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.createdAt,
      collectedAt: r.collectedAt,
      patient: r.patient ? { mrn: r.patient.mrn, name: `${r.patient.firstName} ${r.patient.lastName ?? ''}`.trim() } : null,
      notes: r.notes,
      items: r.items.map((i) => ({
        id: i.id,
        drugName: i.drug?.drugName ?? '-',
        strength: i.drug?.strength ?? null,
        batchNumber: i.drugBatch?.batchNumber ?? null,
        quantity: i.quantity,
        unitPrice: i.unitPrice != null ? Number(i.unitPrice) : null,
      })),
      total: round2(r.items.reduce((s, i) => s + Number(i.unitPrice ?? 0) * i.quantity, 0)),
    })),
    total: rows.length,
  };
}

/**
 * G13: a ward dispenses a drug from its own stock to a patient. Decrements ward
 * stock, logs the ward ledger, and posts the charge to the patient's open IP
 * bill (creating a draft IP-ward bill if none) so it's billed next cycle.
 *
 * IP credit gate: for a cash patient whose running bill has outrun the deposit,
 * the dispense is blocked unless `override` (clearance given) is set or the drug
 * is flagged life-saving.
 */
export async function dispenseFromWard(
  tenantId: string,
  userId: string,
  data: { wardId: string; drugBatchId: string; patientId: string; quantity: number; admissionId?: string; reason?: string; override?: boolean },
) {
  if (data.quantity <= 0) throw AppError.badRequest('Quantity must be positive');

  const patient = await prisma.patient.findFirst({ where: { id: data.patientId, tenantId }, select: { id: true } });
  if (!patient) throw AppError.notFound('Patient not found');

  const result = await prisma.$transaction(async (tx) => {
    const ws = await tx.wardStock.findFirst({
      where: { tenantId, wardId: data.wardId, drugBatchId: data.drugBatchId },
    });
    if (!ws || ws.quantityInStock < data.quantity) {
      throw AppError.badRequest(`Insufficient ward stock (have ${ws?.quantityInStock ?? 0}, need ${data.quantity})`);
    }

    const batch = await tx.drugBatch.findUnique({
      where: { id: data.drugBatchId },
      include: { drug: { select: { drugName: true, price: true, taxPercent: true, isLifeSaving: true, isNarcotic: true, isReimbursable: true } } },
    });
    if (!batch) throw AppError.notFound('Drug batch not found');
    // NDPS "Locked in Main Safe": narcotics are dispensed only via the NDPS vault
    // custody + Form 3E workflow, never through ordinary ward stock.
    if (batch.drug?.isNarcotic) {
      throw AppError.badRequest(
        `${batch.drug.drugName} is an NDPS narcotic — dispense it via the NDPS (Form 3E) consumption workflow, not ward stock.`,
      );
    }

    // IP credit gate — block a cash patient who is over deposit unless clearance
    // was given (override) or the drug is life-saving (design doc IP Step 3).
    if (!data.override && !batch.drug?.isLifeSaving) {
      const credit = await getPatientCreditStatus(tenantId, data.patientId);
      if (credit.requiresClearance) {
        throw AppError.badRequest(
          `Credit Limit Exceeded — Clearance Required. Running bill ₹${credit.billed.toFixed(2)} exceeds deposit ₹${credit.deposit.toFixed(2)}. Collect a top-up deposit or dispense with clearance.`,
        );
      }
    }

    await tx.wardStock.update({ where: { id: ws.id }, data: { quantityInStock: { decrement: data.quantity } } });

    // Pricing — per base unit, MRP (tax-inclusive); derive embedded GST.
    const unitPrice = Number(batch.sellingPrice ?? batch.drug?.price ?? batch.purchasePrice ?? 0);
    const taxPct = batch.drug?.taxPercent != null ? Number(batch.drug.taxPercent) : 0;
    const gross = round2(unitPrice * data.quantity);
    const taxAmt = round2(gross - gross / (1 + taxPct / 100));

    // G2: scope the ward-issue bill to the admission (explicit hint or the
    // patient's active admission) so the running IP ledger is per-stay.
    const admId = data.admissionId
      ?? (await tx.admission.findFirst({ where: { tenantId, patientId: data.patientId, status: 'admitted' }, orderBy: { admissionDate: 'desc' }, select: { id: true } }))?.id
      ?? null;

    // Post the charge to the patient's open bill; else open a draft IP-ward bill.
    let bill = await tx.bill.findFirst({
      where: { tenantId, patientId: data.patientId, status: { in: ['draft', 'pending', 'partially_paid'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!bill) {
      bill = await tx.bill.create({
        data: {
          tenantId,
          billNumber: await nextWardBillNumber(tx, tenantId),
          patientId: data.patientId,
          admissionId: admId,
          billDate: new Date(),
          subtotal: 0,
          discountAmount: 0,
          taxAmount: 0,
          totalAmount: 0,
          patientPayableAmount: 0,
          amountPaid: 0,
          balanceDue: 0,
          status: 'draft',
          generatedBy: userId,
        },
      });
    } else if (!bill.admissionId && admId) {
      bill = await tx.bill.update({ where: { id: bill.id }, data: { admissionId: admId } });
    }

    await tx.billItem.create({
      data: {
        billId: bill.id,
        description: `${batch.drug?.drugName ?? 'Medication'} (Batch ${batch.batchNumber}) — ward issue, ${data.quantity} unit(s)`,
        category: 'pharmacy',
        quantity: data.quantity,
        unitPrice,
        taxPercent: taxPct,
        taxAmount: taxAmt,
        totalAmount: gross,
        referenceType: 'ward_dispense',
        referenceId: ws.id,
        isAutoPulled: true,
        isReimbursable: batch.drug?.isReimbursable ?? null,
      },
    });

    await tx.bill.update({
      where: { id: bill.id },
      data: {
        subtotal: round2(Number(bill.subtotal) + gross),
        taxAmount: round2(Number(bill.taxAmount) + taxAmt),
        totalAmount: round2(Number(bill.totalAmount) + gross),
        patientPayableAmount: round2(Number(bill.patientPayableAmount) + gross),
        balanceDue: round2(Number(bill.balanceDue) + gross),
      },
    });

    await tx.wardStockLedger.create({
      data: {
        tenantId,
        wardId: data.wardId,
        drugId: ws.drugId,
        drugBatchId: data.drugBatchId,
        movementType: 'dispensed',
        quantity: data.quantity,
        patientId: data.patientId,
        admissionId: data.admissionId ?? null,
        billId: bill.id,
        performedBy: userId,
        reason: data.reason ?? null,
      },
    });

    return { billId: bill.id, billNumber: bill.billNumber, charged: gross };
  });

  logger.info({ tenantId, ...data, ...result }, 'Ward stock dispensed to patient');
  return result;
}

/**
 * G13: return ward stock to the central pharmacy (the reverse of transferToWard).
 * Used when a ward has excess or near-expiry medicine — it goes back to central
 * (restoring the batch's stock so it can be re-issued or returned to the vendor)
 * and the movement is logged as 'returned' in the ward ledger.
 */
export async function returnWardStock(
  tenantId: string,
  userId: string,
  roles: string[],
  data: { wardId: string; drugBatchId: string; quantity: number; reason?: string },
) {
  assertPharmacyAdmin(roles, 'return ward stock');
  if (data.quantity <= 0) throw AppError.badRequest('Quantity must be positive');

  const ward = await prisma.ward.findFirst({ where: { id: data.wardId, tenantId }, select: { id: true } });
  if (!ward) throw AppError.notFound('Ward not found');

  const result = await prisma.$transaction(async (tx) => {
    const ws = await tx.wardStock.findFirst({
      where: { tenantId, wardId: data.wardId, drugBatchId: data.drugBatchId },
    });
    if (!ws || ws.quantityInStock < data.quantity) {
      throw AppError.badRequest(`Insufficient ward stock (have ${ws?.quantityInStock ?? 0}, need ${data.quantity})`);
    }

    await tx.wardStock.update({ where: { id: ws.id }, data: { quantityInStock: { decrement: data.quantity } } });
    // Restore central stock for the batch.
    await tx.drugBatch.update({ where: { id: data.drugBatchId }, data: { quantityInStock: { increment: data.quantity } } });

    await tx.wardStockLedger.create({
      data: {
        tenantId,
        wardId: data.wardId,
        drugId: ws.drugId,
        drugBatchId: data.drugBatchId,
        movementType: 'returned',
        quantity: data.quantity,
        performedBy: userId,
        reason: data.reason ?? null,
      },
    });

    return { wardStockId: ws.id, returned: data.quantity };
  });

  logger.info({ tenantId, ...data }, 'Ward stock returned to central');
  return result;
}

/**
 * G13: correct a ward's on-hand count (breakage, spillage, miscount) to a
 * physically-verified quantity. Central stock is NOT touched — this only fixes
 * the ward figure — and the signed delta is logged as 'adjusted' with the reason.
 */
export async function adjustWardStock(
  tenantId: string,
  userId: string,
  roles: string[],
  data: { wardId: string; drugBatchId: string; newQuantity: number; reason: string },
) {
  assertPharmacyAdmin(roles, 'adjust ward stock');
  if (data.newQuantity < 0) throw AppError.badRequest('Corrected quantity cannot be negative');

  const result = await prisma.$transaction(async (tx) => {
    const ws = await tx.wardStock.findFirst({
      where: { tenantId, wardId: data.wardId, drugBatchId: data.drugBatchId },
    });
    if (!ws) throw AppError.notFound('Ward stock not found');

    const from = ws.quantityInStock;
    const delta = data.newQuantity - from;
    await tx.wardStock.update({ where: { id: ws.id }, data: { quantityInStock: data.newQuantity } });

    await tx.wardStockLedger.create({
      data: {
        tenantId,
        wardId: data.wardId,
        drugId: ws.drugId,
        drugBatchId: data.drugBatchId,
        movementType: 'adjusted',
        quantity: Math.abs(delta),
        performedBy: userId,
        reason: `${data.reason} (${from} → ${data.newQuantity})`,
      },
    });

    return { wardStockId: ws.id, from, to: data.newQuantity, delta };
  });

  logger.info({ tenantId, ...data, delta: result.delta }, 'Ward stock adjusted');
  return result;
}

// ============================================================
// G15 — Mandatory pharmacy reports
// ============================================================

/** Daily Transaction Report (EOD): counter sales for a day + payment-mode breakup. */
export async function getDailyTransactionReport(tenantId: string, dateStr?: string) {
  const day = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(day);
  end.setHours(23, 59, 59, 999);

  const bills = await prisma.bill.findMany({
    where: { tenantId, billNumber: { startsWith: 'PH-' }, billDate: { gte: start, lte: end } },
    select: {
      id: true,
      billNumber: true,
      billDate: true,
      totalAmount: true,
      discountAmount: true,
      taxAmount: true,
      amountPaid: true,
      status: true,
      patient: { select: { firstName: true, lastName: true, mrn: true } },
      payments: { select: { amount: true, paymentMethod: true, status: true } },
    },
    orderBy: { billDate: 'asc' },
    take: 2000,
  });

  const byMode: Record<string, number> = {};
  let gross = 0;
  let discount = 0;
  let tax = 0;
  let collected = 0;
  let cancelled = 0;
  for (const b of bills) {
    if (b.status === 'cancelled') {
      cancelled += 1;
      continue;
    }
    gross += Number(b.totalAmount ?? 0);
    discount += Number(b.discountAmount ?? 0);
    tax += Number(b.taxAmount ?? 0);
    collected += Number(b.amountPaid ?? 0);
    for (const p of b.payments) {
      if (p.status !== 'completed') continue;
      byMode[p.paymentMethod] = round2((byMode[p.paymentMethod] ?? 0) + Number(p.amount));
    }
  }

  return {
    date: start,
    bills,
    summary: {
      billCount: bills.length - cancelled,
      cancelledCount: cancelled,
      gross: round2(gross),
      discount: round2(discount),
      tax: round2(tax),
      collected: round2(collected),
      byPaymentMode: byMode,
    },
  };
}

/** Purchase Report: stock inward (batches received) over a date range. */
export async function getPurchaseReport(
  tenantId: string,
  query: { fromDate?: string; toDate?: string; supplierId?: string },
) {
  const where: any = { tenantId };
  if (query.supplierId) where.supplierId = query.supplierId;
  if (query.fromDate || query.toDate) {
    where.createdAt = {};
    if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
    if (query.toDate) where.createdAt.lte = new Date(query.toDate);
  }

  const batches = await prisma.drugBatch.findMany({
    where,
    select: {
      id: true,
      batchNumber: true,
      expiryDate: true,
      createdAt: true,
      mrp: true,
      purchasePrice: true,
      purchaseDiscountPercent: true,
      gstPercent: true,
      quantityReceived: true,
      freeQuantity: true,
      invoiceNumber: true,
      invoiceDate: true,
      drug: { select: { id: true, drugName: true } },
      supplier: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 3000,
  });

  let totalQty = 0;
  let totalValue = 0;
  let totalTax = 0;
  const items = batches.map((b) => {
    const econ = batchPurchaseEconomics(b as any);
    totalQty += b.quantityReceived;
    totalValue += econ.netPurchaseValue ?? 0;
    totalTax += econ.taxAmount ?? 0;
    return {
      batchId: b.id,
      drugName: b.drug?.drugName ?? '-',
      batchNumber: b.batchNumber,
      supplier: b.supplier?.name ?? null,
      invoiceNumber: b.invoiceNumber ?? null,
      invoiceDate: b.invoiceDate ?? null,
      receivedAt: b.createdAt,
      expiryDate: b.expiryDate,
      quantityReceived: b.quantityReceived,
      freeQuantity: b.freeQuantity ?? 0,
      mrp: b.mrp != null ? Number(b.mrp) : null,
      purchaseRate: b.purchasePrice != null ? Number(b.purchasePrice) : null,
      discountPercent: b.purchaseDiscountPercent != null ? Number(b.purchaseDiscountPercent) : null,
      gstPercent: b.gstPercent != null ? Number(b.gstPercent) : null,
      netPurchaseValue: econ.netPurchaseValue,
      taxAmount: econ.taxAmount,
    };
  });

  return {
    items,
    totals: { lineCount: items.length, totalQty, totalValue: round2(totalValue), totalTax: round2(totalTax) },
  };
}

/** Stock Valuation Report: on-hand stock at purchase value and selling value. */
export async function getStockValuationReport(tenantId: string) {
  const batches = await prisma.drugBatch.findMany({
    where: { tenantId, isExpired: false, quantityInStock: { gt: 0 } },
    select: {
      id: true,
      batchNumber: true,
      quantityInStock: true,
      purchasePrice: true,
      sellingPrice: true,
      expiryDate: true,
      drug: { select: { id: true, drugName: true } },
    },
    orderBy: { drug: { drugName: 'asc' } },
    take: 5000,
  });

  let totalPurchaseValue = 0;
  let totalSellingValue = 0;
  const items = batches.map((b) => {
    const purchaseValue = round2(Number(b.purchasePrice ?? 0) * b.quantityInStock);
    const sellingValue = round2(Number(b.sellingPrice ?? 0) * b.quantityInStock);
    totalPurchaseValue += purchaseValue;
    totalSellingValue += sellingValue;
    return {
      batchId: b.id,
      drugName: b.drug?.drugName ?? '-',
      batchNumber: b.batchNumber,
      quantityInStock: b.quantityInStock,
      expiryDate: b.expiryDate,
      purchaseValue,
      sellingValue,
    };
  });

  return {
    items,
    totals: {
      batchCount: items.length,
      totalPurchaseValue: round2(totalPurchaseValue),
      totalSellingValue: round2(totalSellingValue),
      potentialMargin: round2(totalSellingValue - totalPurchaseValue),
    },
  };
}

/**
 * Vendor-wise Segregation (G15): per-vendor purchase value, stock qty, medicines.
 * Each row carries the vendor's metadata (GSTIN / drug-licence / contact) so the
 * report auto-populates vendor details on dropdown selection rather than only an
 * id. When a single vendor is selected, `vendor` returns that supplier's full
 * record even if it has no batches yet.
 */
export async function getVendorWiseReport(tenantId: string, supplierId?: string) {
  const where: any = { tenantId, supplierId: supplierId ?? { not: null } };
  const batches = await prisma.drugBatch.findMany({
    where,
    select: {
      drugId: true,
      supplierId: true,
      quantityReceived: true,
      quantityInStock: true,
      purchasePrice: true,
      purchaseDiscountPercent: true,
      supplier: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          address: true,
          gstNumber: true,
          licenseNumber: true,
          supplyType: true,
        },
      },
    },
    take: 8000,
  });

  type VendorMeta = {
    phone: string | null;
    email: string | null;
    address: string | null;
    gstNumber: string | null;
    licenseNumber: string | null;
    supplyType: string | null;
  };
  const map = new Map<
    string,
    {
      supplierId: string;
      supplierName: string;
      totalPaid: number;
      totalQty: number;
      inStockQty: number;
      drugIds: Set<string>;
      batchCount: number;
      meta: VendorMeta;
    }
  >();
  for (const b of batches) {
    if (!b.supplierId) continue;
    const net = Number(b.purchasePrice ?? 0) * (1 - Number(b.purchaseDiscountPercent ?? 0) / 100) * b.quantityReceived;
    const cur =
      map.get(b.supplierId) ??
      {
        supplierId: b.supplierId,
        supplierName: b.supplier?.name ?? '-',
        totalPaid: 0,
        totalQty: 0,
        inStockQty: 0,
        drugIds: new Set<string>(),
        batchCount: 0,
        meta: {
          phone: b.supplier?.phone ?? null,
          email: b.supplier?.email ?? null,
          address: b.supplier?.address ?? null,
          gstNumber: b.supplier?.gstNumber ?? null,
          licenseNumber: b.supplier?.licenseNumber ?? null,
          supplyType: (b.supplier?.supplyType as string | null) ?? null,
        },
      };
    cur.totalPaid += net;
    cur.totalQty += b.quantityReceived;
    cur.inStockQty += b.quantityInStock;
    cur.drugIds.add(b.drugId);
    cur.batchCount += 1;
    map.set(b.supplierId, cur);
  }

  const items = [...map.values()]
    .map((v) => ({
      supplierId: v.supplierId,
      supplierName: v.supplierName,
      totalPaid: round2(v.totalPaid),
      totalQty: v.totalQty,
      inStockQty: v.inStockQty,
      medicineCount: v.drugIds.size,
      batchCount: v.batchCount,
      ...v.meta,
    }))
    .sort((a, b) => b.totalPaid - a.totalPaid);

  // Auto-populate the selected vendor's metadata even when it has no purchases yet.
  let vendor: (VendorMeta & { id: string; name: string; isActive: boolean }) | null = null;
  if (supplierId) {
    const s = await prisma.supplier.findFirst({
      where: { id: supplierId, tenantId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        address: true,
        gstNumber: true,
        licenseNumber: true,
        supplyType: true,
        isActive: true,
      },
    });
    if (s) {
      vendor = {
        id: s.id,
        name: s.name,
        isActive: s.isActive,
        phone: s.phone ?? null,
        email: s.email ?? null,
        address: s.address ?? null,
        gstNumber: s.gstNumber ?? null,
        licenseNumber: s.licenseNumber ?? null,
        supplyType: (s.supplyType as string | null) ?? null,
      };
    }
  }

  return {
    vendor,
    items,
    totals: {
      vendorCount: items.length,
      totalPaid: round2(items.reduce((s, i) => s + i.totalPaid, 0)),
      totalQty: items.reduce((s, i) => s + i.totalQty, 0),
    },
  };
}

/** Supplier Credit Notes: vendor returns with the supplier's credit note + value. */
export async function getCreditNotesReport(
  tenantId: string,
  query: { fromDate?: string; toDate?: string; supplierId?: string },
) {
  const where: any = { tenantId, returnType: 'vendor_return' };
  if (query.supplierId) where.supplierId = query.supplierId;
  if (query.fromDate || query.toDate) {
    where.createdAt = {};
    if (query.fromDate) where.createdAt.gte = new Date(query.fromDate);
    if (query.toDate) where.createdAt.lte = new Date(query.toDate);
  }

  const rows = await prisma.drugReturn.findMany({
    where,
    select: {
      id: true,
      createdAt: true,
      quantity: true,
      status: true,
      creditNoteNumber: true,
      creditAmount: true,
      reason: true,
      supplier: { select: { id: true, name: true } },
      drugBatch: { select: { batchNumber: true, drug: { select: { drugName: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 2000,
  });

  const items = rows.map((r) => ({
    id: r.id,
    date: r.createdAt,
    supplier: r.supplier?.name ?? null,
    drugName: r.drugBatch?.drug?.drugName ?? null,
    batchNumber: r.drugBatch?.batchNumber ?? null,
    quantity: r.quantity,
    status: r.status,
    creditNoteNumber: r.creditNoteNumber,
    creditAmount: r.creditAmount != null ? Number(r.creditAmount) : null,
    reason: r.reason,
  }));

  return {
    items,
    totals: {
      noteCount: items.length,
      totalCredit: round2(items.reduce((s, i) => s + (i.creditAmount ?? 0), 0)),
    },
  };
}

/**
 * G9: reorder list — formulary drugs whose live stock has fallen to/below their
 * reorder level (minStock). Drives a draft purchase order (not auto-sent). Each
 * row suggests an order quantity and the last supplier used.
 */
export async function getReorderList(tenantId: string) {
  const drugs = await prisma.drugFormulary.findMany({
    where: { tenantId, isActive: true, minStock: { not: null } },
    select: {
      id: true,
      drugName: true,
      strength: true,
      manufacturer: true,
      minStock: true,
      packSize: true,
      drugBatches: {
        where: { isExpired: false, isRecalled: false, quantityInStock: { gt: 0 } },
        select: { quantityInStock: true },
      },
      // Most recent batch → last supplier used (for the draft PO).
      // (separate ordered fetch below to keep this select lean)
    },
    take: 5000,
  });

  const lowIds: string[] = [];
  const base = drugs
    .map((d) => {
      const stock = d.drugBatches.reduce((s, b) => s + b.quantityInStock, 0);
      return { d, stock };
    })
    .filter(({ d, stock }) => d.minStock != null && stock <= d.minStock);

  base.forEach(({ d }) => lowIds.push(d.id));

  // Last supplier per low-stock drug (most recent batch with a supplier).
  const lastSupplierByDrug = new Map<string, string>();
  if (lowIds.length) {
    const recent = await prisma.drugBatch.findMany({
      where: { tenantId, drugId: { in: lowIds }, supplierId: { not: null } },
      select: { drugId: true, supplier: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    for (const r of recent) {
      if (!lastSupplierByDrug.has(r.drugId) && r.supplier) {
        lastSupplierByDrug.set(r.drugId, r.supplier.name);
      }
    }
  }

  const items = base.map(({ d, stock }) => {
    const minStock = d.minStock ?? 0;
    // Suggest topping up to ~2× the reorder level (at least the reorder level).
    const suggestedQty = Math.max(minStock * 2 - stock, minStock);
    return {
      drugId: d.id,
      drugName: d.drugName,
      strength: d.strength,
      manufacturer: d.manufacturer,
      stock,
      minStock,
      suggestedQty,
      lastSupplier: lastSupplierByDrug.get(d.id) ?? null,
    };
  });

  return { items, total: items.length };
}

// ============================================================
// G9 — Draft Purchase Orders for drugs
// ============================================================
// The reorder list above is a read-only report. These turn it into actual,
// persisted DRAFT purchase orders (grouped by the drug's last-used supplier) that
// the pharmacy reviews and marks "sent" — never auto-dispatched. Drugs already on
// an open (draft/sent) PO are skipped so repeated generation never duplicates.

const DRUG_PO_INCLUDE = {
  supplier: { select: { id: true, name: true, gstNumber: true, phone: true } },
  items: {
    include: { drug: { select: { id: true, drugName: true, strength: true, manufacturer: true } } },
  },
} as const;

const DRUG_PO_TRANSITIONS: Record<string, string[]> = {
  draft: ['sent', 'cancelled'],
  sent: ['received', 'cancelled'],
  received: [],
  cancelled: [],
};

export async function generateReorderDraftPOs(tenantId: string, userId: string, roles: string[]) {
  assertPharmacyAdmin(roles, 'generate purchase orders');
  const { items } = await getReorderList(tenantId);
  if (!items.length) return { created: 0, skipped: 0, purchaseOrders: [] as unknown[] };

  // Don't re-order drugs already on an open (draft/sent) PO — avoids duplicates.
  const openItems = await prisma.drugPurchaseOrderItem.findMany({
    where: { purchaseOrder: { tenantId, status: { in: ['draft', 'sent'] } } },
    select: { drugId: true },
  });
  const alreadyOpen = new Set(openItems.map((i) => i.drugId));
  const toOrder = items.filter((i) => !alreadyOpen.has(i.drugId));
  const skipped = items.length - toOrder.length;
  if (!toOrder.length) return { created: 0, skipped, purchaseOrders: [] as unknown[] };

  // Resolve the last-used supplier per drug to group the orders.
  const recent = await prisma.drugBatch.findMany({
    where: { tenantId, drugId: { in: toOrder.map((i) => i.drugId) }, supplierId: { not: null } },
    select: { drugId: true, supplierId: true },
    orderBy: { createdAt: 'desc' },
  });
  const supplierByDrug = new Map<string, string>();
  for (const r of recent) {
    if (r.supplierId && !supplierByDrug.has(r.drugId)) supplierByDrug.set(r.drugId, r.supplierId);
  }

  // Group items by supplier (null = unassigned → one "to be assigned" PO).
  const groups = new Map<string | null, typeof toOrder>();
  for (const it of toOrder) {
    const sid = supplierByDrug.get(it.drugId) ?? null;
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid)!.push(it);
  }

  const stamp = Date.now();
  let idx = 0;
  const purchaseOrders: unknown[] = [];
  for (const [supplierId, groupItems] of groups) {
    const po = await prisma.drugPurchaseOrder.create({
      data: {
        tenantId,
        supplierId: supplierId ?? null,
        orderNumber: `DPO-${stamp}-${idx++}`,
        status: 'draft',
        createdBy: userId,
        notes: 'Auto-generated from reorder — drugs at/below minimum stock.',
        items: {
          create: groupItems.map((g) => ({ drugId: g.drugId, quantityOrdered: g.suggestedQty })),
        },
      },
      include: DRUG_PO_INCLUDE,
    });
    purchaseOrders.push(po);
  }

  logger.info({ tenantId, created: purchaseOrders.length, skipped }, 'Reorder draft POs generated');
  return { created: purchaseOrders.length, skipped, purchaseOrders };
}

export async function getDrugPurchaseOrders(tenantId: string, query: { status?: string }) {
  const where: { tenantId: string; status?: string } = { tenantId };
  if (query.status) where.status = query.status;
  const orders = await prisma.drugPurchaseOrder.findMany({
    where: where as never,
    orderBy: { createdAt: 'desc' },
    include: DRUG_PO_INCLUDE,
    take: 200,
  });
  return { orders };
}

export async function getDrugPurchaseOrderById(tenantId: string, id: string) {
  const order = await prisma.drugPurchaseOrder.findFirst({
    where: { id, tenantId },
    include: DRUG_PO_INCLUDE,
  });
  if (!order) throw AppError.notFound('Purchase order not found');
  return order;
}

export async function updateDrugPurchaseOrder(
  tenantId: string,
  roles: string[],
  id: string,
  data: { supplierId?: string | null; notes?: string; items?: Array<{ drugId: string; quantityOrdered: number }> },
) {
  assertPharmacyAdmin(roles, 'edit purchase orders');
  const po = await prisma.drugPurchaseOrder.findFirst({ where: { id, tenantId } });
  if (!po) throw AppError.notFound('Purchase order not found');
  if (po.status !== 'draft') throw AppError.badRequest('Only a draft purchase order can be edited.');

  await prisma.$transaction(async (tx) => {
    if (data.items) {
      await tx.drugPurchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
      if (data.items.length) {
        await tx.drugPurchaseOrderItem.createMany({
          data: data.items.map((i) => ({
            purchaseOrderId: id,
            drugId: i.drugId,
            quantityOrdered: i.quantityOrdered,
          })),
        });
      }
    }
    await tx.drugPurchaseOrder.update({
      where: { id },
      data: {
        supplierId: data.supplierId !== undefined ? data.supplierId || null : undefined,
        notes: data.notes !== undefined ? data.notes : undefined,
      },
    });
  });

  return getDrugPurchaseOrderById(tenantId, id);
}

export async function setDrugPurchaseOrderStatus(
  tenantId: string,
  roles: string[],
  id: string,
  status: string,
) {
  assertPharmacyAdmin(roles, 'update purchase orders');
  const po = await prisma.drugPurchaseOrder.findFirst({ where: { id, tenantId } });
  if (!po) throw AppError.notFound('Purchase order not found');
  if (!DRUG_PO_TRANSITIONS[po.status]?.includes(status)) {
    throw AppError.badRequest(`Cannot move a ${po.status} purchase order to ${status}.`);
  }
  if (status === 'sent' && !po.supplierId) {
    throw AppError.badRequest('Assign a supplier before sending this purchase order.');
  }
  await prisma.drugPurchaseOrder.update({ where: { id }, data: { status: status as never } });
  return getDrugPurchaseOrderById(tenantId, id);
}

export async function deleteDrugPurchaseOrder(tenantId: string, roles: string[], id: string) {
  assertPharmacyAdmin(roles, 'delete purchase orders');
  const po = await prisma.drugPurchaseOrder.findFirst({ where: { id, tenantId } });
  if (!po) throw AppError.notFound('Purchase order not found');
  if (po.status !== 'draft') throw AppError.badRequest('Only a draft purchase order can be deleted.');
  await prisma.drugPurchaseOrder.delete({ where: { id } });
  logger.info({ tenantId, id }, 'Drug purchase order deleted');
}

// Indian controlled / habit-forming schedules a drug inspector audits.
const CONTROLLED_SCHEDULES = ['X', 'H1', 'H'];

/**
 * G17: Narcotic / controlled-drug register for a Drug Inspector audit —
 * dispenses of scheduled drugs (Schedule X / H1 / H), filterable by the
 * dispensing user and date range.
 */
export async function getNarcoticRegister(
  tenantId: string,
  query: { fromDate?: string; toDate?: string; dispensedBy?: string; schedule?: string },
) {
  const where: any = {
    tenantId,
    drugBatch: {
      drug: {
        drugMaster: {
          schedule: query.schedule ? { equals: query.schedule } : { in: CONTROLLED_SCHEDULES },
        },
      },
    },
  };
  if (query.dispensedBy) where.dispensedBy = query.dispensedBy;
  if (query.fromDate || query.toDate) {
    where.dispensedAt = {};
    if (query.fromDate) where.dispensedAt.gte = new Date(query.fromDate);
    if (query.toDate) where.dispensedAt.lte = new Date(query.toDate);
  }

  const rows = await prisma.dispensingRecord.findMany({
    where,
    select: {
      id: true,
      quantityDispensed: true,
      dispensedAt: true,
      billId: true,
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      dispenser: { select: { id: true, firstName: true, lastName: true } },
      drugBatch: {
        select: {
          batchNumber: true,
          drug: {
            select: { drugName: true, drugMaster: { select: { schedule: true } } },
          },
        },
      },
    },
    orderBy: { dispensedAt: 'desc' },
    take: 3000,
  });

  const items = rows.map((r) => ({
    id: r.id,
    date: r.dispensedAt,
    drugName: r.drugBatch?.drug?.drugName ?? '-',
    schedule: r.drugBatch?.drug?.drugMaster?.schedule ?? null,
    batchNumber: r.drugBatch?.batchNumber ?? null,
    quantity: r.quantityDispensed,
    patient: r.patient ? `${r.patient.firstName} ${r.patient.lastName ?? ''}`.trim() : null,
    patientMrn: r.patient?.mrn ?? null,
    dispensedBy: r.dispenser ? `${r.dispenser.firstName} ${r.dispenser.lastName ?? ''}`.trim() : null,
    billId: r.billId,
  }));

  return { items, total: items.length };
}

// ============================================================
// Barcode-driven dispensing + compliance (spec Section 2)
// ============================================================

/**
 * Resolve a single counter scan to a product + batch. Accepts a GS1 DataMatrix
 * element string (GTIN + batch + expiry), a plain GTIN/EAN, one of our minted
 * internal batch barcodes, or a raw batch number. Returns the drug, the picked
 * batch (the GS1 batch if present, else the FEFO batch), expiry/mfg dates and
 * the live stock — everything the POS needs from one scan.
 */
export async function resolveScan(tenantId: string, code: string) {
  const raw = (code ?? '').trim();
  if (!raw) throw AppError.badRequest('No barcode provided');

  const gs1 = parseGs1(raw);
  let gtin = gs1?.gtin;
  const scannedBatchNumber = gs1?.batchNumber;
  // A bare 8–14 digit string with no GS1 AIs is a plain GTIN/EAN.
  if (!gtin && !gs1 && /^\d{8,14}$/.test(raw)) gtin = raw;

  const drugSelect = {
    id: true, drugName: true, genericName: true, strength: true, dosageForm: true,
    gtin: true, casePackGtin: true, unitsPerCase: true, packSize: true,
    looseUnitLabel: true, price: true, hsnCode: true, taxPercent: true,
  } as const;

  let drug: any = null;
  let batch: any = null;

  // 1. GTIN → drug. Match either the 13- or 14-digit form (GS1 codes are
  // 14-digit; typed/EAN ones usually 13 — the same product).
  if (gtin) {
    const variants = gtinVariants(gtin);
    drug = await prisma.drugFormulary.findFirst({
      where: { tenantId, OR: [{ gtin: { in: variants } }, { casePackGtin: { in: variants } }] },
      select: drugSelect,
    });
  }

  // 2. Internal/known batch barcode → batch directly (then its drug).
  if (!drug && (isInternalBarcode(raw) || !gs1)) {
    batch = await prisma.drugBatch.findFirst({
      where: { tenantId, barcode: raw },
      include: { drug: { select: drugSelect } },
    });
    if (batch) drug = batch.drug;
  }

  // 3. Raw batch-number label fallback (no GS1, no internal barcode).
  if (!drug && !batch && !gtin) {
    batch = await prisma.drugBatch.findFirst({
      where: { tenantId, batchNumber: raw, quantityInStock: { gt: 0 } },
      orderBy: { expiryDate: 'asc' },
      include: { drug: { select: drugSelect } },
    });
    if (batch) drug = batch.drug;
  }

  if (!drug) throw AppError.notFound('No product matched this barcode');

  // Pick the batch: the GS1-scanned batch if named, else FEFO (earliest expiry).
  if (!batch) {
    batch = await prisma.drugBatch.findFirst({
      where: {
        tenantId,
        drugId: drug.id,
        isExpired: false,
        isRecalled: false,
        quantityInStock: { gt: 0 },
        ...(scannedBatchNumber ? { batchNumber: scannedBatchNumber } : {}),
      },
      orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
    });
  }

  const stock = await prisma.drugBatch.aggregate({
    where: { tenantId, drugId: drug.id, isExpired: false, isRecalled: false, quantityInStock: { gt: 0 } },
    _sum: { quantityInStock: true },
  });

  return {
    resolvedVia: gs1 ? 'gs1' : gtin ? 'gtin' : 'batch',
    gtin: gtin ?? null,
    scannedBatchNumber: scannedBatchNumber ?? null,
    drug: {
      id: drug.id,
      drugName: drug.drugName,
      genericName: drug.genericName,
      strength: drug.strength,
      dosageForm: drug.dosageForm,
      packSize: drug.packSize,
      looseUnitLabel: drug.looseUnitLabel,
      price: drug.price != null ? Number(drug.price) : null,
      hsnCode: drug.hsnCode ?? null,
    },
    batch: batch
      ? {
          id: batch.id,
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate,
          manufacturingDate: batch.manufacturingDate ?? null,
          sellingPrice: batch.sellingPrice != null ? Number(batch.sellingPrice) : null,
          mrp: batch.mrp != null ? Number(batch.mrp) : null,
          quantityInStock: batch.quantityInStock,
          barcode: batch.barcode ?? null,
        }
      : null,
    totalStock: stock._sum.quantityInStock ?? 0,
  };
}

/**
 * Automated compliance validation (spec Section 2) run BEFORE a sale completes.
 * For every cart line it checks: HSN code present, GST rate present, and the
 * Schedule H/H1/X / controlled-drug rule. Schedule X without a prescription is a
 * hard blocker (a prescription is mandatory by law); H/H1 without one is a
 * warning the counter must heed and record. Returns blockers + warnings; the
 * caller blocks the sale when `ok` is false.
 */
export async function checkSaleCompliance(
  tenantId: string,
  input: { items: Array<{ drugBatchId: string }>; prescriptionId?: string | null },
) {
  const hasRx = !!input.prescriptionId;
  const batchIds = [...new Set(input.items.map((i) => i.drugBatchId).filter(Boolean))];
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!batchIds.length) return { ok: true, blockers, warnings };

  const batches = (await prisma.drugBatch.findMany({
    where: { id: { in: batchIds }, tenantId },
    select: {
      id: true,
      drug: {
        select: {
          drugName: true,
          hsnCode: true,
          taxPercent: true,
          drugMaster: { select: { schedule: true } },
        },
      },
    },
  })) ?? [];

  for (const b of batches) {
    const name = b.drug?.drugName ?? 'Drug';
    const schedule = (b.drug?.drugMaster?.schedule ?? '').toUpperCase();
    if (!b.drug?.hsnCode) warnings.push(`${name}: HSN code not set (required for a compliant GST invoice).`);
    if (b.drug?.taxPercent == null) warnings.push(`${name}: GST rate not set.`);
    if (CONTROLLED_SCHEDULES.includes(schedule)) {
      if (schedule === 'X' && !hasRx) {
        blockers.push(`${name} is a Schedule X drug — a prescription is mandatory to dispense it.`);
      } else if (!hasRx) {
        warnings.push(`${name} is a Schedule ${schedule} drug — record the prescriber/Rx for this sale.`);
      }
    }
  }

  return { ok: blockers.length === 0, blockers, warnings };
}

export async function getReturns(tenantId: string, query: GetReturnsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.returnType) where.returnType = query.returnType;
  if (query.status) where.status = query.status;

  if (query.search) {
    where.OR = [
      { drugBatch: { batchNumber: { contains: query.search, mode: 'insensitive' } } },
      { drugBatch: { drug: { drugName: { contains: query.search, mode: 'insensitive' } } } },
      { drug: { drugName: { contains: query.search, mode: 'insensitive' } } },
      { batchNumber: { contains: query.search, mode: 'insensitive' } },
      { reason: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [returns, total] = await Promise.all([
    prisma.drugReturn.findMany({
      where,
      skip,
      take,
      include: {
        drugBatch: {
          select: {
            id: true,
            batchNumber: true,
            drug: { select: { id: true, drugName: true } },
          },
        },
        drug: { select: { id: true, drugName: true } },
        patient: { select: { id: true, firstName: true, lastName: true } },
        supplier: { select: { id: true, name: true } },
        processor: { select: { id: true, firstName: true, lastName: true } },
        refund: { select: { id: true, amount: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.drugReturn.count({ where }),
  ]);

  return { returns, total, page, limit };
}

/**
 * Full return record + hospital header for the return-acknowledgement receipt
 * (G3). Mirrors the sale receipt's payload so the print dialog has everything
 * it needs in one call (drug, batch, patient, refund, original bill number).
 */
export async function getReturnById(tenantId: string, id: string) {
  const drugReturn = await prisma.drugReturn.findFirst({
    where: { id, tenantId },
    include: {
      drugBatch: {
        select: { id: true, batchNumber: true, expiryDate: true, drug: { select: { id: true, drugName: true, looseUnitLabel: true } } },
      },
      drug: { select: { id: true, drugName: true, looseUnitLabel: true } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
      supplier: { select: { id: true, name: true } },
      processor: { select: { id: true, firstName: true, lastName: true } },
      refund: { select: { id: true, amount: true, status: true } },
    },
  });
  if (!drugReturn) throw AppError.notFound('Drug return not found');

  // Resolve the original sale's invoice number (billId is a plain back-pointer).
  let billNumber: string | null = null;
  if (drugReturn.billId) {
    const bill = await prisma.bill.findFirst({
      where: { id: drugReturn.billId, tenantId },
      select: { billNumber: true },
    });
    billNumber = bill?.billNumber ?? null;
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      name: true,
      logoUrl: true,
      address: true,
      city: true,
      state: true,
      phone: true,
      email: true,
    },
  });

  return { return: drugReturn, billNumber, hospital: tenant };
}

/**
 * Counter-sale lines for a patient that still have units eligible for return —
 * powers the "pick the original sale" step of a patient return. Only sales
 * billed at the counter (billId set) in the recent past are offered; each line's
 * remaining qty is the dispensed amount minus what has already been returned
 * (excluding rejected returns).
 */
export async function getReturnableDispenses(
  tenantId: string,
  params: { patientId?: string; billNumber?: string },
) {
  const since = new Date();
  since.setDate(since.getDate() - 120);

  // G3: when a bill number is presented, resolve it first so the picker can be
  // driven purely off the physical bill (and surface whose bill it is).
  let billPatient: { id: string; mrn: string | null; firstName: string; lastName: string | null } | null =
    null;
  const where: any = { tenantId, billId: { not: null }, dispensedAt: { gte: since } };
  if (params.billNumber) {
    const bill = await prisma.bill.findFirst({
      where: { tenantId, billNumber: params.billNumber },
      select: {
        id: true,
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      },
    });
    if (!bill) throw AppError.notFound('Bill not found');
    where.billId = bill.id;
    billPatient = bill.patient ?? null;
  } else if (params.patientId) {
    where.patientId = params.patientId;
  } else {
    throw AppError.badRequest('Provide a patientId or a billNumber');
  }

  const records = await prisma.dispensingRecord.findMany({
    where,
    include: {
      drugBatch: {
        select: {
          batchNumber: true,
          drug: { select: { drugName: true, looseUnitLabel: true } },
        },
      },
      drugReturns: { where: { status: { not: 'rejected' } }, select: { quantity: true } },
    },
    orderBy: { dispensedAt: 'desc' },
  });

  // billId on DispensingRecord is a plain back-pointer (no relation) — resolve
  // the invoice numbers in one extra query.
  const billIds = Array.from(
    new Set(records.map((r) => r.billId).filter((b): b is string => !!b)),
  );
  const bills = billIds.length
    ? await prisma.bill.findMany({
        where: { id: { in: billIds }, tenantId },
        select: { id: true, billNumber: true },
      })
    : [];
  const billNumberById = new Map(bills.map((b) => [b.id, b.billNumber]));

  const items = records
    .map((r) => {
      const returned = r.drugReturns.reduce((s, x) => s + x.quantity, 0);
      const remaining = r.quantityDispensed - returned;
      return {
        id: r.id,
        drugName: r.drugBatch?.drug?.drugName ?? 'Medication',
        looseUnitLabel: r.drugBatch?.drug?.looseUnitLabel ?? null,
        batchNumber: r.drugBatch?.batchNumber ?? null,
        billId: r.billId,
        billNumber: r.billId ? billNumberById.get(r.billId) ?? null : null,
        saleUnit: r.saleUnit ?? 'pack',
        unitPrice: r.unitPrice != null ? Number(r.unitPrice) : null,
        quantityDispensed: r.quantityDispensed,
        remaining,
        // §4.4: surfaced so the picker shows non-returnable lines as such
        // (the createReturn guard also blocks them server-side).
        nonReturnable: r.nonReturnable,
        dispensedAt: r.dispensedAt,
      };
    })
    .filter((i) => i.remaining > 0);

  return { items, total: items.length, patient: billPatient };
}

export async function processReturn(
  tenantId: string,
  id: string,
  userId: string,
  data: ProcessReturnInput,
) {
  const drugReturn = await prisma.drugReturn.findFirst({
    where: { id, tenantId },
  });

  if (!drugReturn) {
    throw AppError.notFound('Drug return not found');
  }

  if (drugReturn.status !== 'pending') {
    throw AppError.badRequest('Only pending returns can be processed');
  }

  // If approving (processed): restock and, for billing-linked patient returns,
  // pay the patient back by creating a Refund against the original sale's
  // payment and reducing the bill — mirroring billing.approveRefund.
  if (data.status === 'processed') {
    const result = await prisma.$transaction(async (tx) => {
      // Resolve which batch to restock. Patient/vendor returns always carry a
      // drugBatchId. A counter return may carry one too; if not, match its
      // free-text batch number against an existing batch for the same medicine,
      // or create one when an expiry was supplied. With no batch info at all we
      // log the return without a stock movement (an admin can add stock later).
      let restockBatchId = drugReturn.drugBatchId;
      if (!restockBatchId && drugReturn.returnType === 'counter_return' && drugReturn.drugId) {
        if (drugReturn.batchNumber) {
          const existing = await tx.drugBatch.findFirst({
            where: { tenantId, drugId: drugReturn.drugId, batchNumber: drugReturn.batchNumber },
            select: { id: true },
          });
          if (existing) {
            restockBatchId = existing.id;
          } else if (drugReturn.expiryDate) {
            const drug = await tx.drugFormulary.findUnique({
              where: { id: drugReturn.drugId },
              select: { price: true },
            });
            const created = await tx.drugBatch.create({
              data: {
                tenantId,
                drugId: drugReturn.drugId,
                batchNumber: drugReturn.batchNumber,
                expiryDate: drugReturn.expiryDate,
                sellingPrice: drug?.price ?? null,
                quantityReceived: 0,
                quantityInStock: 0,
              },
              select: { id: true },
            });
            restockBatchId = created.id;
          }
        }
      }

      await tx.drugReturn.update({
        where: { id },
        // Link the resolved batch back so the record shows where stock went.
        data: { status: 'processed', processedBy: userId, drugBatchId: restockBatchId },
      });

      // Move stock. Patient / counter returns come BACK into stock (increment).
      // A vendor return (expired/damaged stock sent back to the distributor)
      // LEAVES stock (decrement, floored at 0) — G5.
      if (restockBatchId) {
        if (drugReturn.returnType === 'vendor_return') {
          const batch = await tx.drugBatch.findUnique({
            where: { id: restockBatchId },
            select: { quantityInStock: true },
          });
          const dec = Math.min(drugReturn.quantity, batch?.quantityInStock ?? 0);
          if (dec > 0) {
            await tx.drugBatch.update({
              where: { id: restockBatchId },
              data: { quantityInStock: { decrement: dec } },
            });
          }
        } else {
          await tx.drugBatch.update({
            where: { id: restockBatchId },
            data: { quantityInStock: { increment: drugReturn.quantity } },
          });
        }
      }

      const refundDue =
        drugReturn.refundAmount != null ? Number(drugReturn.refundAmount) : 0;
      if (
        drugReturn.returnType === 'patient_return' &&
        drugReturn.billId &&
        drugReturn.patientId &&
        refundDue > 0
      ) {
        const payment = await tx.payment.findFirst({
          where: { billId: drugReturn.billId, tenantId, status: 'completed' },
          orderBy: { paymentDate: 'desc' },
          include: { bill: true },
        });
        if (payment?.bill) {
          // G14: decide whether to refund cash or credit the patient's advance.
          // Explicit refundMode wins; otherwise auto-detect from the patient's
          // active admission billing category (package/insurance → advance).
          let mode: 'cash' | 'advance' = (data as any).refundMode ?? 'cash';
          const admission = await tx.admission.findFirst({
            where: { tenantId, patientId: drugReturn.patientId, status: 'admitted' },
            orderBy: { admissionDate: 'desc' },
            select: { id: true, billingCategory: true, depositAmount: true },
          });
          if (!(data as any).refundMode && admission) {
            const cat = (admission.billingCategory ?? 'cash').toLowerCase();
            if (cat === 'package' || cat === 'insurance') mode = 'advance';
          }

          const refund = await tx.refund.create({
            data: {
              tenantId,
              billId: drugReturn.billId,
              paymentId: payment.id,
              patientId: drugReturn.patientId,
              amount: refundDue,
              reason:
                mode === 'advance'
                  ? `Drug return — credited to advance${drugReturn.reason ? `: ${drugReturn.reason}` : ''}`
                  : `Drug return${drugReturn.reason ? `: ${drugReturn.reason}` : ''}`,
              status: 'approved',
              requestedBy: userId,
              approvedBy: userId,
              processedAt: new Date(),
            },
          });

          // Reduce what the bill counts as collected (same maths as a billing
          // refund approval) so the cash counter / receipts stay accurate.
          const newPaid = Number(payment.bill.amountPaid) - refundDue;
          const newBalance = Number(payment.bill.totalAmount) - newPaid;
          const newStatus =
            newPaid <= 0 ? 'refunded' : newBalance > 0 ? 'partially_paid' : payment.bill.status;
          await tx.bill.update({
            where: { id: payment.bill.id },
            data: { amountPaid: newPaid, balanceDue: newBalance, status: newStatus as any },
          });

          // G14: advance mode parks the refunded value on the IP admission's
          // deposit (advance) pool instead of paying cash out.
          if (mode === 'advance' && admission) {
            await tx.admission.update({
              where: { id: admission.id },
              data: { depositAmount: Number(admission.depositAmount) + refundDue },
            });
          }

          await tx.drugReturn.update({ where: { id }, data: { refundId: refund.id } });
        }
      }

      return tx.drugReturn.findUnique({
        where: { id },
        include: {
          drugBatch: {
            select: {
              id: true,
              batchNumber: true,
              drug: { select: { id: true, drugName: true } },
            },
          },
          drug: { select: { id: true, drugName: true } },
          patient: { select: { id: true, firstName: true, lastName: true } },
          supplier: { select: { id: true, name: true } },
          processor: { select: { id: true, firstName: true, lastName: true } },
          refund: { select: { id: true, amount: true, status: true } },
        },
      });
    });

    // Post-commit: tell the patient their refund is on the way.
    try {
      if (result?.patientId && result.refundId && result.patient) {
        const patient = await prisma.patient.findUnique({
          where: { id: result.patientId },
          select: { userId: true },
        });
        if (patient?.userId) {
          void safePharmacyNotify({
            tenantId,
            userId: patient.userId,
            title: 'Medicine return refund processed',
            message: `Your return of ${result.drugBatch?.drug?.drugName ?? 'medication'} has been accepted and ₹${Number(result.refund?.amount ?? 0).toFixed(2)} refunded.`,
            referenceType: 'drug_return',
            referenceId: result.id,
          });
        }
      }
    } catch (err) {
      logger.warn({ err, returnId: id }, 'Pharmacy return refund notify failed');
    }

    void safePharmacyAudit({
      tenantId,
      userId,
      action: 'update',
      entityType: 'drug_return',
      entityId: id,
      description: result?.drugBatchId
        ? `Return approved — restocked ${drugReturn.quantity} unit(s) to batch ${result?.drugBatch?.batchNumber ?? '-'}`
        : `Return approved — ${drugReturn.quantity} unit(s) logged (no batch to restock)`,
      oldValues: { status: 'pending' },
      newValues: { status: 'processed', restockedQuantity: result?.drugBatchId ? drugReturn.quantity : 0 },
    });

    logger.info({ tenantId, returnId: id, status: 'processed', processedBy: userId }, 'Drug return processed');
    return result;
  }

  // Rejected -- no stock adjustment
  const updated = await prisma.drugReturn.update({
    where: { id },
    data: {
      status: 'rejected',
      processedBy: userId,
    },
    include: {
      drugBatch: {
        select: {
          id: true,
          batchNumber: true,
          drug: { select: { id: true, drugName: true } },
        },
      },
      drug: { select: { id: true, drugName: true } },
      patient: { select: { id: true, firstName: true, lastName: true } },
      supplier: { select: { id: true, name: true } },
      processor: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  void safePharmacyAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'drug_return',
    entityId: id,
    description: 'Return rejected — no stock adjustment',
    oldValues: { status: 'pending' },
    newValues: { status: 'rejected' },
  });

  logger.info({ tenantId, returnId: id, status: 'rejected', processedBy: userId }, 'Drug return rejected');
  return updated;
}

// ============================================================
// Stock ledger — batch-wise movement register
// ============================================================
// The register Indian pharmacies keep for drug-license inspections: every
// inflow (batch receipt, approved return) and outflow (dispense / counter
// sale) in the window, batch-wise, newest first, with window totals and the
// live closing stock.

export interface StockLedgerEntry {
  date: Date;
  movementType: 'receipt' | 'dispense' | 'patient_return' | 'vendor_return' | 'counter_return';
  drugId: string;
  drugName: string;
  batchNumber: string;
  quantityIn: number;
  quantityOut: number;
  party: string | null;
  referenceId: string;
}

export async function getStockLedger(tenantId: string, query: GetStockLedgerQuery) {
  const toDate = query.toDate ? new Date(query.toDate) : new Date();
  const fromDate = query.fromDate
    ? new Date(query.fromDate)
    : (() => {
        const d = new Date(toDate);
        d.setDate(d.getDate() - 30);
        return d;
      })();
  const page = query.page ?? 1;
  const limit = query.limit ?? 50;

  const window = { gte: fromDate, lte: toDate };
  const batchDrugFilter = query.drugId ? { drugBatch: { drugId: query.drugId } } : {};

  const [batches, dispenses, returns, stockAgg] = await Promise.all([
    prisma.drugBatch.findMany({
      where: { tenantId, createdAt: window, ...(query.drugId ? { drugId: query.drugId } : {}) },
      include: {
        drug: { select: { id: true, drugName: true } },
        supplier: { select: { name: true } },
      },
    }),
    prisma.dispensingRecord.findMany({
      where: { tenantId, dispensedAt: window, ...batchDrugFilter },
      include: {
        drugBatch: { select: { batchNumber: true, drug: { select: { id: true, drugName: true } } } },
        patient: { select: { firstName: true, lastName: true, mrn: true } },
      },
    }),
    // DrugReturn has no processedAt; createdAt is close enough for a
    // window-bounded register (returns are processed within days).
    // Only returns that actually moved stock back in — counter returns without a
    // resolved batch (drugBatchId still null after approval) never incremented
    // stock, so they don't belong in the inflow register.
    prisma.drugReturn.findMany({
      where: { tenantId, status: 'processed', createdAt: window, drugBatchId: { not: null }, ...batchDrugFilter },
      include: {
        drugBatch: { select: { batchNumber: true, drug: { select: { id: true, drugName: true } } } },
        drug: { select: { id: true, drugName: true } },
        supplier: { select: { name: true } },
      },
    }),
    prisma.drugBatch.aggregate({
      where: { tenantId, isExpired: false, ...(query.drugId ? { drugId: query.drugId } : {}) },
      _sum: { quantityInStock: true },
    }),
  ]);

  const entries: StockLedgerEntry[] = [
    ...batches.map((b): StockLedgerEntry => ({
      date: b.createdAt,
      movementType: 'receipt',
      drugId: b.drug.id,
      drugName: b.drug.drugName,
      batchNumber: b.batchNumber,
      quantityIn: b.quantityReceived,
      quantityOut: 0,
      party: b.supplier?.name ?? null,
      referenceId: b.id,
    })),
    ...dispenses.map((d): StockLedgerEntry => ({
      date: d.dispensedAt,
      movementType: 'dispense',
      drugId: d.drugBatch.drug.id,
      drugName: d.drugBatch.drug.drugName,
      batchNumber: d.drugBatch.batchNumber,
      quantityIn: 0,
      quantityOut: d.quantityDispensed,
      party: d.patient ? `${d.patient.firstName} ${d.patient.lastName} (${d.patient.mrn})` : null,
      referenceId: d.id,
    })),
    ...returns.map((r): StockLedgerEntry => ({
      date: r.createdAt,
      movementType:
        r.returnType === 'vendor_return'
          ? 'vendor_return'
          : r.returnType === 'counter_return'
          ? 'counter_return'
          : 'patient_return',
      drugId: r.drugBatch?.drug.id ?? r.drug?.id ?? '',
      drugName: r.drugBatch?.drug.drugName ?? r.drug?.drugName ?? 'Medication',
      batchNumber: r.drugBatch?.batchNumber ?? r.batchNumber ?? '-',
      quantityIn: r.quantity,
      quantityOut: 0,
      party: r.supplier?.name ?? null,
      referenceId: r.id,
    })),
  ].sort((a, b) => b.date.getTime() - a.date.getTime());

  const totalIn = entries.reduce((s, e) => s + e.quantityIn, 0);
  const totalOut = entries.reduce((s, e) => s + e.quantityOut, 0);

  return {
    fromDate: fromDate.toISOString(),
    toDate: toDate.toISOString(),
    entries: entries.slice((page - 1) * limit, page * limit),
    page,
    limit,
    total: entries.length,
    summary: {
      totalReceived: batches.reduce((s, b) => s + b.quantityReceived, 0),
      totalDispensed: dispenses.reduce((s, d) => s + d.quantityDispensed, 0),
      totalReturned: returns.reduce((s, r) => s + r.quantity, 0),
      totalIn,
      totalOut,
      netChange: totalIn - totalOut,
      closingStock: stockAgg._sum.quantityInStock ?? 0,
    },
  };
}

// ============================================================
// Analytics — drives the Pharmacy Reports page
// ============================================================
// One endpoint, four bundled reports (Sales / Expiry / Stock Usage / Batch-wise)
// so the frontend can render the whole dashboard from a single fetch and avoid
// flicker across sections.

export async function getPharmacyAnalytics(
  tenantId: string,
  range: { fromDate?: string; toDate?: string },
) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const monthAgo = new Date(today); monthAgo.setDate(monthAgo.getDate() - 30);
  const ninetyDaysFromNow = new Date(today); ninetyDaysFromNow.setDate(ninetyDaysFromNow.getDate() + 90);

  const dispenseWhere: any = { tenantId };
  if (range.fromDate) dispenseWhere.dispensedAt = { ...dispenseWhere.dispensedAt, gte: new Date(range.fromDate) };
  if (range.toDate) dispenseWhere.dispensedAt = { ...dispenseWhere.dispensedAt, lte: new Date(range.toDate) };

  const [
    allDispenses,
    todayDispenses,
    weekDispenses,
    monthDispenses,
    expiringBatches,
    expiredBatches,
    activeBatches,
  ] = await Promise.all([
    prisma.dispensingRecord.findMany({
      where: dispenseWhere,
      include: {
        drugBatch: {
          select: {
            sellingPrice: true,
            purchasePrice: true,
            drug: { select: { id: true, drugName: true } },
          },
        },
      },
    }),
    prisma.dispensingRecord.findMany({
      where: { tenantId, dispensedAt: { gte: today } },
      include: { drugBatch: { select: { sellingPrice: true } } },
    }),
    prisma.dispensingRecord.findMany({
      where: { tenantId, dispensedAt: { gte: weekAgo } },
      include: { drugBatch: { select: { sellingPrice: true } } },
    }),
    prisma.dispensingRecord.findMany({
      where: { tenantId, dispensedAt: { gte: monthAgo } },
      include: { drugBatch: { select: { sellingPrice: true } } },
    }),
    prisma.drugBatch.findMany({
      where: {
        tenantId,
        isExpired: false,
        isRecalled: false,
        expiryDate: { gte: today, lte: ninetyDaysFromNow },
        quantityInStock: { gt: 0 },
      },
      include: { drug: { select: { drugName: true } } },
      orderBy: { expiryDate: 'asc' },
    }),
    prisma.drugBatch.findMany({
      where: { tenantId, OR: [{ isExpired: true }, { expiryDate: { lt: today } }] },
      include: { drug: { select: { drugName: true } } },
      take: 50,
    }),
    prisma.drugBatch.findMany({
      where: { tenantId, isExpired: false, isRecalled: false, quantityInStock: { gt: 0 } },
      include: { drug: { select: { drugName: true } } },
    }),
  ]);

  const lineRevenue = (r: { quantityDispensed: number; drugBatch: { sellingPrice: any } | null }) =>
    Number(r.drugBatch?.sellingPrice ?? 0) * r.quantityDispensed;

  const lineMargin = (r: {
    quantityDispensed: number;
    drugBatch: { sellingPrice: any; purchasePrice: any } | null;
  }) => (Number(r.drugBatch?.sellingPrice ?? 0) - Number(r.drugBatch?.purchasePrice ?? 0)) * r.quantityDispensed;

  const totalRevenue = allDispenses.reduce((s, r) => s + lineRevenue(r), 0);
  const totalMargin = allDispenses.reduce((s, r) => s + lineMargin(r), 0);

  // Top-dispensed drugs
  const drugTally = new Map<string, { drugId: string; drugName: string; qty: number; revenue: number }>();
  for (const r of allDispenses) {
    const drug = r.drugBatch?.drug;
    if (!drug) continue;
    const k = drug.id;
    const prev = drugTally.get(k);
    const inc = lineRevenue(r);
    if (prev) {
      prev.qty += r.quantityDispensed;
      prev.revenue += inc;
    } else {
      drugTally.set(k, { drugId: drug.id, drugName: drug.drugName, qty: r.quantityDispensed, revenue: inc });
    }
  }
  const topDrugs = Array.from(drugTally.values()).sort((a, b) => b.qty - a.qty).slice(0, 15);

  // Sum helpers for sale windows
  const sumRevenue = (rows: typeof todayDispenses) =>
    rows.reduce((s, r) => s + Number(r.drugBatch?.sellingPrice ?? 0) * r.quantityDispensed, 0);

  // Batch-wise summary
  const totalStockValue = activeBatches.reduce(
    (s, b) => s + Number(b.purchasePrice ?? 0) * b.quantityInStock,
    0,
  );
  const totalRetailValue = activeBatches.reduce(
    (s, b) => s + Number(b.sellingPrice ?? 0) * b.quantityInStock,
    0,
  );

  // Expiry "value at risk" = retail value of soon-to-expire stock
  const valueAtRisk = expiringBatches.reduce(
    (s, b) => s + Number(b.sellingPrice ?? 0) * b.quantityInStock,
    0,
  );

  // Slow movers — active batches that haven't been dispensed at all in range
  const dispensedBatchIds = new Set(allDispenses.map((r) => (r as any).drugBatchId));
  const slowMovers = activeBatches
    .filter((b) => !dispensedBatchIds.has(b.id))
    .slice(0, 25)
    .map((b) => ({
      batchId: b.id,
      drugName: b.drug.drugName,
      batchNumber: b.batchNumber,
      quantityInStock: b.quantityInStock,
      expiryDate: b.expiryDate,
    }));

  return {
    sales: {
      today: sumRevenue(todayDispenses),
      week: sumRevenue(weekDispenses),
      month: sumRevenue(monthDispenses),
      rangeRevenue: totalRevenue,
      rangeMargin: totalMargin,
      rangeTransactions: allDispenses.length,
    },
    topDrugs,
    expiry: {
      soonCount: expiringBatches.length,
      expiredCount: expiredBatches.length,
      valueAtRisk: Number(valueAtRisk.toFixed(2)),
      upcoming: expiringBatches.slice(0, 25).map((b) => ({
        batchId: b.id,
        drugName: b.drug.drugName,
        batchNumber: b.batchNumber,
        quantityInStock: b.quantityInStock,
        expiryDate: b.expiryDate,
        sellingPrice: Number(b.sellingPrice ?? 0),
      })),
    },
    stockUsage: {
      activeBatches: activeBatches.length,
      slowMovers,
    },
    batchSummary: {
      activeBatches: activeBatches.length,
      totalStockValue: Number(totalStockValue.toFixed(2)),
      totalRetailValue: Number(totalRetailValue.toFixed(2)),
      potentialMargin: Number((totalRetailValue - totalStockValue).toFixed(2)),
    },
  };
}

// ============================================================
// Recall Management
// ============================================================
// Marks a BATCH as recalled — a recall always names a specific batch, never a
// whole medicine. The dispense path already rejects recalled batches, so once
// flagged the stock is auto-blocked. Returns the list of patients who received
// doses of the batch so the clinic can contact them.

export async function recallBatch(
  tenantId: string,
  batchId: string,
  userId: string,
  data: RecallBatchInput,
) {
  const batch = await prisma.drugBatch.findFirst({
    where: { id: batchId, tenantId },
  });
  if (!batch) throw AppError.notFound('Drug batch not found');

  const updated = await prisma.drugBatch.update({
    where: { id: batchId },
    data: {
      isRecalled: true,
      recallReason: data.recallReason,
    },
    include: {
      drug: { select: { id: true, drugName: true, genericName: true } },
      supplier: { select: { id: true, name: true } },
    },
  });

  // Notify pharmacy admins
  try {
    const pharmacyUsers = await prisma.user.findMany({
      where: {
        tenantId,
        isActive: true,
        userRoles: {
          some: { role: { name: { in: ['pharmacy_admin', 'pharmacist', 'admin'] } } },
        },
      },
      select: { id: true },
      take: 25,
    });
    for (const u of pharmacyUsers) {
      void safePharmacyNotify({
        tenantId,
        userId: u.id,
        title: 'Batch recalled',
        message: `${updated.drug.drugName} batch ${updated.batchNumber} has been recalled. Reason: ${data.recallReason}`,
        referenceType: 'drug_batch',
        referenceId: batchId,
      });
    }
  } catch (err) {
    logger.warn({ err, batchId }, 'Failed to notify recall');
  }

  logger.info({ tenantId, batchId, userId }, 'Batch recalled');
  return updated;
}

export async function unrecallBatch(tenantId: string, batchId: string) {
  const batch = await prisma.drugBatch.findFirst({ where: { id: batchId, tenantId } });
  if (!batch) throw AppError.notFound('Drug batch not found');
  if (!batch.isRecalled) throw AppError.badRequest('Batch is not recalled');

  return prisma.drugBatch.update({
    where: { id: batchId },
    data: { isRecalled: false, recallReason: null },
    include: {
      drug: { select: { id: true, drugName: true, genericName: true } },
    },
  });
}

// Whole-medicine recall was removed: a recall is always issued against a
// specific batch (that is what a manufacturer recall identifies). To pull a
// medicine entirely, recall each affected batch — every stock, FEFO and
// dispensing path already keys off DrugBatch.isRecalled.

/**
 * For a given recalled batch, return the patients (with dispense dates &
 * quantities) who actually received the drug. Used to print a contact list.
 */
export async function getRecallAffectedPatients(tenantId: string, batchId: string) {
  const batch = await prisma.drugBatch.findFirst({
    where: { id: batchId, tenantId },
    include: {
      drug: { select: { id: true, drugName: true, genericName: true } },
    },
  });
  if (!batch) throw AppError.notFound('Drug batch not found');

  const records = await prisma.dispensingRecord.findMany({
    where: { tenantId, drugBatchId: batchId },
    include: {
      patient: {
        select: {
          id: true, mrn: true, firstName: true, lastName: true,
          phone: true, email: true, dateOfBirth: true,
        },
      },
      prescription: {
        select: {
          id: true,
          doctor: { select: { user: { select: { firstName: true, lastName: true } } } },
        },
      },
      dispenser: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { dispensedAt: 'desc' },
  });

  // Group by patient for the call sheet, summing the quantity received.
  const grouped = new Map<string, {
    patientId: string;
    mrn: string;
    name: string;
    phone: string | null;
    email: string | null;
    totalQuantity: number;
    dispenses: { dispensedAt: Date; quantity: number; prescriptionId: string | null; doctorName: string | null }[];
  }>();

  for (const r of records) {
    const p = r.patient;
    const key = p.id;
    const existing = grouped.get(key);
    const doctorName = r.prescription?.doctor?.user
      ? `${r.prescription.doctor.user.firstName} ${r.prescription.doctor.user.lastName}`.trim()
      : null;
    const dispense = {
      dispensedAt: r.dispensedAt,
      quantity: r.quantityDispensed,
      prescriptionId: r.prescriptionId,
      doctorName,
    };
    if (existing) {
      existing.totalQuantity += r.quantityDispensed;
      existing.dispenses.push(dispense);
    } else {
      grouped.set(key, {
        patientId: p.id,
        mrn: p.mrn,
        name: `${p.firstName} ${p.lastName ?? ''}`.trim(),
        phone: p.phone,
        email: p.email,
        totalQuantity: r.quantityDispensed,
        dispenses: [dispense],
      });
    }
  }

  return {
    batch: {
      id: batch.id,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      isRecalled: batch.isRecalled,
      recallReason: batch.recallReason,
      drug: batch.drug,
    },
    totalPatients: grouped.size,
    totalDispenses: records.length,
    patients: Array.from(grouped.values()).sort((a, b) => b.totalQuantity - a.totalQuantity),
  };
}

/**
 * Recalled batches with affected-patient counts. Recall is batch-level only —
 * there is no drug-wide recall to list.
 */
export async function getRecalledItems(tenantId: string, _query: GetRecalledItemsQuery) {
  const recalledBatches = await prisma.drugBatch.findMany({
    where: { tenantId, isRecalled: true },
    include: {
      drug: { select: { id: true, drugName: true, genericName: true } },
      supplier: { select: { id: true, name: true } },
      _count: { select: { dispensingRecords: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });

  return { recalledBatches };
}

// ============================================================
// GST Report
// ============================================================
// We don't have HSN codes per drug yet — but we can derive GST liability
// from dispense × selling price × configured rate (default 12% if the
// caller doesn't pass one). Categorises by drug category so the
// finance/pharmacy team can file by HSN once that field is added.

export async function getGstReport(tenantId: string, query: GetGstReportQuery) {
  const gstRate = query.gstRate ?? 12;

  const where: any = { tenantId };
  if (query.fromDate) where.dispensedAt = { ...where.dispensedAt, gte: new Date(query.fromDate) };
  if (query.toDate) where.dispensedAt = { ...where.dispensedAt, lte: new Date(query.toDate) };

  const records = await prisma.dispensingRecord.findMany({
    where,
    include: {
      drugBatch: {
        select: {
          sellingPrice: true,
          drug: {
            select: {
              id: true,
              drugName: true,
            },
          },
        },
      },
    },
  });

  // Total taxable & gst per drug
  const drugs = new Map<string, {
    drugId: string;
    drugName: string;
    taxableValue: number;
    gstAmount: number;
    totalAmount: number;
    transactions: number;
  }>();

  let totalTaxable = 0;
  let totalGst = 0;
  let totalSales = 0;

  for (const r of records) {
    const sellingPrice = Number(r.drugBatch?.sellingPrice ?? 0);
    const lineTotal = sellingPrice * r.quantityDispensed;
    // Treat sellingPrice as GST-inclusive (most retail pharmacy pricing).
    // Reverse-calc taxable: total / (1 + rate/100).
    const taxable = lineTotal / (1 + gstRate / 100);
    const gst = lineTotal - taxable;

    totalSales += lineTotal;
    totalTaxable += taxable;
    totalGst += gst;

    const drug = r.drugBatch?.drug;
    const dId = drug?.id ?? '__unknown__';
    const dName = drug?.drugName ?? 'Unknown';
    const existing = drugs.get(dId);
    if (existing) {
      existing.taxableValue += taxable;
      existing.gstAmount += gst;
      existing.totalAmount += lineTotal;
      existing.transactions += 1;
    } else {
      drugs.set(dId, {
        drugId: dId,
        drugName: dName,
        taxableValue: taxable,
        gstAmount: gst,
        totalAmount: lineTotal,
        transactions: 1,
      });
    }
  }

  // CGST + SGST is a 50/50 split of the total GST for intra-state sales.
  const cgst = totalGst / 2;
  const sgst = totalGst / 2;

  return {
    gstRate,
    summary: {
      totalSales: Number(totalSales.toFixed(2)),
      taxableValue: Number(totalTaxable.toFixed(2)),
      totalGst: Number(totalGst.toFixed(2)),
      cgst: Number(cgst.toFixed(2)),
      sgst: Number(sgst.toFixed(2)),
      igst: 0,
      transactions: records.length,
    },
    byDrug: Array.from(drugs.values())
      .map((c) => ({
        ...c,
        taxableValue: Number(c.taxableValue.toFixed(2)),
        gstAmount: Number(c.gstAmount.toFixed(2)),
        totalAmount: Number(c.totalAmount.toFixed(2)),
      }))
      .sort((a, b) => b.totalAmount - a.totalAmount),
  };
}

// ============================================================
// Auto-Expiry Job — called by scheduler (or manually) to flag any batch
// whose expiryDate has passed but isExpired = false. Idempotent.
// ============================================================

export async function flagExpiredBatches(tenantId?: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const where: any = {
    isExpired: false,
    expiryDate: { lt: today },
  };
  if (tenantId) where.tenantId = tenantId;

  const result = await prisma.drugBatch.updateMany({
    where,
    data: { isExpired: true },
  });

  if (result.count > 0) {
    logger.info({ tenantId, count: result.count }, 'Auto-flagged expired batches');
  }
  return { flagged: result.count };
}

/**
 * G5: end-to-end expiry handling for drug stock. Auto-flags fully-expired batches
 * (so they drop out of sellable stock while staying in the ledger for audit) and
 * raises near-expiry alerts to the configured recipients so the pharmacy can
 * start a return-to-distributor before the date hits. Honours the shared
 * inventory settings — expiryAlertMonths (the configurable threshold),
 * expiryAlertEnabled, autoFlagExpired and alertRecipientRoles — so the alert
 * window is configurable per pharmacy. Runs unattended from the daily alerts job;
 * `force` makes the manual "run now" action flag + alert regardless of the
 * toggles. Near-expiry alerts are de-duped against open notifications so repeated
 * runs never spam the same batch.
 */
export async function runPharmacyExpiryAlerts(
  tenantId: string,
  _userId: string,
  opts: { force?: boolean } = {},
) {
  const settings = await getInventorySettingsSafe(tenantId);

  // 1. Auto-tag fully-expired batches as expired (idempotent). They stay in the
  //    table for audit but are excluded from every sellable-stock rollup.
  let expiredFlagged = 0;
  if (opts.force || settings.autoFlagExpired) {
    const res = await flagExpiredBatches(tenantId);
    expiredFlagged = res.flagged;
  }

  // 2. Near-expiry alerts within the configured look-ahead window.
  let expiryAlerts = 0;
  if (opts.force || settings.expiryAlertEnabled) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const until = new Date(today);
    until.setMonth(until.getMonth() + (settings.expiryAlertMonths || 3));

    const batches = await prisma.drugBatch.findMany({
      where: {
        tenantId,
        isExpired: false,
        isRecalled: false,
        quantityInStock: { gt: 0 },
        expiryDate: { gte: today, lte: until },
      },
      take: 1000,
      orderBy: { expiryDate: 'asc' },
      include: { drug: { select: { drugName: true } } },
    });

    for (const b of batches) {
      // Skip if managers already have an unread alert for this batch.
      if (await hasOpenInventoryAlert(tenantId, 'pharmacy_expiry', b.id)) continue;
      const expiry = new Date(b.expiryDate).toISOString().slice(0, 10);
      const sent = await notifyInventoryRecipients({
        tenantId,
        recipientRoles: settings.alertRecipientRoles,
        title: 'Drug stock expiring soon',
        message: `${b.drug?.drugName ?? 'Drug'} batch ${b.batchNumber} — ${b.quantityInStock} unit(s) expiring on ${expiry}. Initiate a return-to-distributor before expiry.`,
        referenceType: 'pharmacy_expiry',
        referenceId: b.id,
      });
      if (sent > 0) expiryAlerts += 1;
    }
  }

  logger.info(
    { tenantId, expiredFlagged, expiryAlerts, force: !!opts.force },
    'Pharmacy expiry alerts run complete',
  );
  return { expiredFlagged, expiryAlerts };
}

// ============================================================
// Pharmacy & Inventory Audit Trail (read)
//
// A single, human-readable register of every pharmacy/inventory action —
// invoice import, product mapping, inventory creation, batch modification,
// stock adjustment/transfer, dispense, sale, return, GST exception, approvals.
// Reads the shared AuditLog filtered to the pharmacy + inventory entity types.
// ============================================================

const PHARMACY_AUDIT_ENTITY_TYPES = [
  'drug_formulary',
  'drug_batch',
  'dispensing_record',
  'pharmacy_sale',
  'drug_return',
  'inward_invoice',
  'gst_exception',
  'inventory_item',
  'inventory_setting',
  'purchase_order',
  'stock_transaction',
  'stock_transfer',
] as const;

export async function getPharmacyAuditTrail(
  tenantId: string,
  query: {
    page?: number;
    limit?: number;
    action?: string;
    entityType?: string;
    userId?: string;
    fromDate?: string;
    toDate?: string;
    search?: string;
  },
) {
  const { skip, take, page, limit } = getPaginationParams(query as any);

  const where: any = {
    tenantId,
    entityType:
      query.entityType && (PHARMACY_AUDIT_ENTITY_TYPES as readonly string[]).includes(query.entityType)
        ? query.entityType
        : { in: PHARMACY_AUDIT_ENTITY_TYPES as unknown as string[] },
  };
  if (query.action) where.action = query.action;
  if (query.userId) where.userId = query.userId;
  if (query.fromDate) where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  if (query.toDate) where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
  if (query.search) {
    where.OR = [
      { description: { contains: query.search, mode: 'insensitive' } },
      { entityType: { contains: query.search, mode: 'insensitive' } },
      { entityId: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  const items = rows.map((r) => ({
    id: r.id,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    description: r.description,
    oldValues: r.oldValues,
    newValues: r.newValues,
    // The "Machine" of the action.
    ipAddress: r.ipAddress,
    userAgent: r.userAgent,
    createdAt: r.createdAt,
    user: r.user
      ? { id: r.user.id, name: `${r.user.firstName} ${r.user.lastName ?? ''}`.trim(), email: r.user.email }
      : null,
  }));

  return { items, total, page, limit };
}
