import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { parseDrugCsv, computeSourceKey, type ParsedDrug } from './drug-master.dataset';
import { getProvider } from './drug-master.providers';

export interface RefreshSummary {
  existingBefore: number;
  incoming: number;
  inserted: number;
  updated: number;
  unchanged: number;
}

type RefreshStatus = 'idle' | 'running' | 'success' | 'error';

interface RefreshState {
  status: RefreshStatus;
  startedAt: string | null;
  finishedAt: string | null;
  source: string | null;
  result: RefreshSummary | null;
  error: string | null;
}

// Single-process job state. The catalog refresh is an infrequent super-admin
// action; this in-memory tracker is enough to drive a button + status poll.
let state: RefreshState = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  source: null,
  result: null,
  error: null,
};

export function getRefreshStatus(): RefreshState {
  return state;
}

/**
 * Upsert the catalog against a set of normalised rows (from ANY provider) —
 * keyed on a stable name|manufacturer|pack identity so existing rows (and every
 * hospital's drugMasterId link) are PRESERVED. Updates mrp / discontinued /
 * composition AND the rich detail fields; inserts new drugs. Hospital
 * formulary + batch prices are never touched.
 */
export async function refreshDrugMasterFromRows(parsed: ParsedDrug[]): Promise<RefreshSummary> {
  // Dedupe incoming by identity (a source can list the same brand twice).
  const incoming = new Map<string, ParsedDrug>();
  for (const d of parsed) incoming.set(d.sourceKey, d);

  // Snapshot existing rows, keyed by the SAME identity computed from live
  // fields. `description` is selected so we can detect rows that still need
  // their rich detail backfilled.
  const existingRows = await prisma.drugMaster.findMany({
    select: {
      id: true,
      name: true,
      manufacturer: true,
      packSizeLabel: true,
      packSize: true,
      mrp: true,
      isDiscontinued: true,
      genericName: true,
      description: true,
    },
  });
  const existingBefore = existingRows.length;
  const existingByKey = new Map<string, (typeof existingRows)[number]>();
  for (const row of existingRows) {
    existingByKey.set(computeSourceKey(row.name, row.manufacturer, row.packSizeLabel), row);
  }

  const inserts: ParsedDrug[] = [];
  const updates: Array<{ id: string; row: ParsedDrug }> = [];
  let unchanged = 0;

  for (const d of incoming.values()) {
    const existing = existingByKey.get(d.sourceKey);
    if (!existing) {
      inserts.push(d);
      continue;
    }
    const currentMrp = existing.mrp != null ? Number(existing.mrp) : null;
    const changed =
      currentMrp !== d.mrp ||
      existing.isDiscontinued !== d.isDiscontinued ||
      (existing.genericName ?? null) !== d.genericName ||
      // Backfill rich detail onto rows that don't have it yet.
      (existing.description == null && d.description != null) ||
      // Backfill the numeric pack size onto rows predating the column.
      (existing.packSize == null && d.packSize != null);
    if (changed) updates.push({ id: existing.id, row: d });
    else unchanged += 1;
  }

  const insertData = (d: ParsedDrug) => ({
    name: d.name,
    genericName: d.genericName,
    manufacturer: d.manufacturer,
    type: d.type,
    dosageForm: d.dosageForm as any,
    packSizeLabel: d.packSizeLabel,
    packSize: d.packSize ?? undefined,
    mrp: d.mrp ?? undefined,
    isDiscontinued: d.isDiscontinued,
    saltComposition: d.saltComposition,
    description: d.description,
    sideEffects: d.sideEffects,
    drugInteractions: (d.drugInteractions ?? undefined) as any,
    searchTokens: d.searchTokens,
    isPublished: true,
  });

  const INSERT_BATCH = 5000;
  for (let i = 0; i < inserts.length; i += INSERT_BATCH) {
    await prisma.drugMaster.createMany({ data: inserts.slice(i, i + INSERT_BATCH).map(insertData) });
  }

  // Concurrency-bounded chunks (no giant transaction → avoids long lock spans).
  const UPDATE_CHUNK = 500;
  for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
    const chunk = updates.slice(i, i + UPDATE_CHUNK);
    await Promise.all(
      chunk.map((u) =>
        prisma.drugMaster.update({
          where: { id: u.id },
          data: {
            mrp: u.row.mrp,
            isDiscontinued: u.row.isDiscontinued,
            genericName: u.row.genericName,
            searchTokens: u.row.searchTokens,
            type: u.row.type,
            dosageForm: u.row.dosageForm as any,
            packSize: u.row.packSize ?? undefined,
            saltComposition: u.row.saltComposition,
            description: u.row.description,
            sideEffects: u.row.sideEffects,
            drugInteractions: (u.row.drugInteractions ?? undefined) as any,
          },
        }),
      ),
    );
  }

  const summary: RefreshSummary = {
    existingBefore,
    incoming: incoming.size,
    inserted: inserts.length,
    updated: updates.length,
    unchanged,
  };
  logger.info(summary, 'Drug master catalog refreshed');
  return summary;
}

export function refreshDrugMasterFromCsv(csvText: string): Promise<RefreshSummary> {
  return refreshDrugMasterFromRows(parseDrugCsv(csvText));
}

async function loadCsvFromUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Kick off a refresh in the background and return immediately. Source precedence:
 * uploaded CSV → explicit url → named provider → default 'open-dataset' provider.
 */
export function startRefresh(opts: {
  url?: string;
  csvText?: string;
  provider?: string;
  sourceLabel: string;
}): RefreshState {
  if (state.status === 'running') {
    throw AppError.conflict('A catalog refresh is already in progress');
  }
  state = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    source: opts.sourceLabel,
    result: null,
    error: null,
  };

  (async () => {
    try {
      let result: RefreshSummary;
      if (opts.csvText) {
        result = await refreshDrugMasterFromCsv(opts.csvText);
      } else if (opts.url) {
        result = await refreshDrugMasterFromCsv(await loadCsvFromUrl(opts.url));
      } else {
        const provider = getProvider(opts.provider ?? 'open-dataset');
        if (!provider) throw AppError.badRequest(`Unknown provider: ${opts.provider}`);
        if (!provider.configured()) {
          throw AppError.badRequest(`Provider "${provider.name}" is not configured`);
        }
        result = await refreshDrugMasterFromRows(await provider.fetchRows());
      }
      state = { ...state, status: 'success', finishedAt: new Date().toISOString(), result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Refresh failed';
      logger.error({ err }, 'Drug master refresh failed');
      state = { ...state, status: 'error', finishedAt: new Date().toISOString(), error: message };
    }
  })();

  return state;
}
