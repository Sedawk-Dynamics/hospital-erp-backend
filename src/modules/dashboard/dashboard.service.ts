import { prisma } from '../../config/database';
import { ACTIVE_ADMISSION_STATUS } from '../../shared/admission-status';
import { logger } from '../../config/logger';
import { istDateStr, istDayRange } from '../../shared/date.utils';
import { fullName } from '../../shared/person-name';
import { collectionDocumentNumber, isAdvanceApplication } from '../billing/bill-payment-ledger';

interface PatientStats {
  total: number;
  todayNew: number;
  inpatient: number;
  outpatient: number;
}

interface AppointmentStats {
  todayTotal: number;
  completed: number;
  pending: number;
  cancelled: number;
}

interface BillingStats {
  /** Recognised revenue today: money received against billed services. */
  todayRevenue: number;
  pendingBills: number;
  totalRevenue: number;
  /** Advances / deposits received today — held money, not revenue. */
  todayAdvances: number;
  /** The IST day both money tiles cover — what their drill-down is asked for. */
  moneyDate: string;
}

/**
 * Recognised revenue (gap item 360): completed money on REAL bills. An advance
 * or deposit receipt sits on the patient's ADV- holding bill and is not revenue
 * until it is applied — and when it is applied it lands on a real bill (as an
 * IPDEP: or adjustment row), which this then counts. Refund payouts are money
 * going back, never revenue.
 */
export const RECOGNISED_REVENUE_WHERE = {
  status: 'completed' as const,
  paymentType: { not: 'refund' as const },
  bill: { billNumber: { not: { startsWith: 'ADV-' } } },
};

/** Advance / deposit RECEIPTS: money held on the ADV- bill, not revenue. */
export const ADVANCES_RECEIVED_WHERE = {
  status: 'completed' as const,
  paymentType: 'advance' as const,
  bill: { billNumber: { startsWith: 'ADV-' } },
};

/**
 * The money tiles' day (gap item 360). One definition, read by the tile AND by
 * the rows it links to, so the two can never disagree. An IST calendar day,
 * like every billing report: the old UTC midnight meant "today" did not begin
 * until 05:30 in the morning at the counter.
 */
export function revenueDayWindow(date?: string): { date: string; gte: Date; lte: Date } {
  const day = date ?? istDateStr(new Date());
  const { start, end } = istDayRange(day);
  return { date: day, gte: start, lte: end };
}

/**
 * The payments behind "Today's revenue" and "Advances received today" — what
 * the tiles link to. Same `where` and same window as the tiles, so the totals
 * here equal the tiles to the rupee.
 */
export async function getRevenueRows(tenantId: string, query: { date?: string; kind?: 'revenue' | 'advances' } = {}) {
  const { date, gte, lte } = revenueDayWindow(query.date);
  const kind = query.kind === 'advances' ? 'advances' : 'revenue';
  const rows = await prisma.payment.findMany({
    where: {
      tenantId,
      ...(kind === 'advances' ? ADVANCES_RECEIVED_WHERE : RECOGNISED_REVENUE_WHERE),
      paymentDate: { gte, lte },
    },
    orderBy: { paymentDate: 'asc' },
    select: {
      id: true, amount: true, paymentDate: true, paymentMethod: true, paymentType: true,
      transactionId: true, sourceAdvancePaymentId: true, notes: true, voucherNumber: true,
      receipt: { select: { receiptNumber: true } },
      bill: { select: { billNumber: true } },
      patient: { select: { firstName: true, lastName: true, mrn: true } },
    },
  });
  const out = (rows ?? []).map((p) => ({
    id: p.id,
    paymentDate: p.paymentDate,
    amount: Number(p.amount ?? 0),
    method: String(p.paymentMethod),
    type: String(p.paymentType),
    documentNumber: collectionDocumentNumber(p as never),
    billNumber: p.bill?.billNumber ?? null,
    patientName: p.patient ? fullName(p.patient) : null,
    mrn: p.patient?.mrn ?? null,
    /** Revenue recognised by setting held money against the bill. */
    fromAdvance: isAdvanceApplication(p as never),
  }));
  const total = Math.round(out.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  return { date, kind, total, count: out.length, rows: out };
}

interface BedStats {
  total: number;
  occupied: number;
  available: number;
}

interface StaffStats {
  totalDoctors: number;
  totalNurses: number;
  totalStaff: number;
}

export interface DashboardStats {
  patientStats: PatientStats;
  appointmentStats: AppointmentStats;
  billingStats: BillingStats;
  bedStats: BedStats;
  staffStats: StaffStats;
}

/**
 * Get aggregated dashboard statistics for a tenant.
 */
export async function getDashboardStats(tenantId: string): Promise<DashboardStats> {
  logger.info({ tenantId }, 'Fetching dashboard stats');

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  // The money tiles use the day their drill-down uses (gap item 360).
  const moneyDay = revenueDayWindow();

  // Run all queries in parallel for performance
  const [
    totalPatients,
    todayNewPatients,
    inpatientCount,
    todayAppointments,
    completedAppointments,
    pendingAppointments,
    cancelledAppointments,
    pendingBills,
    todayPayments,
    allCompletedPayments,
    totalBeds,
    occupiedBeds,
    doctorCount,
    nurseCount,
    totalStaffCount,
  ] = await Promise.all([
    // Patient stats
    prisma.patient.count({ where: { tenantId } }),

    prisma.patient.count({
      where: {
        tenantId,
        createdAt: { gte: today, lt: tomorrow },
      },
    }),

    prisma.admission.count({
      where: {
        tenantId,
        status: ACTIVE_ADMISSION_STATUS,
      },
    }),

    // Appointment stats - today
    prisma.appointment.count({
      where: {
        tenantId,
        appointmentDate: { gte: today, lt: tomorrow },
      },
    }),

    prisma.appointment.count({
      where: {
        tenantId,
        appointmentDate: { gte: today, lt: tomorrow },
        status: 'completed',
      },
    }),

    prisma.appointment.count({
      where: {
        tenantId,
        appointmentDate: { gte: today, lt: tomorrow },
        status: { in: ['booked', 'confirmed'] },
      },
    }),

    prisma.appointment.count({
      where: {
        tenantId,
        appointmentDate: { gte: today, lt: tomorrow },
        status: 'cancelled',
      },
    }),

    // Billing stats
    prisma.bill.count({
      where: {
        tenantId,
        status: { in: ['pending', 'partially_paid'] },
      },
    }),

    prisma.payment.aggregate({
      where: {
        tenantId,
        ...RECOGNISED_REVENUE_WHERE,
        paymentDate: { gte: moneyDay.gte, lte: moneyDay.lte },
      },
      _sum: { amount: true },
    }),

    prisma.payment.aggregate({
      where: {
        tenantId,
        ...RECOGNISED_REVENUE_WHERE,
      },
      _sum: { amount: true },
    }),

    // Bed stats
    prisma.bed.count({ where: { tenantId } }),

    prisma.bed.count({
      where: {
        tenantId,
        status: 'occupied',
      },
    }),

    // Staff stats
    prisma.doctorProfile.count({ where: { tenantId } }),

    // Staff and nurse counts come from the same source as Hospital Settings →
    // Users (active user accounts of this hospital), not HR staff profiles.
    // HR profiles are optional and usually empty, which made these tiles read
    // 0 while the Users page listed every account (gap item 199).
    prisma.user.count({
      where: {
        tenantId,
        isActive: true,
        userRoles: { some: { role: { name: { contains: 'nurse', mode: 'insensitive' } } } },
      },
    }),

    prisma.user.count({ where: { tenantId, isActive: true } }),
  ]);

  // Advances received today, shown beside revenue rather than inside it.
  const todayAdvanceReceipts = await prisma.payment.aggregate({
    where: {
      tenantId,
      ...ADVANCES_RECEIVED_WHERE,
      paymentDate: { gte: moneyDay.gte, lte: moneyDay.lte },
    },
    _sum: { amount: true },
  });
  const todayAdvances = Number(todayAdvanceReceipts?._sum?.amount ?? 0);

  // Compute outpatient (total patients - currently admitted inpatients)
  const outpatientCount = totalPatients - inpatientCount;

  const todayRevenue = todayPayments._sum.amount
    ? Number(todayPayments._sum.amount)
    : 0;

  const totalRevenue = allCompletedPayments._sum.amount
    ? Number(allCompletedPayments._sum.amount)
    : 0;

  const availableBeds = totalBeds - occupiedBeds;

  const stats: DashboardStats = {
    patientStats: {
      total: totalPatients,
      todayNew: todayNewPatients,
      inpatient: inpatientCount,
      outpatient: outpatientCount > 0 ? outpatientCount : 0,
    },
    appointmentStats: {
      todayTotal: todayAppointments,
      completed: completedAppointments,
      pending: pendingAppointments,
      cancelled: cancelledAppointments,
    },
    billingStats: {
      todayRevenue,
      pendingBills,
      totalRevenue,
      todayAdvances,
      moneyDate: moneyDay.date,
    },
    bedStats: {
      total: totalBeds,
      occupied: occupiedBeds,
      available: availableBeds > 0 ? availableBeds : 0,
    },
    staffStats: {
      totalDoctors: doctorCount,
      totalNurses: nurseCount,
      totalStaff: totalStaffCount,
    },
  };

  logger.debug({ tenantId, stats }, 'Dashboard stats computed');
  return stats;
}
