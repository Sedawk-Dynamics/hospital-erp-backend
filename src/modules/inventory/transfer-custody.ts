/**
 * Controlled-drug custody rules for a stock transfer.
 *
 * The NDPS page enforced these on its own challan screen; the transfer board
 * enforced nothing at all. Merging the two without this would have let a vault
 * narcotic move between departments with no second person involved and no trace
 * in the controlled register — the statutory chain of custody, gone silently.
 *
 * The rule is deliberately IDENTICAL to `ndps.service.transferStock`: a vault
 * narcotic hand-off names a receiving custodian, and that custodian must be
 * someone other than the person dispatching. Two people, or it did not happen.
 *
 * Note on strength: the counter's witness re-authenticates with their own
 * password (`assertWitnessIdentity`), whereas an NDPS transfer only names the
 * counterparty. That asymmetry is inherited on purpose — this is a port of the
 * existing rule, not a tightening of it. Raising transfers to password re-auth
 * is a one-line change here if the hospital wants it.
 */

import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';

export interface TransferCustodyDrug {
  drugName: string;
  controlledClass?: string | null;
  vaultControlled?: boolean | null;
  schedule?: string | null;
}

export interface CustodyRequirement {
  /** Any controlled handling applies — the UI shows the custody panel. */
  isControlled: boolean;
  /** A second person must take custody before the stock moves. */
  needsCustodian: boolean;
  /** Why, in words — shown to whoever is dispatching. */
  reason: string | null;
}

/** What this drug requires to be moved. Pure — no database, no throwing. */
export function resolveTransferCustody(
  drug: TransferCustodyDrug | null | undefined,
): CustodyRequirement {
  if (!drug) return { isControlled: false, needsCustodian: false, reason: null };

  const vault = Boolean(drug.vaultControlled);
  const controlled = Boolean(drug.controlledClass) || vault;

  if (vault) {
    return {
      isControlled: true,
      needsCustodian: true,
      reason:
        `${drug.drugName} is held in the narcotic safe. Moving it is a hand-over: ` +
        'name the person receiving custody, and it cannot be you.',
    };
  }
  if (controlled) {
    return {
      isControlled: true,
      needsCustodian: false,
      reason: `${drug.drugName} is a controlled substance — this move is recorded in the controlled-drug register.`,
    };
  }
  return { isControlled: false, needsCustodian: false, reason: null };
}

/**
 * Enforce the rule at dispatch, where the stock actually moves. Throws with a
 * message that says what is missing rather than just refusing.
 */
export async function assertTransferCustody(
  tenantId: string,
  drug: TransferCustodyDrug | null | undefined,
  opts: { dispatcherId: string; custodianId?: string | null },
): Promise<{ custodianId: string | null; custodyAt: Date | null }> {
  const req = resolveTransferCustody(drug);
  if (!req.needsCustodian) {
    // A controlled-but-not-vaulted drug still records a custodian when one was
    // named; it is simply not compulsory.
    return opts.custodianId
      ? { custodianId: opts.custodianId, custodyAt: new Date() }
      : { custodianId: null, custodyAt: null };
  }

  if (!opts.custodianId) {
    throw AppError.badRequest(
      `${drug?.drugName ?? 'This drug'} is kept under vault custody — name the person ` +
        'receiving it before dispatching.',
    );
  }
  if (opts.custodianId === opts.dispatcherId) {
    throw AppError.badRequest(
      'A second person must take custody of a narcotic. The receiving custodian cannot be ' +
        'the person dispatching it.',
    );
  }

  const custodian = await prisma.user.findFirst({
    where: { id: opts.custodianId, tenantId },
    select: { id: true },
  });
  if (!custodian) {
    throw AppError.badRequest('The named custodian is not a user of this hospital.');
  }

  return { custodianId: opts.custodianId, custodyAt: new Date() };
}
