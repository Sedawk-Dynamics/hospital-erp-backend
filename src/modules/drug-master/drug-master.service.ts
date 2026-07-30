import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { makeMedicineRankComparator, mergePrefixFirst } from '../../shared/medicine-search-rank';
import { fuzzyMatchIds } from '../../shared/medicine-fuzzy';
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
  const drug = await prisma.drugMaster.create({
    data: {
      name: data.name,
      genericName: data.genericName ?? null,
      saltComposition: (data as any).saltComposition ?? null,
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
  return drug;
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
  return drug;
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

  const drug = await prisma.drugMaster.update({
    where: { id },
    data: {
      name,
      genericName,
      saltComposition: (data as any).saltComposition !== undefined ? (data as any).saltComposition : undefined,
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

  logger.info({ drugMasterId: drug.id }, 'Drug master entry updated');
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
  description: string | null;
}

type HsnRow = { hsnCode: string; gstRate: unknown; description: string | null };

/** Full active reference — small table, safe to load and match in-memory. */
export async function getHsnGstRows(): Promise<HsnRow[]> {
  return prisma.hsnGstRate.findMany({
    where: { isActive: true },
    select: { hsnCode: true, gstRate: true, description: true },
  });
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
  return { hsnCode: input, matchedCode: best.hsnCode, gstRate: Number(best.gstRate), description: best.description };
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

export async function createHsnGstRate(roles: string[], data: CreateHsnGstRateInput) {
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
    return { ...row, gstRate: Number(row.gstRate) };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict(`An HSN → GST rate for "${hsnCode}" already exists`);
    }
    throw err;
  }
}

export async function updateHsnGstRate(roles: string[], id: string, data: UpdateHsnGstRateInput) {
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
