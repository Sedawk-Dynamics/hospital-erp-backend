/**
 * Emergency / Casualty (Golden Hour) shared helpers.
 *
 * An emergency patient is a *temporary* patient the front desk mints on the spot
 * for an unidentified / walk-in casualty case, so treatment (OP consult or IP
 * admission), prescriptions, orders and billing can start immediately with no
 * registration. It is a normal `Patient` row distinguished ONLY by its MRN
 * prefix — there is no schema flag, so there is no migration.
 *
 * Once the patient is identified, the front desk either
 *   - registers the temp record in place (fills real details + issues a permanent
 *     MRN, keeping all the emergency-episode history on the same record), or
 *   - connects it to an already-registered patient (the emergency episode is
 *     repointed onto that patient and the temp record is retired).
 */
export const EMERGENCY_MRN_PREFIX = 'TEMP-ER-';

/** True when a patient MRN belongs to a temporary emergency (Golden-Hour) record. */
export function isEmergencyMrn(mrn?: string | null): boolean {
  return !!mrn && mrn.startsWith(EMERGENCY_MRN_PREFIX);
}
