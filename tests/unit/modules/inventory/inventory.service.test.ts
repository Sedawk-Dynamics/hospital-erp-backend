import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { AppError } from '../../../../src/shared/appError';

import {
  createSupplier,
  getSuppliers,
  createItem,
  getItems,
  getLowStockItems,
  createStockTransaction,
  createPurchaseOrder,
  approvePurchaseOrder,
  receivePurchaseOrder,
  createSupplyRequest,
  approveSupplyRequest,
  getStockTransactions,
  getPurchaseOrders,
} from '../../../../src/modules/inventory/inventory.service';

// ─── Helpers ───

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

function mockTransaction() {
  const txMock = {
    stockTransaction: {
      create: vi.fn(),
    },
    inventoryItem: {
      update: vi.fn(),
      findMany: vi.fn(),
    },
    purchaseOrder: {
      update: vi.fn(),
    },
    purchaseOrderItem: {
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
      // receivePurchaseOrder recomputes the PO total from the line prices.
      findMany: vi.fn().mockResolvedValue([]),
    },
    drugBatch: {
      // Drug PO lines are received as a DrugBatch (none in these item-only tests).
      create: vi.fn(),
    },
    supplyRequest: {
      update: vi.fn(),
    },
  };
  (prisma.$transaction as any).mockImplementation((fn: any) => fn(txMock));
  return txMock;
}

// ─── Test Suites ───

describe('Inventory Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // Suppliers
  // ============================================================
  describe('createSupplier', () => {
    it('should create a supplier successfully', async () => {
      const input = {
        name: 'MedSupply Inc.',
        phone: '+1234567890',
        email: 'john@medsupply.com',
        supplyType: 'pharmaceutical',
      };

      const expected = {
        id: 'supplier-1',
        tenantId: TENANT_ID,
        ...input,
        isActive: true,
      };
      (prisma.supplier.create as any).mockResolvedValue(expected);

      const result = await createSupplier(TENANT_ID, input as any);

      expect(prisma.supplier.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          name: 'MedSupply Inc.',
          isActive: true,
        }),
      });
      expect(result).toEqual(expected);
    });
  });

  describe('getSuppliers', () => {
    it('should return paginated suppliers', async () => {
      const suppliers = [
        { id: 'supplier-1', name: 'MedSupply Inc.', tenantId: TENANT_ID },
        { id: 'supplier-2', name: 'Pharma Dist', tenantId: TENANT_ID },
      ];

      (prisma.supplier.findMany as any).mockResolvedValue(suppliers);
      (prisma.supplier.count as any).mockResolvedValue(2);

      const result = await getSuppliers(TENANT_ID, { page: 1, limit: 20 } as any);

      expect(result.suppliers).toEqual(suppliers);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
    });

    it('should filter suppliers by search term', async () => {
      (prisma.supplier.findMany as any).mockResolvedValue([]);
      (prisma.supplier.count as any).mockResolvedValue(0);

      await getSuppliers(TENANT_ID, { page: 1, limit: 20, search: 'Med' } as any);

      const findManyCall = (prisma.supplier.findMany as any).mock.calls[0][0];
      expect(findManyCall.where.OR).toEqual([
        { name: { contains: 'Med', mode: 'insensitive' } },
        { email: { contains: 'Med', mode: 'insensitive' } },
      ]);
    });

    it('should filter suppliers by active status and supply type', async () => {
      (prisma.supplier.findMany as any).mockResolvedValue([]);
      (prisma.supplier.count as any).mockResolvedValue(0);

      await getSuppliers(TENANT_ID, {
        page: 1,
        limit: 20,
        isActive: true,
        supplyType: 'pharmaceutical',
      } as any);

      const findManyCall = (prisma.supplier.findMany as any).mock.calls[0][0];
      expect(findManyCall.where.isActive).toBe(true);
      expect(findManyCall.where.supplyType).toBe('pharmaceutical');
    });
  });

  // ============================================================
  // Inventory Items
  // ============================================================
  describe('createItem', () => {
    it('should create an inventory item successfully', async () => {
      const input = {
        itemName: 'Surgical Gloves',
        itemCode: 'SG-001',
        category: 'consumables',
        unitOfMeasurement: 'box',
        minimumStockThreshold: 50,
        currentStock: 200,
        costPerUnit: 25,
      };

      const expected = { id: 'item-1', tenantId: TENANT_ID, ...input, isActive: true };

      (prisma.inventoryItem.findFirst as any).mockResolvedValue(null);
      (prisma.inventoryItem.create as any).mockResolvedValue(expected);

      const result = await createItem(TENANT_ID, input as any);

      expect(result.itemName).toBe('Surgical Gloves');
      expect(result.itemCode).toBe('SG-001');
      expect(prisma.inventoryItem.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          itemName: 'Surgical Gloves',
          itemCode: 'SG-001',
          minimumStockThreshold: 50,
          currentStock: 200,
        }),
      });
    });

    it('should throw conflict if item code already exists', async () => {
      (prisma.inventoryItem.findFirst as any).mockResolvedValue({ id: 'existing-item' });

      await expect(
        createItem(TENANT_ID, { itemName: 'Test', itemCode: 'DUP-001' } as any),
      ).rejects.toThrow('An inventory item with this code already exists');
    });
  });

  describe('getItems', () => {
    it('should return paginated inventory items', async () => {
      const items = [
        { id: 'item-1', itemName: 'Surgical Gloves', tenantId: TENANT_ID },
      ];

      (prisma.inventoryItem.findMany as any).mockResolvedValue(items);
      (prisma.inventoryItem.count as any).mockResolvedValue(1);

      const result = await getItems(TENANT_ID, { page: 1, limit: 20 } as any);

      expect(result.items).toEqual(items);
      expect(result.total).toBe(1);
    });
  });

  describe('getLowStockItems', () => {
    it('should return items where currentStock is below threshold', async () => {
      const lowStockItems = [
        { id: 'item-1', itemName: 'Gloves', currentStock: 5, minimumStockThreshold: 50 },
      ];

      // Raw query yields matching IDs; the rows themselves are re-fetched
      // through Prisma (SELECT * would come back snake_case).
      (prisma.$queryRawUnsafe as any).mockResolvedValueOnce([{ id: 'item-1' }]);
      (prisma.$queryRawUnsafe as any).mockResolvedValueOnce([{ count: 1 }]);
      (prisma.inventoryItem.findMany as any).mockResolvedValue(lowStockItems);

      const result = await getLowStockItems(TENANT_ID, { page: 1, limit: 20 });

      expect(result.items).toEqual(lowStockItems);
      expect(result.total).toBe(1);
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================
  // Stock Transactions
  // ============================================================
  describe('createStockTransaction', () => {
    it('should create stock_in transaction and increase current stock', async () => {
      const input = {
        inventoryItemId: 'item-1',
        transactionType: 'stock_in',
        quantity: 100,
        unitCost: 25,
        notes: 'Restocking surgical gloves',
      };

      (prisma.inventoryItem.findFirst as any).mockResolvedValue({
        id: 'item-1',
        tenantId: TENANT_ID,
        currentStock: 50,
      });

      const txMock = mockTransaction();

      const createdTx = {
        id: 'tx-1',
        tenantId: TENANT_ID,
        ...input,
        totalCost: 2500,
        performedBy: USER_ID,
        inventoryItem: { id: 'item-1', itemName: 'Surgical Gloves', itemCode: 'SG-001' },
      };
      txMock.stockTransaction.create.mockResolvedValue(createdTx);
      txMock.inventoryItem.update.mockResolvedValue({});

      const result = await createStockTransaction(TENANT_ID, USER_ID, input as any);

      expect(result.transactionType).toBe('stock_in');
      expect(txMock.inventoryItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { currentStock: 150 }, // 50 + 100
      });
    });

    it('should create stock_out transaction and decrease current stock', async () => {
      const input = {
        inventoryItemId: 'item-1',
        transactionType: 'stock_out',
        quantity: 20,
      };

      (prisma.inventoryItem.findFirst as any).mockResolvedValue({
        id: 'item-1',
        tenantId: TENANT_ID,
        currentStock: 50,
      });

      const txMock = mockTransaction();

      const createdTx = {
        id: 'tx-2',
        tenantId: TENANT_ID,
        ...input,
        performedBy: USER_ID,
        inventoryItem: { id: 'item-1', itemName: 'Surgical Gloves', itemCode: 'SG-001' },
      };
      txMock.stockTransaction.create.mockResolvedValue(createdTx);
      txMock.inventoryItem.update.mockResolvedValue({});

      const result = await createStockTransaction(TENANT_ID, USER_ID, input as any);

      expect(result.transactionType).toBe('stock_out');
      expect(txMock.inventoryItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { currentStock: 30 }, // 50 - 20
      });
    });

    it('should throw bad request for insufficient stock on stock_out', async () => {
      (prisma.inventoryItem.findFirst as any).mockResolvedValue({
        id: 'item-1',
        tenantId: TENANT_ID,
        currentStock: 5,
      });

      await expect(
        createStockTransaction(TENANT_ID, USER_ID, {
          inventoryItemId: 'item-1',
          transactionType: 'stock_out',
          quantity: 20,
        } as any),
      ).rejects.toThrow('Insufficient stock');
    });

    it('should throw not found if inventory item does not exist', async () => {
      (prisma.inventoryItem.findFirst as any).mockResolvedValue(null);

      await expect(
        createStockTransaction(TENANT_ID, USER_ID, {
          inventoryItemId: 'nonexistent',
          transactionType: 'stock_in',
          quantity: 10,
        } as any),
      ).rejects.toThrow('Inventory item not found');
    });

    it('should handle adjustment transaction type correctly', async () => {
      const input = {
        inventoryItemId: 'item-1',
        transactionType: 'adjustment',
        quantity: 80, // new absolute stock level
      };

      (prisma.inventoryItem.findFirst as any).mockResolvedValue({
        id: 'item-1',
        tenantId: TENANT_ID,
        currentStock: 50,
      });

      const txMock = mockTransaction();

      const createdTx = {
        id: 'tx-3',
        tenantId: TENANT_ID,
        ...input,
        performedBy: USER_ID,
        inventoryItem: { id: 'item-1', itemName: 'Surgical Gloves', itemCode: 'SG-001' },
      };
      txMock.stockTransaction.create.mockResolvedValue(createdTx);
      txMock.inventoryItem.update.mockResolvedValue({});

      await createStockTransaction(TENANT_ID, USER_ID, input as any);

      // adjustment: delta = 80 - 50 = 30, newStock = 50 + 30 = 80
      expect(txMock.inventoryItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { currentStock: 80 },
      });
    });
  });

  // ============================================================
  // Purchase Orders
  // ============================================================
  describe('createPurchaseOrder', () => {
    it('should create a PO with items in approved (ready-to-receive) status', async () => {
      const input = {
        supplierId: 'supplier-1',
        items: [
          { inventoryItemId: 'item-1', quantityOrdered: 100, unitPrice: 25 },
          { inventoryItemId: 'item-2', quantityOrdered: 50, unitPrice: 10 },
        ],
        notes: 'Monthly order',
      };

      (prisma.supplier.findFirst as any).mockResolvedValue({
        id: 'supplier-1',
        tenantId: TENANT_ID,
        isActive: true,
      });
      (prisma.inventoryItem.findMany as any).mockResolvedValue([
        { id: 'item-1' },
        { id: 'item-2' },
      ]);
      // Mock for generateOrderNumber
      (prisma.purchaseOrder.findFirst as any)
        .mockResolvedValueOnce(null)   // latest order lookup
        .mockResolvedValueOnce(null);  // uniqueness check

      const createdPO = {
        id: 'po-1',
        tenantId: TENANT_ID,
        supplierId: 'supplier-1',
        orderNumber: 'PO-20260309-0001',
        status: 'approved',
        totalAmount: 3000,
        supplier: { id: 'supplier-1', name: 'MedSupply Inc.' },
        items: [
          {
            inventoryItemId: 'item-1',
            quantityOrdered: 100,
            unitPrice: 25,
            totalPrice: 2500,
            inventoryItem: { id: 'item-1', itemName: 'Gloves', itemCode: 'SG-001' },
          },
          {
            inventoryItemId: 'item-2',
            quantityOrdered: 50,
            unitPrice: 10,
            totalPrice: 500,
            inventoryItem: { id: 'item-2', itemName: 'Masks', itemCode: 'M-001' },
          },
        ],
      };
      (prisma.purchaseOrder.create as any).mockResolvedValue(createdPO);

      const result = await createPurchaseOrder(TENANT_ID, input as any);

      expect(result.status).toBe('approved');
      expect(result.items).toHaveLength(2);
      expect(result.totalAmount).toBe(3000);
      expect(prisma.purchaseOrder.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            supplierId: 'supplier-1',
            status: 'approved',
          }),
        }),
      );
    });

    it('should throw not found if supplier does not exist or is inactive', async () => {
      (prisma.supplier.findFirst as any).mockResolvedValue(null);

      await expect(
        createPurchaseOrder(TENANT_ID, {
          supplierId: 'nonexistent',
          items: [{ inventoryItemId: 'item-1', quantityOrdered: 10 }],
        } as any),
      ).rejects.toThrow('Supplier not found or inactive');
    });

    it('should throw bad request if one or more inventory items not found', async () => {
      (prisma.supplier.findFirst as any).mockResolvedValue({
        id: 'supplier-1',
        tenantId: TENANT_ID,
        isActive: true,
      });
      (prisma.inventoryItem.findMany as any).mockResolvedValue([{ id: 'item-1' }]);

      await expect(
        createPurchaseOrder(TENANT_ID, {
          supplierId: 'supplier-1',
          items: [
            { inventoryItemId: 'item-1', quantityOrdered: 10 },
            { inventoryItemId: 'item-invalid', quantityOrdered: 5 },
          ],
        } as any),
      ).rejects.toThrow('One or more inventory items not found');
    });
  });

  describe('approvePurchaseOrder (updatePurchaseOrderStatus)', () => {
    it('should approve a draft purchase order', async () => {
      (prisma.purchaseOrder.findFirst as any).mockResolvedValue({
        id: 'po-1',
        tenantId: TENANT_ID,
        status: 'draft',
      });

      const approvedPO = {
        id: 'po-1',
        status: 'approved',
        approvedBy: USER_ID,
        supplier: { id: 'supplier-1', name: 'MedSupply' },
        items: [],
      };
      (prisma.purchaseOrder.update as any).mockResolvedValue(approvedPO);

      const result = await approvePurchaseOrder(TENANT_ID, 'po-1', USER_ID);

      expect(result.status).toBe('approved');
      expect(prisma.purchaseOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'po-1' },
          data: { status: 'approved', approvedBy: USER_ID },
        }),
      );
    });

    it('should throw bad request if PO status is not draft or submitted', async () => {
      (prisma.purchaseOrder.findFirst as any).mockResolvedValue({
        id: 'po-1',
        tenantId: TENANT_ID,
        status: 'delivered',
      });

      await expect(approvePurchaseOrder(TENANT_ID, 'po-1', USER_ID)).rejects.toThrow(
        'Only draft or submitted purchase orders can be approved',
      );
    });

    it('should throw not found if purchase order does not exist', async () => {
      (prisma.purchaseOrder.findFirst as any).mockResolvedValue(null);

      await expect(approvePurchaseOrder(TENANT_ID, 'nonexistent', USER_ID)).rejects.toThrow(
        'Purchase order not found',
      );
    });
  });

  describe('receivePurchaseOrder (deliver PO)', () => {
    it('should receive items and mark PO as delivered when fully received', async () => {
      const existingOrder = {
        id: 'po-1',
        tenantId: TENANT_ID,
        status: 'approved',
        supplierId: 'supplier-1',
        orderNumber: 'PO-20260309-0001',
        items: [
          {
            id: 'poi-1',
            inventoryItemId: 'item-1',
            quantityOrdered: 100,
            quantityReceived: 0,
            unitPrice: 25,
          },
        ],
      };

      (prisma.purchaseOrder.findFirst as any).mockResolvedValue(existingOrder);

      const txMock = mockTransaction();
      txMock.purchaseOrderItem.update.mockResolvedValue({});
      txMock.stockTransaction.create.mockResolvedValue({});
      txMock.inventoryItem.update.mockResolvedValue({});

      const deliveredPO = {
        id: 'po-1',
        status: 'delivered',
        supplier: { id: 'supplier-1', name: 'MedSupply' },
        items: [
          {
            id: 'poi-1',
            quantityOrdered: 100,
            quantityReceived: 100,
            inventoryItem: { id: 'item-1', itemName: 'Gloves', itemCode: 'SG-001', currentStock: 250 },
          },
        ],
      };
      txMock.purchaseOrder.update.mockResolvedValue(deliveredPO);

      const result = await receivePurchaseOrder(TENANT_ID, 'po-1', USER_ID, {
        items: [{ purchaseOrderItemId: 'poi-1', quantityReceived: 100 }],
      } as any);

      expect(result.status).toBe('delivered');
      expect(txMock.inventoryItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { currentStock: { increment: 100 } },
      });
    });

    it('should throw bad request if PO is not in approved or partially_delivered status', async () => {
      (prisma.purchaseOrder.findFirst as any).mockResolvedValue({
        id: 'po-1',
        tenantId: TENANT_ID,
        status: 'draft',
        items: [],
      });

      await expect(
        receivePurchaseOrder(TENANT_ID, 'po-1', USER_ID, {
          items: [{ purchaseOrderItemId: 'poi-1', quantityReceived: 10 }],
        } as any),
      ).rejects.toThrow('Only approved or partially delivered purchase orders can be received');
    });
  });

  // ============================================================
  // Supply Requests
  // ============================================================
  describe('createSupplyRequest', () => {
    it('should create a supply request with pending status', async () => {
      const input = {
        inventoryItemId: 'item-1',
        departmentId: 'dept-1',
        quantityRequested: 30,
        urgency: 'urgent',
        notes: 'Running low on gloves',
      };

      (prisma.inventoryItem.findFirst as any).mockResolvedValue({
        id: 'item-1',
        tenantId: TENANT_ID,
        isActive: true,
      });
      (prisma.department.findFirst as any).mockResolvedValue({
        id: 'dept-1',
        tenantId: TENANT_ID,
      });

      const created = {
        id: 'sr-1',
        tenantId: TENANT_ID,
        ...input,
        requestedBy: USER_ID,
        status: 'pending',
        inventoryItem: { id: 'item-1', itemName: 'Gloves', itemCode: 'SG-001', currentStock: 50 },
        department: { id: 'dept-1', name: 'Surgery' },
        requester: { id: USER_ID, firstName: 'Nurse', lastName: 'Jane' },
      };
      (prisma.supplyRequest.create as any).mockResolvedValue(created);

      const result = await createSupplyRequest(TENANT_ID, USER_ID, input as any);

      expect(result.status).toBe('pending');
      expect(result.quantityRequested).toBe(30);
      expect(prisma.supplyRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            requestedBy: USER_ID,
            inventoryItemId: 'item-1',
            departmentId: 'dept-1',
            status: 'pending',
          }),
        }),
      );
    });

    it('should throw not found if inventory item does not exist or is inactive', async () => {
      (prisma.inventoryItem.findFirst as any).mockResolvedValue(null);

      await expect(
        createSupplyRequest(TENANT_ID, USER_ID, {
          inventoryItemId: 'nonexistent',
          departmentId: 'dept-1',
          quantityRequested: 10,
        } as any),
      ).rejects.toThrow('Inventory item not found or inactive');
    });

    it('should throw not found if department does not exist', async () => {
      (prisma.inventoryItem.findFirst as any).mockResolvedValue({
        id: 'item-1',
        tenantId: TENANT_ID,
        isActive: true,
      });
      (prisma.department.findFirst as any).mockResolvedValue(null);

      await expect(
        createSupplyRequest(TENANT_ID, USER_ID, {
          inventoryItemId: 'item-1',
          departmentId: 'nonexistent',
          quantityRequested: 10,
        } as any),
      ).rejects.toThrow('Department not found');
    });
  });

  describe('approveSupplyRequest', () => {
    it('should approve a pending supply request', async () => {
      (prisma.supplyRequest.findFirst as any).mockResolvedValue({
        id: 'sr-1',
        tenantId: TENANT_ID,
        status: 'pending',
      });

      const approved = {
        id: 'sr-1',
        status: 'approved',
        approvedBy: USER_ID,
        inventoryItem: { id: 'item-1', itemName: 'Gloves', itemCode: 'SG-001' },
        department: { id: 'dept-1', name: 'Surgery' },
        requester: { id: 'user-2', firstName: 'Nurse', lastName: 'Jane' },
      };
      (prisma.supplyRequest.update as any).mockResolvedValue(approved);

      const result = await approveSupplyRequest(TENANT_ID, 'sr-1', USER_ID, {
        status: 'approved',
      } as any);

      expect(result.status).toBe('approved');
      expect(prisma.supplyRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sr-1' },
          data: expect.objectContaining({
            status: 'approved',
            approvedBy: USER_ID,
          }),
        }),
      );
    });

    it('should throw bad request if supply request is not pending', async () => {
      (prisma.supplyRequest.findFirst as any).mockResolvedValue({
        id: 'sr-1',
        tenantId: TENANT_ID,
        status: 'approved',
      });

      await expect(
        approveSupplyRequest(TENANT_ID, 'sr-1', USER_ID, { status: 'approved' } as any),
      ).rejects.toThrow('Only pending supply requests can be approved or rejected');
    });
  });
});
