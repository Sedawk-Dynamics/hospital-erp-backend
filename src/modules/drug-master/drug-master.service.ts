import { Prisma } from '@prisma/client';
import { classifyDrugMasterItem, affectsClassification } from './drug-schedule.service';
import { cleanSalts, compositionText, type SaltInput } from './composition';
import { writeStructuredSalts } from './salt-classification.service';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { recordRateChange } from '../gst/gst-rate-log';
import { getPaginationParams } from '../../shared/pagination';
import { makeMedicineRankComparator, mergePrefixFirst } from '../../shared/medicine-search-rank';
import { fuzzyMatchIds } from '../../shared/medicine-fuzzy';
import { isGstTreatment, type GstTreatment } from '../../shared/gst';
import { buildDrugSearchTokens } from './drug-master.dataset';
import { gtinVariants, normalizeGtin } from '../pharmacy/pharmacy.barcode';
import type {
  SearchDrugMasterQuery,
  ListDrugMasterQuery,
  CreateDrugMasterInput,
  UpdateDrugMasterInput,
  SuggestDrugMasterInput,
  CreateHsnGstRateInput,
  UpdateHsnGstRateInput,
} from './drug-master.validation';

// Only super_admin authors / edits the platform-wide drug catalog. Hospitals
// consume it read-only (search) and clone rows into their own formulary.
const DRUG_MASTER_WRITER_ROLES = new Set(['super_admin']);

function assertCanManage(roles: string[]): void {
  if (!roles.some((r) => DRUG_MASTER_WRITER_ROLES.has(r))) {
    throw AppError.forbidden('Only platform administrators can manage the drug catalog');
  }
}

// buildDrugSearchTokens lives in drug-master.dataset.ts (shared with refresh).

// ─────────────────────────────────────────────────────────────
// Search (public to any pharmacy/prescriptions reader)
// ─────────────────────────────────────────────────────────────
export async function searchDrugMaster(query: SearchDrugMasterQuery) {
  const terms = query.q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const published: Prisma.DrugMasterWhereInput = {
    isPublished: true,
    ...(query.includeDiscontinued ? {} : { isDiscontinued: false }),
  };
  const where: Prisma.DrugMasterWhereInput = {
    ...published,
    // Every term must appear somewhere in the token blob (AND), so
    // "para 500" narrows rather than widens.
    AND: terms.map((term) => ({
      searchTokens: { contains: term, mode: 'insensitive' as const },
    })),
  };

  const select = {
    id: true,
    name: true,
    genericName: true,
    manufacturer: true,
    dosageForm: true,
    strength: true,
    packSizeLabel: true,
    // Identity fields so a catalog pick can fill the stock-entry boxes fully.
    packSize: true,
    hsnCode: true,
    gtin: true,
    mrp: true,
    type: true,
    schedule: true,
  } as const;

  // Wider window so JS relevance ranking can see all near matches; sliced back
  // to the requested limit after ranking.
  const window = Math.max(query.limit ?? 20, 100);
  const q = query.q.trim();

  // Fetch dedicated PREFIX windows (name and generic kept SEPARATE) alongside
  // the token search. They must be separate: a single `name startsWith OR
  // generic startsWith` window ordered by name lets drugs whose *generic* starts
  // with the query but whose *name* starts with "A" (e.g. "A-Cet" → Cetirizine)
  // fill the window and clip the real "C…" name-prefix drugs. Separate windows
  // guarantee both are candidates; the comparator then scores name-prefix top.
  const emptyRows = Promise.resolve([] as Prisma.DrugMasterGetPayload<{ select: typeof select }>[]);
  const [namePrefixRows, genericPrefixRows, tokenRows] = await Promise.all([
    q
      ? prisma.drugMaster.findMany({
          where: { ...published, name: { startsWith: q, mode: 'insensitive' } },
          select,
          take: window,
          orderBy: { name: 'asc' },
        })
      : emptyRows,
    q
      ? prisma.drugMaster.findMany({
          where: { ...published, genericName: { startsWith: q, mode: 'insensitive' } },
          select,
          take: window,
          orderBy: { name: 'asc' },
        })
      : emptyRows,
    prisma.drugMaster.findMany({ where, select, take: window, orderBy: { name: 'asc' } }),
  ]);

  // Fuzzy (typo-tolerant) fill: rows whose name/generic are trigram-similar to
  // the query but contain no substring match ("parcetamol" → "Paracetamol").
  // Additive — appended after the strict pool and ranked below every substring
  // match by the comparator, so exact/prefix/substring ordering is unchanged.
  const fuzzyIds = await fuzzyMatchIds({
    table: 'drug_master',
    query: q,
    where: query.includeDiscontinued
      ? Prisma.sql`is_published = true`
      : Prisma.sql`is_published = true AND is_discontinued = false`,
    limit: window,
  });
  const knownIds = new Set([...namePrefixRows, ...genericPrefixRows, ...tokenRows].map((d) => d.id));
  const fuzzyNewIds = fuzzyIds.filter((id) => !knownIds.has(id));
  const fuzzyRows = fuzzyNewIds.length
    ? await prisma.drugMaster.findMany({ where: { ...published, id: { in: fuzzyNewIds } }, select })
    : [];

  const drugs = mergePrefixFirst(
    [...namePrefixRows, ...genericPrefixRows],
    [...tokenRows, ...fuzzyRows],
    (d) => d.id,
  );

  // Rank by textual relevance against the full query so an exact/prefix match
  // (e.g. "DOLO" → "DOLO 650") comes before a mere substring ("PARADOLO").
  const cmp = makeMedicineRankComparator<(typeof drugs)[number]>(query.q, (d) => ({
    name: d.name,
    generic: d.genericName,
  }));
  return drugs.sort(cmp).slice(0, query.limit ?? 20);
}

// ─────────────────────────────────────────────────────────────
// Super-admin management
// ─────────────────────────────────────────────────────────────
export async function listDrugMaster(query: ListDrugMasterQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: Prisma.DrugMasterWhereInput = {};
  if (query.isPublished !== undefined) where.isPublished = query.isPublished;
  if (!query.includeDiscontinued) where.isDiscontinued = false;
  if (query.search) {
    const term = query.search.toLowerCase().trim();
    where.searchTokens = { contains: term, mode: 'insensitive' };
  }
  // Filter on what the classifier resolved, not the legacy `schedule` column —
  // that one is deliberately left NULL so classifying can never switch counter
  // enforcement on by itself.
  if (query.schedule) where.scheduleResolved = query.schedule;
  if (query.controlled !== undefined) {
    where.controlledClass = query.controlled ? { not: null } : null;
  }
  if (query.qrTracked !== undefined) where.requiresQrScan = query.qrTracked;

  const [items, total] = await Promise.all([
    prisma.drugMaster.findMany({ where, skip, take, orderBy: { name: 'asc' } }),
    prisma.drugMaster.count({ where }),
  ]);

  return { items, total, page, limit };
}

export async function getDrugMasterById(id: string) {
  const drug = await prisma.drugMaster.findUnique({ where: { id } });
  if (!drug) throw AppError.notFound('Drug not found in catalog');
  return drug;
}

/**
 * The catalog is platform-wide, so a GTIN identifies one product across every
 * hospital — it may belong to at most one DrugMaster row. Guards both the
 * consumer and case-pack GTIN, across both columns and 13-/14-digit forms.
 * Throws a 409 naming the clashing catalog entry. `excludeId` skips self on edit.
 */
async function assertDrugMasterGtinUnique(
  gtin: string | null | undefined,
  casePackGtin: string | null | undefined,
  excludeId?: string,
) {
  for (const [label, value] of [
    ['GTIN', normalizeGtin(gtin)],
    ['case-pack GTIN', normalizeGtin(casePackGtin)],
  ] as const) {
    if (!value) continue;
    const variants = gtinVariants(value);
    if (!variants.length) continue;
    const clash = await prisma.drugMaster.findFirst({
      where: {
        id: excludeId ? { not: excludeId } : undefined,
        OR: [{ gtin: { in: variants } }, { casePackGtin: { in: variants } }],
      },
      select: { name: true, strength: true },
    });
    if (clash) {
      const who = `${clash.name}${clash.strength ? ' ' + clash.strength : ''}`;
      throw AppError.conflict(
        `${label} ${value} is already assigned to "${who}" in the catalog. Each medicine must have a unique GTIN.`,
      );
    }
  }
}

export async function createDrugMaster(
  roles: string[],
  userId: string,
  data: CreateDrugMasterInput,
) {
  assertCanManage(roles);
  await assertDrugMasterGtinUnique(data.gtin, data.casePackGtin);

  const aliases = data.aliases ?? [];
  const tags = data.tags ?? [];
  // Structured salts are authoritative when sent: the composition text is
  // rendered from them rather than parsed back out of a sentence.
  const structured = cleanSalts((data as { salts?: SaltInput[] }).salts);
  const composition = structured.length
    ? compositionText(structured)
    : ((data as any).saltComposition ?? null);
  const drug = await prisma.drugMaster.create({
    data: {
      name: data.name,
      genericName: data.genericName ?? null,
      saltComposition: composition,
      manufacturer: data.manufacturer ?? null,
      type: data.type ?? null,
      dosageForm: (data.dosageForm ?? null) as any,
      strength: data.strength ?? null,
      packSizeLabel: data.packSizeLabel ?? null,
      mrp: data.mrp ?? null,
      isDiscontinued: data.isDiscontinued ?? false,
      schedule: data.schedule ?? null,
      gtin: normalizeGtin(data.gtin),
      casePackGtin: normalizeGtin(data.casePackGtin),
      unitsPerCase: data.unitsPerCase ?? null,
      manufacturerCode: data.manufacturerCode ?? null,
      hsnCode: data.hsnCode ?? null,
      gstRate: data.gstRate ?? null,
      aliases,
      tags,
      searchTokens: buildDrugSearchTokens({
        name: data.name,
        genericName: data.genericName,
        manufacturer: data.manufacturer,
        aliases,
        tags,
      }),
      isPublished: data.isPublished ?? true,
      createdById: userId,
    },
  });

  logger.info({ drugMasterId: drug.id }, 'Drug master entry created');
  // Link the molecules from the structured rows directly — nothing to parse.
  if (structured.length) await writeStructuredSalts(drug.id, structured);
  // Label it now rather than waiting for the next deploy's backfill — a catalog
  // drug with no schedule is invisible to every badge, filter and register that
  // reads one. Never throws; a failure leaves it for the backfill.
  await classifyDrugMasterItem(drug.id);
  return prisma.drugMaster.findUnique({ where: { id: drug.id } }) ?? drug;
}

/**
 * G11: a hospital pharmacist suggests a brand that isn't in the national master
 * yet. Unlike createDrugMaster (super-admin only), this is open to any pharmacy
 * user but always lands UNPUBLISHED — it's a pending suggestion that a platform
 * admin reviews and publishes (via updateDrugMaster) before it becomes a live
 * catalogue entry. createdById records the suggesting user for traceability.
 */
export async function suggestDrugMaster(userId: string, data: SuggestDrugMasterInput) {
  const drug = await prisma.drugMaster.create({
    data: {
      name: data.name,
      genericName: data.genericName ?? null,
      manufacturer: data.manufacturer ?? null,
      type: data.type ?? null,
      dosageForm: (data.dosageForm ?? null) as any,
      strength: data.strength ?? null,
      packSizeLabel: data.packSizeLabel ?? null,
      schedule: data.schedule ?? null,
      searchTokens: buildDrugSearchTokens({
        name: data.name,
        genericName: data.genericName,
        manufacturer: data.manufacturer,
        aliases: [],
        tags: [],
      }),
      // Always pending review — never auto-published from a tenant suggestion.
      isPublished: false,
      createdById: userId,
    },
  });
  logger.info({ drugMasterId: drug.id, userId }, 'Drug master suggestion submitted');
  await classifyDrugMasterItem(drug.id);
  return prisma.drugMaster.findUnique({ where: { id: drug.id } }) ?? drug;
}

export async function updateDrugMaster(
  roles: string[],
  id: string,
  data: UpdateDrugMasterInput,
) {
  assertCanManage(roles);

  const existing = await prisma.drugMaster.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Drug not found in catalog');

  // Normalise + uniqueness-check any GTIN change before writing.
  const nextGtin = data.gtin !== undefined ? normalizeGtin(data.gtin) : undefined;
  const nextCaseGtin =
    data.casePackGtin !== undefined ? normalizeGtin(data.casePackGtin) : undefined;
  if (nextGtin !== undefined || nextCaseGtin !== undefined) {
    await assertDrugMasterGtinUnique(
      nextGtin !== undefined ? nextGtin : existing.gtin,
      nextCaseGtin !== undefined ? nextCaseGtin : existing.casePackGtin,
      id,
    );
  }

  const name = data.name ?? existing.name;
  const genericName = data.genericName !== undefined ? data.genericName : existing.genericName;
  const manufacturer =
    data.manufacturer !== undefined ? data.manufacturer : existing.manufacturer;
  const aliases = data.aliases ?? existing.aliases;
  const tags = data.tags ?? existing.tags;

  // Structured salts, when the caller sent them. `undefined` means "not sent"
  // and leaves the stored text alone; anything else replaces it.
  const editedSalts = cleanSalts((data as { salts?: SaltInput[] }).salts);
  const editedComposition = editedSalts.length ? compositionText(editedSalts) : undefined;

  const drug = await prisma.drugMaster.update({
    where: { id },
    data: {
      name,
      genericName,
      // Structured salts win: the text is rendered from them, so the two
      // representations cannot disagree after an edit.
      saltComposition: editedComposition !== undefined
        ? editedComposition
        : (data as any).saltComposition !== undefined
          ? (data as any).saltComposition
          : undefined,
      manufacturer,
      type: data.type !== undefined ? data.type : undefined,
      dosageForm: data.dosageForm !== undefined ? (data.dosageForm as any) : undefined,
      strength: data.strength !== undefined ? data.strength : undefined,
      packSizeLabel: data.packSizeLabel !== undefined ? data.packSizeLabel : undefined,
      mrp: data.mrp !== undefined ? data.mrp : undefined,
      isDiscontinued: data.isDiscontinued ?? undefined,
      schedule: data.schedule !== undefined ? data.schedule : undefined,
      gtin: nextGtin,
      casePackGtin: nextCaseGtin,
      unitsPerCase: data.unitsPerCase !== undefined ? data.unitsPerCase : undefined,
      manufacturerCode: data.manufacturerCode !== undefined ? data.manufacturerCode : undefined,
      hsnCode: data.hsnCode !== undefined ? data.hsnCode : undefined,
      gstRate: data.gstRate !== undefined ? data.gstRate : undefined,
      aliases: data.aliases ?? undefined,
      tags: data.tags ?? undefined,
      isPublished: data.isPublished ?? undefined,
      searchTokens: buildDrugSearchTokens({ name, genericName, manufacturer, aliases, tags }),
    },
  });

  // Write the links straight from the structured rows — nothing to parse.
  if (editedSalts.length) await writeStructuredSalts(drug.id, editedSalts);

  logger.info({ drugMasterId: drug.id }, 'Drug master entry updated');
  // Re-label only when something the classifier reads actually changed. An
  // edit to price or pack size costs nothing; an edit to the composition must
  // not leave the old schedule standing, because nothing else would ever
  // revisit it — the row is already at the current classifier version.
  if (affectsClassification(data as Record<string, unknown>)) {
    // Re-derive the composition when the generic name changed but the caller
    // did not supply a composition of its own — otherwise the one derived on
    // create keeps the old schedule alive.
    const refreshComposition =
      'genericName' in (data as Record<string, unknown>) &&
      (data as Record<string, unknown>).saltComposition === undefined;
    await classifyDrugMasterItem(drug.id, { refreshComposition });
    return (await prisma.drugMaster.findUnique({ where: { id: drug.id } })) ?? drug;
  }
  return drug;
}

export async function deleteDrugMaster(roles: string[], id: string) {
  assertCanManage(roles);

  const existing = await prisma.drugMaster.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Drug not found in catalog');

  // FK on DrugFormulary.drugMasterId is optional → set-null on delete, so any
  // hospital rows imported from this entry simply lose their provenance link.
  await prisma.drugMaster.delete({ where: { id } });
  logger.info({ drugMasterId: id }, 'Drug master entry deleted');
  return { id };
}

// ─────────────────────────────────────────────────────────────
// HSN → GST tax reference (platform-wide, shared by all tenants)
// ─────────────────────────────────────────────────────────────

/** Digits only — "3004.90.99" / "3004 9099" all normalise identically. */
export function normalizeHsn(code: string | null | undefined): string {
  return (code ?? '').replace(/\D/g, '');
}

export interface HsnGstMatch {
  hsnCode: string; // the (normalised) code that was looked up
  matchedCode: string; // the reference row that matched (may be a shorter heading)
  gstRate: number;
  /**
   * 'taxable' | 'nil_rated' | 'exempt' | 'non_gst'. A rate of zero cannot say
   * which of the three zeroes it is, and the return reports them separately.
   * Rows written before the column existed fall back to the rate's own reading.
   */
  treatment: GstTreatment;
  description: string | null;
}

type HsnRow = {
  hsnCode: string;
  gstRate: unknown;
  treatment?: string | null;
  description: string | null;
};

/** Full active reference — small table, safe to load and match in-memory. */
export async function getHsnGstRows(): Promise<HsnRow[]> {
  return prisma.hsnGstRate.findMany({
    where: { isActive: true },
    select: { hsnCode: true, gstRate: true, treatment: true, description: true },
  });
}

/**
 * What a row's treatment is, tolerating a row saved before the column existed.
 * A positive rate can only be taxable; a zero with nothing recorded is read as
 * nil-rated, which reports to the same GSTR-3B line as exempt and so cannot
 * put the money wrong.
 */
function rowTreatment(raw: string | null | undefined, rate: number): GstTreatment {
  if (isGstTreatment(raw)) return raw;
  return rate > 0 ? 'taxable' : 'nil_rated';
}

/**
 * Longest-prefix match: an 8-digit tariff item (e.g. ORS 30049010 → nil) wins
 * over its 4-digit chapter heading (3004 → 5%). Pure, so the inward loop can
 * match many lines against one preloaded row set. Returns null when no seeded
 * row is a prefix of the input.
 */
export function matchHsnGst(code: string | null | undefined, rows: HsnRow[]): HsnGstMatch | null {
  const input = normalizeHsn(code);
  if (!input) return null;
  let best: HsnRow | null = null;
  for (const r of rows) {
    if (input === r.hsnCode || input.startsWith(r.hsnCode)) {
      if (!best || r.hsnCode.length > best.hsnCode.length) best = r;
    }
  }
  if (!best) return null;
  const gstRate = Number(best.gstRate);
  return {
    hsnCode: input,
    matchedCode: best.hsnCode,
    gstRate,
    treatment: rowTreatment(best.treatment, gstRate),
    description: best.description,
  };
}

/** Convenience wrapper — one lookup, its own query. */
export async function resolveHsnGst(code: string | null | undefined): Promise<HsnGstMatch | null> {
  return matchHsnGst(code, await getHsnGstRows());
}

/** List for the reference UI / frontend cache (rates as numbers). */
export async function listHsnGstRates() {
  const rows = await prisma.hsnGstRate.findMany({
    where: { isActive: true },
    orderBy: { hsnCode: 'asc' },
    select: { id: true, hsnCode: true, description: true, gstRate: true, category: true },
  });
  return rows.map((r) => ({ ...r, gstRate: Number(r.gstRate) }));
}

// ── Super-admin management of the HSN → GST reference ──

/** Full list incl. inactive rows, for the super-admin management table. */
export async function listAllHsnGstRates() {
  const rows = await prisma.hsnGstRate.findMany({
    orderBy: { hsnCode: 'asc' },
  });
  return rows.map((r) => ({ ...r, gstRate: Number(r.gstRate) }));
}

export async function createHsnGstRate(
  roles: string[],
  data: CreateHsnGstRateInput,
  changedBy?: string | null,
) {
  assertCanManage(roles);
  const hsnCode = normalizeHsn(data.hsnCode);
  if (!hsnCode) throw AppError.badRequest('HSN code must contain digits');
  try {
    const row = await prisma.hsnGstRate.create({
      data: {
        hsnCode,
        description: data.description ?? null,
        gstRate: data.gstRate,
        category: data.category ?? null,
        isActive: data.isActive ?? true,
      },
    });
    logger.info({ hsnGstRateId: row.id, hsnCode }, 'HSN → GST rate created');
    await recordRateChange({
      codeType: 'hsn',
      code: row.hsnCode,
      description: row.description,
      previousRate: null,
      newRate: Number(row.gstRate),
      previousTreatment: null,
      newTreatment: row.treatment,
      action: 'create',
      changedBy,
    });
    return { ...row, gstRate: Number(row.gstRate) };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict(`An HSN → GST rate for "${hsnCode}" already exists`);
    }
    throw err;
  }
}

export async function updateHsnGstRate(
  roles: string[],
  id: string,
  data: UpdateHsnGstRateInput,
  changedBy?: string | null,
) {
  assertCanManage(roles);
  const existing = await prisma.hsnGstRate.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('HSN → GST rate not found');

  const hsnCode = data.hsnCode !== undefined ? normalizeHsn(data.hsnCode) : undefined;
  if (hsnCode !== undefined && !hsnCode) throw AppError.badRequest('HSN code must contain digits');
  try {
    const row = await prisma.hsnGstRate.update({
      where: { id },
      data: {
        hsnCode,
        description: data.description !== undefined ? data.description : undefined,
        gstRate: data.gstRate !== undefined ? data.gstRate : undefined,
        category: data.category !== undefined ? data.category : undefined,
        isActive: data.isActive !== undefined ? data.isActive : undefined,
      },
    });
    logger.info({ hsnGstRateId: id }, 'HSN → GST rate updated');
    await recordRateChange({
      codeType: 'hsn',
      code: row.hsnCode,
      description: row.description,
      previousRate: Number(existing.gstRate),
      newRate: Number(row.gstRate),
      previousTreatment: existing.treatment,
      newTreatment: row.treatment,
      // Deactivating a code changes what an item resolves to as surely as
      // re-rating it does; the engine falls through to the next rule.
      action: data.isActive === false && existing.isActive ? 'deactivate' : 'update',
      changedBy,
    });
    return { ...row, gstRate: Number(row.gstRate) };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict(`An HSN → GST rate for "${hsnCode}" already exists`);
    }
    throw err;
  }
}

/**
 * Bulk create/update HSN → GST rates. Each row is upserted by its HSN code, so
 * re-importing a code updates its rate rather than erroring on the unique
 * constraint. Returns how many were created vs updated (and any skipped rows).
 */
export async function bulkUpsertHsnGstRates(
  roles: string[],
  rows: CreateHsnGstRateInput[],
) {
  assertCanManage(roles);
  let created = 0;
  let updated = 0;
  const skipped: Array<{ hsnCode: string; reason: string }> = [];

  // De-dup within the payload (last one wins) so two rows for the same HSN in a
  // single paste don't fight each other.
  const byCode = new Map<string, CreateHsnGstRateInput>();
  for (const r of rows) {
    const code = normalizeHsn(r.hsnCode);
    if (!code) {
      skipped.push({ hsnCode: r.hsnCode, reason: 'HSN code must contain digits' });
      continue;
    }
    byCode.set(code, r);
  }

  for (const [hsnCode, r] of byCode) {
    try {
      const existing = await prisma.hsnGstRate.findUnique({ where: { hsnCode } });
      if (existing) {
        await prisma.hsnGstRate.update({
          where: { hsnCode },
          data: {
            gstRate: r.gstRate,
            description: r.description ?? existing.description,
            category: r.category ?? existing.category,
            isActive: r.isActive ?? existing.isActive,
          },
        });
        updated++;
      } else {
        await prisma.hsnGstRate.create({
          data: {
            hsnCode,
            description: r.description ?? null,
            gstRate: r.gstRate,
            category: r.category ?? null,
            isActive: r.isActive ?? true,
          },
        });
        created++;
      }
    } catch (err) {
      skipped.push({
        hsnCode,
        reason: err instanceof Error ? err.message : 'Failed to save',
      });
    }
  }

  logger.info({ created, updated, skipped: skipped.length }, 'HSN → GST rates bulk upserted');
  return { created, updated, skipped };
}

export async function deleteHsnGstRate(roles: string[], id: string) {
  assertCanManage(roles);
  const existing = await prisma.hsnGstRate.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('HSN → GST rate not found');
  await prisma.hsnGstRate.delete({ where: { id } });
  logger.info({ hsnGstRateId: id }, 'HSN → GST rate deleted');
  return { id };
}
