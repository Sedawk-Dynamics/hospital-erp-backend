/**
 * Applying a vendor catalogue release to drug_master.
 *
 * The release ships in the image (prisma/scripts/data/drug-catalog, built by
 * prisma/scripts/build-drug-catalog.py): a manifest, the shared texts, and one
 * line per product in the vendor's own words. Applying it is idempotent and
 * resumable — every phase can be run again and does nothing it already did —
 * so a container killed half way through simply finishes on the next boot.
 *
 *   1. texts     — stored once each, found again by hash
 *   2. products  — upserted on the vendor's Product ID; only rows whose
 *                  fingerprint changed are rewritten
 *   3. discontinue — a product the release no longer lists is marked
 *                  discontinued, never deleted: a hospital may still stock it
 *   4. retire the legacy catalogue — the rows of the old open dataset. Before
 *                  they go, every hospital formulary row imported from one is
 *                  re-pointed at the same product in the new catalogue, and a
 *                  GTIN or HSN someone added by hand is carried across
 *
 * What it never touches: a hospital's formulary data, prices or stock. A
 * formulary row is a hospital's own copy; the catalogue link is provenance and
 * the source of its inherited schedule, and that link is all that moves.
 */

import { createReadStream, existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';
import { createGunzip } from 'zlib';
import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../../config/logger';
import {
  interactionSummary,
  normalizeVendorRow,
  parseInteractions,
  templateText,
  TEMPLATE_PLACEHOLDER,
  type CatalogKind,
  type CatalogProduct,
  type VendorCsvRow,
} from './drug-catalog.normalize';
import { buildDrugSearchTokens } from './drug-master.dataset';
import { invalidateSaltCache } from './salt-classification.service';

/** Resolved from the working directory: backend/ in dev, /app in the image. */
export const CATALOG_DIR = path.resolve(process.cwd(), 'prisma', 'scripts', 'data', 'drug-catalog');

const TEXT_BATCH = 1000;
const PRODUCT_BATCH = 1000;
const DELETE_BATCH = 5000;
const REPORT_CAP = 500;

// ─────────────────────────────────────────────────────────────
// Bundle
// ─────────────────────────────────────────────────────────────

export interface ManifestFile {
  file: string;
  count: number;
  sha256: string;
  bytes: number;
}

export interface ManifestPart {
  columns: string[];
  files: ManifestFile[];
  count: number;
}

export interface CatalogManifest {
  format: number;
  release: string;
  builtAt: string;
  sources: string[];
  placeholder: string;
  texts: { files: ManifestFile[]; count: number };
  drugs: ManifestPart;
  otc?: ManifestPart;
}

/** The bundled release, or null when the image carries none. */
export function readManifest(dir: string = CATALOG_DIR): CatalogManifest | null {
  const file = path.join(dir, 'manifest.json');
  if (!existsSync(file)) return null;
  const m = JSON.parse(readFileSync(file, 'utf-8')) as CatalogManifest;
  if (m.format !== 1) throw new Error(`Drug catalogue bundle format ${m.format} is not supported`);
  if (m.placeholder !== TEMPLATE_PLACEHOLDER) {
    throw new Error(`Drug catalogue bundle uses placeholder "${m.placeholder}", expected "${TEMPLATE_PLACEHOLDER}"`);
  }
  if (!/^\d{4}-\d{2}$/.test(m.release)) throw new Error(`Drug catalogue release "${m.release}" is not YYYY-MM`);
  return m;
}

/**
 * Refuse a damaged bundle before writing anything. A file that is a Git LFS
 * pointer, or was cut short in a checkout, would otherwise import as a
 * catalogue missing half its products — and the retire phase would then delete
 * the old rows those products should have replaced.
 */
async function verifyBundle(dir: string, m: CatalogManifest): Promise<void> {
  const files = [...m.texts.files, ...m.drugs.files, ...(m.otc?.files ?? [])];
  for (const f of files) {
    const full = path.join(dir, f.file);
    if (!existsSync(full)) throw new Error(`Drug catalogue bundle is missing ${f.file}`);
    const digest = await new Promise<string>((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(full)
        .on('data', (chunk) => h.update(chunk))
        .on('end', () => resolve(h.digest('hex')))
        .on('error', reject);
    });
    if (digest !== f.sha256) throw new Error(`Drug catalogue bundle file ${f.file} is corrupt (checksum mismatch)`);
  }
}

/**
 * One JSON value per line. Split on the newline BYTE rather than with
 * `readline`: readline also breaks at U+2028 and U+2029, which are legal inside
 * a JSON string and which the vendor's texts do contain — the first import cut
 * a text in two at one. A 0x0A byte never occurs inside a UTF-8 sequence, so
 * splitting the raw bytes is exact.
 */
export async function* readLines(dir: string, files: ManifestFile[]): AsyncGenerator<unknown> {
  for (const f of files) {
    const stream = createReadStream(path.join(dir, f.file)).pipe(createGunzip());
    let rest: Buffer = Buffer.alloc(0);
    let n = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      let start = 0;
      for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, start)) {
        if (i > start) {
          n += 1;
          yield JSON.parse(buf.toString('utf8', start, i));
        }
        start = i + 1;
      }
      rest = buf.subarray(start);
    }
    if (rest.length) {
      n += 1;
      yield JSON.parse(rest.toString('utf8'));
    }
    if (n !== f.count) throw new Error(`${f.file}: expected ${f.count} lines, read ${n}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Texts
// ─────────────────────────────────────────────────────────────

/** 128 bits of sha256 — the key a text is found by. */
export function textHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32);
}

/** Store each body once; return their ids in the same order. */
export async function upsertTexts(db: PrismaClient, bodies: string[]): Promise<number[]> {
  if (!bodies.length) return [];
  const hashes = bodies.map(textHash);
  await db.drugText.createMany({
    data: bodies.map((body, i) => ({ hash: hashes[i], body })),
    skipDuplicates: true,
  });
  const rows = await db.drugText.findMany({
    where: { hash: { in: [...new Set(hashes)] } },
    select: { id: true, hash: true },
  });
  const byHash = new Map(rows.map((r) => [r.hash, r.id]));
  return hashes.map((h) => {
    const id = byHash.get(h);
    if (id === undefined) throw new Error(`drug text ${h} was not stored`);
    return id;
  });
}

// ─────────────────────────────────────────────────────────────
// Products
// ─────────────────────────────────────────────────────────────

type Summary = { drug: string[]; effect: string[] } | null;

export interface ProductDraft {
  product: CatalogProduct;
  monograph: Record<string, number> | null;
  drugInteractions: Summary;
}

/** Everything the vendor supplied for a row, so an unchanged row is skipped. */
export function productFingerprint(d: ProductDraft): string {
  const p = d.product;
  return createHash('sha256')
    .update(
      JSON.stringify([
        p.name, p.genericName, p.saltComposition, p.manufacturer, p.type, p.dosageForm,
        p.packSizeLabel, p.packSize, p.mrp, p.packageType, p.packQuantity, p.productForm,
        p.rxRequired, p.habitForming, p.therapeuticClass, p.chemicalClass, p.actionClass,
        p.productCategory, p.categoryPath, p.storage, p.countryOfOrigin, p.safetyAdvice,
        p.description, p.sideEffects, d.monograph, d.drugInteractions,
      ]),
      'utf8',
    )
    .digest('hex')
    .slice(0, 32);
}

function jsonOrNull(v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return v == null ? Prisma.DbNull : (v as Prisma.InputJsonValue);
}

/** The vendor-owned fields. GTIN, HSN, aliases, publish state: never touched. */
function vendorFields(d: ProductDraft, release: string, hash: string) {
  const p = d.product;
  return {
    name: p.name,
    genericName: p.genericName,
    saltComposition: p.saltComposition,
    manufacturer: p.manufacturer,
    type: p.type,
    dosageForm: p.dosageForm,
    packSizeLabel: p.packSizeLabel,
    packSize: p.packSize,
    mrp: p.mrp,
    isDiscontinued: false,
    packageType: p.packageType,
    packQuantity: p.packQuantity,
    productForm: p.productForm,
    rxRequired: p.rxRequired,
    habitForming: p.habitForming,
    therapeuticClass: p.therapeuticClass,
    chemicalClass: p.chemicalClass,
    actionClass: p.actionClass,
    productCategory: p.productCategory,
    categoryPath: p.categoryPath,
    storage: p.storage,
    countryOfOrigin: p.countryOfOrigin,
    description: p.description,
    sideEffects: p.sideEffects,
    sourceId: p.sourceId,
    sourceRelease: release,
    sourceHash: hash,
  };
}

export interface UpsertTotals {
  inserted: number;
  updated: number;
  unchanged: number;
}

/**
 * Upsert on the vendor's Product ID. A new product is inserted; a changed one
 * rewritten; an unchanged one only has its release stamp moved. When a
 * composition changes, the drug's salt links and schedule are made stale — and
 * so are the hospital formulary rows that inherit that schedule — so the salt
 * and classification passes that follow redo them instead of keeping an answer
 * worked out from the old ingredients. A change to the prescription flag alone
 * makes the schedule stale the same way, since the classifier reads the label.
 */
export async function upsertProducts(
  db: PrismaClient,
  drafts: ProductDraft[],
  release: string,
): Promise<UpsertTotals> {
  const totals: UpsertTotals = { inserted: 0, updated: 0, unchanged: 0 };
  const withId = drafts.filter((d) => d.product.sourceId);
  if (!withId.length) return totals;

  const existing = await db.drugMaster.findMany({
    where: { sourceId: { in: withId.map((d) => d.product.sourceId!) } },
    select: {
      id: true, sourceId: true, sourceHash: true, sourceRelease: true, isDiscontinued: true,
      saltComposition: true, rxRequired: true, aliases: true, tags: true,
    },
  });
  const bySource = new Map(existing.map((e) => [e.sourceId!, e]));

  const inserts: Prisma.DrugMasterCreateManyInput[] = [];
  const touch: string[] = [];
  for (const d of withId) {
    const hash = productFingerprint(d);
    const e = bySource.get(d.product.sourceId!);
    if (!e) {
      inserts.push({
        ...vendorFields(d, release, hash),
        searchTokens: d.product.searchTokens,
        safetyAdvice: (d.product.safetyAdvice ?? undefined) as Prisma.InputJsonValue | undefined,
        drugInteractions: (d.drugInteractions ?? undefined) as Prisma.InputJsonValue | undefined,
        monograph: (d.monograph ?? undefined) as Prisma.InputJsonValue | undefined,
        isPublished: true,
      });
      continue;
    }
    if (e.sourceHash === hash) {
      if (e.sourceRelease !== release || e.isDiscontinued) touch.push(e.id);
      totals.unchanged += 1;
      continue;
    }
    const compositionChanged = (e.saltComposition ?? null) !== (d.product.saltComposition ?? null);
    // The label feeds the classifier too, so a flip of the prescription flag
    // alone is re-classified as well. Only a new composition needs new salts.
    const reclassify =
      compositionChanged || (e.rxRequired ?? null) !== (d.product.rxRequired ?? null);
    await db.drugMaster.update({
      where: { id: e.id },
      data: {
        ...vendorFields(d, release, hash),
        // Rebuilt with the row's own aliases and tags, which the vendor does not own.
        searchTokens: buildDrugSearchTokens({
          name: d.product.name,
          genericName: d.product.genericName,
          manufacturer: d.product.manufacturer,
          aliases: e.aliases,
          tags: e.tags,
        }),
        safetyAdvice: jsonOrNull(d.product.safetyAdvice),
        drugInteractions: jsonOrNull(d.drugInteractions),
        monograph: jsonOrNull(d.monograph),
        ...(reclassify ? { classifierVersion: null } : {}),
      },
    });
    if (compositionChanged) {
      await db.drugSalt.deleteMany({ where: { drugMasterId: e.id } });
    }
    if (reclassify) {
      await db.drugFormulary.updateMany({
        where: {
          drugMasterId: e.id,
          OR: [{ scheduleSource: null }, { scheduleSource: { not: 'manual' } }],
        },
        data: { classifierVersion: null },
      });
    }
    totals.updated += 1;
  }

  if (inserts.length) {
    // skipDuplicates: a second importer racing this one, or a resumed run, finds
    // the row already there rather than failing on the unique Product ID.
    const r = await db.drugMaster.createMany({ data: inserts, skipDuplicates: true });
    totals.inserted += r.count;
    totals.unchanged += inserts.length - r.count;
  }
  if (touch.length) {
    await db.drugMaster.updateMany({
      where: { id: { in: touch } },
      data: { sourceRelease: release, isDiscontinued: false },
    });
  }
  return totals;
}

/**
 * Rows uploaded through the Refresh dialog: their texts arrive whole, so they
 * are templated and stored first, then the products upserted like any release.
 * A partial file never discontinues anything.
 */
export async function upsertVendorRows(
  db: PrismaClient,
  rows: VendorCsvRow[],
  release: string,
): Promise<UpsertTotals & { skipped: number }> {
  const totals = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
  for (let i = 0; i < rows.length; i += PRODUCT_BATCH) {
    const chunk = rows.slice(i, i + PRODUCT_BATCH).filter((r) => {
      if (r.product.sourceId) return true;
      totals.skipped += 1;
      return false;
    });
    const bodies: string[] = [];
    const slots: Array<[number, string]> = [];
    chunk.forEach((r, ri) => {
      for (const [key, value] of Object.entries(r.texts)) {
        slots.push([ri, key]);
        bodies.push(templateText(value, r.product.name));
      }
    });
    const ids = await upsertTexts(db, bodies);
    const monographs: Array<Record<string, number>> = chunk.map(() => ({}));
    slots.forEach(([ri, key], j) => {
      monographs[ri][key] = ids[j];
    });
    const drafts: ProductDraft[] = chunk.map((r, ri) => ({
      product: r.product,
      monograph: Object.keys(monographs[ri]).length ? monographs[ri] : null,
      drugInteractions: r.texts.interactions
        ? interactionSummary(parseInteractions(r.texts.interactions, r.product.name))
        : null,
    }));
    const t = await upsertProducts(db, drafts, release);
    totals.inserted += t.inserted;
    totals.updated += t.updated;
    totals.unchanged += t.unchanged;
  }
  return totals;
}

// ─────────────────────────────────────────────────────────────
// Retiring the legacy catalogue
// ─────────────────────────────────────────────────────────────

/**
 * A row of the old catalogue that something depends on: a hospital imported it,
 * or someone gave it a GTIN / HSN / GST rate by hand. Every other legacy row is
 * simply deleted.
 */
export interface LegacyTarget {
  id: string;
  name: string;
  manufacturer: string | null;
  packSizeLabel: string | null;
  composition: string | null;
}

export type MatchTier =
  | 'name+manufacturer+pack'
  | 'spelling+manufacturer+pack'
  | 'name+manufacturer'
  | 'spelling+manufacturer'
  | 'name+pack'
  | 'unique-name';

const TIERS: MatchTier[] = [
  'name+manufacturer+pack',
  'spelling+manufacturer+pack',
  'name+manufacturer',
  'spelling+manufacturer',
  'name+pack',
  'unique-name',
];

const nameKey = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const compact = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The keys for tiers 1-5, null where the row lacks a part of it. Two rows that
 * both have NO pack must not "agree on the pack" — a blank would otherwise pair
 * any two products that share a name.
 */
function tierKeys(p: {
  name: string;
  manufacturer: string | null;
  packSizeLabel: string | null;
}): Array<string | null> {
  const n = nameKey(p.name);
  const c = compact(p.name);
  const m = compact(p.manufacturer);
  const k = compact(p.packSizeLabel);
  if (!n) return [null, null, null, null, null];
  return [
    m && k ? `${n}|${m}|${k}` : null,
    m && k && c ? `${c}|${m}|${k}` : null,
    m ? `${n}|${m}` : null,
    m && c ? `${c}|${m}` : null,
    k ? `${n}|${k}` : null,
  ];
}

export interface LegacyMatch {
  sourceId: string;
  tier: MatchTier;
  sameComposition: boolean;
}

/**
 * Finds each legacy row's product in the new catalogue while the release
 * streams past, so matching costs no extra pass over three-quarters of a
 * million rows and holds only the few hundred targets in memory.
 *
 * Deliberately conservative. The old and new catalogues were both scraped from
 * the same Indian listings, so most names match exactly; where they do not,
 * a loose guess would re-point a hospital's drug at a different product, and it
 * would then inherit THAT product's schedule. An unmatched row loses its link
 * instead, and is re-classified from its own composition.
 */
export class LegacyMatcher {
  private readonly byKey: Array<Map<string, number[]>> = TIERS.slice(0, 5).map(() => new Map());
  private readonly best = new Map<number, LegacyMatch & { rank: number }>();
  private readonly names = new Map<string, { count: number; sourceId: string; comp: string }>();

  constructor(private readonly targets: LegacyTarget[]) {
    targets.forEach((t, i) => {
      tierKeys(t).forEach((key, tier) => {
        if (!key) return;
        const list = this.byKey[tier].get(key);
        if (list) list.push(i);
        else this.byKey[tier].set(key, [i]);
      });
      this.names.set(nameKey(t.name), { count: 0, sourceId: '', comp: '' });
    });
  }

  observe(p: {
    sourceId: string | null;
    name: string;
    manufacturer: string | null;
    packSizeLabel: string | null;
    composition: string | null;
  }): void {
    if (!p.sourceId || !this.targets.length) return;
    const comp = compact(p.composition);
    tierKeys(p).forEach((key, tier) => {
      if (!key) return;
      for (const i of this.byKey[tier].get(key) ?? []) {
        const same = !!comp && comp === compact(this.targets[i].composition);
        const rank = tier * 2 + (same ? 0 : 1);
        const prev = this.best.get(i);
        if (!prev || rank < prev.rank) {
          this.best.set(i, { sourceId: p.sourceId!, tier: TIERS[tier], sameComposition: same, rank });
        }
      }
    });
    const n = this.names.get(nameKey(p.name));
    if (n) {
      n.count += 1;
      if (n.count === 1) {
        n.sourceId = p.sourceId;
        n.comp = comp;
      }
    }
  }

  /** targetId → the product it becomes. Targets absent here have no match. */
  results(): Map<string, LegacyMatch> {
    const out = new Map<string, LegacyMatch>();
    this.targets.forEach((t, i) => {
      const hit = this.best.get(i);
      if (hit) {
        out.set(t.id, { sourceId: hit.sourceId, tier: hit.tier, sameComposition: hit.sameComposition });
        return;
      }
      const n = this.names.get(nameKey(t.name));
      if (n && n.count === 1) {
        out.set(t.id, {
          sourceId: n.sourceId,
          tier: 'unique-name',
          sameComposition: !!n.comp && n.comp === compact(t.composition),
        });
      }
    });
    return out;
  }
}

/** Rows of the old catalogue: no vendor id, and not added by a person. */
const LEGACY: Prisma.DrugMasterWhereInput = { sourceId: null, createdById: null };

async function loadLegacyTargets(db: PrismaClient) {
  return db.drugMaster.findMany({
    where: {
      ...LEGACY,
      OR: [
        { formularyItems: { some: {} } },
        { gtin: { not: null } },
        { casePackGtin: { not: null } },
        { hsnCode: { not: null } },
        { gstRate: { not: null } },
        { manufacturerCode: { not: null } },
        { unitsPerCase: { not: null } },
        { aliases: { isEmpty: false } },
        { tags: { isEmpty: false } },
      ],
    },
    select: {
      id: true, name: true, manufacturer: true, packSizeLabel: true, genericName: true,
      saltComposition: true, gtin: true, casePackGtin: true, unitsPerCase: true,
      manufacturerCode: true, hsnCode: true, gstRate: true, aliases: true, tags: true,
    },
  });
}

type LegacyRow = Awaited<ReturnType<typeof loadLegacyTargets>>[number];

export interface RetireReport {
  tiers: Record<string, number>;
  carried: Array<{ legacy: string; product: string; fields: string[] }>;
  unlinked: Array<{ tenant: string; drug: string; legacy: string }>;
}

/** An interrupted attempt's report, with this attempt's added to it. */
export function mergeReports(prior: unknown, next: RetireReport): RetireReport {
  const p = (prior && typeof prior === 'object' ? prior : {}) as Partial<RetireReport>;
  const tiers: Record<string, number> = { ...(p.tiers ?? {}) };
  for (const [k, v] of Object.entries(next.tiers)) tiers[k] = (tiers[k] ?? 0) + v;
  return {
    tiers,
    carried: [...(p.carried ?? []), ...next.carried].slice(0, REPORT_CAP),
    unlinked: [...(p.unlinked ?? []), ...next.unlinked].slice(0, REPORT_CAP),
  };
}

/**
 * Re-point every formulary row imported from a legacy row at its successor,
 * carry hand-added codes across, and unlink the rows that have none. Nothing is
 * deleted here — see deleteLegacy.
 */
async function relinkLegacy(
  db: PrismaClient,
  targets: LegacyRow[],
  matches: Map<string, LegacyMatch>,
): Promise<{ relinked: number; unlinked: number; report: RetireReport }> {
  const report: RetireReport = { tiers: {}, carried: [], unlinked: [] };
  let relinked = 0;

  const newRows = matches.size
    ? await db.drugMaster.findMany({
        where: { sourceId: { in: [...new Set([...matches.values()].map((m) => m.sourceId))] } },
        select: {
          id: true, sourceId: true, name: true, gtin: true, casePackGtin: true, unitsPerCase: true,
          manufacturerCode: true, hsnCode: true, gstRate: true, aliases: true, tags: true,
        },
      })
    : [];
  const bySource = new Map(newRows.map((r) => [r.sourceId!, r]));

  for (const t of targets) {
    const match = matches.get(t.id);
    const target = match ? bySource.get(match.sourceId) : undefined;
    if (!match || !target) continue;
    report.tiers[match.tier] = (report.tiers[match.tier] ?? 0) + 1;

    // Fill-empty only: what the new row already has, it keeps.
    const carry: Prisma.DrugMasterUpdateInput = {};
    const fields: string[] = [];
    if (t.gtin && !target.gtin) { carry.gtin = t.gtin; fields.push('gtin'); }
    if (t.casePackGtin && !target.casePackGtin) { carry.casePackGtin = t.casePackGtin; fields.push('casePackGtin'); }
    if (t.unitsPerCase != null && target.unitsPerCase == null) { carry.unitsPerCase = t.unitsPerCase; fields.push('unitsPerCase'); }
    if (t.manufacturerCode && !target.manufacturerCode) { carry.manufacturerCode = t.manufacturerCode; fields.push('manufacturerCode'); }
    if (t.hsnCode && !target.hsnCode) { carry.hsnCode = t.hsnCode; fields.push('hsnCode'); }
    if (t.gstRate != null && target.gstRate == null) { carry.gstRate = t.gstRate; fields.push('gstRate'); }
    if (t.aliases.length && !target.aliases.length) { carry.aliases = t.aliases; fields.push('aliases'); }
    if (t.tags.length && !target.tags.length) { carry.tags = t.tags; fields.push('tags'); }

    const moved = await db.$transaction(async (tx) => {
      if (fields.length) {
        // A GTIN is unique across the catalogue, so it leaves the old row first.
        if (carry.gtin || carry.casePackGtin) {
          await tx.drugMaster.update({
            where: { id: t.id },
            data: { ...(carry.gtin ? { gtin: null } : {}), ...(carry.casePackGtin ? { casePackGtin: null } : {}) },
          });
        }
        await tx.drugMaster.update({ where: { id: target.id }, data: carry });
        // Keep this row's own view current for a second legacy row that maps here.
        Object.assign(target, carry);
      }
      const r = await tx.drugFormulary.updateMany({
        where: { drugMasterId: t.id },
        data: { drugMasterId: target.id },
      });
      // Re-inherit from the new product. A schedule a pharmacist set by hand stays.
      await tx.drugFormulary.updateMany({
        where: {
          drugMasterId: target.id,
          OR: [{ scheduleSource: null }, { scheduleSource: { not: 'manual' } }],
        },
        data: { classifierVersion: null },
      });
      return r.count;
    });
    relinked += moved;
    if (fields.length && report.carried.length < REPORT_CAP) {
      report.carried.push({ legacy: t.name, product: target.name, fields });
    }
  }

  // Formulary rows whose product is not in the new catalogue. They keep every
  // field they have — name, composition, price, stock — and lose only the link;
  // the classifier then works their schedule out from their own composition.
  const stranded = await db.drugFormulary.findMany({
    where: { drugMaster: LEGACY },
    select: { id: true, drugName: true, tenant: { select: { name: true } }, drugMaster: { select: { name: true } } },
  });
  for (const s of stranded) {
    if (report.unlinked.length >= REPORT_CAP) break;
    report.unlinked.push({ tenant: s.tenant.name, drug: s.drugName, legacy: s.drugMaster?.name ?? '' });
  }
  if (stranded.length) {
    const ids = stranded.map((s) => s.id);
    await db.drugFormulary.updateMany({
      where: { id: { in: ids }, OR: [{ scheduleSource: null }, { scheduleSource: { not: 'manual' } }] },
      data: { drugMasterId: null, classifierVersion: null },
    });
    await db.drugFormulary.updateMany({ where: { id: { in: ids } }, data: { drugMasterId: null } });
  }
  return { relinked, unlinked: stranded.length, report };
}

/**
 * Delete the legacy rows. Their salt links go with them (cascade); nothing in a
 * formulary points at them any more. Counted onto the release row batch by
 * batch, so an interrupted run's deletes are not forgotten.
 */
async function deleteLegacy(db: PrismaClient, release: string, log: (m: string) => void): Promise<number> {
  // The ids are read ONCE and deleted by primary key. Asking for "the next
  // 5,000 legacy rows" each time re-scans the table past every row already
  // deleted, so each batch is slower than the last — measured at seconds per
  // batch by the second hundred thousand. A quarter of a million uuids is ~10 MB.
  const ids = (await db.drugMaster.findMany({ where: LEGACY, select: { id: true } })).map((r) => r.id);
  let removed = 0;
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    const r = await db.drugMaster.deleteMany({ where: { ...LEGACY, id: { in: ids.slice(i, i + DELETE_BATCH) } } });
    removed += r.count;
    if (r.count) {
      await db.drugCatalogRelease.update({ where: { release }, data: { legacyRemoved: { increment: r.count } } });
    }
    if (removed % 50000 < DELETE_BATCH) log(`  retired ${removed.toLocaleString('en-IN')} legacy rows`);
  }
  return removed;
}

// ─────────────────────────────────────────────────────────────
// Apply
// ─────────────────────────────────────────────────────────────

export interface ApplyResult {
  release: string;
  products: number;
  inserted: number;
  updated: number;
  unchanged: number;
  discontinued: number;
  texts: number;
  legacyRemoved: number;
  relinked: number;
  unlinked: number;
  seconds: number;
}

/** Refused because another writer holds the catalogue. */
export class CatalogBusyError extends Error {}

// Distinct from auto-seed's own lock (4820257011). Auto-seed only TRIES its
// lock and carries on without it, so two replicas booting together would both
// reach the catalogue step; this one is a hard stop.
const CATALOG_LOCK_KEY = 4820257012;

/** DATABASE_URL forced to one connection, so the lock and its release share a session. */
function singleConnectionUrl(): string {
  const url = process.env.DATABASE_URL ?? '';
  if (/[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`;
}

let busy = false;

/** True while this process is writing a release or an upload. */
export function isCatalogBusy(): boolean {
  return busy;
}

/**
 * Hold the catalogue for one write — in this process, and across processes by
 * a Postgres advisory lock. Two replicas booting together, or the CLI run beside
 * a live server, would otherwise apply the same release at once: harmless row by
 * row (every phase is idempotent), but one of them would then mark the release
 * failed on finding its legacy rows already gone. The lock lives on its own
 * one-connection client; a session lock taken through the pool could be let go
 * by a different connection than the one holding it. Disconnecting ends the
 * session, which releases it — as does a killed process's closed socket.
 */
export async function withCatalogLock<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw new CatalogBusyError('A drug catalogue import is already running');
  busy = true;
  const lock = new PrismaClient({ datasources: { db: { url: singleConnectionUrl() } } });
  try {
    const rows = await lock.$queryRawUnsafe<Array<{ locked: boolean }>>(
      `SELECT pg_try_advisory_lock(${CATALOG_LOCK_KEY}) AS locked`,
    );
    if (!rows[0]?.locked) throw new CatalogBusyError('Another process is writing the drug catalogue');
    return await fn();
  } finally {
    busy = false;
    await lock.$disconnect().catch(() => {});
  }
}

function recordFrom(
  columns: string[],
  line: unknown[],
): { rec: Record<string, string | null>; refs: Record<string, number> } {
  const rec: Record<string, string | null> = {};
  const refs: Record<string, number> = {};
  columns.forEach((c, i) => {
    const v = line[i];
    if (c.startsWith('@')) {
      if (typeof v === 'number') refs[c.slice(1)] = v;
    } else {
      rec[c] = v == null ? null : String(v);
    }
  });
  return { rec, refs };
}

/**
 * Apply the bundled release. See the file header for the phases.
 * `log` receives progress lines; the auto-seed passes the logger.
 */
export async function applyCatalogRelease(
  db: PrismaClient,
  manifest: CatalogManifest,
  opts: { dir?: string; log?: (m: string) => void } = {},
): Promise<ApplyResult> {
  const dir = opts.dir ?? CATALOG_DIR;
  const log = opts.log ?? ((m: string) => logger.info(`[drug-catalog] ${m}`));
  const t0 = Date.now();

  await verifyBundle(dir, manifest);
  await db.drugCatalogRelease.upsert({
    where: { release: manifest.release },
    update: { status: 'importing', error: null, startedAt: new Date(), finishedAt: null },
    create: { release: manifest.release, status: 'importing', sources: manifest.sources },
  });

  try {
    // ── 1. texts ──────────────────────────────────────────────────────────
    log(`release ${manifest.release}: storing ${manifest.texts.count.toLocaleString('en-IN')} texts`);
    const textIds = new Int32Array(manifest.texts.count);
    // The interaction lists are also summarised onto each product row, so they
    // are the one kind of text kept in memory — about 3,000 of them.
    const interactionBodies = new Map<number, string>();
    let pending: string[] = [];
    let base = 0;
    let index = 0;
    const flush = async () => {
      const ids = await upsertTexts(db, pending);
      ids.forEach((id, j) => {
        textIds[base + j] = id;
      });
      base += pending.length;
      pending = [];
    };
    for await (const raw of readLines(dir, manifest.texts.files)) {
      const [section, body] = raw as [string, string];
      if (section === 'interactions') interactionBodies.set(index, body);
      pending.push(body);
      index += 1;
      if (pending.length >= TEXT_BATCH) await flush();
      if (index % 200000 === 0) log(`  ${index.toLocaleString('en-IN')} texts`);
    }
    if (pending.length) await flush();

    // ── 2 + 4a. products, finding the legacy rows' successors as they pass ──
    const targets = await loadLegacyTargets(db);
    const matcher = new LegacyMatcher(
      targets.map((t) => ({
        id: t.id,
        name: t.name,
        manufacturer: t.manufacturer,
        packSizeLabel: t.packSizeLabel,
        composition: t.saltComposition ?? t.genericName,
      })),
    );
    log(`  ${targets.length} legacy rows are referenced by a hospital or carry a code; matching them`);

    const totals = { products: 0, inserted: 0, updated: 0, unchanged: 0 };
    const parts: Array<[CatalogKind, ManifestPart | undefined]> = [
      ['drug', manifest.drugs],
      ['otc', manifest.otc],
    ];
    for (const [kind, part] of parts) {
      if (!part) continue;
      log(`  ${kind}: ${part.count.toLocaleString('en-IN')} products`);
      let batch: ProductDraft[] = [];
      const write = async () => {
        const t = await upsertProducts(db, batch, manifest.release);
        totals.inserted += t.inserted;
        totals.updated += t.updated;
        totals.unchanged += t.unchanged;
        // Counted as it goes: a run that is interrupted and resumed reports the
        // rows the first attempt wrote, not just the ones it wrote itself.
        if (t.inserted || t.updated) {
          await db.drugCatalogRelease.update({
            where: { release: manifest.release },
            data: { inserted: { increment: t.inserted }, updated: { increment: t.updated } },
          });
        }
        batch = [];
      };
      for await (const raw of readLines(dir, part.files)) {
        const { rec, refs } = recordFrom(part.columns, raw as unknown[]);
        const product = normalizeVendorRow(kind, rec);
        if (!product) continue;
        const monograph: Record<string, number> = {};
        for (const [key, idx] of Object.entries(refs)) monograph[key] = textIds[idx];
        const interactions = refs.interactions !== undefined ? interactionBodies.get(refs.interactions) : undefined;
        batch.push({
          product,
          monograph: Object.keys(monograph).length ? monograph : null,
          drugInteractions: interactions ? interactionSummary(parseInteractions(interactions, product.name)) : null,
        });
        matcher.observe({
          sourceId: product.sourceId,
          name: product.name,
          manufacturer: product.manufacturer,
          packSizeLabel: product.packSizeLabel,
          composition: product.saltComposition,
        });
        totals.products += 1;
        if (batch.length >= PRODUCT_BATCH) await write();
        if (totals.products % 100000 === 0) log(`  ${totals.products.toLocaleString('en-IN')} products`);
      }
      if (batch.length) await write();
    }

    // ── 3. discontinue what this release no longer lists ──────────────────
    const discontinued = await db.drugMaster.updateMany({
      where: {
        sourceId: { not: null },
        isDiscontinued: false,
        OR: [{ sourceRelease: null }, { sourceRelease: { not: manifest.release } }],
      },
      data: { isDiscontinued: true },
    });
    if (discontinued.count) {
      await db.drugCatalogRelease.update({
        where: { release: manifest.release },
        data: { discontinued: { increment: discontinued.count } },
      });
    }

    // ── 4b. retire the legacy catalogue ───────────────────────────────────
    // What an earlier, interrupted attempt at this release already recorded is
    // added to, never replaced.
    const prior = await db.drugCatalogRelease.findUnique({
      where: { release: manifest.release },
      select: { relinked: true, unlinked: true, report: true },
    });
    const links = await relinkLegacy(db, targets, matcher.results());
    // Written BEFORE a single legacy row is deleted. If the process dies during
    // the deletes, the record of which hospital drugs were re-pointed — and
    // which lost their link — survives, and the resumed run adds to it.
    await db.drugCatalogRelease.update({
      where: { release: manifest.release },
      data: {
        relinked: (prior?.relinked ?? 0) + links.relinked,
        unlinked: (prior?.unlinked ?? 0) + links.unlinked,
        report: mergeReports(prior?.report, links.report) as unknown as Prisma.InputJsonValue,
      },
    });
    const removed = await deleteLegacy(db, manifest.release, log);

    try {
      await db.$executeRawUnsafe('ANALYZE drug_master');
      await db.$executeRawUnsafe('ANALYZE drug_texts');
    } catch (err) {
      logger.warn({ err }, '[drug-catalog] ANALYZE skipped');
    }
    // New molecules are about to be seeded; the in-process cache must not hide them.
    invalidateSaltCache();

    const result: ApplyResult = {
      release: manifest.release,
      ...totals,
      discontinued: discontinued.count,
      texts: manifest.texts.count,
      legacyRemoved: removed,
      relinked: links.relinked,
      unlinked: links.unlinked,
      seconds: Math.round((Date.now() - t0) / 1000),
    };
    // The counts were written as each phase went; only the outcome is left.
    await db.drugCatalogRelease.update({
      where: { release: manifest.release },
      data: {
        status: 'complete',
        products: result.products,
        texts: result.texts,
        finishedAt: new Date(),
      },
    });
    log(`release ${manifest.release} applied: ${JSON.stringify(result)}`);
    return result;
  } catch (err) {
    await db.drugCatalogRelease
      .update({
        where: { release: manifest.release },
        data: { status: 'failed', error: err instanceof Error ? err.message : String(err), finishedAt: new Date() },
      })
      .catch(() => {});
    throw err;
  }
}

export interface ReleaseStatus {
  bundled: string | null;
  applied: string | null;
  latest: { release: string; status: string; finishedAt: Date | null; error: string | null } | null;
}

export async function getReleaseStatus(db: PrismaClient): Promise<ReleaseStatus> {
  let bundled: string | null = null;
  try {
    bundled = readManifest()?.release ?? null;
  } catch {
    bundled = null;
  }
  const [applied, latest] = await Promise.all([
    db.drugCatalogRelease.findFirst({ where: { status: 'complete' }, orderBy: { release: 'desc' } }),
    db.drugCatalogRelease.findFirst({ orderBy: { startedAt: 'desc' } }),
  ]);
  return {
    bundled,
    applied: applied?.release ?? null,
    latest: latest
      ? { release: latest.release, status: latest.status, finishedAt: latest.finishedAt, error: latest.error }
      : null,
  };
}

/**
 * Bring the database up to the bundled release. One query when it already is.
 *
 * Never goes backwards: an image carrying an OLDER release than the database
 * has applied (a rollback, say) leaves the catalogue alone rather than
 * discontinuing everything the newer release added.
 */
export async function ensureBundledRelease(
  db: PrismaClient,
  opts: { force?: boolean; log?: (m: string) => void } = {},
): Promise<ApplyResult | null> {
  const manifest = readManifest();
  if (!manifest) {
    logger.warn('[drug-catalog] no bundled release found — catalogue left as it is');
    return null;
  }
  const newest = await db.drugCatalogRelease.findFirst({
    where: { status: 'complete' },
    orderBy: { release: 'desc' },
  });
  if (newest && newest.release > manifest.release) {
    logger.warn(
      `[drug-catalog] database already holds release ${newest.release}; bundled ${manifest.release} is older — skipped`,
    );
    return null;
  }
  if (!opts.force && newest?.release === manifest.release) return null;
  try {
    return await withCatalogLock(() => applyCatalogRelease(db, manifest, { log: opts.log }));
  } catch (err) {
    // Another process is already applying it — this one's job is done.
    if (err instanceof CatalogBusyError) {
      logger.warn(`[drug-catalog] ${err.message}; release ${manifest.release} left to it`);
      return null;
    }
    throw err;
  }
}
