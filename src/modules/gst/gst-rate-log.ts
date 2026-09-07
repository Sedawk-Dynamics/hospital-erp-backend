// ---------------------------------------------------------------------------
// The tax master's own history.
//
// A rate that moves changes what a bill costs, and nothing recorded that it
// moved. A hospital that starts charging 5% on something it used to charge
// nothing for could not answer "when did that change, and who changed it" —
// which is the first question asked when two bills for the same service carry
// different tax.
//
// Best effort, and deliberately so: failing to write the log must never stop
// the change itself. A super admin correcting a wrong rate being blocked by the
// audit trail meant to explain the correction is the worst possible trade.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { logger } from '../../config/logger';

export type RateCodeType = 'hsn' | 'sac';
export type RateChangeAction = 'create' | 'update' | 'deactivate';

export interface RateChangeInput {
  codeType: RateCodeType;
  code: string;
  description?: string | null;
  previousRate?: number | null;
  newRate?: number | null;
  previousTreatment?: string | null;
  newTreatment?: string | null;
  action: RateChangeAction;
  changedBy?: string | null;
}

const same = (a: unknown, b: unknown) => Number(a ?? -1) === Number(b ?? -1);

/**
 * Record a change to a tax master.
 *
 * An update that moved neither the rate nor the treatment is not logged: a
 * corrected spelling is not a rate change, and a log full of them is a log
 * nobody reads.
 */
export async function recordRateChange(input: RateChangeInput): Promise<void> {
  try {
    if (
      input.action === 'update' &&
      same(input.previousRate, input.newRate) &&
      (input.previousTreatment ?? null) === (input.newTreatment ?? null)
    ) {
      return;
    }
    await prisma.gstRateChange.create({
      data: {
        codeType: input.codeType,
        code: input.code,
        description: input.description ?? null,
        previousRate: input.previousRate ?? null,
        newRate: input.newRate ?? null,
        previousTreatment: input.previousTreatment ?? null,
        newTreatment: input.newTreatment ?? null,
        action: input.action,
        changedBy: input.changedBy ?? null,
      },
    });
  } catch (err) {
    logger.error(
      { err, code: input.code, codeType: input.codeType },
      'Could not log a tax master change — the change itself stands',
    );
  }
}
