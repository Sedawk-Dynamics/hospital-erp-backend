import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../src/config/database';
import { resolveConsultationStates } from '../../../src/shared/consultation-state';

const TENANT = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
});

/** One visit row shaped the way the resolver selects it. */
const visit = (over: Record<string, unknown> = {}) => ({
  id: 'visit-1',
  status: 'active',
  visitType: 'op',
  appointment: { status: 'in_consultation' },
  doctor: { user: { firstName: 'Asha', lastName: 'Rao' } },
  ...over,
});

async function stateOf(over: Record<string, unknown> = {}) {
  vi.mocked(prisma.visit.findMany).mockResolvedValueOnce([visit(over)] as never);
  const map = await resolveConsultationStates(TENANT, ['visit-1']);
  return map.get('visit-1');
}

describe('resolveConsultationStates', () => {
  it('reports the doctor having the patient now', async () => {
    expect((await stateOf())?.state).toBe('in_consultation');
    expect((await stateOf())?.doctorName).toBe('Asha Rao');
  });

  it('reports a finished consultation', async () => {
    expect((await stateOf({ appointment: { status: 'completed' } }))?.state).toBe('done');
  });

  it.each(['pending_payment', 'booked', 'confirmed', 'checked_in', 'waiting'])(
    'treats %s as not yet seen',
    async (status) => {
      expect((await stateOf({ appointment: { status } }))?.state).toBe('awaiting');
    },
  );

  it('treats a closed visit as done even while the appointment reads open', async () => {
    const s = await stateOf({ status: 'completed', appointment: { status: 'in_consultation' } });
    expect(s?.state).toBe('done');
  });

  // The ordering that matters: closing the visit behind a cancelled
  // appointment must not read as "consultation done" to the lab.
  it.each(['cancelled', 'no_show'])(
    'never reports done for a %s appointment, even on a closed visit',
    async (status) => {
      const s = await stateOf({ status: 'completed', appointment: { status } });
      expect(s?.state).toBe('none');
    },
  );

  it('reports none when there is no appointment behind the visit', async () => {
    expect((await stateOf({ appointment: null }))?.state).toBe('none');
  });

  it('carries the visit type so an inpatient can be told apart', async () => {
    expect((await stateOf({ visitType: 'ip' }))?.visitType).toBe('ip');
  });

  it('has no doctor name when none is assigned yet', async () => {
    expect((await stateOf({ doctor: null }))?.doctorName).toBeNull();
  });

  it('resolves a page of orders in a single query', async () => {
    vi.mocked(prisma.visit.findMany).mockResolvedValueOnce([
      visit({ id: 'v1' }),
      visit({ id: 'v2', appointment: { status: 'completed' } }),
    ] as never);

    // Duplicates and nulls are normal in a page of orders.
    const map = await resolveConsultationStates(TENANT, ['v1', 'v2', 'v1', null, undefined]);

    expect(prisma.visit.findMany).toHaveBeenCalledTimes(1);
    const where = vi.mocked(prisma.visit.findMany).mock.calls[0]![0]!.where as any;
    expect(where.tenantId).toBe(TENANT);
    expect(where.id.in).toEqual(['v1', 'v2']);
    expect(map.get('v1')?.state).toBe('in_consultation');
    expect(map.get('v2')?.state).toBe('done');
  });

  it('does not query at all when no order carries a visit', async () => {
    const map = await resolveConsultationStates(TENANT, [null, undefined]);
    expect(map.size).toBe(0);
    expect(prisma.visit.findMany).not.toHaveBeenCalled();
  });
});
