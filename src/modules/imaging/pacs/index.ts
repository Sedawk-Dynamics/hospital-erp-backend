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
