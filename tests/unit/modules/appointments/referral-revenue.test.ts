// Gap 334: the Referral report carries each referred visit's revenue — the net
// billed amount of the finalised bills linked to the appointment or its visit.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  getAppointments,
  getReferralRevenue,
  netReferralRevenue,
} from '../../../../src/modules/appointments/appointments.service';

const T = 'tenant-1';

beforeEach(() => vi.clearAllMocks());

describe('netReferralRevenue (gap 334)', () => {
  it('sums finalised bills net of approved/processed refunds; drafts and cancelled bills earn nothing', () => {
    expect(
      netReferralRevenue([
        { status: 'paid', totalAmount: 500, refunds: [{ amount: 100, status: 'processed' }] },
        { status: 'pending', totalAmount: 250 },
        { status: 'partially_paid', totalAmount: 300, refunds: [{ amount: 50, status: 'requested' }] },
        { status: 'draft', totalAmount: 999 },
        { status: 'cancelled', totalAmount: 999 },
        { status: 'refunded', totalAmount: 200, refunds: [{ amount: 200, status: 'approved' }] },
      ]),
    ).toBe(950);
  });

  it('never goes below zero for one bill', () => {
    expect(netReferralRevenue([{ status: 'paid', totalAmount: 100, refunds: [{ amount: 150 }] }])).toBe(0);
  });
});

describe('getReferralRevenue (gap 334)', () => {
  it('links bills by the consultation line and by the visit opened from the appointment, each once', async () => {
    vi.mocked(prisma.billItem.findMany).mockResolvedValue([
      { billId: 'bill-consult', referenceId: 'appt-1' },
      { billId: 'bill-consult', referenceId: 'appt-1' },
    ] as never);
    vi.mocked(prisma.visit.findMany).mockResolvedValue([{ id: 'visit-1', appointmentId: 'appt-1' }] as never);
    vi.mocked(prisma.bill.findMany).mockResolvedValue([
      { id: 'bill-consult', status: 'paid', totalAmount: 500, visitId: 'visit-1', refunds: [] },
      { id: 'bill-lab', status: 'pending', totalAmount: 1200, visitId: 'visit-1', refunds: [{ amount: 200, status: 'processed' }] },
    ] as never);

    const map = await getReferralRevenue(T, ['appt-1', 'appt-2']);
    expect(map.get('appt-1')).toBe(1500);
    expect(map.has('appt-2')).toBe(false);

    const where = (vi.mocked(prisma.bill.findMany).mock.calls[0][0] as any).where;
    expect(where.tenantId).toBe(T);
    expect(where.status).toEqual({ notIn: ['draft', 'cancelled'] });
  });

  it('the referral list returns referralRevenue on each row (0 when nothing billed)', async () => {
    vi.mocked(prisma.appointment.findMany).mockResolvedValue([
      { id: 'appt-1', patient: { referredBy: 'Dr Ref' } },
      { id: 'appt-2', patient: { referredBy: 'Dr Ref' } },
    ] as never);
    vi.mocked(prisma.appointment.count).mockResolvedValue(2 as never);
    vi.mocked(prisma.billItem.findMany)
      .mockResolvedValueOnce([] as never) // payment info lookup
      .mockResolvedValueOnce([{ billId: 'bill-1', referenceId: 'appt-1' }] as never);
    vi.mocked(prisma.visit.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.bill.findMany).mockResolvedValue([
      { id: 'bill-1', status: 'paid', totalAmount: 700, visitId: null, refunds: [] },
    ] as never);

    const res = await getAppointments(T, { referred: true } as any);
    expect(res.appointments.map((a: any) => a.referralRevenue)).toEqual([700, 0]);
  });

  it('other appointment lists do not pay for the revenue lookup', async () => {
    vi.mocked(prisma.appointment.findMany).mockResolvedValue([{ id: 'appt-1', patient: {} }] as never);
    const res = await getAppointments(T, {} as any);
    expect((res.appointments[0] as any).referralRevenue).toBeUndefined();
    expect(prisma.visit.findMany).not.toHaveBeenCalled();
  });
});
