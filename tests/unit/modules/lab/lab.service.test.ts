import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';

import {
  createTest,
  getTests,
  createLabOrder,
  collectSample,
  enterResults,
  generateLabReport,
  getLabReports,
  cancelLabOrder,
  rejectSample,
} from '../../../../src/modules/lab/lab.service';

// ─── Helpers ───

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

// Transaction client: every model materialises on first touch with the full
// delegate surface, mirroring tests/setup.ts. A hand-listed shape rots — the
// moment the service called tx.labResult.deleteMany the whole file broke.
function mockTransaction() {
  const DELEGATE = [
    'findUnique', 'findFirst', 'findMany', 'create', 'createMany',
    'update', 'updateMany', 'upsert', 'delete', 'deleteMany',
    'count', 'aggregate', 'groupBy',
  ] as const;
  const DEFAULTS: Record<string, () => unknown> = {
    findMany: () => [], groupBy: () => [], count: () => 0,
    createMany: () => ({ count: 0 }), updateMany: () => ({ count: 0 }),
    deleteMany: () => ({ count: 0 }),
    aggregate: () => ({ _sum: {}, _count: 0, _avg: {}, _min: {}, _max: {} }),
  };
  const models = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  const txMock: any = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        let m = models.get(prop);
        if (!m) {
          m = {};
          for (const fn of DELEGATE) {
            const d = DEFAULTS[fn];
            m[fn] = d ? vi.fn(async () => d()) : vi.fn();
          }
          models.set(prop, m);
        }
        return m;
      },
    },
  );
  (prisma.$transaction as any).mockImplementation((fn: any) => fn(txMock));
  return txMock;
}

// ─── Test Suites ───

describe('Lab Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // Test Catalog
  // ============================================================
  describe('createTest', () => {
    it('should create a lab test successfully', async () => {
      const input = {
        testName: 'Complete Blood Count',
        testCode: 'CBC-001',
        sampleType: 'Blood',
        price: 500,
        turnaroundHours: 4,
        unit: 'cells/uL',
        normalRange: '4500-11000',
      };
      const createdTest = {
        id: 'test-1',
        tenantId: TENANT_ID,
        ...input,
      };

      (prisma.labTestCatalog.findFirst as any).mockResolvedValue(null);
      (prisma.labTestCatalog.create as any).mockResolvedValue(createdTest);

      const result = await createTest(TENANT_ID, ['admin'], input as any);

      expect(result.testName).toBe('Complete Blood Count');
    });

    it('should throw conflict if test code already exists', async () => {
      const input = { testName: 'Test', testCode: 'DUP-001' };
      (prisma.labTestCatalog.findFirst as any).mockResolvedValue({ id: 'existing-test' });

      await expect(createTest(TENANT_ID, ['admin'], input as any)).rejects.toThrow(
        'A test with this code already exists',
      );
    });
  });

  describe('getTests', () => {
    it('should return paginated lab tests', async () => {
      const tests = [
        {
          id: 'test-1',
          testName: 'CBC',
          testCode: 'CBC-001',
        },
      ];

      (prisma.labTestCatalog.findMany as any).mockResolvedValue(tests);
      (prisma.labTestCatalog.count as any).mockResolvedValue(1);

      const result = await getTests(TENANT_ID, { page: 1, limit: 20 } as any);

      expect(result.tests).toEqual(tests);
      expect(result.total).toBe(1);
    });
  });

  // ============================================================
  // Lab Orders
  // ============================================================
  describe('createLabOrder', () => {
    it('should create a lab order with items and status ordered', async () => {
      const input = {
        patientId: 'patient-1',
        visitId: 'visit-1',
        urgency: 'routine',
        items: [{ testId: 'test-1' }, { testId: 'test-2' }],
      };

      (prisma.patient.findFirst as any).mockResolvedValue({ id: 'patient-1' });
      (prisma.visit.findFirst as any).mockResolvedValue({ id: 'visit-1' });
      (prisma.labTestCatalog.findMany as any).mockResolvedValue([
        { id: 'test-1', isActive: true },
        { id: 'test-2', isActive: true },
      ]);

      const txMock = mockTransaction();

      const createdOrder = {
        id: 'order-1',
        tenantId: TENANT_ID,
        patientId: 'patient-1',
        visitId: 'visit-1',
        orderedBy: USER_ID,
        status: 'ordered',
      };

      txMock.labOrder.create.mockResolvedValue(createdOrder);
      txMock.labOrderItem.createMany.mockResolvedValue({ count: 2 });

      const fullOrder = {
        ...createdOrder,
        patient: { id: 'patient-1', mrn: 'MRN001', firstName: 'Jane', lastName: 'Doe' },
        orderer: { id: USER_ID, firstName: 'Dr', lastName: 'Smith' },
        labOrderItems: [
          { testId: 'test-1', status: 'pending', test: { id: 'test-1', testName: 'CBC', testCode: 'CBC-001' } },
          { testId: 'test-2', status: 'pending', test: { id: 'test-2', testName: 'LFT', testCode: 'LFT-001' } },
        ],
      };
      txMock.labOrder.findUnique.mockResolvedValue(fullOrder);

      const result = await createLabOrder(TENANT_ID, USER_ID, input as any);

      expect(txMock.labOrder.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            patientId: 'patient-1',
            visitId: 'visit-1',
            orderedBy: USER_ID,
            status: 'ordered',
          }),
        }),
      );
      expect(txMock.labOrderItem.createMany).toHaveBeenCalledWith({
        data: [
          { labOrderId: 'order-1', testId: 'test-1', status: 'pending' },
          { labOrderId: 'order-1', testId: 'test-2', status: 'pending' },
        ],
      });
      expect(result?.status).toBe('ordered');
      expect(result?.labOrderItems).toHaveLength(2);
    });

    it('should throw not found when patient does not exist', async () => {
      const input = {
        patientId: 'nonexistent',
        visitId: 'visit-1',
        items: [{ testId: 'test-1' }],
      };

      (prisma.patient.findFirst as any).mockResolvedValue(null);

      await expect(createLabOrder(TENANT_ID, USER_ID, input as any)).rejects.toThrow(
        'Patient not found',
      );
    });

    it('should throw not found when visit does not exist', async () => {
      const input = {
        patientId: 'patient-1',
        visitId: 'nonexistent',
        items: [{ testId: 'test-1' }],
      };

      (prisma.patient.findFirst as any).mockResolvedValue({ id: 'patient-1' });
      (prisma.visit.findFirst as any).mockResolvedValue(null);

      await expect(createLabOrder(TENANT_ID, USER_ID, input as any)).rejects.toThrow(
        'Visit not found',
      );
    });

    it('should throw bad request when one or more test IDs are invalid', async () => {
      const input = {
        patientId: 'patient-1',
        visitId: 'visit-1',
        items: [{ testId: 'test-1' }, { testId: 'test-invalid' }],
      };

      (prisma.patient.findFirst as any).mockResolvedValue({ id: 'patient-1' });
      (prisma.visit.findFirst as any).mockResolvedValue({ id: 'visit-1' });
      (prisma.labTestCatalog.findMany as any).mockResolvedValue([{ id: 'test-1' }]);

      await expect(createLabOrder(TENANT_ID, USER_ID, input as any)).rejects.toThrow(
        'One or more test IDs are invalid or inactive',
      );
    });
  });

  // ============================================================
  // Samples
  // ============================================================
  describe('collectSample', () => {
    it('should collect a sample and update order status to sample_collected', async () => {
      const input = {
        labOrderId: 'order-1',
        sampleType: 'Blood',
        barcode: 'BAR-001',
      };

      (prisma.labOrder.findFirst as any).mockResolvedValue({
        id: 'order-1',
        tenantId: TENANT_ID,
        status: 'ordered',
      });
      (prisma.labSample.findUnique as any).mockResolvedValue(null);

      const txMock = mockTransaction();

      const createdSample = {
        id: 'sample-1',
        labOrderId: 'order-1',
        sampleType: 'Blood',
        barcode: 'BAR-001',
        collectedBy: USER_ID,
        status: 'collected',
        collectedAt: new Date(),
        labOrder: { id: 'order-1', status: 'ordered', tenantId: TENANT_ID },
        collector: { id: USER_ID, firstName: 'Lab', lastName: 'Tech' },
      };
      txMock.labSample.create.mockResolvedValue(createdSample);
      txMock.labOrder.update.mockResolvedValue({});

      const result = await collectSample(TENANT_ID, USER_ID, input as any);

      expect(result.status).toBe('collected');
      expect(result.sampleType).toBe('Blood');
      expect(txMock.labOrder.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: { status: 'sample_collected' },
      });
    });

    it('should throw not found if order does not exist', async () => {
      (prisma.labOrder.findFirst as any).mockResolvedValue(null);

      await expect(
        collectSample(TENANT_ID, USER_ID, { labOrderId: 'nonexistent', sampleType: 'Blood' } as any),
      ).rejects.toThrow('Lab order not found');
    });

    it('should throw bad request if order is cancelled', async () => {
      (prisma.labOrder.findFirst as any).mockResolvedValue({
        id: 'order-1',
        tenantId: TENANT_ID,
        status: 'cancelled',
      });

      await expect(
        collectSample(TENANT_ID, USER_ID, { labOrderId: 'order-1', sampleType: 'Blood' } as any),
      ).rejects.toThrow('Cannot collect sample for a cancelled order');
    });

    it('should throw conflict if barcode already exists', async () => {
      (prisma.labOrder.findFirst as any).mockResolvedValue({
        id: 'order-1',
        tenantId: TENANT_ID,
        status: 'ordered',
      });
      (prisma.labSample.findUnique as any).mockResolvedValue({ id: 'existing-sample' });

      await expect(
        collectSample(TENANT_ID, USER_ID, {
          labOrderId: 'order-1',
          sampleType: 'Blood',
          barcode: 'DUP-BAR',
        } as any),
      ).rejects.toThrow('A sample with this barcode already exists');
    });
  });

  // ============================================================
  // Results
  // ============================================================
  describe('enterResults (addLabResult)', () => {
    it('should add result values and update order item status to in_progress', async () => {
      const input = {
        labOrderItemId: 'item-1',
        labOrderId: 'order-1',
        patientId: 'patient-1',
        results: [
          {
            parameterName: 'WBC',
            value: '7500',
            unit: 'cells/uL',
            normalRange: '4500-11000',
            isAbnormal: false,
          },
          {
            parameterName: 'RBC',
            value: '3.0',
            unit: 'million/uL',
            normalRange: '4.0-5.5',
            isAbnormal: true,
          },
        ],
      };

      (prisma.labOrderItem.findFirst as any).mockResolvedValue({
        id: 'item-1',
        status: 'pending',
        labOrder: { id: 'order-1', tenantId: TENANT_ID, status: 'sample_collected' },
      });

      const txMock = mockTransaction();

      const createdResults = input.results.map((r, i) => ({
        id: `result-${i + 1}`,
        labOrderItemId: 'item-1',
        ...r,
        enteredBy: USER_ID,
        enteredAt: new Date(),
      }));

      txMock.labResult.create
        .mockResolvedValueOnce(createdResults[0])
        .mockResolvedValueOnce(createdResults[1]);
      txMock.labOrderItem.update.mockResolvedValue({});
      txMock.labOrder.update.mockResolvedValue({});

      const results = await enterResults(TENANT_ID, USER_ID, input as any);

      expect(results).toHaveLength(2);
      expect(txMock.labResult.create).toHaveBeenCalledTimes(2);
      expect(txMock.labOrderItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { status: 'in_progress' },
      });
      expect(txMock.labOrder.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: { status: 'in_progress' },
      });
    });

    it('should throw not found if order item does not exist', async () => {
      (prisma.labOrderItem.findFirst as any).mockResolvedValue(null);

      await expect(
        enterResults(TENANT_ID, USER_ID, {
          labOrderItemId: 'nonexistent',
          labOrderId: 'order-1',
          patientId: 'patient-1',
          results: [{ parameterName: 'WBC', value: '7500' }],
        } as any),
      ).rejects.toThrow('Lab order item not found');
    });

    it('should throw bad request if order item is cancelled', async () => {
      (prisma.labOrderItem.findFirst as any).mockResolvedValue({
        id: 'item-1',
        status: 'cancelled',
        labOrder: { id: 'order-1', tenantId: TENANT_ID, status: 'cancelled' },
      });

      await expect(
        enterResults(TENANT_ID, USER_ID, {
          labOrderItemId: 'item-1',
          labOrderId: 'order-1',
          patientId: 'patient-1',
          results: [{ parameterName: 'WBC', value: '7500' }],
        } as any),
      ).rejects.toThrow('Cannot enter results for a cancelled order item');
    });
  });

  // ============================================================
  // Reports
  // ============================================================
  describe('generateLabReport', () => {
    it('should generate a lab report with draft status', async () => {
      const order = {
        id: 'order-1',
        tenantId: TENANT_ID,
        patientId: 'patient-1',
        labOrderItems: [
          {
            id: 'item-1',
            test: { id: 'test-1', testName: 'CBC' },
            labResults: [{ id: 'result-1', parameterName: 'WBC', value: '7500' }],
          },
        ],
        patient: { id: 'patient-1', firstName: 'Jane', lastName: 'Doe' },
      };

      (prisma.labOrder.findFirst as any).mockResolvedValue(order);
      (prisma.labReport.findUnique as any).mockResolvedValue(null);

      const createdReport = {
        id: 'report-1',
        labOrderId: 'order-1',
        patientId: 'patient-1',
        reportContent: 'Test report content',
        status: 'draft',
        labOrder: {
          id: 'order-1',
          status: 'completed',
          urgency: 'routine',
          labOrderItems: order.labOrderItems,
        },
        patient: { id: 'patient-1', mrn: 'MRN001', firstName: 'Jane', lastName: 'Doe' },
      };
      (prisma.labReport.create as any).mockResolvedValue(createdReport);

      const result = await generateLabReport(TENANT_ID, 'order-1', USER_ID, 'Test report content');

      // reportContent is a structured JSON document now (hospital branding,
      // patient, per-test results, notes, generatedAt) rather than the raw
      // string the caller passes — assert the notes survive into it plus the
      // fields the caller actually controls.
      expect(prisma.labReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            labOrderId: 'order-1',
            patientId: 'patient-1',
            status: 'draft',
            reportContent: expect.stringContaining('Test report content'),
          }),
        }),
      );
      expect(result.status).toBe('draft');
    });

    it('should throw not found if order does not exist', async () => {
      (prisma.labOrder.findFirst as any).mockResolvedValue(null);

      await expect(generateLabReport(TENANT_ID, 'nonexistent', USER_ID)).rejects.toThrow(
        'Lab order not found',
      );
    });

    it('should throw conflict if a report already exists for the order', async () => {
      (prisma.labOrder.findFirst as any).mockResolvedValue({
        id: 'order-1',
        tenantId: TENANT_ID,
        patientId: 'patient-1',
        labOrderItems: [],
        patient: {},
      });
      (prisma.labReport.findUnique as any).mockResolvedValue({ id: 'existing-report' });

      await expect(generateLabReport(TENANT_ID, 'order-1', USER_ID)).rejects.toThrow(
        'A report already exists for this order',
      );
    });
  });

  describe('getLabReports', () => {
    it('should return paginated lab reports', async () => {
      const reports = [
        {
          id: 'report-1',
          status: 'draft',
          patient: { id: 'patient-1', mrn: 'MRN001', firstName: 'Jane', lastName: 'Doe' },
        },
      ];

      (prisma.labReport.findMany as any).mockResolvedValue(reports);
      (prisma.labReport.count as any).mockResolvedValue(1);

      const result = await getLabReports(TENANT_ID, { page: 1, limit: 20 } as any);

      expect(result.reports).toEqual(reports);
      expect(result.total).toBe(1);
    });
  });

  // ============================================================
  // Cancel Lab Order
  // ============================================================
  describe('cancelLabOrder', () => {
    it('should cancel an order and update pending items to cancelled', async () => {
      (prisma.labOrder.findFirst as any).mockResolvedValue({
        id: 'order-1',
        tenantId: TENANT_ID,
        status: 'ordered',
      });

      const txMock = mockTransaction();
      txMock.labOrderItem.updateMany.mockResolvedValue({ count: 2 });

      const cancelledOrder = {
        id: 'order-1',
        status: 'cancelled',
        patient: { id: 'patient-1', mrn: 'MRN001', firstName: 'Jane', lastName: 'Doe' },
        labOrderItems: [],
      };
      txMock.labOrder.update.mockResolvedValue(cancelledOrder);

      const result = await cancelLabOrder(TENANT_ID, 'order-1');

      expect(result.status).toBe('cancelled');
      expect(txMock.labOrderItem.updateMany).toHaveBeenCalledWith({
        where: { labOrderId: 'order-1', status: 'pending' },
        data: { status: 'cancelled' },
      });
    });

    it('should throw bad request if order is already cancelled', async () => {
      (prisma.labOrder.findFirst as any).mockResolvedValue({
        id: 'order-1',
        tenantId: TENANT_ID,
        status: 'cancelled',
      });

      await expect(cancelLabOrder(TENANT_ID, 'order-1')).rejects.toThrow(
        'Order is already cancelled',
      );
    });
  });

  // ============================================================
  // Reject Sample
  // ============================================================
  describe('rejectSample', () => {
    it('should reject a sample with a reason', async () => {
      (prisma.labSample.findFirst as any).mockResolvedValue({
        id: 'sample-1',
        status: 'collected',
      });
      const updated = {
        id: 'sample-1',
        status: 'rejected',
        rejectionReason: 'Hemolyzed sample',
        labOrder: { id: 'order-1', status: 'ordered' },
      };
      (prisma.labSample.update as any).mockResolvedValue(updated);

      const result = await rejectSample(TENANT_ID, 'sample-1', USER_ID, { rejectionReason: 'Hemolyzed sample' } as any);

      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('Hemolyzed sample');
    });

    it('should throw bad request if sample is already rejected', async () => {
      (prisma.labSample.findFirst as any).mockResolvedValue({
        id: 'sample-1',
        status: 'rejected',
      });

      await expect(
        rejectSample(TENANT_ID, 'sample-1', USER_ID, { rejectionReason: 'Bad' } as any),
      ).rejects.toThrow('Sample is already rejected');
    });
  });
});
