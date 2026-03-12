import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  createSavedReport,
  getSavedReportById,
  generateReport,
  createScheduledReport,
  createSupportTicket,
} from '../../../../src/modules/reports/reports.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// Saved Reports
// ============================================================

describe('Reports Service - Saved Reports', () => {
  describe('createSavedReport', () => {
    it('should create a saved report', async () => {
      vi.mocked(prisma.savedReport.create).mockResolvedValueOnce({
        id: 'rpt-1',
        tenantId: TENANT_ID,
        reportName: 'Monthly Admissions',
        reportType: 'clinical',
        generatedBy: USER_ID,
      } as any);

      const result = await createSavedReport(TENANT_ID, USER_ID, {
        reportName: 'Monthly Admissions',
        reportType: 'clinical',
        fileFormat: 'pdf',
      } as any);

      expect(result.reportName).toBe('Monthly Admissions');
      expect(result.reportType).toBe('clinical');
    });
  });

  describe('getSavedReportById', () => {
    it('should throw notFound when report does not exist', async () => {
      vi.mocked(prisma.savedReport.findFirst).mockResolvedValueOnce(null);

      await expect(getSavedReportById(TENANT_ID, 'bad-id')).rejects.toThrow(
        'Saved report not found',
      );
    });
  });
});

// ============================================================
// Generate Report
// ============================================================

describe('Reports Service - Generate Report', () => {
  describe('generateReport', () => {
    it('should generate a clinical report with patient counts', async () => {
      vi.mocked(prisma.savedReport.findFirst).mockResolvedValueOnce({
        id: 'rpt-1',
        reportType: 'clinical',
        reportName: 'Clinical Summary',
      } as any);
      vi.mocked(prisma.patient.count).mockResolvedValueOnce(100); // totalPatients
      vi.mocked(prisma.patient.count).mockResolvedValueOnce(10); // recentPatients
      vi.mocked(prisma.savedReport.update).mockResolvedValueOnce({} as any);

      const result = await generateReport(TENANT_ID, 'rpt-1');

      expect(result.reportType).toBe('clinical');
      expect(result.data.totalPatients).toBe(100);
      expect(result.data.recentPatients).toBe(10);
    });

    it('should throw notFound when report does not exist', async () => {
      vi.mocked(prisma.savedReport.findFirst).mockResolvedValueOnce(null);

      await expect(generateReport(TENANT_ID, 'bad-id')).rejects.toThrow(
        'Saved report not found',
      );
    });
  });
});

// ============================================================
// Scheduled Reports
// ============================================================

describe('Reports Service - Scheduled Reports', () => {
  describe('createScheduledReport', () => {
    it('should create a scheduled report', async () => {
      vi.mocked(prisma.scheduledReport.create).mockResolvedValueOnce({
        id: 'sched-1',
        tenantId: TENANT_ID,
        reportName: 'Weekly Revenue',
        reportType: 'financial',
        schedule: 'weekly',
        deliveryEmail: 'admin@hospital.com',
      } as any);

      const result = await createScheduledReport(TENANT_ID, USER_ID, {
        reportName: 'Weekly Revenue',
        reportType: 'financial',
        schedule: 'weekly',
        deliveryEmail: 'admin@hospital.com',
      } as any);

      expect(result.reportName).toBe('Weekly Revenue');
      expect(result.schedule).toBe('weekly');
    });
  });
});

// ============================================================
// Support Tickets
// ============================================================

describe('Reports Service - Support Tickets', () => {
  describe('createSupportTicket', () => {
    it('should create a support ticket', async () => {
      vi.mocked(prisma.supportTicket.create).mockResolvedValueOnce({
        id: 'st-1',
        tenantId: TENANT_ID,
        subject: 'Login issue',
        description: 'Cannot login to dashboard',
        priority: 'high',
        status: 'open',
      } as any);

      const result = await createSupportTicket(TENANT_ID, USER_ID, {
        subject: 'Login issue',
        description: 'Cannot login to dashboard',
        priority: 'high',
      } as any);

      expect(result.subject).toBe('Login issue');
      expect(result.status).toBe('open');
    });
  });
});
