import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getDashboardStats } from '../../../../src/modules/dashboard/dashboard.service';

const TENANT_ID = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Dashboard Service', () => {
  describe('getDashboardStats', () => {
    /**
     * Helper to set up all mocks for the 15 parallel queries that getDashboardStats
     * issues via Promise.all. The order must match the order in the source code.
     */
    function setupDashboardMocks(overrides: Partial<{
      totalPatients: number;
      todayNewPatients: number;
      inpatientCount: number;
      todayAppointments: number;
      completedAppointments: number;
      pendingAppointments: number;
      cancelledAppointments: number;
      pendingBills: number;
      todayPaymentsSum: number | null;
      allPaymentsSum: number | null;
      totalBeds: number;
      occupiedBeds: number;
      doctorCount: number;
      nurseCount: number;
      totalStaffCount: number;
    }> = {}) {
      const d = {
        totalPatients: 200,
        todayNewPatients: 5,
        inpatientCount: 30,
        todayAppointments: 50,
        completedAppointments: 20,
        pendingAppointments: 25,
        cancelledAppointments: 5,
        pendingBills: 10,
        todayPaymentsSum: 50000,
        allPaymentsSum: 1500000,
        totalBeds: 100,
        occupiedBeds: 60,
        doctorCount: 25,
        nurseCount: 40,
        totalStaffCount: 80,
        ...overrides,
      };

      // patient.count - totalPatients
      vi.mocked(prisma.patient.count).mockResolvedValueOnce(d.totalPatients);
      // patient.count - todayNewPatients
      vi.mocked(prisma.patient.count).mockResolvedValueOnce(d.todayNewPatients);
      // admission.count - inpatientCount
      vi.mocked(prisma.admission.count).mockResolvedValueOnce(d.inpatientCount);
      // appointment.count - todayAppointments
      vi.mocked(prisma.appointment.count).mockResolvedValueOnce(d.todayAppointments);
      // appointment.count - completedAppointments
      vi.mocked(prisma.appointment.count).mockResolvedValueOnce(d.completedAppointments);
      // appointment.count - pendingAppointments
      vi.mocked(prisma.appointment.count).mockResolvedValueOnce(d.pendingAppointments);
      // appointment.count - cancelledAppointments
      vi.mocked(prisma.appointment.count).mockResolvedValueOnce(d.cancelledAppointments);
      // bill.count - pendingBills
      vi.mocked(prisma.bill.count).mockResolvedValueOnce(d.pendingBills);
      // payment.aggregate - todayPayments
      vi.mocked(prisma.payment.aggregate).mockResolvedValueOnce({
        _sum: { amount: d.todayPaymentsSum },
      } as any);
      // payment.aggregate - allCompletedPayments
      vi.mocked(prisma.payment.aggregate).mockResolvedValueOnce({
        _sum: { amount: d.allPaymentsSum },
      } as any);
      // bed.count - totalBeds
      vi.mocked(prisma.bed.count).mockResolvedValueOnce(d.totalBeds);
      // bed.count - occupiedBeds
      vi.mocked(prisma.bed.count).mockResolvedValueOnce(d.occupiedBeds);
      // doctorProfile.count
      vi.mocked(prisma.doctorProfile.count).mockResolvedValueOnce(d.doctorCount);
      // staffProfile.count - nurses
      vi.mocked(prisma.staffProfile.count).mockResolvedValueOnce(d.nurseCount);
      // staffProfile.count - totalStaff
      vi.mocked(prisma.staffProfile.count).mockResolvedValueOnce(d.totalStaffCount);
    }

    it('should return all dashboard statistics with correct values', async () => {
      setupDashboardMocks();

      const stats = await getDashboardStats(TENANT_ID);

      expect(stats.patientStats.total).toBe(200);
      expect(stats.patientStats.todayNew).toBe(5);
      expect(stats.patientStats.inpatient).toBe(30);
      expect(stats.patientStats.outpatient).toBe(170); // 200 - 30

      expect(stats.appointmentStats.todayTotal).toBe(50);
      expect(stats.appointmentStats.completed).toBe(20);
      expect(stats.appointmentStats.pending).toBe(25);
      expect(stats.appointmentStats.cancelled).toBe(5);

      expect(stats.billingStats.todayRevenue).toBe(50000);
      expect(stats.billingStats.pendingBills).toBe(10);
      expect(stats.billingStats.totalRevenue).toBe(1500000);

      expect(stats.bedStats.total).toBe(100);
      expect(stats.bedStats.occupied).toBe(60);
      expect(stats.bedStats.available).toBe(40); // 100 - 60

      expect(stats.staffStats.totalDoctors).toBe(25);
      expect(stats.staffStats.totalNurses).toBe(40);
      expect(stats.staffStats.totalStaff).toBe(80);
    });

    it('should handle zero revenue (null sums) gracefully', async () => {
      setupDashboardMocks({
        todayPaymentsSum: null,
        allPaymentsSum: null,
      });

      const stats = await getDashboardStats(TENANT_ID);

      expect(stats.billingStats.todayRevenue).toBe(0);
      expect(stats.billingStats.totalRevenue).toBe(0);
    });

    it('should clamp outpatient and available beds to zero when negative', async () => {
      setupDashboardMocks({
        totalPatients: 10,
        inpatientCount: 50, // more than total -> would give negative outpatient
        totalBeds: 20,
        occupiedBeds: 30, // more than total -> would give negative available
      });

      const stats = await getDashboardStats(TENANT_ID);

      expect(stats.patientStats.outpatient).toBe(0);
      expect(stats.bedStats.available).toBe(0);
    });
  });
});
