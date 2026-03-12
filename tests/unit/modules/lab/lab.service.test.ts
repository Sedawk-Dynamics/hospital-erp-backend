import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { AppError } from '../../../../src/shared/appError';

import {
  createLabDepartment,
  getLabDepartments,
  createTest,
  getTests,
  createLabOrder,
  collectSample,
  enterResults,
  generateLabReport,
  getLabReports,
  cancelLabOrder,
  updateLabDepartment,
  rejectSample,
} from '../../../../src/modules/lab/lab.service';

// ─── Helpers ───

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

function mockTransaction() {
  const txMock = {
    labOrder: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    labOrderItem: {
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    labSample: {
      create: vi.fn(),
    },
    labResult: {
      create: vi.fn(),
    },
  };
  (prisma.$transaction as any).mockImplementation((fn: any) => fn(txMock));
  return txMock;
}

// ─── Test Suites ───

describe('Lab Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // Lab Departments
  // ============================================================
  describe('createLabDepartment', () => {
    it('should create a lab department successfully', async () => {
      const input = { name: 'Hematology', isActive: true };
      const expected = { id: 'dept-1', tenantId: TENANT_ID, ...input, createdAt: new Date() };

      (prisma.labDepartment.findFirst as any).mockResolvedValue(null);
      (prisma.labDepartment.create as any).mockResolvedValue(expected);

      const result = await createLabDepartment(TENANT_ID, input);

      expect(prisma.labDepartment.findFirst).toHaveBeenCalledWith({
        where: { tenantId: TENANT_ID, name: 'Hematology' },
      });
      expect(prisma.labDepartment.create).toHaveBeenCalledWith({
        data: { tenantId: TENANT_ID, name: 'Hematology', isActive: true },
      });
      expect(result).toEqual(expected);
    });

    it('should throw conflict error when department name already exists', async () => {
      const input = { name: 'Hematology', isActive: true };
      (prisma.labDepartment.findFirst as any).mockResolvedValue({ id: 'existing-dept' });

      await expect(createLabDepartment(TENANT_ID, input)).rejects.toThrow(AppError);
      await expect(createLabDepartment(TENANT_ID, input)).rejects.toThrow(
        'A lab department with this name already exists',
      );
      expect(prisma.labDepartment.create).not.toHaveBeenCalled();
    });
  });

  describe('getLabDepartments', () => {
    it('should return paginated lab departments', async () => {
      const departments = [
        { id: 'dept-1', name: 'Hematology', tenantId: TENANT_ID },
        { id: 'dept-2', name: 'Microbiology', tenantId: TENANT_ID },
      ];

      (prisma.labDepartment.findMany as any).mockResolvedValue(departments);
      (prisma.labDepartment.count as any).mockResolvedValue(2);

      const result = await getLabDepartments(TENANT_ID, { page: 1, limit: 20 } as any);

      expect(result.departments).toEqual(departments);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('should filter departments by search term', async () => {
      (prisma.labDepartment.findMany as any).mockResolvedValue([]);
      (prisma.labDepartment.count as any).mockResolvedValue(0);

      await getLabDepartments(TENANT_ID, { page: 1, limit: 20, search: 'hema' } as any);

      const findManyCall = (prisma.labDepartment.findMany as any).mock.calls[0][0];
      expect(findManyCall.where.name).toEqual({ contains: 'hema', mode: 'insensitive' });
    });

    it('should filter departments by isActive flag', async () => {
      (prisma.labDepartment.findMany as any).mockResolvedValue([]);
      (prisma.labDepartment.count as any).mockResolvedValue(0);

      await getLabDepartments(TENANT_ID, { page: 1, limit: 20, isActive: true } as any);

      const findManyCall = (prisma.labDepartment.findMany as any).mock.calls[0][0];
      expect(findManyCall.where.isActive).toBe(true);
    });
  });

  // ============================================================
  // Test Catalog
  // ============================================================
  describe('createTest', () => {
    it('should create a lab test successfully', async () => {
      const input = {
        labDepartmentId: 'dept-1',
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
        labDepartment: { id: 'dept-1', name: 'Hematology' },
      };

      (prisma.labDepartment.findFirst as any).mockResolvedValue({ id: 'dept-1', tenantId: TENANT_ID });
      (prisma.labTestCatalog.findFirst as any).mockResolvedValue(null);
      (prisma.labTestCatalog.create as any).mockResolvedValue(createdTest);

      const result = await createTest(TENANT_ID, input as any);

      expect(prisma.labDepartment.findFirst).toHaveBeenCalledWith({
        where: { id: 'dept-1', tenantId: TENANT_ID },
      });
      expect(result.testName).toBe('Complete Blood Count');
      expect(result.labDepartment.name).toBe('Hematology');
    });

    it('should throw not found if department does not exist', async () => {
      const input = { labDepartmentId: 'nonexistent', testName: 'Test' };
      (prisma.labDepartment.findFirst as any).mockResolvedValue(null);

      await expect(createTest(TENANT_ID, input as any)).rejects.toThrow('Lab department not found');
    });

    it('should throw conflict if test code already exists', async () => {
      const input = { labDepartmentId: 'dept-1', testName: 'Test', testCode: 'DUP-001' };

      (prisma.labDepartment.findFirst as any).mockResolvedValue({ id: 'dept-1', tenantId: TENANT_ID });
      (prisma.labTestCatalog.findFirst as any).mockResolvedValue({ id: 'existing-test' });

      await expect(createTest(TENANT_ID, input as any)).rejects.toThrow(
        'A test with this code already exists',
      );
    });
  });

  describe('getTests', () => {
    it('should return paginated lab tests with department info', async () => {
      const tests = [
        {
          id: 'test-1',
          testName: 'CBC',
          testCode: 'CBC-001',
          labDepartment: { id: 'dept-1', name: 'Hematology' },
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

      expect(prisma.labReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            labOrderId: 'order-1',
            patientId: 'patient-1',
            reportContent: 'Test report content',
            status: 'draft',
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
  // Update Lab Department
  // ============================================================
  describe('updateLabDepartment', () => {
    it('should update a lab department name', async () => {
      (prisma.labDepartment.findFirst as any)
        .mockResolvedValueOnce({ id: 'dept-1', name: 'Old Name', tenantId: TENANT_ID })
        .mockResolvedValueOnce(null); // no duplicate

      const updated = { id: 'dept-1', name: 'New Name', tenantId: TENANT_ID };
      (prisma.labDepartment.update as any).mockResolvedValue(updated);

      const result = await updateLabDepartment(TENANT_ID, 'dept-1', { name: 'New Name' } as any);

      expect(result.name).toBe('New Name');
    });

    it('should throw not found when department does not exist', async () => {
      (prisma.labDepartment.findFirst as any).mockResolvedValue(null);

      await expect(
        updateLabDepartment(TENANT_ID, 'nonexistent', { name: 'Test' } as any),
      ).rejects.toThrow('Lab department not found');
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

      const result = await rejectSample(TENANT_ID, 'sample-1', { rejectionReason: 'Hemolyzed sample' } as any);

      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('Hemolyzed sample');
    });

    it('should throw bad request if sample is already rejected', async () => {
      (prisma.labSample.findFirst as any).mockResolvedValue({
        id: 'sample-1',
        status: 'rejected',
      });

      await expect(
        rejectSample(TENANT_ID, 'sample-1', { rejectionReason: 'Bad' } as any),
      ).rejects.toThrow('Sample is already rejected');
    });
  });
});
