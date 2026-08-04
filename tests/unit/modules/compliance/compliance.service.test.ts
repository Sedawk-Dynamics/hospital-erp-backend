import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  createTicket,
  updateTicket,
  closeTicket,
  submitFeedback,
  getAuditLogs,
  createComplianceDoc,
  createOTRequest,
  reportIncident,
  updateIncident,
} from '../../../../src/modules/compliance/compliance.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// Tickets
// ============================================================

describe('Compliance Service - Tickets', () => {
  describe('createTicket', () => {
    it('should create a ticket with a generated ticket number', async () => {
      vi.mocked(prisma.ticket.count).mockResolvedValueOnce(5);
      vi.mocked(prisma.ticket.create).mockResolvedValueOnce({
        id: 'tkt-1',
        tenantId: TENANT_ID,
        ticketNumber: 'TKT-000006',
        subject: 'Broken AC',
        status: 'open',
      } as any);

      const result = await createTicket(TENANT_ID, USER_ID, {
        ticketType: 'maintenance',
        subject: 'Broken AC',
        description: 'AC in room 101 is not working',
        priority: 'high',
      } as any);

      expect(result.ticketNumber).toBe('TKT-000006');
      expect(result.status).toBe('open');
    });
  });

  describe('updateTicket', () => {
    it('should update an open ticket', async () => {
      vi.mocked(prisma.ticket.findFirst).mockResolvedValueOnce({
        id: 'tkt-1',
        status: 'open',
      } as any);
      vi.mocked(prisma.ticket.update).mockResolvedValueOnce({
        id: 'tkt-1',
        subject: 'Updated subject',
        status: 'in_progress',
      } as any);

      const result = await updateTicket(TENANT_ID, 'tkt-1', {
        subject: 'Updated subject',
        status: 'in_progress',
      } as any);

      expect(result.subject).toBe('Updated subject');
    });

    it('should throw badRequest when updating a closed ticket', async () => {
      vi.mocked(prisma.ticket.findFirst).mockResolvedValueOnce({
        id: 'tkt-1',
        status: 'closed',
      } as any);

      await expect(
        updateTicket(TENANT_ID, 'tkt-1', { subject: 'x' } as any),
      ).rejects.toThrow('Cannot update a closed ticket');
    });

    it('should throw notFound when ticket does not exist', async () => {
      vi.mocked(prisma.ticket.findFirst).mockResolvedValueOnce(null);

      await expect(
        updateTicket(TENANT_ID, 'bad-id', { subject: 'x' } as any),
      ).rejects.toThrow('Ticket not found');
    });
  });

  describe('closeTicket', () => {
    it('should throw badRequest when ticket is already closed', async () => {
      vi.mocked(prisma.ticket.findFirst).mockResolvedValueOnce({
        id: 'tkt-1',
        status: 'closed',
      } as any);

      await expect(
        closeTicket(TENANT_ID, 'tkt-1', USER_ID, { resolutionNotes: 'Done' } as any),
      ).rejects.toThrow('Ticket is already closed');
    });
  });
});

// ============================================================
// Feedback
// ============================================================

describe('Compliance Service - Feedback', () => {
  describe('submitFeedback', () => {
    it('should create a feedback record', async () => {
      vi.mocked(prisma.feedback.create).mockResolvedValueOnce({
        id: 'fb-1',
        tenantId: TENANT_ID,
        feedbackType: 'compliment',
        subject: 'Great service',
        content: 'Dr. Smith was excellent',
        rating: 5,
      } as any);

      const result = await submitFeedback(TENANT_ID, USER_ID, {
        feedbackType: 'compliment',
        subject: 'Great service',
        content: 'Dr. Smith was excellent',
        rating: 5,
      } as any);

      expect(result.id).toBe('fb-1');
      expect(result.rating).toBe(5);
    });
  });
});

// ============================================================
// Audit Logs
// ============================================================

describe('Compliance Service - Audit Logs', () => {
  describe('getAuditLogs', () => {
    it('should return paginated audit logs', async () => {
      const logs = [{ id: 'log-1', action: 'CREATE', entityType: 'Patient' }];
      vi.mocked(prisma.auditLog.findMany).mockResolvedValueOnce(logs as any);
      vi.mocked(prisma.auditLog.count).mockResolvedValueOnce(1);

      const result = await getAuditLogs(TENANT_ID, {
        page: 1,
        limit: 20,
        sortOrder: 'desc',
      } as any);

      expect(result.logs).toEqual(logs);
      expect(result.total).toBe(1);
    });

    it('should apply userId filter when provided', async () => {
      vi.mocked(prisma.auditLog.findMany).mockResolvedValueOnce([] as any);
      vi.mocked(prisma.auditLog.count).mockResolvedValueOnce(0);

      const result = await getAuditLogs(TENANT_ID, {
        page: 1,
        limit: 20,
        sortOrder: 'desc',
        userId: 'user-42',
      } as any);

      expect(result.logs).toEqual([]);
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-42' }),
        }),
      );
    });
  });
});

// ============================================================
// Compliance Documents
// ============================================================

describe('Compliance Service - Compliance Documents', () => {
  describe('createComplianceDoc', () => {
    it('should create a compliance document', async () => {
      vi.mocked(prisma.complianceDocument.create).mockResolvedValueOnce({
        id: 'doc-1',
        tenantId: TENANT_ID,
        documentType: 'license',
        title: 'NABH Certificate',
      } as any);

      const result = await createComplianceDoc(TENANT_ID, USER_ID, {
        documentType: 'license',
        title: 'NABH Certificate',
        description: 'Hospital accreditation',
        fileUrl: 'https://files.example.com/nabh.pdf',
      } as any);

      expect(result.title).toBe('NABH Certificate');
    });
  });
});

// ============================================================
// OT Requests
// ============================================================

describe('Compliance Service - OT Requests', () => {
  describe('createOTRequest', () => {
    it('should create an OT request when patient and visit exist', async () => {
      // OT is in-patient only: the patient must be currently admitted so the
      // surgery charge lands on their running IP bill.
      vi.mocked(prisma.admission.findFirst).mockResolvedValue({
        id: 'adm-1', visitId: 'visit-1',
      } as any);
      // doctorId / surgeonId may arrive as a DoctorProfile id OR a User id, so
      // the service resolves them through doctorProfile before writing.
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValue({ id: 'doc-1' } as any);
      vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce({ id: 'pat-1' } as any);
      vi.mocked(prisma.visit.findFirst).mockResolvedValueOnce({ id: 'visit-1' } as any);
      vi.mocked(prisma.otRequest.create).mockResolvedValueOnce({
        id: 'ot-1',
        tenantId: TENANT_ID,
        procedureName: 'Appendectomy',
        status: 'requested',
      } as any);

      const result = await createOTRequest(TENANT_ID, USER_ID, {
        patientId: 'pat-1',
        visitId: 'visit-1',
        doctorId: 'doc-1',
        procedureName: 'Appendectomy',
        urgency: 'routine',
      } as any);

      expect(result.procedureName).toBe('Appendectomy');
    });

    it('should throw notFound when patient does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce(null);

      await expect(
        createOTRequest(TENANT_ID, USER_ID, {
          patientId: 'bad',
          visitId: 'visit-1',
          doctorId: 'doc-1',
          procedureName: 'Appendectomy',
          urgency: 'routine',
        } as any),
      ).rejects.toThrow('Patient not found');
    });
  });
});

// ============================================================
// Incidents
// ============================================================

describe('Compliance Service - Incidents', () => {
  describe('reportIncident', () => {
    it('should create an incident report', async () => {
      vi.mocked(prisma.incidentReport.create).mockResolvedValueOnce({
        id: 'inc-1',
        tenantId: TENANT_ID,
        incidentType: 'fall',
        description: 'Patient fell in corridor',
        severity: 'moderate',
        status: 'reported',
      } as any);

      const result = await reportIncident(TENANT_ID, USER_ID, {
        incidentType: 'fall',
        description: 'Patient fell in corridor',
        severity: 'moderate',
        location: 'Corridor B',
      } as any);

      expect(result.id).toBe('inc-1');
      expect(result.status).toBe('reported');
    });
  });

  describe('updateIncident', () => {
    it('should throw badRequest when updating a closed incident', async () => {
      vi.mocked(prisma.incidentReport.findFirst).mockResolvedValueOnce({
        id: 'inc-1',
        status: 'closed',
      } as any);

      await expect(
        updateIncident(TENANT_ID, 'inc-1', { description: 'x' } as any),
      ).rejects.toThrow('Cannot update a closed incident');
    });
  });
});
