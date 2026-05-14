import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { getISTDateStr, formatDateTimeIST } from '../../shared/date.utils';
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
  const dateStr = getISTDateStr();

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
  const dateStr = getISTDateStr();

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

// --- Collection Summary ---

export async function getCollectionSummary(
  tenantId: string,
  query: { startDate?: string; endDate?: string },
) {
  const where: any = { tenantId, status: 'completed' };

  if (query.startDate) {
    where.paymentDate = { ...where.paymentDate, gte: new Date(query.startDate) };
  }
  if (query.endDate) {
    where.paymentDate = { ...where.paymentDate, lte: new Date(query.endDate) };
  }

  const payments = await prisma.payment.findMany({ where });

  let totalCollection = 0;
  let cash = 0;
  let card = 0;
  let upi = 0;
  let bankTransfer = 0;
  let cheque = 0;

  const emptyMethods = () => ({
    total: 0,
    cash: 0,
    card: 0,
    upi: 0,
    bankTransfer: 0,
    cheque: 0,
    insurance: 0,
    other: 0,
  });
  const bySource = {
    online: emptyMethods(),
    frontdesk: emptyMethods(),
    unknown: emptyMethods(),
  };

  const addToBucket = (
    bucket: ReturnType<typeof emptyMethods>,
    method: string,
    amt: number,
  ) => {
    bucket.total += amt;
    switch (method) {
      case 'cash': bucket.cash += amt; break;
      case 'credit_card':
      case 'debit_card': bucket.card += amt; break;
      case 'upi': bucket.upi += amt; break;
      case 'net_banking': bucket.bankTransfer += amt; break;
      case 'cheque': bucket.cheque += amt; break;
      case 'insurance': bucket.insurance += amt; break;
      default: bucket.other += amt; break;
    }
  };

  for (const p of payments) {
    const amt = toNumber(p.amount);
    totalCollection += amt;
    switch (p.paymentMethod) {
      case 'cash': cash += amt; break;
      case 'credit_card':
      case 'debit_card': card += amt; break;
      case 'upi': upi += amt; break;
      case 'net_banking': bankTransfer += amt; break;
      case 'cheque': cheque += amt; break;
    }

    const sourceKey: 'online' | 'frontdesk' | 'unknown' =
      p.paymentSource === 'online' ? 'online' : p.paymentSource === 'frontdesk' ? 'frontdesk' : 'unknown';
    addToBucket(bySource[sourceKey], p.paymentMethod, amt);
  }

  // Bill-level aggregation
  const billWhere: any = { tenantId };
  if (query.startDate) {
    billWhere.createdAt = { ...billWhere.createdAt, gte: new Date(query.startDate) };
  }
  if (query.endDate) {
    billWhere.createdAt = { ...billWhere.createdAt, lte: new Date(query.endDate) };
  }

  const bills = await prisma.bill.findMany({
    where: { ...billWhere, status: { not: 'draft' } },
    select: { totalAmount: true, amountPaid: true, balanceDue: true },
  });

  const totalBill = bills.reduce((s, b) => s + toNumber(b.totalAmount), 0);
  const totalPaid = bills.reduce((s, b) => s + toNumber(b.amountPaid), 0);
  const totalCredit = bills.reduce((s, b) => s + toNumber(b.balanceDue), 0);

  return {
    totalCollection,
    cash,
    card,
    upi,
    bankTransfer,
    cheque,
    totalBill,
    totalPaid,
    totalCredit,
    netAdvanceAdjusted: 0,
    bySource,
  };
}

// --- Credit Settlements ---

export async function getCreditSettlements(
  tenantId: string,
  query: { type?: string; status?: string; page?: number; limit?: number },
) {
  const { skip, take, page, limit } = getPaginationParams(query as any);

  // Aggregate unpaid bills grouped by insurance claims or self-pay
  const unpaidBills = await prisma.bill.findMany({
    where: {
      tenantId,
      balanceDue: { gt: 0 },
      status: { in: ['pending', 'partially_paid'] },
    },
    include: {
      insuranceClaims: {
        include: {
          policy: {
            include: {
              insurer: { select: { id: true, name: true } },
            },
          },
        },
        take: 1,
      },
    },
  });

  // Group by provider
  const grouped: Record<string, {
    providerType: string;
    providerName: string;
    totalAdmissions: number;
    claimAmount: number;
    receivedAmount: number;
    outstandingAmount: number;
  }> = {};

  for (const bill of unpaidBills) {
    const claim = bill.insuranceClaims?.[0];
    const provider = claim?.policy?.insurer?.name || 'Self-Pay Patient';
    const providerType = claim ? 'insurance' : 'patient';

    if (!grouped[provider]) {
      grouped[provider] = {
        providerType,
        providerName: provider,
        totalAdmissions: 0,
        claimAmount: 0,
        receivedAmount: 0,
        outstandingAmount: 0,
      };
    }

    grouped[provider].totalAdmissions += 1;
    grouped[provider].claimAmount += toNumber(bill.totalAmount);
    grouped[provider].receivedAmount += toNumber(bill.amountPaid);
    grouped[provider].outstandingAmount += toNumber(bill.balanceDue);
  }

  let settlements = Object.entries(grouped).map(([key, val]) => ({
    id: key,
    ...val,
    tenantId,
    createdAt: formatDateTimeIST(new Date()),
    updatedAt: formatDateTimeIST(new Date()),
  }));

  if (query.type) {
    settlements = settlements.filter((s) => s.providerType === query.type);
  }

  const total = settlements.length;
  const paginated = settlements.slice(skip, skip + take);

  return { settlements: paginated, total, page, limit };
}

export async function settleCredit(
  tenantId: string,
  providerId: string,
  data: { amount: number; method?: string; notes?: string },
) {
  // Find all unpaid bills
  const bills = await prisma.bill.findMany({
    where: {
      tenantId,
      balanceDue: { gt: 0 },
      status: { in: ['pending', 'partially_paid'] },
    },
    orderBy: { createdAt: 'asc' },
  });

  let remaining = data.amount;

  for (const bill of bills) {
    if (remaining <= 0) break;
    const balance = toNumber(bill.balanceDue);
    const payAmount = Math.min(remaining, balance);

    const receiptNumber = await generateReceiptNumber(tenantId);

    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          tenantId,
          billId: bill.id,
          patientId: bill.patientId,
          amount: payAmount,
          paymentMethod: mapPaymentMethod(data.method || 'bank_transfer') as any,
          notes: data.notes || `Credit settlement for ${providerId}`,
          status: 'completed',
          paymentDate: new Date(),
        },
      });

      await tx.receipt.create({
        data: {
          tenantId,
          receiptNumber,
          paymentId: payment.id,
          receiptDate: new Date(),
          amount: payAmount,
        },
      });

      const newPaid = toNumber(bill.amountPaid) + payAmount;
      const newBalance = toNumber(bill.totalAmount) - newPaid;

      await tx.bill.update({
        where: { id: bill.id },
        data: {
          amountPaid: newPaid,
          balanceDue: Math.max(0, newBalance),
          status: newBalance <= 0 ? 'paid' : 'partially_paid',
        },
      });
    });

    remaining -= payAmount;
  }

  return {
    settledAmount: data.amount - remaining,
    provider: providerId,
  };
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
        paymentSource: 'frontdesk',
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

// --- Patient Charges (auto-pull from clinical sources) ---

export type ChargeSource =
  | 'consultation'
  | 'lab'
  | 'pharmacy'
  | 'imaging'
  | 'room'
  | 'all';

interface ChargeRow {
  source: 'consultation' | 'lab' | 'pharmacy' | 'imaging' | 'room';
  referenceType: string;
  referenceId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  taxRate: number;
  category: string;
  occurredAt: string;
  status: string;
  alreadyBilled: boolean;
  billItemId?: string;
  billId?: string;
}

const CHARGE_TAX_RATES: Record<string, number> = {
  consultation: 0,
  lab: 0,
  pharmacy: 12,
  imaging: 0,
  room: 0,
};

/**
 * Lookup of bill_items already created against a (referenceType, referenceId)
 * tuple for this patient. Used to mark auto-pulled charges so the UI can
 * grey them out (and so we don't double-bill).
 */
async function indexBilledReferences(tenantId: string, patientId: string) {
  const items = await prisma.billItem.findMany({
    where: {
      bill: { tenantId, patientId, status: { not: 'cancelled' } },
      referenceType: { not: null },
      referenceId: { not: null },
    },
    select: {
      id: true,
      billId: true,
      referenceType: true,
      referenceId: true,
    },
  });
  const map = new Map<string, { billItemId: string; billId: string }>();
  for (const it of items) {
    if (it.referenceType && it.referenceId) {
      map.set(`${it.referenceType}:${it.referenceId}`, {
        billItemId: it.id,
        billId: it.billId,
      });
    }
  }
  return map;
}

async function getConsultationCharges(
  tenantId: string,
  patientId: string,
  billedIndex: Map<string, { billItemId: string; billId: string }>,
): Promise<ChargeRow[]> {
  const visits = await prisma.visit.findMany({
    where: { tenantId, patientId },
    include: {
      doctor: {
        select: {
          consultationFee: true,
          user: { select: { firstName: true, lastName: true } },
          specialization: true,
        },
      },
      appointment: { select: { id: true, appointmentDate: true } },
    },
    orderBy: { visitDate: 'desc' },
    take: 50,
  });

  return visits
    .filter((v) => v.visitType === 'op' || v.visitType === 'ip')
    .map((v) => {
      const fee = toNumber(v.doctor?.consultationFee ?? 0);
      const doctorName = v.doctor?.user
        ? `Dr. ${v.doctor.user.firstName} ${v.doctor.user.lastName}`
        : 'Doctor';
      const billed = billedIndex.get(`visit:${v.id}`);
      return {
        source: 'consultation' as const,
        referenceType: 'visit',
        referenceId: v.id,
        description: `Consultation — ${doctorName} (${formatDateTimeIST(v.visitDate)})`,
        quantity: 1,
        unitPrice: fee,
        totalAmount: fee,
        taxRate: CHARGE_TAX_RATES.consultation,
        category: 'consultation',
        occurredAt: formatDateTimeIST(v.visitDate),
        status: v.status,
        alreadyBilled: !!billed,
        billItemId: billed?.billItemId,
        billId: billed?.billId,
      };
    })
    .filter((r) => r.unitPrice > 0 || !r.alreadyBilled);
}

async function getLabCharges(
  tenantId: string,
  patientId: string,
  billedIndex: Map<string, { billItemId: string; billId: string }>,
): Promise<ChargeRow[]> {
  const orders = await prisma.labOrder.findMany({
    where: {
      tenantId,
      patientId,
      status: { notIn: ['cancelled'] as any },
    },
    include: {
      labOrderItems: {
        include: {
          test: { select: { id: true, testName: true, testCode: true, price: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  const rows: ChargeRow[] = [];
  for (const order of orders) {
    for (const item of order.labOrderItems) {
      if (!item.test) continue;
      const price = toNumber(item.test.price);
      const billed = billedIndex.get(`lab_order_item:${item.id}`);
      rows.push({
        source: 'lab',
        referenceType: 'lab_order_item',
        referenceId: item.id,
        description: `Lab: ${item.test.testName}${item.test.testCode ? ` (${item.test.testCode})` : ''}`,
        quantity: 1,
        unitPrice: price,
        totalAmount: price,
        taxRate: CHARGE_TAX_RATES.lab,
        category: 'lab',
        occurredAt: formatDateTimeIST(order.createdAt),
        status: item.status,
        alreadyBilled: !!billed,
        billItemId: billed?.billItemId,
        billId: billed?.billId,
      });
    }
  }
  return rows;
}

async function getPharmacyCharges(
  tenantId: string,
  patientId: string,
  billedIndex: Map<string, { billItemId: string; billId: string }>,
): Promise<ChargeRow[]> {
  const records = await prisma.dispensingRecord.findMany({
    where: { tenantId, patientId },
    include: {
      drugBatch: {
        select: {
          batchNumber: true,
          sellingPrice: true,
          purchasePrice: true,
          drug: { select: { drugName: true, price: true } },
        },
      },
    },
    orderBy: { dispensedAt: 'desc' },
    take: 200,
  });

  return records.map((r) => {
    const unit =
      toNumber((r.drugBatch as any)?.sellingPrice) ||
      toNumber((r.drugBatch as any)?.drug?.price) ||
      toNumber((r.drugBatch as any)?.purchasePrice);
    const total = unit * r.quantityDispensed;
    const drugName = (r.drugBatch as any)?.drug?.drugName ?? 'Medication';
    const batchTag = (r.drugBatch as any)?.batchNumber ? ` (Batch ${(r.drugBatch as any).batchNumber})` : '';
    const billed = billedIndex.get(`dispensing_record:${r.id}`);
    return {
      source: 'pharmacy' as const,
      referenceType: 'dispensing_record',
      referenceId: r.id,
      description: `${drugName}${batchTag}`,
      quantity: r.quantityDispensed,
      unitPrice: unit,
      totalAmount: total,
      taxRate: CHARGE_TAX_RATES.pharmacy,
      category: 'pharmacy',
      occurredAt: formatDateTimeIST(r.dispensedAt),
      status: 'dispensed',
      alreadyBilled: !!billed,
      billItemId: billed?.billItemId,
      billId: billed?.billId,
    };
  });
}

async function getImagingCharges(
  tenantId: string,
  patientId: string,
  billedIndex: Map<string, { billItemId: string; billId: string }>,
): Promise<ChargeRow[]> {
  const requests = await prisma.imagingRequest.findMany({
    where: { tenantId, patientId, status: { not: 'cancelled' as any } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  // Pricing for imaging: lookup tariff by category=radiology and try to match
  // by imagingType. Fallback to a configurable baseline.
  const tariffs = await prisma.serviceTariff.findMany({
    where: { tenantId, category: 'radiology', isActive: true },
    select: { id: true, serviceName: true, serviceCode: true, basePrice: true, gstRatePercent: true },
  });

  const tariffByCode = new Map<string, (typeof tariffs)[number]>();
  for (const t of tariffs) {
    if (t.serviceCode) tariffByCode.set(t.serviceCode.toLowerCase(), t);
    tariffByCode.set(t.serviceName.toLowerCase(), t);
  }

  return requests.map((req) => {
    const typeLabel = `${req.imagingType}${req.bodyPart ? ` — ${req.bodyPart}` : ''}`;
    const tariff =
      tariffByCode.get(req.imagingType.toLowerCase()) ||
      tariffByCode.get(typeLabel.toLowerCase());
    const price = toNumber(tariff?.basePrice ?? 0);
    const taxRate = toNumber(tariff?.gstRatePercent ?? 0);
    const billed = billedIndex.get(`imaging_request:${req.id}`);
    return {
      source: 'imaging' as const,
      referenceType: 'imaging_request',
      referenceId: req.id,
      description: `Imaging: ${typeLabel}`,
      quantity: 1,
      unitPrice: price,
      totalAmount: price,
      taxRate,
      category: 'radiology',
      occurredAt: formatDateTimeIST(req.createdAt),
      status: req.status,
      alreadyBilled: !!billed,
      billItemId: billed?.billItemId,
      billId: billed?.billId,
    };
  });
}

async function getRoomCharges(
  tenantId: string,
  patientId: string,
  billedIndex: Map<string, { billItemId: string; billId: string }>,
): Promise<ChargeRow[]> {
  const admissions = await prisma.admission.findMany({
    where: { tenantId, patientId },
    include: {
      bed: { select: { bedNumber: true, bedType: true } },
      ward: { select: { name: true } },
    },
    orderBy: { admissionDate: 'desc' },
    take: 20,
  });

  // Per-day room rate from ServiceTariff (category=room). Match by bedType
  // as serviceCode (e.g. "general", "icu", "private") — fallback to first
  // active room tariff.
  const roomTariffs = await prisma.serviceTariff.findMany({
    where: { tenantId, category: 'room', isActive: true },
  });

  return admissions.map((adm) => {
    const start = new Date(adm.admissionDate);
    const end = adm.dischargeDate ? new Date(adm.dischargeDate) : new Date();
    const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));

    const bedType = adm.bed?.bedType ?? null;
    const tariff =
      roomTariffs.find((t) => (t.serviceCode ?? '').toLowerCase() === String(bedType ?? '').toLowerCase()) ||
      roomTariffs[0];

    const unit = toNumber(tariff?.basePrice ?? 0);
    const total = unit * days;
    const wardName = adm.ward?.name ?? 'Ward';
    const bedNumber = adm.bed?.bedNumber ?? '-';
    const billed = billedIndex.get(`admission:${adm.id}`);
    return {
      source: 'room' as const,
      referenceType: 'admission',
      referenceId: adm.id,
      description: `Room (${wardName} / Bed ${bedNumber}) — ${days} day${days === 1 ? '' : 's'}`,
      quantity: days,
      unitPrice: unit,
      totalAmount: total,
      taxRate: CHARGE_TAX_RATES.room,
      category: 'room',
      occurredAt: formatDateTimeIST(adm.admissionDate),
      status: adm.status,
      alreadyBilled: !!billed,
      billItemId: billed?.billItemId,
      billId: billed?.billId,
    };
  });
}

/**
 * Unified "what hasn't been billed yet" feed for a patient. Front-desk uses
 * this on the Billing tab to auto-pull line items across modules into a
 * single bill, and to flag charges that are already on a bill.
 */
export async function getPatientCharges(
  tenantId: string,
  query: { patientId: string; source?: ChargeSource; includeBilled?: boolean },
) {
  const patient = await prisma.patient.findFirst({
    where: { id: query.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const source = query.source ?? 'all';
  const billedIndex = await indexBilledReferences(tenantId, query.patientId);

  let rows: ChargeRow[] = [];
  if (source === 'consultation' || source === 'all') {
    rows = rows.concat(await getConsultationCharges(tenantId, query.patientId, billedIndex));
  }
  if (source === 'lab' || source === 'all') {
    rows = rows.concat(await getLabCharges(tenantId, query.patientId, billedIndex));
  }
  if (source === 'pharmacy' || source === 'all') {
    rows = rows.concat(await getPharmacyCharges(tenantId, query.patientId, billedIndex));
  }
  if (source === 'imaging' || source === 'all') {
    rows = rows.concat(await getImagingCharges(tenantId, query.patientId, billedIndex));
  }
  if (source === 'room' || source === 'all') {
    rows = rows.concat(await getRoomCharges(tenantId, query.patientId, billedIndex));
  }

  if (!query.includeBilled) {
    rows = rows.filter((r) => !r.alreadyBilled);
  }

  // Totals by source for the auto-pull UI summary strip.
  const summary = {
    consultation: 0,
    lab: 0,
    pharmacy: 0,
    imaging: 0,
    room: 0,
    grandTotal: 0,
    count: rows.length,
  };
  for (const r of rows) {
    summary[r.source] += r.totalAmount;
    summary.grandTotal += r.totalAmount;
  }

  return { charges: rows, summary };
}

/**
 * Bulk-add unbilled charges to a bill (creates one BillItem per row with
 * referenceType/referenceId set so future pulls won't duplicate). Used by
 * the "Auto-Pull Selected" button on the Billing tab.
 */
export async function pullChargesToBill(
  tenantId: string,
  billId: string,
  charges: Array<{
    referenceType: string;
    referenceId: string;
    description: string;
    quantity: number;
    unitPrice: number;
    taxRate?: number;
    category?: string;
  }>,
) {
  const bill = await prisma.bill.findFirst({ where: { id: billId, tenantId } });
  if (!bill) throw AppError.notFound('Bill not found');
  if (bill.status !== 'draft') {
    throw AppError.badRequest('Can only auto-pull into draft bills');
  }

  const created: any[] = [];
  await prisma.$transaction(async (tx) => {
    for (const c of charges) {
      // Idempotency: skip if a bill item with the same reference already
      // exists on this bill.
      const exists = await tx.billItem.findFirst({
        where: { billId, referenceType: c.referenceType, referenceId: c.referenceId },
      });
      if (exists) continue;

      const taxPercent = c.taxRate ?? 0;
      const subtotal = c.quantity * c.unitPrice;
      const taxAmount = subtotal * (taxPercent / 100);
      const totalAmount = subtotal + taxAmount;
      const item = await tx.billItem.create({
        data: {
          billId,
          description: c.description,
          category: (c.category as any) ?? 'other',
          quantity: c.quantity,
          unitPrice: c.unitPrice,
          discountAmount: 0,
          discountPercent: 0,
          taxPercent,
          taxAmount,
          totalAmount,
          referenceType: c.referenceType,
          referenceId: c.referenceId,
          isAutoPulled: true,
        },
      });
      created.push(item);
    }
  });

  await recalculateBillTotals(billId);
  logger.info({ tenantId, billId, count: created.length }, 'Charges auto-pulled to bill');
  return { added: created.length, billId };
}

// --- Bill-level discount (single value, editable) ---

export async function setBillDiscount(
  tenantId: string,
  billId: string,
  data: {
    discountType: 'percentage' | 'fixed';
    discountValue: number;
    reason?: string;
    approvedBy?: string;
  },
) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
    include: { billItems: true },
  });
  if (!bill) throw AppError.notFound('Bill not found');
  if (bill.status !== 'draft' && bill.status !== 'pending' && bill.status !== 'partially_paid') {
    throw AppError.badRequest('Discount can only be applied to draft, pending or partially-paid bills');
  }

  const subtotal = bill.billItems.reduce(
    (sum, it) => sum + it.quantity * toNumber(it.unitPrice),
    0,
  );
  const itemDiscounts = bill.billItems.reduce(
    (sum, it) => sum + toNumber(it.discountAmount),
    0,
  );
  const itemTax = bill.billItems.reduce(
    (sum, it) => sum + toNumber(it.taxAmount),
    0,
  );

  let billDiscountAmt = 0;
  if (data.discountType === 'percentage') {
    if (data.discountValue < 0 || data.discountValue > 100) {
      throw AppError.badRequest('Percentage discount must be between 0 and 100');
    }
    billDiscountAmt = (subtotal - itemDiscounts) * (data.discountValue / 100);
  } else {
    if (data.discountValue < 0) throw AppError.badRequest('Discount cannot be negative');
    billDiscountAmt = Math.min(data.discountValue, subtotal - itemDiscounts);
  }

  const totalDiscount = itemDiscounts + billDiscountAmt;
  const totalAmount = Math.max(0, subtotal - totalDiscount + itemTax);

  // Remove any prior bill-level discount rows (keep an audit row).
  await prisma.discount.deleteMany({ where: { billId } });
  if (data.discountValue > 0) {
    await prisma.discount.create({
      data: {
        tenantId,
        billId,
        discountType: data.discountType as any,
        value: billDiscountAmt,
        reason: data.reason,
        approvedBy: data.approvedBy,
      },
    });
  }

  const amountPaid = toNumber(bill.amountPaid);
  const updated = await prisma.bill.update({
    where: { id: billId },
    data: {
      subtotal,
      taxAmount: itemTax,
      discountAmount: totalDiscount,
      totalAmount,
      balanceDue: Math.max(0, totalAmount - amountPaid),
      status:
        bill.status === 'draft'
          ? 'draft'
          : amountPaid >= totalAmount && totalAmount > 0
            ? 'paid'
            : amountPaid > 0
              ? 'partially_paid'
              : 'pending',
    },
  });

  logger.info({ tenantId, billId, billDiscountAmt }, 'Bill-level discount applied');
  return updated;
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
