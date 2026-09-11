import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/modules/drug-master/drug-schedule.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/modules/drug-master/drug-schedule.service')>()),
  overrideFormularySchedule: vi.fn(async () => ({ id: 'd1', schedule: 'OTC' })),
}));

import { overrideFormularySchedule } from '../../../../src/modules/pharmacy/pharmacy.controller';
import { overrideFormularySchedule as overrideSchedule } from '../../../../src/modules/drug-master/drug-schedule.service';
import { AppError } from '../../../../src/shared/appError';

/**
 * A pharmacist holds pharmacy:update because dispensing needs it — and that
 * permission alone used to let it change a drug's legal schedule, for example
 * take a prescription drug off Schedule H at its own counter.
 */

async function override(roles: string[]) {
  const req: any = {
    user: { tenantId: 't1', userId: 'u1', roles },
    params: { id: 'd1' },
    body: { schedule: 'OTC' },
  };
  const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn();
  await overrideFormularySchedule(req, res, next);
  return next;
}

beforeEach(() => vi.clearAllMocks());

describe('overriding a drug schedule', () => {
  it('is refused to a pharmacist', async () => {
    const next = await override(['pharmacist']);
    expect(next.mock.calls[0][0]).toBeInstanceOf(AppError);
    expect(next.mock.calls[0][0].message).toMatch(/pharmacy admin/i);
    expect(overrideSchedule).not.toHaveBeenCalled();
  });

  it('is allowed to a pharmacy admin', async () => {
    const next = await override(['pharmacy_admin']);
    expect(next).not.toHaveBeenCalled();
    expect(overrideSchedule).toHaveBeenCalledWith('t1', 'd1', 'u1', { schedule: 'OTC' });
  });
});
