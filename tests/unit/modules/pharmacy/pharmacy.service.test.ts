import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { AppError } from '../../../../src/shared/appError';

import {
  createDrugCategory,
  getDrugCategories,
  createFormularyItem,
  getFormulary,
  createBatch,
  getBatches,
  createDispense,
  createReturn,
  processReturn,
  deleteDrugCategory,
  verifyDispense,
  getExpiringBatches,
} from '../../../../src/modules/pharmacy/pharmacy.service';

// ─── Helpers ───

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

function mockTransaction() {
  const txMock = {
    dispensingRecord: {
      create: vi.fn(),
    },
    drugBatch: {
      update: vi.fn(),
    },
    drugReturn: {
      update: vi.fn(),
    },
  };
  (prisma.$transaction as any).mockImplementation((fn: any) => fn(txMock));
  return txMock;
}

// ─── Test Suites ───

describe('Pharmacy Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // Drug Categories
  // ============================================================
  describe('createDrugCategory', () => {
    it('should create a drug category successfully', async () => {
      const input = { name: 'Antibiotics', description: 'Antimicrobial agents' };
      const expected = { id: 'cat-1', tenantId: TENANT_ID, ...input };

      (prisma.drugCategory.findFirst as any).mockResolvedValue(null);
      (prisma.drugCategory.create as any).mockResolvedValue(expected);

      const result = await createDrugCategory(TENANT_ID, input);

      expect(prisma.drugCategory.findFirst).toHaveBeenCalledWith({
        where: { tenantId: TENANT_ID, name: 'Antibiotics' },
      });
      expect(prisma.drugCategory.create).toHaveBeenCalledWith({
        data: { tenantId: TENANT_ID, name: 'Antibiotics', description: 'Antimicrobial agents' },
      });
      expect(result).toEqual(expected);
    });

    it('should throw conflict if category name already exists', async () => {
      (prisma.drugCategory.findFirst as any).mockResolvedValue({ id: 'cat-existing' });

      await expect(
        createDrugCategory(TENANT_ID, { name: 'Antibiotics' } as any),
      ).rejects.toThrow('A drug category with this name already exists');
    });
  });

  describe('getDrugCategories', () => {
    it('should return paginated drug categories', async () => {
      const categories = [
        { id: 'cat-1', name: 'Antibiotics', tenantId: TENANT_ID },
        { id: 'cat-2', name: 'Analgesics', tenantId: TENANT_ID },
      ];

      (prisma.drugCategory.findMany as any).mockResolvedValue(categories);
      (prisma.drugCategory.count as any).mockResolvedValue(2);

      const result = await getDrugCategories(TENANT_ID, { page: 1, limit: 20 });

      expect(result.categories).toEqual(categories);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('should filter categories by search term', async () => {
      (prisma.drugCategory.findMany as any).mockResolvedValue([]);
      (prisma.drugCategory.count as any).mockResolvedValue(0);

      await getDrugCategories(TENANT_ID, { page: 1, limit: 20, search: 'anti' });

      const findManyCall = (prisma.drugCategory.findMany as any).mock.calls[0][0];
      expect(findManyCall.where.OR).toEqual([
        { name: { contains: 'anti', mode: 'insensitive' } },
        { description: { contains: 'anti', mode: 'insensitive' } },
      ]);
    });
  });

  describe('deleteDrugCategory', () => {
    it('should throw bad request if category has linked formulary items', async () => {
      (prisma.drugCategory.findFirst as any).mockResolvedValue({ id: 'cat-1', tenantId: TENANT_ID });
      (prisma.drugFormulary.count as any).mockResolvedValue(3);

      await expect(deleteDrugCategory(TENANT_ID, 'cat-1')).rejects.toThrow(
        'Cannot delete category. 3 formulary item(s) are linked to this category.',
      );
    });
  });

  // ============================================================
  // Formulary
  // ============================================================
  describe('createFormularyItem', () => {
    it('should create a drug formulary item successfully', async () => {
      const input = {
        drugName: 'Amoxicillin',
        genericName: 'Amoxicillin Trihydrate',
        categoryId: 'cat-1',
        manufacturer: 'PharmaCo',
        dosageForm: 'tablet',
        strength: '500mg',
        unitOfMeasurement: 'tablet',
        price: 15,
      };

      const created = {
        id: 'drug-1',
        tenantId: TENANT_ID,
        ...input,
        isActive: true,
        category: { id: 'cat-1', name: 'Antibiotics' },
      };

      (prisma.drugCategory.findFirst as any).mockResolvedValue({ id: 'cat-1', tenantId: TENANT_ID });
      (prisma.drugFormulary.create as any).mockResolvedValue(created);

      const result = await createFormularyItem(TENANT_ID, input as any);

      expect(result.drugName).toBe('Amoxicillin');
      expect(result.category.name).toBe('Antibiotics');
      expect(prisma.drugFormulary.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            drugName: 'Amoxicillin',
            categoryId: 'cat-1',
          }),
        }),
      );
    });

    it('should throw not found if category does not exist', async () => {
      const input = { drugName: 'Test Drug', categoryId: 'nonexistent' };
      (prisma.drugCategory.findFirst as any).mockResolvedValue(null);

      await expect(createFormularyItem(TENANT_ID, input as any)).rejects.toThrow(
        'Drug category not found',
      );
    });
  });

  describe('getFormulary', () => {
    it('should return paginated formulary items', async () => {
      const items = [
        {
          id: 'drug-1',
          drugName: 'Amoxicillin',
          category: { id: 'cat-1', name: 'Antibiotics' },
        },
      ];

      (prisma.drugFormulary.findMany as any).mockResolvedValue(items);
      (prisma.drugFormulary.count as any).mockResolvedValue(1);

      const result = await getFormulary(TENANT_ID, { page: 1, limit: 20 } as any);

      expect(result.items).toEqual(items);
      expect(result.total).toBe(1);
    });
  });

  // ============================================================
  // Batches
  // ============================================================
  describe('createBatch', () => {
    it('should create a drug batch with quantity and expiry', async () => {
      const input = {
        drugId: 'drug-1',
        batchNumber: 'BATCH-001',
        expiryDate: '2027-12-31',
        quantityReceived: 500,
        purchasePrice: 10,
        sellingPrice: 15,
      };

      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'drug-1', tenantId: TENANT_ID });
      (prisma.drugBatch.findFirst as any).mockResolvedValue(null);

      const created = {
        id: 'batch-1',
        tenantId: TENANT_ID,
        ...input,
        quantityInStock: 500,
        drug: { id: 'drug-1', drugName: 'Amoxicillin', genericName: 'Amoxicillin' },
        supplier: null,
      };
      (prisma.drugBatch.create as any).mockResolvedValue(created);

      const result = await createBatch(TENANT_ID, input as any);

      expect(result.batchNumber).toBe('BATCH-001');
      expect(result.quantityInStock).toBe(500);
      expect(prisma.drugBatch.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            drugId: 'drug-1',
            batchNumber: 'BATCH-001',
            quantityReceived: 500,
            quantityInStock: 500,
          }),
        }),
      );
    });

    it('should throw not found if drug does not exist in formulary', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue(null);

      await expect(
        createBatch(TENANT_ID, { drugId: 'nonexistent', batchNumber: 'B1', expiryDate: '2027-01-01', quantityReceived: 10 } as any),
      ).rejects.toThrow('Drug not found in formulary');
    });

    it('should throw conflict if batch number already exists for the same drug', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'drug-1', tenantId: TENANT_ID });
      (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'existing-batch' });

      await expect(
        createBatch(TENANT_ID, { drugId: 'drug-1', batchNumber: 'DUP-001', expiryDate: '2027-01-01', quantityReceived: 10 } as any),
      ).rejects.toThrow('A batch with this number already exists for this drug');
    });
  });

  // ============================================================
  // Dispensing
  // ============================================================
  describe('createDispense (dispenseDrug)', () => {
    it('should dispense from a batch and reduce stock', async () => {
      const input = {
        drugBatchId: 'batch-1',
        patientId: 'patient-1',
        quantityDispensed: 10,
      };

      (prisma.drugBatch.findFirst as any).mockResolvedValue({
        id: 'batch-1',
        tenantId: TENANT_ID,
        isExpired: false,
        isRecalled: false,
        quantityInStock: 100,
      });
      (prisma.patient.findFirst as any).mockResolvedValue({ id: 'patient-1' });

      const txMock = mockTransaction();

      const dispenseRecord = {
        id: 'dispense-1',
        tenantId: TENANT_ID,
        drugBatchId: 'batch-1',
        patientId: 'patient-1',
        quantityDispensed: 10,
        dispensedBy: USER_ID,
        patient: { id: 'patient-1', firstName: 'Jane', lastName: 'Doe' },
        drugBatch: {
          id: 'batch-1',
          batchNumber: 'BATCH-001',
          drug: { id: 'drug-1', drugName: 'Amoxicillin' },
        },
      };
      txMock.dispensingRecord.create.mockResolvedValue(dispenseRecord);
      txMock.drugBatch.update.mockResolvedValue({});

      const result = await createDispense(TENANT_ID, USER_ID, input as any);

      expect(result.quantityDispensed).toBe(10);
      expect(txMock.drugBatch.update).toHaveBeenCalledWith({
        where: { id: 'batch-1' },
        data: { quantityInStock: { decrement: 10 } },
      });
    });

    it('should throw bad request for insufficient stock', async () => {
      (prisma.drugBatch.findFirst as any).mockResolvedValue({
        id: 'batch-1',
        tenantId: TENANT_ID,
        isExpired: false,
        isRecalled: false,
        quantityInStock: 5,
      });

      await expect(
        createDispense(TENANT_ID, USER_ID, {
          drugBatchId: 'batch-1',
          patientId: 'patient-1',
          quantityDispensed: 20,
        } as any),
      ).rejects.toThrow('Insufficient stock');
    });

    it('should throw bad request when dispensing from an expired batch', async () => {
      (prisma.drugBatch.findFirst as any).mockResolvedValue({
        id: 'batch-1',
        tenantId: TENANT_ID,
        isExpired: true,
        isRecalled: false,
        quantityInStock: 100,
      });

      await expect(
        createDispense(TENANT_ID, USER_ID, {
          drugBatchId: 'batch-1',
          patientId: 'patient-1',
          quantityDispensed: 5,
        } as any),
      ).rejects.toThrow('Cannot dispense from an expired batch');
    });

    it('should throw bad request when dispensing from a recalled batch', async () => {
      (prisma.drugBatch.findFirst as any).mockResolvedValue({
        id: 'batch-1',
        tenantId: TENANT_ID,
        isExpired: false,
        isRecalled: true,
        quantityInStock: 100,
      });

      await expect(
        createDispense(TENANT_ID, USER_ID, {
          drugBatchId: 'batch-1',
          patientId: 'patient-1',
          quantityDispensed: 5,
        } as any),
      ).rejects.toThrow('Cannot dispense from a recalled batch');
    });

    it('should throw not found when patient does not exist', async () => {
      (prisma.drugBatch.findFirst as any).mockResolvedValue({
        id: 'batch-1',
        tenantId: TENANT_ID,
        isExpired: false,
        isRecalled: false,
        quantityInStock: 100,
      });
      (prisma.patient.findFirst as any).mockResolvedValue(null);

      await expect(
        createDispense(TENANT_ID, USER_ID, {
          drugBatchId: 'batch-1',
          patientId: 'nonexistent',
          quantityDispensed: 5,
        } as any),
      ).rejects.toThrow('Patient not found');
    });
  });

  describe('verifyDispense', () => {
    it('should throw bad request if dispenser tries to verify their own record', async () => {
      (prisma.dispensingRecord.findFirst as any).mockResolvedValue({
        id: 'dispense-1',
        tenantId: TENANT_ID,
        dispensedBy: USER_ID,
        verifiedBy: null,
      });

      await expect(verifyDispense(TENANT_ID, 'dispense-1', USER_ID)).rejects.toThrow(
        'The dispenser cannot verify their own dispensing record',
      );
    });
  });

  // ============================================================
  // Returns
  // ============================================================
  describe('createReturn (returnDrug)', () => {
    it('should create a patient return with pending status', async () => {
      const input = {
        returnType: 'patient_return',
        drugBatchId: 'batch-1',
        patientId: 'patient-1',
        quantity: 5,
        reason: 'Adverse reaction',
      };

      (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'batch-1', tenantId: TENANT_ID });
      (prisma.patient.findFirst as any).mockResolvedValue({ id: 'patient-1' });

      const created = {
        id: 'return-1',
        tenantId: TENANT_ID,
        ...input,
        status: 'pending',
        drugBatch: {
          id: 'batch-1',
          batchNumber: 'BATCH-001',
          drug: { id: 'drug-1', drugName: 'Amoxicillin' },
        },
        patient: { id: 'patient-1', firstName: 'Jane', lastName: 'Doe' },
        supplier: null,
      };
      (prisma.drugReturn.create as any).mockResolvedValue(created);

      const result = await createReturn(TENANT_ID, input as any);

      expect(result.status).toBe('pending');
      expect(result.quantity).toBe(5);
      expect(result.returnType).toBe('patient_return');
    });

    it('should throw bad request if patient_return lacks patientId', async () => {
      (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'batch-1', tenantId: TENANT_ID });

      await expect(
        createReturn(TENANT_ID, {
          returnType: 'patient_return',
          drugBatchId: 'batch-1',
          quantity: 5,
          reason: 'Test',
        } as any),
      ).rejects.toThrow('Patient ID is required for patient returns');
    });
  });

  describe('processReturn', () => {
    it('should process a return and increase batch stock', async () => {
      (prisma.drugReturn.findFirst as any).mockResolvedValue({
        id: 'return-1',
        tenantId: TENANT_ID,
        status: 'pending',
        drugBatchId: 'batch-1',
        quantity: 5,
      });

      const txMock = mockTransaction();

      const processedReturn = {
        id: 'return-1',
        status: 'processed',
        processedBy: USER_ID,
        quantity: 5,
        drugBatch: {
          id: 'batch-1',
          batchNumber: 'BATCH-001',
          drug: { id: 'drug-1', drugName: 'Amoxicillin' },
        },
        patient: null,
        supplier: null,
        processor: { id: USER_ID, firstName: 'Admin', lastName: 'User' },
      };
      txMock.drugReturn.update.mockResolvedValue(processedReturn);
      txMock.drugBatch.update.mockResolvedValue({});

      const result = await processReturn(TENANT_ID, 'return-1', USER_ID, { status: 'processed' });

      expect(result.status).toBe('processed');
      expect(txMock.drugBatch.update).toHaveBeenCalledWith({
        where: { id: 'batch-1' },
        data: { quantityInStock: { increment: 5 } },
      });
    });

    it('should reject a return without adjusting stock', async () => {
      (prisma.drugReturn.findFirst as any).mockResolvedValue({
        id: 'return-1',
        tenantId: TENANT_ID,
        status: 'pending',
        drugBatchId: 'batch-1',
        quantity: 5,
      });

      const rejectedReturn = {
        id: 'return-1',
        status: 'rejected',
        processedBy: USER_ID,
        drugBatch: {
          id: 'batch-1',
          batchNumber: 'BATCH-001',
          drug: { id: 'drug-1', drugName: 'Amoxicillin' },
        },
        patient: null,
        supplier: null,
        processor: { id: USER_ID, firstName: 'Admin', lastName: 'User' },
      };
      (prisma.drugReturn.update as any).mockResolvedValue(rejectedReturn);

      const result = await processReturn(TENANT_ID, 'return-1', USER_ID, { status: 'rejected' });

      expect(result.status).toBe('rejected');
      // Should NOT use transaction for rejected returns
      expect(prisma.drugReturn.update).toHaveBeenCalled();
    });

    it('should throw bad request if return is not pending', async () => {
      (prisma.drugReturn.findFirst as any).mockResolvedValue({
        id: 'return-1',
        tenantId: TENANT_ID,
        status: 'processed',
      });

      await expect(
        processReturn(TENANT_ID, 'return-1', USER_ID, { status: 'processed' }),
      ).rejects.toThrow('Only pending returns can be processed');
    });

    it('should throw not found if return does not exist', async () => {
      (prisma.drugReturn.findFirst as any).mockResolvedValue(null);

      await expect(
        processReturn(TENANT_ID, 'nonexistent', USER_ID, { status: 'processed' }),
      ).rejects.toThrow('Drug return not found');
    });
  });
});
