import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  createImagingRequest,
  getImagingRequests,
  getImagingRequestById,
  uploadImagingResult,
  addImagingReport,
} from '../../../../src/modules/imaging/imaging.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Imaging Service', () => {
  describe('createImagingRequest', () => {
    it('should create an imaging request when patient and visit exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce({ id: 'pat-1' } as any);
      vi.mocked(prisma.visit.findFirst).mockResolvedValueOnce({ id: 'visit-1' } as any);
      vi.mocked(prisma.imagingRequest.create).mockResolvedValueOnce({
        id: 'img-req-1',
        tenantId: TENANT_ID,
        patientId: 'pat-1',
        visitId: 'visit-1',
        imagingType: 'xray',
        bodyPart: 'chest',
        status: 'requested',
      } as any);

      const result = await createImagingRequest(TENANT_ID, USER_ID, {
        patientId: 'pat-1',
        visitId: 'visit-1',
        imagingType: 'xray',
        bodyPart: 'chest',
        urgency: 'routine',
      } as any);

      expect(result.id).toBe('img-req-1');
      expect(result.imagingType).toBe('xray');
    });

    it('should throw notFound when patient does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce(null);

      await expect(
        createImagingRequest(TENANT_ID, USER_ID, {
          patientId: 'bad',
          visitId: 'visit-1',
          imagingType: 'xray',
          bodyPart: 'chest',
          urgency: 'routine',
        } as any),
      ).rejects.toThrow('Patient not found');
    });

    it('should throw notFound when visit does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce({ id: 'pat-1' } as any);
      vi.mocked(prisma.visit.findFirst).mockResolvedValueOnce(null);

      await expect(
        createImagingRequest(TENANT_ID, USER_ID, {
          patientId: 'pat-1',
          visitId: 'bad',
          imagingType: 'xray',
          bodyPart: 'chest',
          urgency: 'routine',
        } as any),
      ).rejects.toThrow('Visit not found');
    });
  });

  describe('uploadImagingResult', () => {
    it('should upload a result and mark the request as completed', async () => {
      vi.mocked(prisma.imagingRequest.findFirst).mockResolvedValueOnce({
        id: 'img-req-1',
        tenantId: TENANT_ID,
        paymentVerified: true,
      } as any);
      vi.mocked(prisma.imagingResult.findUnique).mockResolvedValueOnce(null);

      const txMock = vi.fn(async (fn: any) => {
        const tx = {
          imagingResult: {
            create: vi.fn().mockResolvedValueOnce({
              id: 'img-res-1',
              imagingRequestId: 'img-req-1',
              status: 'draft',
              impression: 'No abnormalities',
            }),
          },
          imagingRequest: {
            update: vi.fn().mockResolvedValueOnce({}),
          },
        };
        return fn(tx);
      });
      vi.mocked(prisma.$transaction).mockImplementation(txMock as any);

      const result = await uploadImagingResult(TENANT_ID, USER_ID, {
        imagingRequestId: 'img-req-1',
        patientId: 'pat-1',
        impression: 'No abnormalities',
      } as any);

      expect(result.status).toBe('draft');
      expect(result.impression).toBe('No abnormalities');
    });

    it('should throw conflict when a result already exists for the request', async () => {
      vi.mocked(prisma.imagingRequest.findFirst).mockResolvedValueOnce({
        id: 'img-req-1',
        tenantId: TENANT_ID,
        paymentVerified: true,
      } as any);
      vi.mocked(prisma.imagingResult.findUnique).mockResolvedValueOnce({
        id: 'existing',
      } as any);

      await expect(
        uploadImagingResult(TENANT_ID, USER_ID, {
          imagingRequestId: 'img-req-1',
          patientId: 'pat-1',
        } as any),
      ).rejects.toThrow('A result already exists for this imaging request');
    });
  });

  describe('getImagingRequests', () => {
    it('should return paginated imaging requests decorated with the linked bill', async () => {
      const requests = [{ id: 'img-req-1', imagingType: 'xray' }];
      vi.mocked(prisma.imagingRequest.findMany).mockResolvedValueOnce(requests as any);
      vi.mocked(prisma.imagingRequest.count).mockResolvedValueOnce(1);
      // No linked bill for this request → decoration attaches linkedBill: null.
      vi.mocked(prisma.billItem.findMany).mockResolvedValueOnce([] as any);

      const result = await getImagingRequests(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' } as any);

      expect(result.requests).toEqual([{ ...requests[0], linkedBill: null }]);
      expect(result.total).toBe(1);
    });
  });
});
