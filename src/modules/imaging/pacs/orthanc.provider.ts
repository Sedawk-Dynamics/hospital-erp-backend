import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { buildProxiedViewerUrl } from './pacs-proxy';
import type { PacsProvider, PacsStoreInput, PacsStoreResult } from './pacs.types';

// ── Orthanc provider ─────────────────────────────────────────────────────────
// Talks to a self-hosted Orthanc DICOM server over its REST API. Uploaded
// DICOM is archived with `POST /instances`; we then read the tags back from
// Orthanc (the source of truth) and build an OHIF viewer URL served by
// Orthanc's bundled OHIF plugin.
//
// Why the REST `/instances` route and not DICOMweb STOW-RS? Both work, but the
// REST route returns Orthanc's internal ids directly and we read tags via the
// simplified-tags endpoint in a single follow-up call — fewer round-trips and
// no multipart assembly. Viewing still goes through DICOMweb (OHIF ↔ Orthanc).

function authHeader(): Record<string, string> {
  if (!env.ORTHANC_USERNAME) return {};
  const token = Buffer.from(`${env.ORTHANC_USERNAME}:${env.ORTHANC_PASSWORD}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

function base(): string {
  return env.ORTHANC_URL.replace(/\/+$/, '');
}

/** Browser-facing base for the OHIF viewer; falls back to ORTHANC_URL. */
function publicBase(): string {
  return (env.ORTHANC_PUBLIC_URL || env.ORTHANC_URL).replace(/\/+$/, '');
}

async function orthancGet<T>(path: string): Promise<T> {
  const res = await fetch(`${base()}${path}`, { headers: { ...authHeader() } });
  if (!res.ok) throw new Error(`Orthanc GET ${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** "20230131" → "2023-01-31"; passthrough for anything else. */
function dicomDateToIso(d?: string): string | undefined {
  if (!d || !/^\d{8}$/.test(d)) return d || undefined;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function toInt(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : undefined;
}

interface OrthancStoreResponse {
  ID: string;
  ParentStudy?: string;
  ParentSeries?: string;
  Status?: string;
}

export const orthancProvider: PacsProvider = {
  name: 'orthanc',
  embeddable: true,
  label: 'Orthanc PACS (OHIF viewer)',

  isConfigured(): boolean {
    return Boolean(env.ORTHANC_URL);
  },

  async ping(): Promise<boolean> {
    try {
      await orthancGet('/system');
      return true;
    } catch (err) {
      logger.warn({ err }, 'Orthanc ping failed');
      return false;
    }
  },

  async storeInstance(input: PacsStoreInput): Promise<PacsStoreResult> {
    const stored = await fetch(`${base()}/instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/dicom', ...authHeader() },
      body: new Uint8Array(input.buffer),
    });
    if (!stored.ok) {
      const text = await stored.text().catch(() => '');
      throw new Error(`Orthanc store failed → ${stored.status} ${stored.statusText} ${text}`);
    }
    const result = (await stored.json()) as OrthancStoreResponse;

    // Read every tag back in one call (human-readable keys).
    const tags = await orthancGet<Record<string, string>>(
      `/instances/${result.ID}/tags?simplify`,
    );

    const studyInstanceUid = tags.StudyInstanceUID;
    const sopInstanceUid = tags.SOPInstanceUID;
    if (!studyInstanceUid || !sopInstanceUid) {
      throw new Error('Orthanc returned an instance without Study/SOP Instance UID');
    }

    return {
      externalInstanceId: result.ID,
      externalStudyId: result.ParentStudy,
      studyInstanceUid,
      seriesInstanceUid: tags.SeriesInstanceUID || undefined,
      sopInstanceUid,
      studyDescription: tags.StudyDescription || undefined,
      seriesDescription: tags.SeriesDescription || undefined,
      modality: tags.Modality || undefined,
      bodyPart: tags.BodyPartExamined || undefined,
      accessionNumber: tags.AccessionNumber || undefined,
      studyDate: dicomDateToIso(tags.StudyDate),
      patientName: tags.PatientName || input.patientName || undefined,
      patientDicomId: tags.PatientID || input.patientMrn || undefined,
      referringPhysician: tags.ReferringPhysicianName || undefined,
      instanceNumber: toInt(tags.InstanceNumber),
      seriesNumber: toInt(tags.SeriesNumber),
      rows: toInt(tags.Rows),
      columns: toInt(tags.Columns),
    };
  },

  buildViewerUrl(studyInstanceUid: string): string {
    // Production: route the viewer through the authenticating, tenant-scoped
    // PACS proxy so the browser never touches Orthanc directly.
    if (env.PACS_PROXY_ENABLED) {
      return buildProxiedViewerUrl(studyInstanceUid);
    }
    // Direct mode (dev / trusted network): hit Orthanc's bundled OHIF.
    const path = env.ORTHANC_OHIF_PATH.startsWith('/')
      ? env.ORTHANC_OHIF_PATH
      : `/${env.ORTHANC_OHIF_PATH}`;
    return `${publicBase()}${path}?StudyInstanceUIDs=${encodeURIComponent(studyInstanceUid)}`;
  },
};
