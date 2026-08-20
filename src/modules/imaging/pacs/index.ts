import { env } from '../../../config/env';
import { orthancProvider } from './orthanc.provider';
import { postdicomProvider, PacsArchiveUnsupportedError } from './postdicom.provider';
import type { PacsProvider, PacsConfigSummary } from './pacs.types';

export type { PacsProvider, PacsStoreInput, PacsStoreResult, PacsConfigSummary } from './pacs.types';
export { PacsArchiveUnsupportedError };
export { buildPacsRouter, buildProxiedViewerUrl, pacsProxyOhifBase, buildRetrieveUrl } from './pacs-proxy';

/** True when browser access to Orthanc is routed through the auth gateway. */
export function isPacsProxyEnabled(): boolean {
  return env.PACS_PROXY_ENABLED && env.PACS_PROVIDER === 'orthanc';
}

/** The provider selected by PACS_PROVIDER, or null when integration is off. */
export function getPacsProvider(): PacsProvider | null {
  switch (env.PACS_PROVIDER) {
    case 'orthanc':
      return orthancProvider;
    case 'postdicom':
      return postdicomProvider;
    case 'none':
    default:
      return null;
  }
}

/** True when a provider is selected AND has enough config to be usable. */
export function isPacsEnabled(): boolean {
  const p = getPacsProvider();
  return Boolean(p && p.isConfigured());
}

export type PacsHealthStatus =
  /** No provider selected — the integration is deliberately switched off. */
  | 'off'
  /** A provider is selected but its configuration is incomplete. */
  | 'misconfigured'
  /** Configured, but the archive did not answer. */
  | 'unreachable'
  /** Configured and answering. */
  | 'ok';

export interface PacsHealth {
  status: PacsHealthStatus;
  provider: string;
  /** Round-trip to the archive in ms, when it answered. */
  latencyMs: number | null;
  checkedAt: string;
}

// A reachability probe is a network round trip, and the status sits on a screen
// that may poll. Serving a recent answer keeps a dashboard from turning into
// traffic against the archive; 15s is short enough that an outage surfaces
// while someone is still looking at the page.
const HEALTH_TTL_MS = 15_000;
let cached: { at: number; value: PacsHealth } | null = null;

/**
 * Whether the imaging archive is actually answering.
 *
 * `isPacsEnabled()` only says a provider is selected and configured — which is
 * true of an Orthanc that is switched off. Nothing distinguished that from a
 * working one, so a study simply failed to open with no way to tell "not
 * deployed" from "broken", by either the user or an admin.
 */
export async function getPacsHealth(opts: { force?: boolean } = {}): Promise<PacsHealth> {
  if (!opts.force && cached && Date.now() - cached.at < HEALTH_TTL_MS) {
    return cached.value;
  }

  const provider = getPacsProvider();
  const base = { provider: provider?.name ?? 'none', latencyMs: null as number | null };

  let value: PacsHealth;
  if (!provider) {
    value = { ...base, status: 'off', checkedAt: new Date().toISOString() };
  } else if (!provider.isConfigured()) {
    value = { ...base, status: 'misconfigured', checkedAt: new Date().toISOString() };
  } else if (!provider.ping) {
    // Configured with no probe to run — the most that can honestly be said.
    value = { ...base, status: 'ok', checkedAt: new Date().toISOString() };
  } else {
    const startedAt = Date.now();
    let reachable = false;
    try {
      reachable = await provider.ping();
    } catch {
      // ping() already logs; an exception here just means unreachable.
      reachable = false;
    }
    const latencyMs = Date.now() - startedAt;
    value = {
      ...base,
      status: reachable ? 'ok' : 'unreachable',
      latencyMs: reachable ? latencyMs : null,
      checkedAt: new Date().toISOString(),
    };
  }

  cached = { at: Date.now(), value };
  return value;
}

/** Can the active provider archive DICOM server-side (vs embed-only)? */
export function pacsSupportsArchive(): boolean {
  return env.PACS_PROVIDER === 'orthanc' && isPacsEnabled();
}

/** Summary shape consumed by the frontend to decide what UI to show. */
export function getPacsConfigSummary(): PacsConfigSummary {
  const p = getPacsProvider();
  if (!p) {
    return { provider: 'none', configured: false, embeddable: false, label: 'In-house viewer', proxy: false };
  }
  return {
    provider: p.name,
    configured: p.isConfigured(),
    embeddable: p.embeddable,
    label: p.label,
    proxy: isPacsProxyEnabled(),
  };
}
