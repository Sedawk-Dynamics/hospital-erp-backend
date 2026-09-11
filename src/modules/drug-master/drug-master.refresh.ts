import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { parseVendorCsv, type VendorCsvRow } from './drug-catalog.normalize';
import {
  ensureBundledRelease,
  getReleaseStatus,
  isCatalogBusy,
  upsertVendorRows,
  withCatalogLock,
} from './drug-catalog.release';
import { DEFAULT_PROVIDER, getProvider } from './drug-master.providers';
import { runCatalogFollowUps } from '../../seeds/drug-master';

export interface RefreshSummary {
  existingBefore: number;
  incoming: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Bundled release only. */
  release?: string;
  discontinued?: number;
  legacyRemoved?: number;
  relinked?: number;
  unlinked?: number;
  /** Upload/API rows without a Product ID, which cannot be matched later. */
  skipped?: number;
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
 * Upsert rows from an upload or an API. They carry the release the database
 * is on, so re-applying that release later does not mistake them for products
 * it dropped.
 */
async function refreshFromRows(rows: VendorCsvRow[]): Promise<RefreshSummary> {
  const existingBefore = await prisma.drugMaster.count();
  const { applied, bundled } = await getReleaseStatus(prisma);
  const t = await withCatalogLock(() =>
    upsertVendorRows(prisma, rows, applied ?? bundled ?? 'upload'),
  );
  return { existingBefore, incoming: rows.length, ...t };
}

function csvRows(csvText: string): VendorCsvRow[] {
  const rows = parseVendorCsv(csvText);
  if (!rows) {
    throw AppError.badRequest(
      'Not a vendor catalogue CSV. Export the vendor workbook as CSV — the header must include ' +
        '"Product ID" and either "Product Name" (drugs) or "name" (OTC).',
    );
  }
  return rows;
}

async function loadCsvFromUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Kick off a refresh in the background and return immediately. Source precedence:
 * uploaded CSV → explicit url → named provider → the bundled release.
 *
 * The salt master, salt links and schedules are brought up to date afterwards
 * in the same job, so a product added here is labelled like every other.
 */
export function startRefresh(opts: {
  url?: string;
  csvText?: string;
  provider?: string;
  sourceLabel: string;
}): RefreshState {
  if (state.status === 'running' || isCatalogBusy()) {
    throw AppError.conflict('A catalog refresh is already in progress');
  }
  // Parse an upload before answering, so a wrong file is a 400 on the request
  // rather than an error the user has to poll for.
  const uploaded = opts.csvText ? csvRows(opts.csvText) : null;
  const provider = !uploaded && !opts.url ? getProvider(opts.provider ?? DEFAULT_PROVIDER) : undefined;
  if (!uploaded && !opts.url) {
    if (!provider) throw AppError.badRequest(`Unknown provider: ${opts.provider}`);
    if (!provider.configured()) {
      throw AppError.badRequest(`Provider "${provider.name}" is not configured`);
    }
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
      if (uploaded) {
        result = await refreshFromRows(uploaded);
      } else if (opts.url) {
        result = await refreshFromRows(csvRows(await loadCsvFromUrl(opts.url)));
      } else if (provider!.mode === 'release') {
        const existingBefore = await prisma.drugMaster.count();
        const r = await ensureBundledRelease(prisma, { force: true });
        if (!r) throw new Error('The bundled release could not be applied — see the server log');
        result = {
          existingBefore,
          incoming: r.products,
          inserted: r.inserted,
          updated: r.updated,
          unchanged: r.unchanged,
          release: r.release,
          discontinued: r.discontinued,
          legacyRemoved: r.legacyRemoved,
          relinked: r.relinked,
          unlinked: r.unlinked,
        };
      } else {
        result = await refreshFromRows(await provider!.fetchRows!());
      }
      await runCatalogFollowUps(prisma);
      state = { ...state, status: 'success', finishedAt: new Date().toISOString(), result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Refresh failed';
      logger.error({ err }, 'Drug master refresh failed');
      state = { ...state, status: 'error', finishedAt: new Date().toISOString(), error: message };
    }
  })();

  return state;
}
