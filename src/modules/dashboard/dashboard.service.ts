import { prisma } from '../../config/database';
import { logger } from '../../config/logger';

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
  todayRevenue: number;
  pendingBills: number;
  totalRevenue: number;
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
        status: 'admitted',
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
        status: 'completed',
        paymentDate: { gte: today, lt: tomorrow },
      },
      _sum: { amount: true },
    }),

    prisma.payment.aggregate({
      where: {
        tenantId,
        status: 'completed',
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

    // Count nurses via role (users with a role containing 'nurse')
    prisma.staffProfile.count({
      where: {
        tenantId,
        position: { contains: 'nurse', mode: 'insensitive' },
      },
    }),

    prisma.staffProfile.count({ where: { tenantId } }),
  ]);

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
