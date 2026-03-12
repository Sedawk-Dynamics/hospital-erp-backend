import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateServiceTariffInput,
  UpdateServiceTariffInput,
  CreateBillInput,
  AddBillItemInput,
  CreatePaymentInput,
  CreateRefundInput,
  ApplyDiscountInput,
  GetBillsQuery,
  GetPaymentsQuery,
} from './billing.validation';

/**
 * Map validation category values to ServiceTariffCategory enum values.
 * Validation has 'imaging' which maps to 'radiology' in the schema,
 * and 'nursing' which doesn't exist in schema enum (maps to 'other').
 */
function mapToServiceTariffCategory(cat: string): string {
  const mapping: Record<string, string> = {
    consultation: 'consultation',
    surgery: 'surgery',
    room: 'room',
    lab: 'lab',
    imaging: 'radiology',
    pharmacy: 'pharmacy',
    procedure: 'procedure',
    nursing: 'other',
    other: 'other',
  };
  return mapping[cat] ?? 'other';
}

/**
 * Map validation payment method to PaymentMethod enum.
 * Validation allows 'bank_transfer' and 'wallet' which don't exist in schema.
 */
function mapPaymentMethod(method: string): string {
  const mapping: Record<string, string> = {
    cash: 'cash',
    credit_card: 'credit_card',
    debit_card: 'debit_card',
    bank_transfer: 'net_banking',
    upi: 'upi',
    cheque: 'cheque',
    insurance: 'insurance',
    wallet: 'other',
    other: 'other',
  };
  return mapping[method] ?? 'other';
}

/**
 * Convert Decimal to number for arithmetic.
 */
function toNumber(val: Decimal | number | null | undefined): number {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  return val.toNumber();
}

/**
 * Generate a unique bill number.
 * Format: BILL-YYYYMMDD-XXXX
 */
async function generateBillNumber(tenantId: string): Promise<string> {
  const today = new Date();
  const dateStr =
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, '0') +
    today.getDate().toString().padStart(2, '0');

  const prefix = `BILL-${dateStr}-`;

  const latestBill = await prisma.bill.findFirst({
    where: {
      tenantId,
      billNumber: { startsWith: prefix },
    },
    orderBy: { billNumber: 'desc' },
    select: { billNumber: true },
  });

  let nextNumber = 1;
  if (latestBill?.billNumber) {
    const lastNumber = parseInt(latestBill.billNumber.split('-').pop() || '0', 10);
    nextNumber = lastNumber + 1;
  }

  const billNumber = `${prefix}${nextNumber.toString().padStart(4, '0')}`;

  const existing = await prisma.bill.findFirst({
    where: { tenantId, billNumber },
  });

  if (existing) {
    return generateBillNumber(tenantId);
  }

  return billNumber;
}

/**
 * Generate a unique receipt number.
 * Format: RCP-YYYYMMDD-XXXX
 */
async function generateReceiptNumber(tenantId: string): Promise<string> {
  const today = new Date();
  const dateStr =
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, '0') +
    today.getDate().toString().padStart(2, '0');

  const prefix = `RCP-${dateStr}-`;

  const latestReceipt = await prisma.receipt.findFirst({
    where: {
      tenantId,
      receiptNumber: { startsWith: prefix },
    },
    orderBy: { receiptNumber: 'desc' },
    select: { receiptNumber: true },
  });

  let nextNumber = 1;
  if (latestReceipt?.receiptNumber) {
    const lastNumber = parseInt(latestReceipt.receiptNumber.split('-').pop() || '0', 10);
    nextNumber = lastNumber + 1;
  }

  const receiptNumber = `${prefix}${nextNumber.toString().padStart(4, '0')}`;

  const existing = await prisma.receipt.findFirst({
    where: { tenantId, receiptNumber },
  });

  if (existing) {
    return generateReceiptNumber(tenantId);
  }

  return receiptNumber;
}

/**
 * Recalculate bill totals from items.
 */
async function recalculateBillTotals(billId: string) {
  const items = await prisma.billItem.findMany({
    where: { billId },
  });

  let subtotal = 0;
  let totalTax = 0;
  let totalDiscount = 0;

  for (const item of items) {
    const itemSubtotal = item.quantity * toNumber(item.unitPrice);
    const itemDiscount = toNumber(item.discountAmount);
    const itemTax = toNumber(item.taxAmount);

    subtotal += itemSubtotal;
    totalDiscount += itemDiscount;
    totalTax += itemTax;
  }

  const total = subtotal - totalDiscount + totalTax;

  // Get total paid
  const payments = await prisma.payment.findMany({
    where: { billId, status: 'completed' },
  });
  const totalPaid = payments.reduce((sum, p) => sum + toNumber(p.amount), 0);

  // Determine status based on payment
  let status: string | undefined;
  const bill = await prisma.bill.findUnique({ where: { id: billId }, select: { status: true } });
  if (bill && bill.status !== 'draft') {
    if (totalPaid >= total && total > 0) {
      status = 'paid';
    } else if (totalPaid > 0) {
      status = 'partially_paid';
    }
  }

  const updateData: any = {
    subtotal,
    taxAmount: totalTax,
    discountAmount: totalDiscount,
    totalAmount: total,
    amountPaid: totalPaid,
    balanceDue: total - totalPaid,
  };

  if (status) {
    updateData.status = status;
  }

  await prisma.bill.update({
    where: { id: billId },
    data: updateData,
  });
}

// --- Service Tariffs ---

export async function createServiceTariff(tenantId: string, data: CreateServiceTariffInput) {
  // Check for duplicate serviceCode within tenant
  if (data.code) {
    const existing = await prisma.serviceTariff.findFirst({
      where: { tenantId, serviceCode: data.code },
    });

    if (existing) {
      throw AppError.conflict('A service tariff with this code already exists');
    }
  }

  const tariff = await prisma.serviceTariff.create({
    data: {
      tenantId,
      serviceName: data.name,
      serviceCode: data.code,
      category: mapToServiceTariffCategory(data.category) as any,
      basePrice: data.basePrice,
      gstRatePercent: data.taxRate ?? 0,
      isActive: data.isActive ?? true,
    },
  });

  logger.info({ tenantId, tariffId: tariff.id }, 'Service tariff created');
  return tariff;
}

export async function getServiceTariffs(tenantId: string, query: any) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.category) where.category = mapToServiceTariffCategory(query.category);
  if (query.isActive !== undefined) where.isActive = query.isActive;

  if (query.search) {
    where.OR = [
      { serviceName: { contains: query.search, mode: 'insensitive' } },
      { serviceCode: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [tariffs, total] = await Promise.all([
    prisma.serviceTariff.findMany({
      where,
      skip,
      take,
      orderBy: { serviceName: 'asc' },
    }),
    prisma.serviceTariff.count({ where }),
  ]);

  return { tariffs, total, page, limit };
}

export async function updateServiceTariff(
  tenantId: string,
  id: string,
  data: UpdateServiceTariffInput,
) {
  const existing = await prisma.serviceTariff.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Service tariff not found');
  }

  // Check for duplicate code if code is being changed
  if (data.code && data.code !== existing.serviceCode) {
    const duplicate = await prisma.serviceTariff.findFirst({
      where: { tenantId, serviceCode: data.code, id: { not: id } },
    });
    if (duplicate) {
      throw AppError.conflict('A service tariff with this code already exists');
    }
  }

  const updateData: any = {};
  if (data.name !== undefined) updateData.serviceName = data.name;
  if (data.code !== undefined) updateData.serviceCode = data.code;
  if (data.category !== undefined) updateData.category = mapToServiceTariffCategory(data.category);
  if (data.basePrice !== undefined) updateData.basePrice = data.basePrice;
  if (data.taxRate !== undefined) updateData.gstRatePercent = data.taxRate;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;

  const tariff = await prisma.serviceTariff.update({
    where: { id },
    data: updateData,
  });

  logger.info({ tenantId, tariffId: id }, 'Service tariff updated');
  return tariff;
}

// --- Bills ---

export async function createBill(tenantId: string, data: CreateBillInput) {
  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });

  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const billNumber = await generateBillNumber(tenantId);

  const bill = await prisma.bill.create({
    data: {
      tenantId,
      billNumber,
      patientId: data.patientId,
      visitId: data.visitId,
      admissionId: data.admissionId,
      billDate: new Date(),
      status: 'draft',
      subtotal: 0,
      taxAmount: 0,
      discountAmount: 0,
      totalAmount: 0,
      insuranceCoveredAmount: 0,
      patientPayableAmount: 0,
      amountPaid: 0,
      balanceDue: 0,
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
    },
  });

  logger.info({ tenantId, billId: bill.id, billNumber }, 'Bill created');
  return bill;
}

export async function getBills(tenantId: string, query: GetBillsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.status) where.status = query.status;

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { billNumber: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [bills, total] = await Promise.all([
    prisma.bill.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.bill.count({ where }),
  ]);

  return { bills, total, page, limit };
}

export async function getBillById(tenantId: string, id: string) {
  const bill = await prisma.bill.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          addressLine1: true,
          city: true,
        },
      },
      billItems: {
        include: {
          serviceTariff: {
            select: { id: true, serviceName: true, serviceCode: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
      payments: {
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!bill) {
    throw AppError.notFound('Bill not found');
  }

  return bill;
}

export async function addBillItem(tenantId: string, billId: string, data: AddBillItemInput) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
  });

  if (!bill) {
    throw AppError.notFound('Bill not found');
  }

  if (bill.status !== 'draft') {
    throw AppError.badRequest('Can only add items to draft bills');
  }

  // If service tariff is provided, verify it exists
  if (data.serviceTariffId) {
    const tariff = await prisma.serviceTariff.findFirst({
      where: { id: data.serviceTariffId, tenantId },
    });
    if (!tariff) {
      throw AppError.notFound('Service tariff not found');
    }
  }

  const unitPrice = data.unitPrice;
  const quantity = data.quantity;
  const discountAmount = data.discount ?? 0;
  const taxPercent = data.taxRate ?? 0;
  const lineBeforeTax = quantity * unitPrice - discountAmount;
  const taxAmount = lineBeforeTax * (taxPercent / 100);
  const totalAmount = lineBeforeTax + taxAmount;
  const discountPercent = unitPrice > 0 ? (discountAmount / (quantity * unitPrice)) * 100 : 0;

  const item = await prisma.billItem.create({
    data: {
      billId,
      serviceTariffId: data.serviceTariffId,
      description: data.description,
      category: 'other',
      quantity,
      unitPrice,
      discountPercent,
      discountAmount,
      taxPercent,
      taxAmount,
      totalAmount,
    },
  });

  // Recalculate bill totals
  await recalculateBillTotals(billId);

  logger.info({ tenantId, billId, itemId: item.id }, 'Bill item added');
  return item;
}

export async function removeBillItem(tenantId: string, billId: string, itemId: string) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
  });

  if (!bill) {
    throw AppError.notFound('Bill not found');
  }

  if (bill.status !== 'draft') {
    throw AppError.badRequest('Can only remove items from draft bills');
  }

  const item = await prisma.billItem.findFirst({
    where: { id: itemId, billId },
  });

  if (!item) {
    throw AppError.notFound('Bill item not found');
  }

  await prisma.billItem.delete({ where: { id: itemId } });

  // Recalculate bill totals
  await recalculateBillTotals(billId);

  logger.info({ tenantId, billId, itemId }, 'Bill item removed');
}

export async function finalizeBill(tenantId: string, billId: string) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
    include: { billItems: true },
  });

  if (!bill) {
    throw AppError.notFound('Bill not found');
  }

  if (bill.status !== 'draft') {
    throw AppError.badRequest('Only draft bills can be finalized');
  }

  if (bill.billItems.length === 0) {
    throw AppError.badRequest('Cannot finalize a bill with no items');
  }

  // Recalculate final totals
  await recalculateBillTotals(billId);

  const updatedBill = await prisma.bill.update({
    where: { id: billId },
    data: {
      status: 'pending',
    },
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      billItems: true,
    },
  });

  logger.info({ tenantId, billId, totalAmount: updatedBill.totalAmount }, 'Bill finalized');
  return updatedBill;
}

// --- Payments ---

export async function createPayment(tenantId: string, data: CreatePaymentInput) {
  const bill = await prisma.bill.findFirst({
    where: { id: data.billId, tenantId },
  });

  if (!bill) {
    throw AppError.notFound('Bill not found');
  }

  if (bill.status === 'draft') {
    throw AppError.badRequest('Cannot pay a draft bill. Finalize the bill first.');
  }

  if (bill.status === 'paid') {
    throw AppError.badRequest('Bill is already fully paid');
  }

  if (bill.status === 'cancelled') {
    throw AppError.badRequest('Cannot pay a cancelled bill');
  }

  const balanceDue = toNumber(bill.balanceDue);
  if (data.amount > balanceDue) {
    throw AppError.badRequest(
      `Payment amount (${data.amount}) exceeds the balance due (${balanceDue})`,
    );
  }

  const receiptNumber = await generateReceiptNumber(tenantId);
  const mappedPaymentMethod = mapPaymentMethod(data.paymentMethod) as any;

  // Create payment and receipt in a transaction
  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        tenantId,
        billId: data.billId,
        patientId: bill.patientId,
        amount: data.amount,
        paymentMethod: mappedPaymentMethod,
        transactionId: data.referenceNumber,
        notes: data.notes,
        status: 'completed',
        paymentDate: new Date(),
      },
    });

    // Create receipt
    const receipt = await tx.receipt.create({
      data: {
        tenantId,
        receiptNumber,
        paymentId: payment.id,
        receiptDate: new Date(),
        amount: data.amount,
      },
    });

    // Update bill amounts
    const currentPaid = toNumber(bill.amountPaid);
    const newPaidAmount = currentPaid + data.amount;
    const totalAmount = toNumber(bill.totalAmount);
    const newBalanceDue = totalAmount - newPaidAmount;
    const newStatus = newBalanceDue <= 0 ? 'paid' : 'partially_paid';

    await tx.bill.update({
      where: { id: data.billId },
      data: {
        amountPaid: newPaidAmount,
        balanceDue: newBalanceDue,
        status: newStatus,
      },
    });

    return { payment, receipt };
  });

  logger.info(
    { tenantId, billId: data.billId, paymentId: result.payment.id, amount: data.amount },
    'Payment recorded',
  );
  return result;
}

export async function getPayments(tenantId: string, query: GetPaymentsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.billId) where.billId = query.billId;
  if (query.paymentMethod) where.paymentMethod = mapPaymentMethod(query.paymentMethod);

  if (query.fromDate) {
    where.paymentDate = { ...where.paymentDate, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.paymentDate = { ...where.paymentDate, lte: new Date(query.toDate) };
  }

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      skip,
      take,
      include: {
        bill: {
          select: { id: true, billNumber: true, totalAmount: true },
        },
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.payment.count({ where }),
  ]);

  return { payments, total, page, limit };
}

// --- Refunds ---

export async function createRefund(tenantId: string, data: CreateRefundInput) {
  const payment = await prisma.payment.findFirst({
    where: { id: data.paymentId, tenantId, status: 'completed' },
    include: { bill: true },
  });

  if (!payment) {
    throw AppError.notFound('Payment not found or not completed');
  }

  const paymentAmount = toNumber(payment.amount);
  if (data.amount > paymentAmount) {
    throw AppError.badRequest('Refund amount cannot exceed the payment amount');
  }

  // Check for existing refunds on this payment
  const existingRefunds = await prisma.refund.findMany({
    where: { paymentId: data.paymentId, status: { in: ['requested', 'approved'] } },
  });

  const totalRefunded = existingRefunds.reduce((sum: number, r: { amount: Decimal }) => sum + toNumber(r.amount), 0);
  if (totalRefunded + data.amount > paymentAmount) {
    throw AppError.badRequest(
      'Total refund amount cannot exceed the payment amount. Already refunded: ' + totalRefunded,
    );
  }

  const refund = await prisma.refund.create({
    data: {
      tenantId,
      paymentId: data.paymentId,
      billId: payment.billId,
      patientId: payment.patientId,
      amount: data.amount,
      reason: data.reason,
      status: 'requested',
    },
  });

  logger.info(
    { tenantId, refundId: refund.id, paymentId: data.paymentId, amount: data.amount },
    'Refund request created',
  );
  return refund;
}

export async function approveRefund(tenantId: string, refundId: string, approvedBy: string) {
  const refund = await prisma.refund.findFirst({
    where: { id: refundId, tenantId, status: 'requested' },
    include: { bill: true },
  });

  if (!refund) {
    throw AppError.notFound('Refund not found or not in pending status');
  }

  const result = await prisma.$transaction(async (tx) => {
    // Update refund status
    const updatedRefund = await tx.refund.update({
      where: { id: refundId },
      data: {
        status: 'approved',
        approvedBy,
        processedAt: new Date(),
      },
    });

    // Update bill amounts
    const bill = refund.bill!;
    const currentPaid = toNumber(bill.amountPaid);
    const refundAmount = toNumber(refund.amount);
    const newPaidAmount = currentPaid - refundAmount;
    const totalAmount = toNumber(bill.totalAmount);
    const newBalanceDue = totalAmount - newPaidAmount;

    let newStatus = bill.status;
    if (newPaidAmount <= 0) {
      newStatus = 'refunded';
    } else if (newBalanceDue > 0) {
      newStatus = 'partially_paid';
    }

    await tx.bill.update({
      where: { id: bill.id },
      data: {
        amountPaid: newPaidAmount,
        balanceDue: newBalanceDue,
        status: newStatus,
      },
    });

    return updatedRefund;
  });

  logger.info(
    { tenantId, refundId, approvedBy, amount: refund.amount },
    'Refund approved',
  );
  return result;
}

// --- Discounts ---

export async function applyDiscount(tenantId: string, billId: string, data: ApplyDiscountInput) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
  });

  if (!bill) {
    throw AppError.notFound('Bill not found');
  }

  if (bill.status !== 'draft' && bill.status !== 'pending') {
    throw AppError.badRequest('Can only apply discounts to draft or pending bills');
  }

  const subtotal = toNumber(bill.subtotal);
  let discountValue: number;
  if (data.discountType === 'percentage') {
    if (data.discountValue > 100) {
      throw AppError.badRequest('Percentage discount cannot exceed 100%');
    }
    discountValue = subtotal * (data.discountValue / 100);
  } else {
    discountValue = data.discountValue;
    if (discountValue > subtotal) {
      throw AppError.badRequest('Fixed discount cannot exceed the subtotal');
    }
  }

  // Record the discount using prisma.discount
  const discount = await prisma.discount.create({
    data: {
      tenantId,
      billId,
      discountType: data.discountType as any,
      value: discountValue,
      reason: data.reason,
      approvedBy: data.approvedBy,
    },
  });

  // Recalculate totals - apply discount to the bill level
  const allDiscounts = await prisma.discount.findMany({
    where: { billId },
  });

  const totalDiscountValue = allDiscounts.reduce((sum: number, d: { value: Decimal }) => sum + toNumber(d.value), 0);
  const taxAmount = toNumber(bill.taxAmount);
  const totalAmount = subtotal - totalDiscountValue + taxAmount;

  await prisma.bill.update({
    where: { id: billId },
    data: {
      discountAmount: totalDiscountValue,
      totalAmount: Math.max(0, totalAmount),
      balanceDue: Math.max(0, totalAmount - toNumber(bill.amountPaid)),
    },
  });

  logger.info({ tenantId, billId, discountValue }, 'Discount applied');
  return discount;
}

// --- Patient Bills ---

export async function getPatientBills(tenantId: string, patientId: string) {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
  });

  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const bills = await prisma.bill.findMany({
    where: { tenantId, patientId },
    include: {
      billItems: {
        select: { id: true, description: true, totalAmount: true },
      },
      payments: {
        select: { id: true, amount: true, paymentMethod: true, status: true, paymentDate: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return bills;
}
