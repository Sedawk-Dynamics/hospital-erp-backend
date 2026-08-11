import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { AppError } from '../../../../src/shared/appError';
import {
  createServiceTariff,
  createBill,
  addBillItem,
  removeBillItem,
  finalizeBill,
  createPayment,
  createRefund,
  approveRefund,
  applyDiscount,
  getServiceTariffs,
  getBillById,
  getBills,
  getCollectionSummary,
  adjustAdvanceToBill,
  settleGatewayPayment,
  pullChargesToBill,
  getPatientCharges,
} from '../../../../src/modules/billing/billing.service';

// ─── Extend mocks that setup.ts does not provide ───
// The shared setup mocks prisma.billItem but not findMany; same for discount.
// We add them here so recalculateBillTotals and applyDiscount work.
(prisma.billItem as any).findMany = vi.fn();
(prisma.discount as any).findMany = vi.fn();
(prisma.refund as any).findFirst = vi.fn();
(prisma.payment as any).findFirst = vi.fn();

// ─── Shared fixtures ───

const TENANT_ID = 'tenant-1';

// The acting user. Money-touching calls take this so the record carries who did
// it — generatedBy / processedBy / requestedBy / approvedBy.
const USER_ID = 'user-cashier-1';

const mockPatient = {
  id: 'patient-1',
  mrn: 'MRN-001',
  firstName: 'Alice',
  lastName: 'Smith',
  tenantId: TENANT_ID,
};

const mockBillDraft = {
  id: 'bill-1',
  tenantId: TENANT_ID,
  billNumber: 'BILL-20260309-0001',
  patientId: 'patient-1',
  status: 'draft',
  subtotal: 0,
  taxAmount: 0,
  discountAmount: 0,
  totalAmount: 0,
  amountPaid: 0,
  balanceDue: 0,
  insuranceCoveredAmount: 0,
  patientPayableAmount: 0,
  billDate: new Date(),
};

const mockBillPending = {
  ...mockBillDraft,
  status: 'pending',
  subtotal: 1000,
  taxAmount: 100,
  totalAmount: 1100,
  balanceDue: 1100,
};

const mockBillItem = {
  id: 'item-1',
  billId: 'bill-1',
  description: 'X-Ray',
  quantity: 1,
  unitPrice: 500,
  discountPercent: 0,
  discountAmount: 0,
  taxPercent: 10,
  taxAmount: 50,
  totalAmount: 550,
  category: 'other',
};

// ─── Helper: set up recalculateBillTotals dependencies ───

function mockRecalculate(
  items: any[],
  payments: any[] = [],
  billStatus = 'draft',
  // Bill-level concessions live in the Discount table, not on the items, and
  // recalculateBillTotals folds them in — default none.
  billLevelDiscount = 0,
) {
  // A real BillItem always carries its own totalAmount, and the bill total is
  // summed from those — that is the only formula that holds for both a
  // tax-exclusive service (tax added on top) and a tax-inclusive medicine price
  // (tax embedded in the MRP). Fixtures that only describe qty/price/tax get
  // the figure a real row would have stored.
  const withTotals = items.map((i) =>
    i.totalAmount != null
      ? i
      : {
          ...i,
          totalAmount:
            (i.quantity ?? 1) * (i.unitPrice ?? 0) - (i.discountAmount ?? 0) + (i.taxAmount ?? 0),
        },
  );
  vi.mocked((prisma.billItem as any).findMany).mockResolvedValue(withTotals);
  vi.mocked(prisma.payment.findMany).mockResolvedValue(payments);
  vi.mocked(prisma.bill.findUnique).mockResolvedValue({ status: billStatus } as any);
  vi.mocked(prisma.bill.update).mockResolvedValue({} as any);
  vi.mocked((prisma.discount as any).aggregate).mockResolvedValue({
    _sum: { value: billLevelDiscount },
  } as any);
}

// ─── Tests ───

describe('BillingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // clearAllMocks wipes recorded calls but KEEPS implementations, so a
    // hand-rolled `tx` stub set up by one describe leaks into every describe
    // that runs after it — and a stub carrying two models silently starves any
    // later transaction body that touches a third. Restore the shared setup's
    // behaviour each time: the callback gets the prisma proxy itself, so
    // `tx.<anyModel>` resolves exactly as `prisma.<anyModel>` does.
    (prisma.$transaction as any).mockImplementation((arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg ?? []),
    );
  });

  // ═══════════════════════════════════════════
  // createServiceTariff
  // ═══════════════════════════════════════════
  describe('createServiceTariff', () => {
    it('should create a service tariff successfully', async () => {
      vi.mocked(prisma.serviceTariff.findFirst).mockResolvedValue(null);
      const mockTariff = {
        id: 'tariff-1',
        tenantId: TENANT_ID,
        serviceName: 'Blood Test',
        serviceCode: 'BT-001',
        category: 'lab',
        basePrice: 250,
        gstRatePercent: 5,
        isActive: true,
      };
      vi.mocked(prisma.serviceTariff.create).mockResolvedValue(mockTariff as any);

      const result = await createServiceTariff(TENANT_ID, {
        name: 'Blood Test',
        code: 'BT-001',
        category: 'lab',
        basePrice: 250,
        taxRate: 5,
        isActive: true,
      });

      expect(result).toEqual(mockTariff);
      expect(prisma.serviceTariff.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          serviceName: 'Blood Test',
          serviceCode: 'BT-001',
          category: 'lab',
          basePrice: 250,
          gstRatePercent: 5,
          isActive: true,
        }),
      });
    });

    it('should throw conflict if service tariff code already exists', async () => {
      vi.mocked(prisma.serviceTariff.findFirst).mockResolvedValue({ id: 'existing' } as any);

      await expect(
        createServiceTariff(TENANT_ID, {
          name: 'Duplicate',
          code: 'BT-001',
          category: 'lab',
          basePrice: 100,
        }),
      ).rejects.toThrow(AppError);

      await expect(
        createServiceTariff(TENANT_ID, {
          name: 'Duplicate',
          code: 'BT-001',
          category: 'lab',
          basePrice: 100,
        }),
      ).rejects.toThrow('A service tariff with this code already exists');

      expect(prisma.serviceTariff.create).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════
  // getServiceTariffs
  // ═══════════════════════════════════════════
  describe('getServiceTariffs', () => {
    it('should return paginated tariffs', async () => {
      const tariffs = [{ id: 'tariff-1' }, { id: 'tariff-2' }];
      vi.mocked(prisma.serviceTariff.findMany).mockResolvedValue(tariffs as any);
      vi.mocked(prisma.serviceTariff.count).mockResolvedValue(2);

      const result = await getServiceTariffs(TENANT_ID, { page: 1, limit: 20 });

      expect(result.tariffs).toEqual(tariffs);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });
  });

  // ═══════════════════════════════════════════
  // createBill
  // ═══════════════════════════════════════════
  describe('createBill', () => {
    it('should create a bill with a generated bill number', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      // generateBillNumber: first findFirst for latest bill, second for collision check
      vi.mocked(prisma.bill.findFirst)
        .mockResolvedValueOnce(null) // no existing bills today
        .mockResolvedValueOnce(null); // no collision
      const mockCreatedBill = {
        ...mockBillDraft,
        patient: { id: 'patient-1', mrn: 'MRN-001', firstName: 'Alice', lastName: 'Smith' },
      };
      vi.mocked(prisma.bill.create).mockResolvedValue(mockCreatedBill as any);

      const result = await createBill(TENANT_ID, USER_ID, { patientId: 'patient-1' });

      expect(result).toEqual(mockCreatedBill);
      expect(prisma.bill.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            patientId: 'patient-1',
            status: 'draft',
            subtotal: 0,
            totalAmount: 0,
          }),
        }),
      );
      // Verify bill number format BILL-YYYYMMDD-XXXX
      const createCall = vi.mocked(prisma.bill.create).mock.calls[0][0];
      expect((createCall.data as any).billNumber).toMatch(/^BILL-\d{8}-\d{4}$/);
    });

    it('should throw notFound if patient does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);

      await expect(createBill(TENANT_ID, USER_ID, { patientId: 'no-such-patient' })).rejects.toThrow(
        'Patient not found',
      );

      expect(prisma.bill.create).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════
  // addBillItem
  // ═══════════════════════════════════════════
  describe('addBillItem', () => {
    it('should add a bill item and recalculate totals', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(mockBillDraft as any);
      const createdItem = {
        id: 'item-new',
        billId: 'bill-1',
        description: 'Consultation',
        quantity: 1,
        unitPrice: 500,
        discountPercent: 0,
        discountAmount: 0,
        taxPercent: 10,
        taxAmount: 50,
        totalAmount: 550,
      };
      vi.mocked(prisma.billItem.create).mockResolvedValue(createdItem as any);
      // recalculateBillTotals mocks
      mockRecalculate(
        [{ quantity: 1, unitPrice: 500, discountAmount: 0, taxAmount: 50 }],
        [],
        'draft',
      );

      const result = await addBillItem(TENANT_ID, 'bill-1', {
        description: 'Consultation',
        quantity: 1,
        unitPrice: 500,
        taxRate: 10,
      });

      expect(result).toEqual(createdItem);
      expect(prisma.billItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            billId: 'bill-1',
            description: 'Consultation',
            quantity: 1,
            unitPrice: 500,
          }),
        }),
      );
      // recalculate was triggered
      expect((prisma.billItem as any).findMany).toHaveBeenCalledWith({
        where: { billId: 'bill-1' },
      });
    });

    // Regression: a counter concession is a BILL-LEVEL Discount row, not a line
    // discount. recalculateBillTotals used to rebuild discountAmount from the
    // items alone, so posting any further charge silently erased the
    // concession and re-billed the patient the full amount.
    it('keeps a bill-level concession when a later charge is posted', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(mockBillDraft as any);
      vi.mocked(prisma.billItem.create).mockResolvedValue({ id: 'item-new' } as any);
      mockRecalculate(
        [
          { quantity: 1, unitPrice: 3500, discountAmount: 0, taxAmount: 0 },
          { quantity: 1, unitPrice: 200, discountAmount: 0, taxAmount: 0 },
        ],
        [],
        'draft',
        500, // the concession already granted at the counter
      );

      await addBillItem(TENANT_ID, 'bill-1', {
        description: 'Dressing',
        quantity: 1,
        unitPrice: 200,
      });

      expect(prisma.bill.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            subtotal: 3700,
            discountAmount: 500,
            totalAmount: 3200,
          }),
        }),
      );
    });

    it('should throw badRequest when adding item to non-draft bill', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(mockBillPending as any);

      await expect(
        addBillItem(TENANT_ID, 'bill-1', {
          description: 'Test',
          quantity: 1,
          unitPrice: 100,
        }),
      ).rejects.toThrow('Can only add items to draft bills');
    });

    it('should throw notFound when bill does not exist for addBillItem', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(null);

      await expect(
        addBillItem(TENANT_ID, 'no-bill', {
          description: 'Test',
          quantity: 1,
          unitPrice: 100,
        }),
      ).rejects.toThrow('Bill not found');
    });
  });

  // ═══════════════════════════════════════════
  // removeBillItem
  // ═══════════════════════════════════════════
  describe('removeBillItem', () => {
    it('should remove a bill item and recalculate totals', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(mockBillDraft as any);
      vi.mocked(prisma.billItem.findFirst).mockResolvedValue(mockBillItem as any);
      vi.mocked(prisma.billItem.delete).mockResolvedValue(mockBillItem as any);
      // After removal, no items left
      mockRecalculate([], [], 'draft');

      await removeBillItem(TENANT_ID, 'bill-1', 'item-1');

      expect(prisma.billItem.delete).toHaveBeenCalledWith({ where: { id: 'item-1' } });
      // Verify recalculate was triggered
      expect((prisma.billItem as any).findMany).toHaveBeenCalledWith({
        where: { billId: 'bill-1' },
      });
    });

    it('should throw notFound if bill item does not exist', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(mockBillDraft as any);
      vi.mocked(prisma.billItem.findFirst).mockResolvedValue(null);

      await expect(removeBillItem(TENANT_ID, 'bill-1', 'no-item')).rejects.toThrow(
        'Bill item not found',
      );
    });
  });

  // ═══════════════════════════════════════════
  // finalizeBill
  // ═══════════════════════════════════════════
  describe('finalizeBill', () => {
    it('should finalize a draft bill to pending status', async () => {
      const billWithItems = {
        ...mockBillDraft,
        billItems: [mockBillItem],
      };
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(billWithItems as any);
      // recalculate mocks
      mockRecalculate(
        [{ quantity: 1, unitPrice: 500, discountAmount: 0, taxAmount: 50 }],
        [],
        'draft',
      );
      const finalizedBill = {
        ...billWithItems,
        status: 'pending',
        totalAmount: 550,
        patient: { id: 'patient-1', mrn: 'MRN-001', firstName: 'Alice', lastName: 'Smith' },
      };
      vi.mocked(prisma.bill.update).mockResolvedValue(finalizedBill as any);

      const result = await finalizeBill(TENANT_ID, USER_ID, 'bill-1');

      expect(result.status).toBe('pending');
      // The second update call is the finalize (first is from recalculate)
      const updateCalls = vi.mocked(prisma.bill.update).mock.calls;
      const finalizeCall = updateCalls[updateCalls.length - 1][0];
      expect(finalizeCall).toEqual(
        expect.objectContaining({
          where: { id: 'bill-1' },
          data: expect.objectContaining({ status: 'pending' }),
        }),
      );
    });

    it('should throw badRequest when trying to finalize a non-draft bill', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue({
        ...mockBillPending,
        billItems: [mockBillItem],
      } as any);

      await expect(finalizeBill(TENANT_ID, USER_ID, 'bill-1')).rejects.toThrow(
        'Only draft bills can be finalized',
      );
    });

    it('should throw badRequest when trying to finalize a bill with no items', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue({
        ...mockBillDraft,
        billItems: [],
      } as any);

      await expect(finalizeBill(TENANT_ID, USER_ID, 'bill-1')).rejects.toThrow(
        'Cannot finalize a bill with no items',
      );
    });

    it('should throw notFound if bill does not exist for finalization', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(null);

      await expect(finalizeBill(TENANT_ID, USER_ID, 'no-bill')).rejects.toThrow('Bill not found');
    });
  });

  // ═══════════════════════════════════════════
  // createPayment
  // ═══════════════════════════════════════════
  describe('createPayment', () => {
    // Deliberately NO $transaction override. The shared setup hands the callback
    // the prisma proxy itself, so the transaction body runs against the same
    // mocks as everything else. That matters now: settlement reads the payment
    // ledger *inside* the transaction, which the hand-rolled `tx` stub this
    // suite used to build (payment.create / receipt.create / bill.update only)
    // could never exercise — the happy path was passing without running.
    beforeEach(() => {
      vi.mocked(prisma.receipt.findFirst).mockResolvedValue(null); // receipt numbering
      vi.mocked(prisma.payment.create).mockResolvedValue({
        id: 'payment-1',
        billId: 'bill-1',
        amount: 1100,
        status: 'completed',
      } as any);
      vi.mocked(prisma.receipt.create).mockResolvedValue({
        id: 'receipt-1',
        receiptNumber: 'RCP-20260309-0001',
      } as any);
      vi.mocked(prisma.bill.update).mockResolvedValue({} as any);
    });

    /**
     * Stub what `applyPaymentToBill` reads: the bill's total, and the ledger it
     * settles from — payments collected, less refunds already approved.
     */
    function mockLedger(opts: { total: number; collected: number; refunded?: number }) {
      vi.mocked(prisma.bill.findUnique).mockResolvedValue({
        totalAmount: opts.total,
        status: 'pending',
      } as any);
      vi.mocked(prisma.payment.aggregate).mockResolvedValue({
        _sum: { amount: opts.collected },
      } as any);
      vi.mocked(prisma.refund.aggregate).mockResolvedValue({
        _sum: { amount: opts.refunded ?? 0 },
      } as any);
    }

    const pendingBill = { ...mockBillPending, amountPaid: 0, balanceDue: 1100 };

    it('records the cashier on the payment', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(pendingBill as any);
      mockLedger({ total: 1100, collected: 1100 });

      const result = await createPayment(TENANT_ID, USER_ID, {
        billId: 'bill-1',
        amount: 1100,
        paymentMethod: 'cash',
      });

      expect(result.payment).toBeDefined();
      expect(result.receipt).toBeDefined();
      // The counter path used to omit processedBy, leaving the highest-volume
      // cash records with nobody attached to them.
      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          processedBy: USER_ID,
          amount: 1100,
          status: 'completed',
        }),
      });
    });

    it('settles the bill as paid when the ledger covers the total', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(pendingBill as any);
      mockLedger({ total: 1100, collected: 1100 });

      await createPayment(TENANT_ID, USER_ID, {
        billId: 'bill-1',
        amount: 1100,
        paymentMethod: 'cash',
      });

      expect(prisma.bill.update).toHaveBeenCalledWith({
        where: { id: 'bill-1' },
        data: { amountPaid: 1100, balanceDue: 0, status: 'paid' },
      });
    });

    it('settles as partially_paid when the ledger is short of the total', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(pendingBill as any);
      mockLedger({ total: 1100, collected: 500 });

      await createPayment(TENANT_ID, USER_ID, {
        billId: 'bill-1',
        amount: 500,
        paymentMethod: 'cash',
      });

      expect(prisma.bill.update).toHaveBeenCalledWith({
        where: { id: 'bill-1' },
        data: { amountPaid: 500, balanceDue: 600, status: 'partially_paid' },
      });
    });

    it('trusts the ledger over the amountPaid it read before the transaction', async () => {
      // The concurrency regression. Two cashiers collect against the same bill
      // at once; both read amountPaid = 0 before their transaction opens. The
      // old code wrote `thatStaleZero + ownAmount`, so whichever committed
      // second erased the other's money. Settlement must reflect every payment
      // row that exists at commit time — here ₹600 of our own plus ₹500 the
      // other cashier already committed.
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(pendingBill as any);
      mockLedger({ total: 1100, collected: 1100 });

      await createPayment(TENANT_ID, USER_ID, {
        billId: 'bill-1',
        amount: 600,
        paymentMethod: 'cash',
      });

      expect(prisma.bill.update).toHaveBeenCalledWith({
        where: { id: 'bill-1' },
        data: { amountPaid: 1100, balanceDue: 0, status: 'paid' },
      });
    });

    it('nets approved refunds out of what the bill counts as paid', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(pendingBill as any);
      mockLedger({ total: 1100, collected: 1100, refunded: 400 });

      await createPayment(TENANT_ID, USER_ID, {
        billId: 'bill-1',
        amount: 100,
        paymentMethod: 'cash',
      });

      expect(prisma.bill.update).toHaveBeenCalledWith({
        where: { id: 'bill-1' },
        data: { amountPaid: 700, balanceDue: 400, status: 'partially_paid' },
      });
    });

    it('should throw if payment exceeds bill balance due', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue({
        ...mockBillPending,
        amountPaid: 0,
        balanceDue: 500,
      } as any);

      await expect(
        createPayment(TENANT_ID, USER_ID, {
          billId: 'bill-1',
          amount: 600,
          paymentMethod: 'cash',
        }),
      ).rejects.toThrow('Payment amount (600) exceeds the balance due (500)');
    });

    it('should throw badRequest when paying a draft bill', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(mockBillDraft as any);

      await expect(
        createPayment(TENANT_ID, USER_ID, {
          billId: 'bill-1',
          amount: 100,
          paymentMethod: 'cash',
        }),
      ).rejects.toThrow('Cannot pay a draft bill');
    });

    it('should throw badRequest when bill is already fully paid', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue({
        ...mockBillPending,
        status: 'paid',
        amountPaid: 1100,
        balanceDue: 0,
      } as any);

      await expect(
        createPayment(TENANT_ID, USER_ID, {
          billId: 'bill-1',
          amount: 100,
          paymentMethod: 'cash',
        }),
      ).rejects.toThrow('Bill is already fully paid');
    });

    it('should throw notFound when bill does not exist for payment', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(null);

      await expect(
        createPayment(TENANT_ID, USER_ID, {
          billId: 'no-bill',
          amount: 100,
          paymentMethod: 'cash',
        }),
      ).rejects.toThrow('Bill not found');
    });
  });

  // ═══════════════════════════════════════════
  // createRefund
  // ═══════════════════════════════════════════
  describe('createRefund', () => {
    it('should create a refund request', async () => {
      vi.mocked((prisma.payment as any).findFirst).mockResolvedValue({
        id: 'payment-1',
        tenantId: TENANT_ID,
        billId: 'bill-1',
        patientId: 'patient-1',
        amount: 1100,
        status: 'completed',
        bill: mockBillPending,
      });
      vi.mocked(prisma.refund.findMany).mockResolvedValue([]);
      vi.mocked(prisma.refund.create).mockResolvedValue({
        id: 'refund-1',
        tenantId: TENANT_ID,
        paymentId: 'payment-1',
        billId: 'bill-1',
        patientId: 'patient-1',
        amount: 500,
        reason: 'Overcharge',
        status: 'requested',
      } as any);

      const result = await createRefund(TENANT_ID, USER_ID, {
        paymentId: 'payment-1',
        amount: 500,
        reason: 'Overcharge',
      });

      expect(result.status).toBe('requested');
      expect(result.amount).toBe(500);
      expect(prisma.refund.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            paymentId: 'payment-1',
            amount: 500,
            reason: 'Overcharge',
            status: 'requested',
          }),
        }),
      );
    });

    it('should throw notFound if payment does not exist', async () => {
      vi.mocked((prisma.payment as any).findFirst).mockResolvedValue(null);

      await expect(
        createRefund(TENANT_ID, USER_ID, {
          paymentId: 'no-payment',
          amount: 100,
          reason: 'Test',
        }),
      ).rejects.toThrow('Payment not found or not completed');
    });

    it('should throw badRequest if refund amount exceeds payment amount', async () => {
      vi.mocked((prisma.payment as any).findFirst).mockResolvedValue({
        id: 'payment-1',
        tenantId: TENANT_ID,
        amount: 500,
        status: 'completed',
        bill: mockBillPending,
      });
      vi.mocked(prisma.refund.findMany).mockResolvedValue([]);

      await expect(
        createRefund(TENANT_ID, USER_ID, {
          paymentId: 'payment-1',
          amount: 600,
          reason: 'Too much',
        }),
      ).rejects.toThrow('Refund amount cannot exceed the payment amount');
    });
  });

  // ═══════════════════════════════════════════
  // approveRefund
  // ═══════════════════════════════════════════
  describe('approveRefund', () => {
    /** A ₹500 refund sitting against a fully-paid ₹1100 bill, paid by card. */
    function mockPendingRefund(over: Record<string, unknown> = {}) {
      vi.mocked((prisma.refund as any).findFirst).mockResolvedValue({
        id: 'refund-1',
        tenantId: TENANT_ID,
        paymentId: 'payment-1',
        billId: 'bill-1',
        patientId: 'patient-1',
        amount: 500,
        reason: 'Test cancelled',
        status: 'requested',
        bill: {
          id: 'bill-1',
          billNumber: 'BILL-20260810-0001',
          status: 'paid',
          amountPaid: 1100,
          totalAmount: 1100,
        },
        payment: { id: 'payment-1', paymentMethod: 'credit_card' },
        ...over,
      });
    }

    beforeEach(() => {
      vi.mocked((prisma.refund as any).update).mockResolvedValue({
        id: 'refund-1',
        status: 'approved',
        approvedBy: 'admin-1',
        processedAt: new Date(),
      } as any);
      vi.mocked(prisma.payment.create).mockResolvedValue({ id: 'payout-1' } as any);
      vi.mocked(prisma.receipt.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.receipt.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.receipt.create).mockResolvedValue({
        id: 'receipt-payout-1',
        receiptNumber: 'RCP-20260810-0009',
      } as any);
      vi.mocked(prisma.bill.update).mockResolvedValue({} as any);
      // Ledger after approval: ₹1100 collected, ₹500 now refunded.
      vi.mocked(prisma.payment.aggregate).mockResolvedValue({ _sum: { amount: 1100 } } as any);
      vi.mocked((prisma.refund as any).aggregate).mockResolvedValue({ _sum: { amount: 500 } } as any);
    });

    it('should approve a refund and update bill amounts', async () => {
      mockPendingRefund();

      const result = await approveRefund(TENANT_ID, 'refund-1', 'admin-1');

      expect(result.status).toBe('approved');
      expect(result.approvedBy).toBe('admin-1');
      // ₹1100 collected − ₹500 refunded = ₹600 still counted as paid, so ₹500
      // of the ₹1100 bill is open again.
      expect(prisma.bill.update).toHaveBeenCalledWith({
        where: { id: 'bill-1' },
        data: { amountPaid: 600, balanceDue: 500, status: 'partially_paid' },
      });
    });

    it('records the cash leaving the drawer as a refund payment', async () => {
      // Approving used to adjust the bill and nothing else, so a note handed
      // back across the counter left no trace — Day End's refund line was
      // structurally always ₹0 and no drawer could be tallied.
      mockPendingRefund();

      await approveRefund(TENANT_ID, 'refund-1', 'admin-1');

      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          billId: 'bill-1',
          amount: 500,
          paymentType: 'refund',
          status: 'completed',
          processedBy: 'admin-1',
          // Money goes back out the way it came in, so each tender reconciles
          // against its own line.
          paymentMethod: 'credit_card',
        }),
      });
    });

    it('issues a receipt for the money handed back', async () => {
      mockPendingRefund();

      await approveRefund(TENANT_ID, 'refund-1', 'admin-1');

      expect(prisma.receipt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ paymentId: 'payout-1', amount: 500 }),
      });
    });

    it('falls back to cash when the original payment method is unknown', async () => {
      mockPendingRefund({ payment: null });

      await approveRefund(TENANT_ID, 'refund-1', 'admin-1');

      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ paymentMethod: 'cash' }),
      });
    });

    it('marks the bill refunded when nothing is left paid', async () => {
      mockPendingRefund({ amount: 1100 });
      vi.mocked((prisma.refund as any).aggregate).mockResolvedValue({
        _sum: { amount: 1100 },
      } as any);

      await approveRefund(TENANT_ID, 'refund-1', 'admin-1');

      expect(prisma.bill.update).toHaveBeenCalledWith({
        where: { id: 'bill-1' },
        data: { amountPaid: 0, balanceDue: 1100, status: 'refunded' },
      });
    });

    it('should throw notFound if refund not found or not requested', async () => {
      vi.mocked((prisma.refund as any).findFirst).mockResolvedValue(null);

      await expect(approveRefund(TENANT_ID, 'no-refund', 'admin-1')).rejects.toThrow(
        'Refund not found or not in pending status',
      );
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════
  // applyDiscount
  // ═══════════════════════════════════════════
  describe('applyDiscount', () => {
    it('should apply a percentage discount to a bill', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue({
        ...mockBillDraft,
        subtotal: 1000,
        taxAmount: 100,
        amountPaid: 0,
      } as any);
      vi.mocked(prisma.discount.create).mockResolvedValue({
        id: 'discount-1',
        tenantId: TENANT_ID,
        billId: 'bill-1',
        discountType: 'percentage',
        value: 100, // 10% of 1000
        reason: 'Senior citizen',
      } as any);
      vi.mocked((prisma.discount as any).findMany).mockResolvedValue([
        { value: 100 },
      ]);
      // applyDiscount now also folds in any item-level discounts, so
      // bill.discountAmount means the same thing here as it does in
      // setBillDiscount and recalculateBillTotals.
      vi.mocked((prisma.billItem as any).aggregate).mockResolvedValue({
        _sum: { discountAmount: 0 },
      } as any);
      vi.mocked(prisma.bill.update).mockResolvedValue({} as any);

      const result = await applyDiscount(TENANT_ID, 'bill-1', {
        discountType: 'percentage',
        discountValue: 10,
        reason: 'Senior citizen',
      });

      expect(result.id).toBe('discount-1');
      expect(prisma.discount.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            billId: 'bill-1',
            discountType: 'percentage',
            value: 100,
            reason: 'Senior citizen',
          }),
        }),
      );
    });

    it('should apply a fixed discount to a bill', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue({
        ...mockBillDraft,
        subtotal: 1000,
        taxAmount: 100,
        amountPaid: 0,
      } as any);
      vi.mocked(prisma.discount.create).mockResolvedValue({
        id: 'discount-2',
        tenantId: TENANT_ID,
        billId: 'bill-1',
        discountType: 'fixed',
        value: 200,
        reason: 'Staff discount',
      } as any);
      vi.mocked((prisma.discount as any).findMany).mockResolvedValue([{ value: 200 }]);
      vi.mocked(prisma.bill.update).mockResolvedValue({} as any);

      const result = await applyDiscount(TENANT_ID, 'bill-1', {
        discountType: 'fixed',
        discountValue: 200,
        reason: 'Staff discount',
      });

      expect(result.id).toBe('discount-2');
    });

    it('should throw notFound when bill does not exist for discount', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(null);

      await expect(
        applyDiscount(TENANT_ID, 'no-bill', {
          discountType: 'percentage',
          discountValue: 10,
        }),
      ).rejects.toThrow('Bill not found');
    });

    it('should throw badRequest if percentage discount exceeds 100%', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue({
        ...mockBillDraft,
        subtotal: 1000,
      } as any);

      await expect(
        applyDiscount(TENANT_ID, 'bill-1', {
          discountType: 'percentage',
          discountValue: 150,
        }),
      ).rejects.toThrow('Percentage discount cannot exceed 100%');
    });
  });

  // ═══════════════════════════════════════════
  // getBillById
  // ═══════════════════════════════════════════
  describe('getBillById', () => {
    it('should throw notFound for non-existent bill', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(null);

      await expect(getBillById(TENANT_ID, 'no-bill')).rejects.toThrow('Bill not found');
    });
  });

  // ═══════════════════════════════════════════
  // adjustAdvanceToBill — moving a deposit onto a bill
  // ═══════════════════════════════════════════
  describe('adjustAdvanceToBill', () => {
    const partiallyPaidBill = {
      id: 'bill-1',
      tenantId: TENANT_ID,
      patientId: 'patient-1',
      status: 'partially_paid',
      totalAmount: 2000,
      amountPaid: 1500,
      balanceDue: 500,
    };

    it('refuses to take more off the advance than the bill owes', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(partiallyPaidBill as any);

      // The bill owes 500. Adjusting 2000 used to mark it paid, drain the full
      // 2000 from the advance, and lose the 1500 difference: the bill balance
      // is floored at zero, so the overpayment had nowhere to go.
      await expect(
        adjustAdvanceToBill(TENANT_ID, 'user-1', {
          patientId: 'patient-1',
          billId: 'bill-1',
          amount: 2000,
        }),
      ).rejects.toThrow('Bill balance is 500, cannot adjust 2000');
    });

    it('refuses a bill that cannot take a payment', async () => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue({
        ...partiallyPaidBill,
        status: 'cancelled',
      } as any);

      await expect(
        adjustAdvanceToBill(TENANT_ID, 'user-1', {
          patientId: 'patient-1',
          billId: 'bill-1',
          amount: 100,
        }),
      ).rejects.toThrow('Bill cannot accept payment (status: cancelled)');
    });

    it('rejects a non-positive amount', async () => {
      await expect(
        adjustAdvanceToBill(TENANT_ID, 'user-1', {
          patientId: 'patient-1',
          billId: 'bill-1',
          amount: 0,
        }),
      ).rejects.toThrow('Amount must be > 0');
    });
  });

  // ═══════════════════════════════════════════
  // settleGatewayPayment
  // ═══════════════════════════════════════════
  // Razorpay only reaches this system from the patient portal and the SaaS
  // subscription checkout — the hospital counter marks payments by hand. Low
  // volume, but it is real money and the gateway drives it twice by design:
  // the checkout callback verifies, and the webhook fires independently and
  // retries until it gets a 2xx.
  describe('settleGatewayPayment', () => {
    const pendingGatewayPayment = {
      id: 'payment-online-1',
      tenantId: TENANT_ID,
      billId: 'bill-1',
      amount: 1100,
      status: 'pending',
      transactionId: null,
    };

    beforeEach(() => {
      vi.mocked(prisma.receipt.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.receipt.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.receipt.create).mockResolvedValue({
        id: 'receipt-online-1',
        receiptNumber: 'RCP-20260810-0001',
      } as any);
      vi.mocked(prisma.payment.update).mockResolvedValue({} as any);
      vi.mocked(prisma.bill.update).mockResolvedValue({} as any);
      vi.mocked(prisma.bill.findUnique).mockResolvedValue({
        totalAmount: 1100,
        status: 'pending',
      } as any);
      vi.mocked(prisma.payment.aggregate).mockResolvedValue({
        _sum: { amount: 1100 },
      } as any);
      vi.mocked(prisma.refund.aggregate).mockResolvedValue({ _sum: { amount: 0 } } as any);
    });

    it('settles a pending payment and issues its receipt', async () => {
      vi.mocked(prisma.payment.findUnique).mockResolvedValue(pendingGatewayPayment as any);

      const result = await settleGatewayPayment('payment-online-1', 'pay_rzp_abc');

      expect(result).toEqual({ alreadySettled: false, billId: 'bill-1' });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 'payment-online-1' },
        data: { status: 'completed', transactionId: 'pay_rzp_abc' },
      });
      // Counter payments always produced a receipt; the gateway paths never
      // did, so a patient who paid online had nothing to download.
      expect(prisma.receipt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ paymentId: 'payment-online-1', amount: 1100 }),
      });
      expect(prisma.bill.update).toHaveBeenCalledWith({
        where: { id: 'bill-1' },
        data: { amountPaid: 1100, balanceDue: 0, status: 'paid' },
      });
    });

    it('credits the bill once when the webhook is replayed', async () => {
      // The headline gateway bug: `payment.captured` added the amount to
      // bill.amountPaid with no check that the payment was already completed,
      // so a retried or replayed webhook credited the same money two or three
      // times over.
      vi.mocked(prisma.payment.findUnique).mockResolvedValue({
        ...pendingGatewayPayment,
        status: 'completed',
        transactionId: 'pay_rzp_abc',
      } as any);

      const result = await settleGatewayPayment('payment-online-1', 'pay_rzp_abc');

      expect(result).toEqual({ alreadySettled: true, billId: 'bill-1' });
      expect(prisma.bill.update).not.toHaveBeenCalled();
      expect(prisma.receipt.create).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('does not double-subtract the discount when settling', async () => {
      // totalAmount is already net of discount — recalculateBillTotals stores
      // `subtotal − discount + tax`. The webhook subtracted discountAmount a
      // second time, so a discounted bill paid online flipped to `paid` while
      // the concession amount was still owed. Settling from the ledger against
      // totalAmount alone is what makes that impossible.
      vi.mocked(prisma.payment.findUnique).mockResolvedValue(pendingGatewayPayment as any);
      vi.mocked(prisma.bill.findUnique).mockResolvedValue({
        totalAmount: 900, // ₹1000 of items less a ₹100 concession
        status: 'pending',
      } as any);
      vi.mocked(prisma.payment.aggregate).mockResolvedValue({ _sum: { amount: 800 } } as any);

      await settleGatewayPayment('payment-online-1', 'pay_rzp_abc');

      // ₹100 still owed. The old arithmetic gave 900 − 100 − 800 = 0 → 'paid'.
      expect(prisma.bill.update).toHaveBeenCalledWith({
        where: { id: 'bill-1' },
        data: { amountPaid: 800, balanceDue: 100, status: 'partially_paid' },
      });
    });

    it('reuses an existing receipt rather than failing on the unique paymentId', async () => {
      vi.mocked(prisma.payment.findUnique).mockResolvedValue(pendingGatewayPayment as any);
      vi.mocked(prisma.receipt.findUnique).mockResolvedValue({
        id: 'receipt-online-1',
        receiptNumber: 'RCP-20260810-0001',
      } as any);

      await settleGatewayPayment('payment-online-1', 'pay_rzp_abc');

      expect(prisma.receipt.create).not.toHaveBeenCalled();
      expect(prisma.bill.update).toHaveBeenCalled();
    });

    it('is a no-op for an unknown payment', async () => {
      vi.mocked(prisma.payment.findUnique).mockResolvedValue(null);

      const result = await settleGatewayPayment('no-such-payment');

      expect(result).toEqual({ alreadySettled: false, billId: null });
      expect(prisma.bill.update).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════
  // pullChargesToBill — tax-inclusive vs tax-exclusive lines
  // ═══════════════════════════════════════════
  describe('pullChargesToBill', () => {
    beforeEach(() => {
      vi.mocked(prisma.bill.findFirst).mockResolvedValue(mockBillDraft as any);
      vi.mocked(prisma.billItem.findFirst).mockResolvedValue(null); // no dedupe hit
      vi.mocked(prisma.billItem.create).mockResolvedValue({ id: 'item-1' } as any);
      mockRecalculate([]);
    });

    it('embeds the GST in a tax-inclusive medicine price instead of adding it on top', async () => {
      // Medicine prices are MRP, which is tax-inclusive by law — the pharmacy
      // counter derives the embedded GST for the breakup. Billing used to add
      // the rate ON TOP of the same MRP, so a ₹100 strip cost ₹100 at the
      // counter and ₹112 on an IP bill for the identical item.
      await pullChargesToBill(TENANT_ID, 'bill-1', [
        {
          referenceType: 'dispensing_record',
          referenceId: 'disp-1',
          description: 'Paracetamol 500mg',
          quantity: 1,
          unitPrice: 100,
          taxRate: 12,
          taxInclusive: true,
          category: 'pharmacy',
        },
      ]);

      expect(prisma.billItem.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          unitPrice: 100,
          taxPercent: 12,
          // 100 − 100/1.12 = 10.71 of GST already inside the ₹100.
          taxAmount: 10.71,
          totalAmount: 100,
        }),
      });
    });

    it('still adds tax on top of a tax-exclusive service charge', async () => {
      // A ServiceTariff quotes a basePrice and a gstRatePercent — that reads as
      // "plus GST", so services must keep behaving exactly as before.
      await pullChargesToBill(TENANT_ID, 'bill-1', [
        {
          referenceType: 'imaging_request',
          referenceId: 'img-1',
          description: 'Imaging: xray',
          quantity: 1,
          unitPrice: 100,
          taxRate: 18,
          category: 'radiology',
        },
      ]);

      expect(prisma.billItem.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          unitPrice: 100,
          taxPercent: 18,
          taxAmount: 18,
          totalAmount: 118,
        }),
      });
    });

    it('leaves an untaxed charge alone whichever way it is marked', async () => {
      await pullChargesToBill(TENANT_ID, 'bill-1', [
        {
          referenceType: 'lab_order_item',
          referenceId: 'lab-1',
          description: 'Lab: CBC',
          quantity: 2,
          unitPrice: 150,
          taxRate: 0,
          taxInclusive: true,
          category: 'lab',
        },
      ]);

      expect(prisma.billItem.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ taxAmount: 0, totalAmount: 300 }),
      });
    });
  });

  // ═══════════════════════════════════════════
  // GST resolution — India: healthcare is exempt, with narrow exceptions
  // ═══════════════════════════════════════════
  describe('room GST', () => {
    // In India room rent is exempt EXCEPT non-ICU accommodation above
    // ₹5,000/day, which attracts 5% — and on the whole day's rent, not just the
    // part above the line. ICU is exempt at any rate.
    const DAY = new Date('2026-08-10T06:00:00.000Z');

    /**
     * One admission, one bed, one ward, one billable day — then read back the
     * tax rate the room charge resolved to.
     */
    async function roomCharge(opts: {
      dailyCharge?: number | null;
      wardType?: string | null;
      bedType?: string;
      tariffs?: Array<{ serviceCode: string | null; basePrice: number; gstRatePercent: number; category: string }>;
    }) {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(mockPatient as any);
      vi.mocked(prisma.billItem.findMany).mockResolvedValue([]);
      vi.mocked(prisma.serviceTariff.findMany).mockResolvedValue((opts.tariffs ?? []) as any);
      vi.mocked(prisma.admission.findMany).mockResolvedValue([
        {
          id: 'adm-1',
          visitId: 'visit-1',
          admissionDate: DAY,
          dischargeDate: DAY,
          status: 'discharged',
          bedId: 'bed-1',
          wardId: 'ward-1',
        },
      ] as any);
      vi.mocked(prisma.patientTransfer.findMany).mockResolvedValue([]);
      vi.mocked(prisma.bed.findMany).mockResolvedValue([
        { id: 'bed-1', bedNumber: 'B1', bedType: opts.bedType ?? 'standard' },
      ] as any);
      vi.mocked(prisma.ward.findMany).mockResolvedValue([
        {
          id: 'ward-1',
          name: 'Ward',
          wardType: opts.wardType ?? 'general',
          dailyCharge: opts.dailyCharge ?? null,
        },
      ] as any);

      const res = await getPatientCharges(TENANT_ID, {
        patientId: 'patient-1',
        source: 'room',
      } as any);
      return res.charges[0];
    }

    it('exempts a general ward bed below the threshold', async () => {
      const row = await roomCharge({ dailyCharge: 1500 });
      expect(row.unitPrice).toBe(1500);
      expect(row.taxRate).toBe(0);
    });

    it('charges 5% on a non-ICU room above ₹5,000 a day', async () => {
      const row = await roomCharge({ dailyCharge: 6000, wardType: 'private' });
      expect(row.unitPrice).toBe(6000);
      expect(row.taxRate).toBe(5);
    });

    it('exempts ICU however expensive the bed is', async () => {
      const row = await roomCharge({ dailyCharge: 12000, wardType: 'icu', bedType: 'icu' });
      expect(row.taxRate).toBe(0);
    });

    it('does not let a taxable room tariff spill onto a cheap ward bed', async () => {
      // The regression this rule exists for. A hospital whose room tariffs are
      // mostly deluxe AC at 5% used to have that 5% applied to any bed priced
      // off the ward's own daily charge — rent that is plainly exempt.
      const row = await roomCharge({
        dailyCharge: 1200,
        tariffs: [
          { serviceCode: 'deluxe', basePrice: 8000, gstRatePercent: 5, category: 'room' },
          { serviceCode: 'suite', basePrice: 12000, gstRatePercent: 5, category: 'room' },
        ],
      });
      expect(row.unitPrice).toBe(1200);
      expect(row.taxRate).toBe(0);
    });

    it('honours the tariff’s own rate once the room is over the threshold', async () => {
      const row = await roomCharge({
        dailyCharge: null,
        bedType: 'electric',
        tariffs: [
          { serviceCode: 'electric', basePrice: 7500, gstRatePercent: 5, category: 'room' },
        ],
      });
      expect(row.unitPrice).toBe(7500);
      expect(row.taxRate).toBe(5);
    });
  });

  // ═══════════════════════════════════════════
  // getCollectionSummary — refunds are not takings
  // ═══════════════════════════════════════════
  describe('getCollectionSummary', () => {
    it('leaves refunds out of collection and reports them separately', async () => {
      // Refund payouts are completed payments like any other. Counting them as
      // collection would credit the counter with money it just handed back.
      vi.mocked(prisma.payment.findMany).mockResolvedValue([
        { amount: 1000, paymentMethod: 'cash', paymentType: 'regular', paymentSource: 'frontdesk' },
        { amount: 500, paymentMethod: 'upi', paymentType: 'regular', paymentSource: 'frontdesk' },
        { amount: 300, paymentMethod: 'cash', paymentType: 'refund', paymentSource: 'frontdesk' },
      ] as any);
      vi.mocked(prisma.bill.findMany).mockResolvedValue([]);

      const s = await getCollectionSummary(TENANT_ID, {
        startDate: '2026-08-10',
        endDate: '2026-08-10',
      });

      expect(s.totalCollection).toBe(1500);
      expect(s.refunds).toBe(300);
      expect(s.netCollection).toBe(1200);
      // The ₹300 handed back must not show up under the cash tender either —
      // that is the figure a cashier counts the drawer against.
      expect(s.cash).toBe(1000);
      expect(s.upi).toBe(500);
    });
  });

  // ═══════════════════════════════════════════
  // getBills — advance bucket exclusion
  // ═══════════════════════════════════════════
  describe('getBills', () => {
    it('keeps the ADV- advance bucket out of every bill list', async () => {
      // A patient's advance money is parked on a sentinel ADV- bill so it can
      // reuse the Payment/Receipt machinery. Nobody was ever billed for it, so
      // it must not surface as a bill — left in, it appeared in the Pending
      // List as a phantom row and inflated the day-end revenue totals.
      vi.mocked(prisma.bill.findMany).mockResolvedValue([]);
      vi.mocked(prisma.bill.count).mockResolvedValue(0);

      await getBills(TENANT_ID, { page: 1, limit: 20 });

      expect(prisma.bill.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: TENANT_ID,
            billNumber: { not: { startsWith: 'ADV-' } },
          }),
        }),
      );
    });
  });
});
