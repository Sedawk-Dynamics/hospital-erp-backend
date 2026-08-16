import bcrypt from 'bcryptjs';
import { AppError } from '../../shared/appError';
import { prisma } from '../../config/database';
import { getControlledDrugSettings } from '../hospital-settings/hospital-settings.service';
import {
  resolveControlRequirements,
  legacyBlockMessage,
  type ControlledDrugLike,
  type ControlRequirements,
} from '../../shared/controlled-drug';

// ---------------------------------------------------------------------------
// The single gate every dispensing path calls for a controlled drug.
//
// It replaces five separate `throw` statements that each ejected the user out
// of the screen they were on and told them to go to the NDPS module — a module
// only a pharmacy admin can open, which is why a nurse could never record the
// narcotic dose she had just given.
//
// The policy itself lives in shared/controlled-drug.ts. This file owns only the
// enforcement: read the hospital's mode, and either reproduce the old block
// exactly or check that the inline requirements have been satisfied.
// ---------------------------------------------------------------------------

/**
 * Confirm the witness is really the witness.
 *
 * A name picked from a dropdown is not a co-sign — anyone at the terminal could
 * choose a colleague who is not in the room. The witness enters their OWN
 * password at the moment of witnessing, and it is checked against that user
 * here, so the signature means a second person was physically present.
 *
 * Failures are deliberately vague about which half was wrong: telling a caller
 * "that user exists but the password is wrong" turns this into a way to probe
 * colleagues' credentials.
 */
export async function assertWitnessIdentity(
  tenantId: string,
  witnessId: string,
  password: string | null | undefined,
  allowedRoles: string[],
): Promise<void> {
  if (!password) {
    throw AppError.badRequest('The witness must enter their password to co-sign.');
  }
  const witness = await prisma.user.findFirst({
    where: { id: witnessId, tenantId, isActive: true },
    select: {
      passwordHash: true,
      userRoles: { select: { role: { select: { name: true } } } },
    },
  });
  const ok = witness ? await bcrypt.compare(password, witness.passwordHash) : false;
  if (!ok) {
    throw AppError.badRequest('Witness could not be verified. Check the name and password.');
  }
  const roles = witness!.userRoles.map((r) => r.role.name);
  // super_admin and admin can always witness; otherwise the hospital's own list
  // decides who is authorised to.
  const privileged = roles.some((r) => r === 'super_admin' || r === 'admin');
  if (!privileged && !roles.some((r) => allowedRoles.includes(r))) {
    throw AppError.badRequest('That person is not authorised to witness a controlled-drug transaction.');
  }
}

export interface ControlledDispenseContext {
  /** Who is handing the drug over. */
  userId: string;
  /** An in-system prescription backing this dispense, if any. */
  prescriptionId?: string | null;
  /** A paper prescription captured at the counter, if any. */
  externalPrescriptionId?: string | null;
  /** The second person co-signing, when the drug needs a witness. */
  witnessedById?: string | null;
  /** That person's OWN password, proving they were present to co-sign. */
  witnessPassword?: string | null;
  /** True when the line draws from ordinary shelf/ward batch stock. */
  fromBatchStock?: boolean;
}

export interface ControlledDispenseDecision {
  requirements: ControlRequirements;
  /** Persist alongside the dispense when a witness was required and given. */
  witnessedById: string | null;
  witnessedAt: Date | null;
}

/**
 * Decide whether this controlled drug may be handed over here, and with what
 * recorded alongside it.
 *
 * Throws a specific, actionable error when a requirement is unmet — never a
 * generic refusal, because the person reading it is mid-sale with a patient in
 * front of them and needs to know what to do next.
 *
 * @param path  How the old message described this route ("counter", "ward
 *              stock", …) so `legacy_block` mode stays byte-identical.
 */
export async function checkControlledDispense(
  tenantId: string,
  drug: ControlledDrugLike | null | undefined,
  ctx: ControlledDispenseContext,
  path: string,
): Promise<ControlledDispenseDecision> {
  const requirements = resolveControlRequirements(drug);
  const none: ControlledDispenseDecision = { requirements, witnessedById: null, witnessedAt: null };
  // `drug` is non-null from here — resolveControlRequirements only reports a
  // control requirement when it had a drug to look at.
  if (!requirements.isControlled || !drug) return none;

  const settings = await getControlledDrugSettings(tenantId);

  // Today's behaviour, preserved exactly — including the wording, so a hospital
  // that never flips the switch sees no change at all.
  if (settings.mode === 'legacy_block') {
    // Only the vault tier was ever blocked. A Schedule H1 drug like tramadol has
    // always sold at the counter, and must keep doing so.
    if (requirements.needsVaultCustody) {
      throw AppError.badRequest(legacyBlockMessage(drug.drugName, path));
    }
    return none;
  }

  // ── inline mode ──
  if (requirements.needsRx && !ctx.prescriptionId && !ctx.externalPrescriptionId) {
    throw AppError.badRequest(
      `${requirements.reason} Attach the prescription — either select the patient's ` +
        'prescription or record the outside prescription they presented.',
    );
  }

  if (requirements.needsVaultCustody && ctx.fromBatchStock) {
    // Being honest about a real physical constraint: the stock is in the safe,
    // so there is nothing on the shelf to sell. This is not a policy refusal —
    // it is telling the user where the drug actually is.
    throw AppError.badRequest(
      `${drug.drugName} is held in the narcotic safe, so it cannot be drawn from shelf stock. ` +
        'Issue it out of the vault to this location first, then dispense it here.',
    );
  }

  let witnessedById: string | null = null;
  let witnessedAt: Date | null = null;
  if (requirements.needsWitness) {
    if (!ctx.witnessedById) {
      throw AppError.badRequest(
        `${drug.drugName} needs a second authorised person to witness the hand-over. ` +
          'Select a witness to continue.',
      );
    }
    if (ctx.witnessedById === ctx.userId) {
      // The whole purpose of a witness is that they are somebody else.
      throw AppError.badRequest(
        'The witness must be a different person from the one dispensing.',
      );
    }
    await assertWitnessIdentity(
      tenantId, ctx.witnessedById, ctx.witnessPassword, settings.witnessRoles,
    );
    witnessedById = ctx.witnessedById;
    witnessedAt = new Date();
  }

  return { requirements, witnessedById, witnessedAt };
}

/**
 * Batch-number prefix for quarantined controlled-drug returns.
 *
 * A returned Schedule X or narcotic item cannot simply go back on the sellable
 * shelf — it has to be held and accounted for, usually destroyed under witness.
 * Rather than add a new "quarantined" flag that every dispensing path would
 * have to learn about (and one of them would eventually forget), the returned
 * quantity lands in its own batch marked `isRecalled`. Every path already
 * refuses a recalled batch, so the stock is unsellable the moment it exists,
 * with no new filter to scatter and miss.
 */
export const QUARANTINE_PREFIX = 'QUAR-';

export interface ControlledReturnDecision {
  requirements: ControlRequirements;
  /** True when the returned stock must NOT go back to sellable stock. */
  quarantine: boolean;
  witnessedById: string | null;
}

/**
 * Whether a return of this drug may be restocked, and what it needs first.
 *
 * Vendor returns are exempt: stock going back to the distributor is leaving the
 * building under the vendor's own paperwork, not re-entering the shelf.
 */
export async function checkControlledReturn(
  tenantId: string,
  drug: ControlledDrugLike | null | undefined,
  ctx: {
    userId: string;
    witnessedById?: string | null;
    witnessPassword?: string | null;
    returnType: string;
  },
): Promise<ControlledReturnDecision> {
  const requirements = resolveControlRequirements(drug);
  const none: ControlledReturnDecision = { requirements, quarantine: false, witnessedById: null };
  if (!requirements.isControlled || !drug) return none;
  if (ctx.returnType === 'vendor_return') return none;

  const settings = await getControlledDrugSettings(tenantId);
  // Returns have always been allowed for every drug. Until a hospital switches
  // the mode on, they still are — this must not become a new hard block.
  if (settings.mode === 'legacy_block') return none;

  if (requirements.needsWitness) {
    if (!ctx.witnessedById) {
      throw AppError.badRequest(
        `${drug.drugName} is a controlled narcotic. A second authorised person must witness the ` +
          'return before it can be accepted.',
      );
    }
    if (ctx.witnessedById === ctx.userId) {
      throw AppError.badRequest('The witness must be a different person from the one accepting the return.');
    }
    await assertWitnessIdentity(
      tenantId, ctx.witnessedById, ctx.witnessPassword, settings.witnessRoles,
    );
  }

  return { requirements, quarantine: true, witnessedById: ctx.witnessedById ?? null };
}

/**
 * Read-only preview of what a cart will require, for the UI to render before
 * anything is submitted. Never throws.
 */
export async function previewControlledRequirements(
  tenantId: string,
  drugs: ControlledDrugLike[],
): Promise<{
  mode: string;
  witnessRoles: string[];
  items: Array<ControlRequirements & { drugName: string }>;
}> {
  const settings = await getControlledDrugSettings(tenantId);
  return {
    mode: settings.mode,
    witnessRoles: settings.witnessRoles,
    items: drugs
      .map((d) => ({ drugName: d.drugName, ...resolveControlRequirements(d) }))
      .filter((r) => r.isControlled),
  };
}
