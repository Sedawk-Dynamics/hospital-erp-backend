import { env } from '../../../config/env';
import type { PacsProvider, PacsStoreInput, PacsStoreResult } from './pacs.types';

// ── PostDICOM provider (cloud) ───────────────────────────────────────────────
// PostDICOM is a cloud PACS with a zero-footprint HTML5 viewer. It integrates
// in two ways:
//   1. Embed/link (implemented here): an admin stores a PostDICOM viewer URL on
//      the study and we embed it. POSTDICOM_VIEWER_URL is a template — either
//      it contains the literal token `{studyInstanceUid}` or we append the UID
//      as a query parameter.
//   2. Server-side archive via their Cloud API (Account Key + API Key, Premium
//      plan). That API surface is account-specific and not verifiable without
//      credentials, so we do NOT fabricate an upload call here: storeInstance
//      reports that archiving is unsupported and the caller keeps the file in
//      /uploads as the fallback while still exposing the embedded viewer.

/** Thrown by providers that cannot archive server-side (link/embed only). */
export class PacsArchiveUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PacsArchiveUnsupportedError';
  }
}

export const postdicomProvider: PacsProvider = {
  name: 'postdicom',
  embeddable: true,
  label: 'PostDICOM Cloud',

  isConfigured(): boolean {
    // Embeddable as long as a viewer URL template is configured. Account/API
    // keys are only needed for the (not-yet-wired) server-side upload path.
    return Boolean(env.POSTDICOM_VIEWER_URL);
  },

  async storeInstance(_input: PacsStoreInput): Promise<PacsStoreResult> {
    throw new PacsArchiveUnsupportedError(
      'PostDICOM runs in embed/link mode. Upload DICOM via the PostDICOM ' +
        'uploader, then store the share/viewer URL on the study.',
    );
  },

  buildViewerUrl(studyInstanceUid: string): string | null {
    const tpl = env.POSTDICOM_VIEWER_URL;
    if (!tpl) return null;
    if (tpl.includes('{studyInstanceUid}')) {
      return tpl.replace('{studyInstanceUid}', encodeURIComponent(studyInstanceUid));
    }
    const sep = tpl.includes('?') ? '&' : '?';
    return `${tpl}${sep}studyUid=${encodeURIComponent(studyInstanceUid)}`;
  },
};
