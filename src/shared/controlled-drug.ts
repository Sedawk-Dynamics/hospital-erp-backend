// ---------------------------------------------------------------------------
// Controlled-drug dispensing policy.
//
// Until now a drug flagged `isNarcotic` was THROWN OUT of every ordinary
// dispensing path — the counter, ward stock, ward indents and OT kits all
// refused it with "dispense it via the NDPS workflow". That message ejects the
// user from the screen they are on and sends them to a module only a pharmacy
// admin can open, which is why a nurse cannot record the narcotic dose she
// personally administers.
//
// The replacement keeps ONE flow per role. The drug's control profile decides
// which extra fields light up on the screen the user is already using, rather
// than which module they are sent to.
//
// Two independent axes, never collapsed into one flag:
//   schedule        — what the counter must collect (prescription, register)
//   controlledClass — which statutory register the drug appears in
// Tramadol is Schedule H1 AND a psychotropic: it sells at the counter with a
// prescription and a register line, and never goes near a safe.
// ---------------------------------------------------------------------------

/**
 * `legacy_block` reproduces today's behaviour exactly, down to the message.
 * `inline` lets the dispense complete on the same screen once its requirements
 * are met. Shipping as `legacy_block` means merging this code changes nothing
 * until a hospital chooses otherwise.
 */
export type ControlledDispenseMode = 'legacy_block' | 'inline';

export interface ControlledDrugSettings {
  mode: ControlledDispenseMode;
  /**
   * Who may witness a controlled-drug transaction. A witness always has to be a
   * different person from the one dispensing — that is not configurable, it is
   * the entire point of a witness.
   */
  witnessRoles: string[];
}

export const DEFAULT_CONTROLLED_DRUG_SETTINGS: ControlledDrugSettings = {
  mode: 'legacy_block',
  witnessRoles: ['nurse', 'nurse_admin', 'doctor', 'pharmacist', 'pharmacy_admin'],
};

/** Fold an untrusted patch (wire / JSON column) over the current settings. */
export function mergeControlledDrugSettings(
  base: ControlledDrugSettings,
  patch: unknown,
): ControlledDrugSettings {
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as Record<string, unknown>;
  const mode: ControlledDispenseMode =
    p.mode === 'inline' || p.mode === 'legacy_block' ? p.mode : base.mode;
  const witnessRoles = Array.isArray(p.witnessRoles)
    ? p.witnessRoles.filter((r): r is string => typeof r === 'string' && r.length > 0)
    : base.witnessRoles;
  // An empty witness list would make every witnessed transaction impossible, so
  // an accidental clear falls back rather than locking the hospital out.
  return { mode, witnessRoles: witnessRoles.length ? witnessRoles : base.witnessRoles };
}

/** The drug fields this policy reads. Kept minimal so any caller can select them. */
export interface ControlledDrugLike {
  drugName: string;
  isNarcotic?: boolean | null;
  schedule?: string | null;
  controlledClass?: string | null;
  vaultControlled?: boolean | null;
}

export interface ControlRequirements {
  /** Any control at all applies — the caller shows the controlled-drug panel. */
  isControlled: boolean;
  /** A prescription (in-system or a captured paper one) must back the sale. */
  needsRx: boolean;
  /** A second authenticated person must co-sign. */
  needsWitness: boolean;
  /**
   * Stock physically lives in the narcotic safe, so it cannot be drawn from
   * ordinary shelf batches — it has to be issued out of the vault first.
   */
  needsVaultCustody: boolean;
  /** Which statutory register this dispense belongs in, if any. */
  registerType: 'H1' | 'X' | 'NDPS' | null;
  /** Plain-language explanation, shown to whoever is dispensing. */
  reason: string | null;
}

const NONE: ControlRequirements = {
  isControlled: false,
  needsRx: false,
  needsWitness: false,
  needsVaultCustody: false,
  registerType: null,
  reason: null,
};

/**
 * What this drug requires before it can be handed over.
 *
 * Pure and synchronous so every dispensing path can call it without a query,
 * and so the five call sites cannot drift apart — the policy lives here, once.
 */
export function resolveControlRequirements(
  drug: ControlledDrugLike | null | undefined,
): ControlRequirements {
  // A line with no drug relation loaded carries no control information, so
  // there is nothing to require. Tolerated rather than asserted away: several
  // dispensing paths legitimately hold a batch without its drug.
  if (!drug) return NONE;
  const schedule = (drug.schedule ?? '').toUpperCase();
  const controlled = drug.controlledClass ?? null;
  // `isNarcotic` is the hospital's own manual tick and predates the classifier.
  // It still counts, so a drug an admin flagged by hand is never quietly
  // downgraded by a classification that disagrees.
  const vault = Boolean(drug.vaultControlled) || Boolean(drug.isNarcotic);

  if (vault) {
    return {
      isControlled: true,
      needsRx: true,
      needsWitness: true,
      needsVaultCustody: true,
      registerType: 'NDPS',
      reason:
        `${drug.drugName} is a vault-controlled narcotic. It needs a prescription, ` +
        'a second person to co-sign, and stock issued from the narcotic safe.',
    };
  }

  if (schedule === 'X') {
    return {
      isControlled: true,
      needsRx: true,
      // Schedule X is a paperwork and storage regime, not a two-person one.
      needsWitness: false,
      needsVaultCustody: false,
      registerType: 'X',
      reason:
        `${drug.drugName} is a Schedule X drug. The prescription must be presented in ` +
        'duplicate and the pharmacy retains a copy for two years.',
    };
  }

  if (schedule === 'H1' || controlled) {
    return {
      isControlled: true,
      needsRx: true,
      needsWitness: false,
      needsVaultCustody: false,
      registerType: 'H1',
      reason: controlled
        ? `${drug.drugName} is a controlled substance dispensed under Schedule ${schedule || 'H1'}. ` +
          'It needs a prescription and an entry in the H1 register.'
        : `${drug.drugName} is a Schedule H1 drug. It needs a prescription and an entry in the ` +
          'H1 register, kept for three years.',
    };
  }

  return NONE;
}

/** The message the legacy hard block has always shown. Kept verbatim. */
export function legacyBlockMessage(drugName: string, path: string): string {
  return `${drugName} is an NDPS narcotic — dispense it via the NDPS (Form 3E) ${path}.`;
}
