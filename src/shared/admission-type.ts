/**
 * Admission care type — IP / Emergency / Day Care. All three run the SAME IP
 * flow (admission, bed, ledger, discharge); the type is only a tag + filter +
 * convertible label. Null in the DB is treated as 'ip'.
 *
 * Stored in `admissions.admission_type` (VarChar) and accessed via raw SQL until
 * the Prisma client is regenerated (the dev server locks the engine on Windows).
 */
export const ADMISSION_TYPES = ['ip', 'emergency', 'daycare'] as const;
export type AdmissionType = (typeof ADMISSION_TYPES)[number];

export function normalizeAdmissionType(v: unknown): AdmissionType {
  return (ADMISSION_TYPES as readonly string[]).includes(v as string) ? (v as AdmissionType) : 'ip';
}

/** Human label for print/PDF output — mirrors ADMISSION_TYPE_LABELS on the client. */
export const ADMISSION_TYPE_LABELS: Record<AdmissionType, string> = {
  ip: 'In-Patient',
  emergency: 'Emergency',
  daycare: 'Day Care',
};
