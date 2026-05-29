// ── PACS provider abstraction ───────────────────────────────────────────────
// A "PACS provider" is whatever actually archives DICOM and serves a web viewer.
// The hospital ERP stays provider-agnostic: the imaging module hands a DICOM
// file to the active provider, gets back the parsed UIDs + a viewer URL, and
// mirrors those into our own DicomStudy/Series/Instance tables so every
// existing surface (studies list, doctor orders panel, patient portal) keeps
// working regardless of which backend is configured.

export type PacsProviderName = 'none' | 'orthanc' | 'postdicom';

/** Result of archiving one DICOM instance to the PACS. */
export interface PacsStoreResult {
  /** Provider's opaque id for the instance (e.g. Orthanc internal id). */
  externalInstanceId?: string;
  /** Provider's opaque id for the parent study (e.g. Orthanc internal id). */
  externalStudyId?: string;

  // DICOM UIDs + tags read back from the archive (source of truth).
  studyInstanceUid: string;
  seriesInstanceUid?: string;
  sopInstanceUid: string;

  studyDescription?: string;
  seriesDescription?: string;
  modality?: string;
  bodyPart?: string;
  accessionNumber?: string;
  studyDate?: string; // ISO yyyy-mm-dd if known
  patientName?: string;
  patientDicomId?: string;
  referringPhysician?: string;

  instanceNumber?: number;
  seriesNumber?: number;
  rows?: number;
  columns?: number;
}

/** The DICOM bytes to archive plus light metadata. */
export interface PacsStoreInput {
  buffer: Buffer;
  fileName: string;
  /** Our patient, so cloud providers can group studies under a patient folder. */
  patientMrn?: string;
  patientName?: string;
}

export interface PacsProvider {
  readonly name: PacsProviderName;
  /** True when enough config is present to actually talk to the archive. */
  isConfigured(): boolean;
  /** Whether the produced viewer URL can be embedded in an iframe. */
  readonly embeddable: boolean;
  /** Human label for the UI. */
  readonly label: string;

  /**
   * Archive one DICOM instance. Throws on transport/archive errors so the
   * caller can decide whether the failure is fatal (it isn't — upload still
   * succeeds, the file stays in /uploads as a fallback).
   */
  storeInstance(input: PacsStoreInput): Promise<PacsStoreResult>;

  /** Build the browser-facing viewer URL for a study, or null if unsupported. */
  buildViewerUrl(studyInstanceUid: string): string | null;

  /** Optional liveness check (used by the config endpoint). */
  ping?(): Promise<boolean>;
}

export interface PacsConfigSummary {
  provider: PacsProviderName;
  configured: boolean;
  embeddable: boolean;
  label: string;
}
