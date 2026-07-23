/**
 * Temporary (provisional) patient helpers.
 *
 * The front desk can register a patient the moment they arrive with only
 * whatever is known — even nothing but a first name — so care, billing and the
 * OP/IP flow can start immediately. Such a patient is a completely normal
 * `Patient` row, distinguished ONLY by its MRN prefix (`TEMP-`), so it works
 * everywhere a registered patient does. There is no schema flag and no
 * migration.
 *
 * Later the record is either
 *   - registered in place (real details + a permanent MRN, keeping all history
 *     on the SAME row — never a second row), or
 *   - merged into an already-registered patient (every reference is repointed
 *     onto that patient and the temp record is retired).
 *
 * Note: the retired emergency/casualty flow used the longer `TEMP-ER-` prefix,
 * which also starts with `TEMP-` — so those legacy records are treated as
 * temporary here too and can finally be registered or merged.
 */
export const TEMP_MRN_PREFIX = 'TEMP-';

/** True when a patient MRN belongs to a temporary (provisional) record. */
export function isTemporaryMrn(mrn?: string | null): boolean {
  return !!mrn && mrn.startsWith(TEMP_MRN_PREFIX);
}
