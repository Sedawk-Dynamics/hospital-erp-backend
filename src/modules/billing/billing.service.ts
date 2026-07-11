import { Prisma } from '@prisma/client';
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
 * Best-effort map an imaging modality/service name to the ImagingType enum so
 * radiology admins can add a modality by name (e.g. "MRI", "PET-CT") without
 * picking an enum. Falls back to 'other' for anything unrecognized.
 */
function deriveImagingModality(name: string): string {
  const n = (name || '').toLowerCase();
  if (/\becg\b|electrocardiogram/.test(n)) return 'ecg';
  if (/\becho\b|echocardiogram|2d ?echo/.test(n)) return 'echo';
  if (/\bmri\b|magnetic resonance/.test(n)) return 'mri';
  if (/\bct\b|cat scan|computed tomograph/.test(n)) return 'ct_scan';
  if (/x-?ray|radiograph/.test(n)) return 'xray';
  if (/ultrasound|\busg\b|sonograph|doppler/.test(n)) return 'ultrasound';
  return 'other';
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
 *
 * `db` lets callers pass the active transaction client. This MATTERS for split
 * payments: multiple receipts are created inside one $transaction, so the number
 * generator must read the transaction's own uncommitted rows — reading the
 * global (committed) state would hand every split the same number and violate
 * the `Receipt.receiptNumber` unique constraint on the 2nd split.
 */
async function generateReceiptNumber(
  tenantId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<string> {
  const dateStr = getISTDateStr();

  const prefix = `RCP-${dateStr}-`;

  const latestReceipt = await db.receipt.findFirst({
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

  const existing = await db.receipt.findFirst({
    where: { tenantId, receiptNumber },
  });

  if (existing) {
    return generateReceiptNumber(tenantId, db);
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

/**
 * Aggregates open A/R into three buckets:
 *   • insurance — bill has an InsuranceClaim; group by Insurer.name.
 *   • corporate — bill's claim links to a TpaProvider; group by TPA.name.
 *     (We treat TPA as the corporate counterparty since the schema has no
 *     dedicated Corporate table.)
 *   • patient — no claim; one row per patient with outstanding self-pay.
 */
export async function getCreditSettlements(
  tenantId: string,
  query: {
    type?: 'insurance' | 'corporate' | 'patient';
    status?: string;
    page?: number;
    limit?: number;
    search?: string;
  },
) {
  const { skip, take, page, limit } = getPaginationParams(query as any);

  const unpaidBills = await prisma.bill.findMany({
    where: {
      tenantId,
      balanceDue: { gt: 0 },
      status: { in: ['pending', 'partially_paid'] },
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true, phone: true } },
      insuranceClaims: {
        include: {
          policy: {
            include: {
              insurer: { select: { id: true, name: true } },
              tpa: { select: { id: true, name: true } },
            },
          },
        },
        take: 1,
      },
    },
  });

  type Row = {
    id: string;
    providerType: 'insurance' | 'corporate' | 'patient';
    providerName: string;
    providerContact?: string;
    totalAdmissions: number;
    claimAmount: number;
    receivedAmount: number;
    outstandingAmount: number;
    oldestBillDate?: Date;
  };
  const grouped: Record<string, Row> = {};

  const addToGroup = (key: string, row: Omit<Row, 'totalAdmissions' | 'claimAmount' | 'receivedAmount' | 'outstandingAmount'> & { bill: typeof unpaidBills[number] }) => {
    if (!grouped[key]) {
      grouped[key] = {
        id: row.id,
        providerType: row.providerType,
        providerName: row.providerName,
        providerContact: row.providerContact,
        totalAdmissions: 0,
        claimAmount: 0,
        receivedAmount: 0,
        outstandingAmount: 0,
        oldestBillDate: row.bill.createdAt,
      };
    }
    grouped[key].totalAdmissions += 1;
    grouped[key].claimAmount += toNumber(row.bill.totalAmount);
    grouped[key].receivedAmount += toNumber(row.bill.amountPaid);
    grouped[key].outstandingAmount += toNumber(row.bill.balanceDue);
    if (row.bill.createdAt < (grouped[key].oldestBillDate ?? new Date())) {
      grouped[key].oldestBillDate = row.bill.createdAt;
    }
  };

  for (const bill of unpaidBills) {
    const claim = bill.insuranceClaims?.[0];
    if (claim?.policy?.tpa) {
      // Corporate via TPA
      const tpa = claim.policy.tpa;
      addToGroup(`tpa:${tpa.id}`, {
        id: `tpa:${tpa.id}`,
        providerType: 'corporate',
        providerName: tpa.name,
        bill,
      });
    } else if (claim?.policy?.insurer) {
      const ins = claim.policy.insurer;
      addToGroup(`ins:${ins.id}`, {
        id: `ins:${ins.id}`,
        providerType: 'insurance',
        providerName: ins.name,
        bill,
      });
    } else {
      const p = bill.patient;
      const name = p ? `${p.firstName} ${p.lastName}` : 'Patient';
      addToGroup(`pat:${bill.patientId}`, {
        id: `pat:${bill.patientId}`,
        providerType: 'patient',
        providerName: name,
        providerContact: p?.phone ?? undefined,
        bill,
      });
    }
  }

  let settlements = Object.values(grouped).map((r) => {
    const ageDays = r.oldestBillDate
      ? Math.floor((Date.now() - r.oldestBillDate.getTime()) / (1000 * 60 * 60 * 24))
      : 0;
    return {
      ...r,
      ageDays,
      tenantId,
      createdAt: formatDateTimeIST(r.oldestBillDate ?? new Date()),
      updatedAt: formatDateTimeIST(new Date()),
    };
  });

  if (query.type) settlements = settlements.filter((s) => s.providerType === query.type);
  if (query.search) {
    const q = query.search.toLowerCase();
    settlements = settlements.filter((s) => s.providerName.toLowerCase().includes(q));
  }

  settlements.sort((a, b) => b.outstandingAmount - a.outstandingAmount);

  const total = settlements.length;
  const paginated = settlements.slice(skip, skip + take);

  const stats = {
    totalProviders: total,
    totalClaim: settlements.reduce((s, r) => s + r.claimAmount, 0),
    totalReceived: settlements.reduce((s, r) => s + r.receivedAmount, 0),
    totalOutstanding: settlements.reduce((s, r) => s + r.outstandingAmount, 0),
  };

  return { settlements: paginated, total, page, limit, stats };
}

/**
 * Bills behind a single provider/patient bucket — used by the credit
 * settlement drill-down so the cashier can pick which invoices to clear.
 */
export async function getCreditSettlementBills(
  tenantId: string,
  providerId: string,
) {
  // providerId format: ins:<id> | tpa:<id> | pat:<id>
  const [kind, id] = providerId.split(':');
  if (!id) throw AppError.badRequest('Invalid provider key');

  let where: any = {
    tenantId,
    balanceDue: { gt: 0 },
    status: { in: ['pending', 'partially_paid'] },
  };

  if (kind === 'ins') {
    where = { ...where, insuranceClaims: { some: { policy: { insurerId: id } } } };
  } else if (kind === 'tpa') {
    where = { ...where, insuranceClaims: { some: { policy: { tpaId: id } } } };
  } else if (kind === 'pat') {
    where = { ...where, patientId: id, insuranceClaims: { none: {} } };
  } else {
    throw AppError.badRequest('Unknown provider kind');
  }

  const bills = await prisma.bill.findMany({
    where,
    include: {
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true, phone: true } },
      insuranceClaims: {
        take: 1,
        include: { policy: { include: { insurer: true, tpa: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return bills.map((b) => ({
    id: b.id,
    billNumber: b.billNumber,
    patient: b.patient,
    totalAmount: toNumber(b.totalAmount),
    amountPaid: toNumber(b.amountPaid),
    balanceDue: toNumber(b.balanceDue),
    createdAt: b.createdAt,
    ageDays: Math.floor((Date.now() - b.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
    insurer: b.insuranceClaims[0]?.policy?.insurer?.name ?? null,
    tpa: b.insuranceClaims[0]?.policy?.tpa?.name ?? null,
  }));
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
      modality:
        (data as any).modality ??
        (mapToServiceTariffCategory(data.category) === 'radiology'
          ? deriveImagingModality(data.name)
          : null),
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
  if ((data as any).modality !== undefined) {
    updateData.modality = (data as any).modality;
  } else if (data.name !== undefined && existing.category === ('radiology' as any)) {
    // Re-derive the modality when a radiology service is renamed.
    updateData.modality = deriveImagingModality(data.name) as any;
  }

  const tariff = await prisma.serviceTariff.update({
    where: { id },
    data: updateData,
  });

  logger.info({ tenantId, tariffId: id }, 'Service tariff updated');
  return tariff;
}

export async function deleteServiceTariff(tenantId: string, id: string) {
  const existing = await prisma.serviceTariff.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Service tariff not found');
  }

  // The BillItem → ServiceTariff relation is optional (onDelete: SetNull), so
  // removing a tariff keeps historical bill lines intact (they just lose the
  // catalog link). Hard-delete so it disappears from the modality catalog.
  await prisma.serviceTariff.delete({ where: { id } });

  logger.info({ tenantId, tariffId: id }, 'Service tariff deleted');
  return { id };
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
  | 'ot'
  | 'all';

interface ChargeRow {
  source: 'consultation' | 'lab' | 'pharmacy' | 'imaging' | 'room' | 'ot';
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
  ot: 0,
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

/**
 * OT (surgery) charges — completed/scheduled surgeries with a billing amount
 * set. Mirrors the other charge sources so a surgery can be pulled onto the
 * patient's bill (idempotent via referenceType 'ot_request').
 */
async function getOtCharges(
  tenantId: string,
  patientId: string,
  billedIndex: Map<string, { billItemId: string; billId: string }>,
): Promise<ChargeRow[]> {
  const requests = await prisma.otRequest.findMany({
    where: {
      tenantId,
      patientId,
      status: { notIn: ['cancelled'] as any },
      billingAmount: { gt: 0 },
    },
    include: {
      surgeon: { include: { user: { select: { firstName: true, lastName: true } } } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return requests.map((r) => {
    const amount = toNumber(r.billingAmount ?? 0);
    const sUser = r.surgeon?.user ?? r.doctor?.user;
    const surgeon = sUser ? `Dr. ${sUser.firstName} ${sUser.lastName}` : null;
    const billed = billedIndex.get(`ot_request:${r.id}`);
    return {
      source: 'ot' as const,
      referenceType: 'ot_request',
      referenceId: r.id,
      description: `Surgery — ${r.procedureName}${surgeon ? ` (${surgeon})` : ''}`,
      quantity: 1,
      unitPrice: amount,
      totalAmount: amount,
      taxRate: CHARGE_TAX_RATES.ot,
      category: 'surgery',
      occurredAt: formatDateTimeIST(r.scheduledDate ?? r.createdAt),
      status: r.status,
      alreadyBilled: !!billed,
      billItemId: billed?.billItemId,
      billId: billed?.billId,
    };
  });
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
  if (source === 'ot' || source === 'all') {
    rows = rows.concat(await getOtCharges(tenantId, query.patientId, billedIndex));
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
    ot: 0,
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
 * Push an OT surgery's charge onto a hospital bill for the patient, optionally
 * collecting full payment. Creates a dedicated, finalized surgery invoice and
 * is idempotent — if the surgery was already billed (a bill_item with
 * referenceType 'ot_request' exists on a non-cancelled bill) that bill is
 * reused instead of creating a duplicate. Keeps OtRequest.billingStatus in sync.
 */
export async function billOtRequest(
  tenantId: string,
  otRequestId: string,
  opts: { collectPayment?: boolean; paymentMethod?: string } = {},
) {
  const req = await prisma.otRequest.findFirst({
    where: { id: otRequestId, tenantId },
    include: {
      surgeon: { include: { user: { select: { firstName: true, lastName: true } } } },
      doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
    },
  });
  if (!req) throw AppError.notFound('OT request not found');
  const amount = toNumber(req.billingAmount ?? 0);
  if (amount <= 0) {
    throw AppError.badRequest('Set a billing amount on the surgery before billing it');
  }

  // Idempotency: reuse the bill if this surgery was already billed.
  const existingItem = await prisma.billItem.findFirst({
    where: {
      referenceType: 'ot_request',
      referenceId: otRequestId,
      bill: { tenantId, status: { not: 'cancelled' } },
    },
    select: { billId: true },
  });

  let billId: string;
  if (existingItem) {
    billId = existingItem.billId;
  } else {
    const sUser = req.surgeon?.user ?? req.doctor?.user;
    const surgeon = sUser ? `Dr. ${sUser.firstName} ${sUser.lastName}` : null;
    const bill = await createBill(tenantId, { patientId: req.patientId, visitId: req.visitId ?? undefined });
    await pullChargesToBill(tenantId, bill.id, [
      {
        referenceType: 'ot_request',
        referenceId: otRequestId,
        description: `Surgery — ${req.procedureName}${surgeon ? ` (${surgeon})` : ''}`,
        quantity: 1,
        unitPrice: amount,
        taxRate: CHARGE_TAX_RATES.ot,
        category: 'surgery',
      },
    ]);
    await finalizeBill(tenantId, bill.id);
    billId = bill.id;
  }

  // Optionally collect full payment of the outstanding balance.
  let paid = false;
  const billBefore = await prisma.bill.findUnique({ where: { id: billId } });
  if (opts.collectPayment && billBefore && billBefore.status !== 'paid' && billBefore.status !== 'draft') {
    const due = toNumber(billBefore.balanceDue);
    if (due > 0) {
      await createPayment(tenantId, {
        billId,
        amount: due,
        paymentMethod: (opts.paymentMethod ?? 'cash') as any,
      });
      paid = true;
    }
  }

  const finalBill = await prisma.bill.findUnique({ where: { id: billId } });
  const billingStatus =
    finalBill?.status === 'paid'
      ? 'paid'
      : finalBill?.status === 'partially_paid'
        ? 'partially_paid'
        : 'pending';
  await prisma.otRequest.update({ where: { id: otRequestId }, data: { billingStatus } });

  logger.info({ tenantId, otRequestId, billId, paid }, 'OT surgery pushed to bill');
  return {
    billId,
    billNumber: finalBill?.billNumber ?? null,
    billStatus: finalBill?.status ?? null,
    totalAmount: toNumber(finalBill?.totalAmount ?? amount),
    amountPaid: toNumber(finalBill?.amountPaid ?? 0),
    balanceDue: toNumber(finalBill?.balanceDue ?? 0),
    paid,
  };
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

/**
 * G5 (2.1) — Discharge final-bill assembly. On discharge, pull every charge that
 * is not yet on any bill (room/bed, consultation, lab, imaging, OT, pharmacy) onto
 * a fresh admission-scoped "final charges" bill and finalize it, then optionally
 * apply the patient's advance balance. Pharmacy/indent charges already billed on
 * the running IP bill are NOT duplicated (getPatientCharges only surfaces unbilled
 * references). Returns an admission-wide financial summary (deposit is surfaced,
 * not auto-moved — its settlement stays the biller's explicit step).
 */
export async function assembleDischargeBill(
  tenantId: string,
  userId: string,
  admissionId: string,
  opts: { applyAdvance?: boolean } = {},
) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    select: { id: true, patientId: true, depositAmount: true },
  });
  if (!admission) throw AppError.notFound('Admission not found');
  const patientId = admission.patientId;

  // 1. Discover charges not yet on any bill and pull them onto a fresh draft.
  const { charges } = await getPatientCharges(tenantId, { patientId });
  let finalBillId: string | null = null;
  if (charges.length > 0) {
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const prefix = `FIN-${ymd}-`;
    const seq = await prisma.bill.count({ where: { tenantId, billNumber: { startsWith: prefix } } });
    const draft = await prisma.bill.create({
      data: {
        tenantId,
        billNumber: `${prefix}${String(seq + 1).padStart(4, '0')}`,
        patientId,
        admissionId,
        billDate: new Date(),
        status: 'draft',
        generatedBy: userId,
      },
    });
    await pullChargesToBill(
      tenantId,
      draft.id,
      charges.map((c) => ({
        referenceType: c.referenceType,
        referenceId: c.referenceId,
        description: c.description,
        quantity: c.quantity,
        unitPrice: c.unitPrice,
        taxRate: c.taxRate,
        category: c.category,
      })),
    );
    const withItems = await prisma.billItem.count({ where: { billId: draft.id } });
    if (withItems > 0) {
      await finalizeBill(tenantId, draft.id);
      finalBillId = draft.id;
    } else {
      await prisma.bill.delete({ where: { id: draft.id } });
    }
  }

  // 2. Optionally apply the patient's advance balance to the finalized bill.
  let advanceApplied = 0;
  if (opts.applyAdvance && finalBillId) {
    const adv = await getPatientAdvanceBalance(tenantId, patientId);
    const fb = await prisma.bill.findFirst({ where: { id: finalBillId, tenantId }, select: { balanceDue: true } });
    const toApply = r2(Math.min(Number(adv.balance ?? 0), Number(fb?.balanceDue ?? 0)));
    if (toApply > 0) {
      await adjustAdvanceToBill(tenantId, userId, { patientId, billId: finalBillId, amount: toApply });
      advanceApplied = toApply;
    }
  }

  // 3. Admission-wide financial summary across all non-cancelled bills.
  const bills = await prisma.bill.findMany({
    where: { tenantId, admissionId, status: { not: 'cancelled' } },
    select: { id: true, billNumber: true, status: true, totalAmount: true, amountPaid: true, balanceDue: true },
  });
  const totalBilled = r2(bills.reduce((s, b) => s + Number(b.totalAmount), 0));
  const totalPaid = r2(bills.reduce((s, b) => s + Number(b.amountPaid), 0));
  const totalBalanceDue = r2(bills.reduce((s, b) => s + Number(b.balanceDue), 0));
  const deposit = Number(admission.depositAmount ?? 0);

  logger.info({ tenantId, admissionId, finalBillId, totalBilled, totalBalanceDue }, 'Discharge bill assembled');
  return {
    admissionId,
    patientId,
    finalBillId,
    bills,
    totalBilled,
    totalPaid,
    totalBalanceDue,
    depositAmount: deposit,
    advanceApplied,
    // Informational net after the deposit is settled by the biller.
    netAfterDeposit: r2(Math.max(0, totalBalanceDue - deposit)),
    refundDue: r2(Math.max(0, deposit - totalBalanceDue)),
  };
}

// ============================================================
// IP running ledger (nurse/doctor-addable charges + live view)
// ============================================================

/**
 * The single running IP bill for an admission — the ledger everything posts to.
 * Prefers an open DRAFT bill scoped to the admission (so new lines can be added),
 * else the patient's open draft (backfilling admissionId), else opens a fresh IPW-
 * draft. Stays draft for the whole stay; finalized at discharge.
 */
export async function getOrCreateRunningIpBill(tenantId: string, admissionId: string, userId: string) {
  const admission = await prisma.admission.findFirst({ where: { id: admissionId, tenantId }, select: { id: true, patientId: true } });
  if (!admission) throw AppError.notFound('Admission not found');

  let bill = await prisma.bill.findFirst({ where: { tenantId, admissionId, status: 'draft' }, orderBy: { createdAt: 'desc' } });
  if (!bill) {
    const patientDraft = await prisma.bill.findFirst({ where: { tenantId, patientId: admission.patientId, status: 'draft' }, orderBy: { createdAt: 'desc' } });
    if (patientDraft) {
      bill = patientDraft.admissionId ? patientDraft : await prisma.bill.update({ where: { id: patientDraft.id }, data: { admissionId } });
    }
  }
  if (!bill) {
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const prefix = `IPW-${ymd}-`;
    const seq = await prisma.bill.count({ where: { tenantId, billNumber: { startsWith: prefix } } });
    bill = await prisma.bill.create({
      data: { tenantId, billNumber: `${prefix}${String(seq + 1).padStart(4, '0')}`, patientId: admission.patientId, admissionId, billDate: new Date(), status: 'draft', generatedBy: userId },
    });
  }
  return bill;
}

const IP_CHARGE_CATEGORIES = new Set(['consultation', 'surgery', 'room', 'lab', 'radiology', 'pharmacy', 'procedure', 'consumable', 'other']);

// Billing / hospital-admin roles that get full access to any IP ledger.
const IP_LEDGER_FULL_ROLES = new Set(['super_admin', 'admin', 'billing_admin', 'front_desk', 'cashier']);

/**
 * Access to an admission's IP ledger is relationship-scoped:
 *  - full: billing / hospital-admin roles (super_admin, admin, billing_admin, …);
 *  - read + post charge: the admission's OWN doctor and the actively-assigned nurse;
 *  - read only: the patient (their own ledger);
 *  - everyone else: denied.
 */
async function assertIpLedgerAccess(
  tenantId: string,
  admissionId: string,
  actor: { userId: string; roles: string[] },
  opts: { write: boolean },
) {
  if ((actor.roles ?? []).some((r) => IP_LEDGER_FULL_ROLES.has(r))) return;

  const admission = await prisma.admission.findFirst({ where: { id: admissionId, tenantId }, select: { doctorId: true, patientId: true } });
  if (!admission) throw AppError.notFound('Admission not found');

  // The admission's own doctor (Admission.doctorId is a DoctorProfile.id).
  if (admission.doctorId) {
    const dp = await prisma.doctorProfile.findFirst({ where: { userId: actor.userId, tenantId }, select: { id: true } });
    if (dp && dp.id === admission.doctorId) return;
  }
  // The actively-assigned nurse for this admission.
  const nurse = await prisma.nurseAssignment.findFirst({ where: { tenantId, admissionId, status: 'active', nurseId: actor.userId }, select: { id: true } });
  if (nurse) return;
  // The patient — read only (their own ledger).
  if (!opts.write) {
    const patient = await prisma.patient.findFirst({ where: { id: admission.patientId, tenantId }, select: { userId: true } });
    if (patient?.userId && patient.userId === actor.userId) return;
  }
  throw AppError.forbidden('You do not have access to this IP patient\'s ledger.');
}

/**
 * A clinician (doctor / nurse) posts a charge onto the admission's running IP
 * ledger — a doctor visit / professional fee, a nursing procedure, a consumable,
 * bed extras, etc. Resolves/opens the running draft bill and appends a
 * categorised line (tagged manual_clinical so it never collides with auto-pull).
 */
export async function addIpCharge(
  tenantId: string,
  userId: string,
  admissionId: string,
  data: { category: string; description: string; quantity?: number; unitPrice: number; taxRate?: number; serviceTariffId?: string; notes?: string },
  roles: string[] = [],
) {
  await assertIpLedgerAccess(tenantId, admissionId, { userId, roles }, { write: true });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const category = IP_CHARGE_CATEGORIES.has(data.category) ? data.category : 'other';
  const bill = await getOrCreateRunningIpBill(tenantId, admissionId, userId);
  const qty = Math.max(1, Math.trunc(data.quantity ?? 1));
  const unitPrice = r2(Math.max(0, data.unitPrice));
  const taxPercent = Math.max(0, data.taxRate ?? 0);
  const subtotal = r2(unitPrice * qty);
  const taxAmount = r2(subtotal * (taxPercent / 100));
  const totalAmount = r2(subtotal + taxAmount);

  const item = await prisma.billItem.create({
    data: {
      billId: bill.id,
      serviceTariffId: data.serviceTariffId ?? null,
      description: data.description.trim(),
      category: category as any,
      quantity: qty,
      unitPrice,
      taxPercent,
      taxAmount,
      totalAmount,
      referenceType: 'manual_clinical',
      referenceId: `${userId}:${Date.now()}`,
      isAutoPulled: false,
    },
  });
  await recalculateBillTotals(bill.id);
  logger.info({ tenantId, admissionId, billId: bill.id, category, totalAmount }, 'IP clinical charge added to ledger');
  return { billId: bill.id, item };
}

/**
 * Admission-scoped running ledger for the IP workspace: every posted BillItem
 * across the admission's bills PLUS the still-unbilled auto-charges (room days,
 * doctor fee, lab, imaging, OT) so the care team sees the true running total,
 * grouped by category, with deposit and the reimbursable / patient split.
 */
export async function getAdmissionLedger(tenantId: string, admissionId: string, actor: { userId: string; roles: string[] }) {
  await assertIpLedgerAccess(tenantId, admissionId, actor, { write: false });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    select: { id: true, patientId: true, depositAmount: true, billingCategory: true, admissionDate: true },
  });
  if (!admission) throw AppError.notFound('Admission not found');

  const bills = await prisma.bill.findMany({
    where: { tenantId, admissionId, status: { not: 'cancelled' } },
    orderBy: { createdAt: 'asc' },
    include: { billItems: { orderBy: { createdAt: 'asc' } } },
  });

  const posted = bills.flatMap((b) =>
    b.billItems.map((it) => ({
      id: it.id, billId: b.id, billNumber: b.billNumber,
      description: it.description, category: String(it.category),
      quantity: it.quantity, unitPrice: Number(it.unitPrice), totalAmount: Number(it.totalAmount),
      isReimbursable: it.isReimbursable, isAutoPulled: it.isAutoPulled,
      status: 'posted' as const, at: it.createdAt.toISOString(),
    })),
  );

  // Pending auto-charges not yet on any bill (room days, doctor fee, lab, imaging, OT).
  let pending: typeof posted = [];
  try {
    const { charges } = await getPatientCharges(tenantId, { patientId: admission.patientId });
    pending = charges.map((c) => ({
      id: `${c.referenceType}:${c.referenceId}`, billId: null as any, billNumber: null as any,
      description: c.description, category: String(c.category),
      quantity: c.quantity, unitPrice: c.unitPrice, totalAmount: c.totalAmount,
      isReimbursable: null as any, isAutoPulled: true,
      status: 'pending' as any, at: c.occurredAt,
    }));
  } catch { /* patient missing → no pending */ }

  const lines = [...posted, ...pending].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const byCat = new Map<string, { posted: number; pending: number }>();
  for (const l of lines) {
    const cur = byCat.get(l.category) ?? { posted: 0, pending: 0 };
    if (l.status === 'posted') cur.posted = r2(cur.posted + l.totalAmount); else cur.pending = r2(cur.pending + l.totalAmount);
    byCat.set(l.category, cur);
  }
  const categoryTotals = [...byCat.entries()].map(([category, v]) => ({ category, posted: v.posted, pending: v.pending, total: r2(v.posted + v.pending) }));

  const totalPosted = r2(posted.reduce((s, l) => s + l.totalAmount, 0));
  const totalPending = r2(pending.reduce((s, l) => s + l.totalAmount, 0));
  const paid = r2(bills.reduce((s, b) => s + Number(b.amountPaid), 0));
  const deposit = Number(admission.depositAmount ?? 0);
  const grandTotal = r2(totalPosted + totalPending);
  const reimbursable = r2(posted.filter((l) => l.isReimbursable === true).reduce((s, l) => s + l.totalAmount, 0));
  const nonReimbursable = r2(posted.filter((l) => l.isReimbursable === false).reduce((s, l) => s + l.totalAmount, 0));

  return {
    admissionId,
    patientId: admission.patientId,
    billingCategory: (admission.billingCategory ?? 'cash').toLowerCase(),
    lines,
    categoryTotals,
    bills: bills.map((b) => ({ id: b.id, billNumber: b.billNumber, status: b.status, totalAmount: Number(b.totalAmount), amountPaid: Number(b.amountPaid), balanceDue: Number(b.balanceDue) })),
    totals: {
      posted: totalPosted,
      pending: totalPending,
      grandTotal,
      paid,
      deposit,
      balanceAfterDeposit: r2(Math.max(0, grandTotal - paid - deposit)),
      reimbursable,
      nonReimbursable,
    },
  };
}

/**
 * A doctor records a visit / review round on the admission. This is BOTH a
 * ledger event (a consultation charge — the visit fee, which may be 0 for a
 * no-charge review) AND a timeline entry: the review/situation note is kept in
 * the line description and the item is tagged `doctor_visit` so the activity log
 * renders it as a visit rather than a generic charge.
 */
export async function recordDoctorVisit(
  tenantId: string,
  userId: string,
  admissionId: string,
  data: { review?: string; fee?: number },
  roles: string[] = [],
) {
  await assertIpLedgerAccess(tenantId, admissionId, { userId, roles }, { write: true });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const bill = await getOrCreateRunningIpBill(tenantId, admissionId, userId);
  const review = (data.review ?? '').trim();
  const fee = r2(Math.max(0, data.fee ?? 0));

  const item = await prisma.billItem.create({
    data: {
      billId: bill.id,
      description: review ? `Doctor visit — ${review}` : 'Doctor visit',
      category: 'consultation' as any,
      quantity: 1,
      unitPrice: fee,
      taxPercent: 0,
      taxAmount: 0,
      totalAmount: fee,
      referenceType: 'doctor_visit',
      referenceId: `${userId}:${Date.now()}`,
      isAutoPulled: false,
    },
  });
  await recalculateBillTotals(bill.id);
  logger.info({ tenantId, admissionId, billId: bill.id, fee }, 'IP doctor visit recorded');
  return { billId: bill.id, item };
}

/**
 * A detailed chronological log of everything that happens on an admission —
 * from admit to discharge — for the same care team that can see the ledger.
 * Aggregates admission/discharge, nurse assignments, doctor visits, ledger
 * charges, lab orders, imaging requests and prescriptions into one timeline.
 */
export async function getAdmissionActivity(tenantId: string, admissionId: string, actor: { userId: string; roles: string[] }) {
  await assertIpLedgerAccess(tenantId, admissionId, actor, { write: false });

  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    select: {
      id: true, patientId: true, admissionDate: true, dischargeDate: true, status: true,
      doctor: { select: { user: { select: { firstName: true, lastName: true } } } },
      ward: { select: { name: true } },
      bed: { select: { bedNumber: true } },
    },
  });
  if (!admission) throw AppError.notFound('Admission not found');

  const start = admission.admissionDate;
  const end = admission.dischargeDate ?? new Date();
  const patientWindow = { patientId: admission.patientId, tenantId, createdAt: { gte: start, lte: end } };

  type Event = { at: string; type: string; title: string; detail?: string; actor?: string; amount?: number; status?: string };
  const events: Event[] = [];

  // --- Admission ---
  const doc = admission.doctor?.user;
  const where = [admission.ward?.name && `Ward ${admission.ward.name}`, admission.bed?.bedNumber && `Bed ${admission.bed.bedNumber}`].filter(Boolean).join(', ');
  events.push({
    at: admission.admissionDate.toISOString(), type: 'admission', title: 'Patient admitted',
    detail: where || undefined,
    actor: doc ? `Dr. ${doc.firstName} ${doc.lastName}`.trim() : undefined,
  });

  // --- Nurse assignments ---
  const assignments = await prisma.nurseAssignment.findMany({
    where: { tenantId, admissionId },
    select: { assignedAt: true, shiftType: true, status: true, nurse: { select: { firstName: true, lastName: true } } },
    orderBy: { assignedAt: 'asc' },
  });
  for (const a of assignments) {
    events.push({
      at: a.assignedAt.toISOString(), type: 'nurse_assignment',
      title: `Nurse assigned${a.status !== 'active' ? ' (ended)' : ''}`,
      detail: `${a.shiftType} shift`,
      actor: `${a.nurse.firstName} ${a.nurse.lastName}`.trim(),
    });
  }

  // --- Ledger charges + doctor visits (from the admission's bills) ---
  const bills = await prisma.bill.findMany({
    where: { tenantId, admissionId, status: { not: 'cancelled' } },
    select: { billItems: { select: { description: true, category: true, totalAmount: true, referenceType: true, referenceId: true, createdAt: true } } },
  });
  const items = bills.flatMap((b) => b.billItems);
  const visitorIds = [...new Set(items.filter((it) => it.referenceType === 'doctor_visit').map((it) => it.referenceId?.split(':')[0]).filter(Boolean) as string[])];
  const visitors = visitorIds.length
    ? await prisma.user.findMany({ where: { id: { in: visitorIds } }, select: { id: true, firstName: true, lastName: true } })
    : [];
  const visitorName = new Map(visitors.map((u) => [u.id, `Dr. ${u.firstName} ${u.lastName}`.trim()]));
  for (const it of items) {
    if (it.referenceType === 'doctor_visit') {
      events.push({
        at: it.createdAt.toISOString(), type: 'doctor_visit', title: 'Doctor visit',
        detail: it.description.replace(/^Doctor visit\s*—\s*/, '') || undefined,
        actor: visitorName.get(it.referenceId?.split(':')[0] ?? '') || undefined,
        amount: Number(it.totalAmount) || undefined,
      });
    } else if (it.referenceType === 'manual_clinical') {
      events.push({
        at: it.createdAt.toISOString(), type: 'charge', title: 'Charge added',
        detail: `${it.description} (${String(it.category)})`,
        amount: Number(it.totalAmount),
      });
    }
  }

  // --- Lab orders ---
  const labs = await prisma.labOrder.findMany({
    where: patientWindow,
    select: { id: true, status: true, createdAt: true, labOrderItems: { select: { test: { select: { testName: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  for (const l of labs) {
    const names = l.labOrderItems.map((i) => i.test?.testName).filter(Boolean) as string[];
    events.push({
      at: l.createdAt.toISOString(), type: 'lab_order', title: 'Lab ordered',
      detail: names.length ? names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4} more` : '') : undefined,
      status: String(l.status),
    });
  }

  // --- Imaging requests ---
  const imaging = await prisma.imagingRequest.findMany({
    where: patientWindow,
    select: { imagingType: true, bodyPart: true, status: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const im of imaging) {
    events.push({
      at: im.createdAt.toISOString(), type: 'imaging_request', title: 'Imaging requested',
      detail: [String(im.imagingType), im.bodyPart].filter(Boolean).join(' — '),
      status: String(im.status),
    });
  }

  // --- Prescriptions ---
  const scripts = await prisma.prescription.findMany({
    where: patientWindow,
    select: { prescriptionType: true, status: true, createdAt: true, _count: { select: { prescriptionItems: true } } },
    orderBy: { createdAt: 'asc' },
  });
  for (const s of scripts) {
    events.push({
      at: s.createdAt.toISOString(), type: 'prescription', title: 'Prescription written',
      detail: `${s._count.prescriptionItems} medicine${s._count.prescriptionItems === 1 ? '' : 's'} (${String(s.prescriptionType)})`,
      status: String(s.status),
    });
  }

  // --- Discharge ---
  if (admission.dischargeDate) {
    events.push({ at: admission.dischargeDate.toISOString(), type: 'discharge', title: 'Patient discharged' });
  }

  events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return { admissionId, status: admission.status, discharged: !!admission.dischargeDate, events };
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

// --- Split Payment (multiple modes against one bill) ---

export async function createSplitPayment(
  tenantId: string,
  userId: string,
  data: {
    billId: string;
    splits: Array<{
      amount: number;
      paymentMethod: string;
      referenceNumber?: string;
      notes?: string;
    }>;
  },
) {
  const bill = await prisma.bill.findFirst({
    where: { id: data.billId, tenantId },
  });
  if (!bill) throw AppError.notFound('Bill not found');
  if (bill.status === 'draft') {
    throw AppError.badRequest('Cannot pay a draft bill — finalize first');
  }
  if (bill.status === 'paid') {
    throw AppError.badRequest('Bill is already fully paid');
  }
  if (bill.status === 'cancelled') {
    throw AppError.badRequest('Cannot pay a cancelled bill');
  }

  const totalSplit = data.splits.reduce((s, x) => s + x.amount, 0);
  const balanceDue = toNumber(bill.balanceDue);
  if (totalSplit <= 0) throw AppError.badRequest('Split total must be > 0');
  if (totalSplit > balanceDue) {
    throw AppError.badRequest(
      `Split total (${totalSplit}) exceeds balance due (${balanceDue})`,
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const payments = [] as { id: string; receiptId: string; amount: number; method: string }[];
    for (const split of data.splits) {
      // Pass `tx` so each split's number reflects the ones created earlier in
      // THIS transaction (otherwise every split collides on the same number).
      const receiptNumber = await generateReceiptNumber(tenantId, tx);
      const payment = await tx.payment.create({
        data: {
          tenantId,
          billId: data.billId,
          patientId: bill.patientId,
          amount: split.amount,
          paymentMethod: mapPaymentMethod(split.paymentMethod) as any,
          paymentSource: 'frontdesk',
          paymentType: 'regular',
          transactionId: split.referenceNumber,
          notes: split.notes,
          status: 'completed',
          paymentDate: new Date(),
          processedBy: userId,
        },
      });
      const receipt = await tx.receipt.create({
        data: {
          tenantId,
          receiptNumber,
          paymentId: payment.id,
          receiptDate: new Date(),
          amount: split.amount,
        },
      });
      payments.push({ id: payment.id, receiptId: receipt.id, amount: split.amount, method: split.paymentMethod });
    }

    const newPaid = toNumber(bill.amountPaid) + totalSplit;
    const total = toNumber(bill.totalAmount);
    const newBalance = total - newPaid;
    await tx.bill.update({
      where: { id: data.billId },
      data: {
        amountPaid: newPaid,
        balanceDue: Math.max(0, newBalance),
        status: newBalance <= 0 ? 'paid' : 'partially_paid',
      },
    });

    return { payments, totalCollected: totalSplit, newBalance: Math.max(0, newBalance) };
  });

  logger.info({ tenantId, billId: data.billId, totalCollected: totalSplit }, 'Split payment recorded');
  return result;
}

// --- Advance Payment + Running Balance ---

/**
 * Advance: collect money from a patient *before* a bill exists. Stored as a
 * Payment row with paymentType='advance' against a sentinel "advance" bill
 * per-tenant so we can use the existing Bill/Receipt machinery for audit.
 *
 * The running balance is "advances minus advances-already-adjusted" — we
 * don't materialize that as a column on the patient; we compute it on the
 * fly from the Payment ledger.
 */
async function ensureAdvanceBucketBill(
  tx: typeof prisma,
  tenantId: string,
  patientId: string,
) {
  let bucket = await tx.bill.findFirst({
    where: {
      tenantId,
      patientId,
      billNumber: { startsWith: 'ADV-' },
    },
  });
  if (!bucket) {
    const billNumber = `ADV-${patientId.slice(0, 8)}-${Date.now()}`;
    bucket = await tx.bill.create({
      data: {
        tenantId,
        billNumber,
        patientId,
        billDate: new Date(),
        status: 'pending',
        subtotal: 0,
        totalAmount: 0,
        balanceDue: 0,
        amountPaid: 0,
      },
    });
  }
  return bucket;
}

export async function createAdvancePayment(
  tenantId: string,
  userId: string,
  data: {
    patientId: string;
    amount: number;
    paymentMethod: string;
    referenceNumber?: string;
    notes?: string;
  },
) {
  if (data.amount <= 0) throw AppError.badRequest('Amount must be > 0');
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) throw AppError.notFound('Patient not found');

  const receiptNumber = await generateReceiptNumber(tenantId);

  const result = await prisma.$transaction(async (tx) => {
    const bucket = await ensureAdvanceBucketBill(tx as any, tenantId, data.patientId);
    const payment = await tx.payment.create({
      data: {
        tenantId,
        billId: bucket.id,
        patientId: data.patientId,
        amount: data.amount,
        paymentMethod: mapPaymentMethod(data.paymentMethod) as any,
        paymentSource: 'frontdesk',
        paymentType: 'advance',
        transactionId: data.referenceNumber,
        notes: data.notes ?? 'Advance payment',
        status: 'completed',
        paymentDate: new Date(),
        processedBy: userId,
      },
    });
    const receipt = await tx.receipt.create({
      data: {
        tenantId,
        receiptNumber,
        paymentId: payment.id,
        receiptDate: new Date(),
        amount: data.amount,
      },
    });

    // Lift the bucket totals so subsequent advance reads can compute the
    // running balance from the same row.
    await tx.bill.update({
      where: { id: bucket.id },
      data: {
        totalAmount: toNumber(bucket.totalAmount) + data.amount,
        amountPaid: toNumber(bucket.amountPaid) + data.amount,
      },
    });

    return { paymentId: payment.id, receiptId: receipt.id, receiptNumber };
  });

  logger.info({ tenantId, patientId: data.patientId, amount: data.amount }, 'Advance payment recorded');
  return result;
}

/**
 * Adjust an advance against a specific bill — moves money from the advance
 * bucket to the target bill. Used by the cashier when collecting a new bill
 * and the patient already has advance on file.
 */
export async function adjustAdvanceToBill(
  tenantId: string,
  userId: string,
  data: { patientId: string; billId: string; amount: number },
) {
  if (data.amount <= 0) throw AppError.badRequest('Amount must be > 0');
  const bill = await prisma.bill.findFirst({
    where: { id: data.billId, tenantId, patientId: data.patientId },
  });
  if (!bill) throw AppError.notFound('Bill not found');
  if (bill.status === 'draft' || bill.status === 'cancelled' || bill.status === 'paid') {
    throw AppError.badRequest(`Bill cannot accept payment (status: ${bill.status})`);
  }

  const advance = await getPatientAdvanceBalance(tenantId, data.patientId);
  if (data.amount > advance.balance) {
    throw AppError.badRequest(`Advance balance is ${advance.balance}, cannot adjust ${data.amount}`);
  }

  const result = await prisma.$transaction(async (tx) => {
    // Mark a "regular" payment on the bill, source=advance via notes, and
    // contra-entry on the advance bucket as a refund row so the running
    // balance falls correctly.
    const receiptNumber = await generateReceiptNumber(tenantId);
    const payment = await tx.payment.create({
      data: {
        tenantId,
        billId: data.billId,
        patientId: data.patientId,
        amount: data.amount,
        paymentMethod: 'other',
        paymentSource: 'frontdesk',
        paymentType: 'regular',
        notes: 'Adjusted from advance',
        status: 'completed',
        paymentDate: new Date(),
        processedBy: userId,
      },
    });
    await tx.receipt.create({
      data: {
        tenantId,
        receiptNumber,
        paymentId: payment.id,
        receiptDate: new Date(),
        amount: data.amount,
      },
    });

    // Lift bill totals
    const newPaid = toNumber(bill.amountPaid) + data.amount;
    const newBalance = toNumber(bill.totalAmount) - newPaid;
    await tx.bill.update({
      where: { id: data.billId },
      data: {
        amountPaid: newPaid,
        balanceDue: Math.max(0, newBalance),
        status: newBalance <= 0 ? 'paid' : 'partially_paid',
      },
    });

    // Reduce advance bucket
    const bucket = await tx.bill.findFirst({
      where: { tenantId, patientId: data.patientId, billNumber: { startsWith: 'ADV-' } },
    });
    if (bucket) {
      await tx.bill.update({
        where: { id: bucket.id },
        data: {
          amountPaid: Math.max(0, toNumber(bucket.amountPaid) - data.amount),
          totalAmount: Math.max(0, toNumber(bucket.totalAmount) - data.amount),
        },
      });
    }

    return { paymentId: payment.id, receiptNumber, newBalance: Math.max(0, newBalance) };
  });

  logger.info({ tenantId, patientId: data.patientId, billId: data.billId, amount: data.amount }, 'Advance adjusted to bill');
  return result;
}

export async function getPatientAdvanceBalance(tenantId: string, patientId: string) {
  const advances = await prisma.payment.findMany({
    where: {
      tenantId,
      patientId,
      paymentType: 'advance' as any,
      status: 'completed',
    },
  });
  const collected = advances.reduce((s, p) => s + toNumber(p.amount), 0);

  // Money already adjusted from the advance bucket onto real bills
  const bucket = await prisma.bill.findFirst({
    where: { tenantId, patientId, billNumber: { startsWith: 'ADV-' } },
  });
  const remaining = bucket ? toNumber(bucket.amountPaid) : 0;

  return {
    totalAdvanceCollected: collected,
    totalAdvanceAdjusted: collected - remaining,
    balance: remaining,
    history: advances.map((p) => ({
      id: p.id,
      amount: toNumber(p.amount),
      method: p.paymentMethod,
      paymentDate: p.paymentDate,
      notes: p.notes,
    })),
  };
}

// --- Payment Reversal ---

export async function reversePayment(
  tenantId: string,
  userId: string,
  data: { paymentId: string; reason: string },
) {
  const payment = await prisma.payment.findFirst({
    where: { id: data.paymentId, tenantId },
    include: { bill: true, receipt: true },
  });
  if (!payment) throw AppError.notFound('Payment not found');
  if (payment.status === 'reversed') {
    throw AppError.badRequest('Payment already reversed');
  }
  if (payment.status !== 'completed') {
    throw AppError.badRequest('Only completed payments can be reversed');
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: data.paymentId },
      data: {
        status: 'reversed',
        notes: payment.notes
          ? `${payment.notes}\n[REVERSED ${new Date().toISOString()} by ${userId}: ${data.reason}]`
          : `[REVERSED by ${userId}: ${data.reason}]`,
      },
    });

    // Adjust bill totals back
    if (payment.bill) {
      const newPaid = Math.max(0, toNumber(payment.bill.amountPaid) - toNumber(payment.amount));
      const total = toNumber(payment.bill.totalAmount);
      const newBalance = total - newPaid;
      let newStatus = payment.bill.status as string;
      if (newPaid <= 0) newStatus = 'pending';
      else if (newBalance > 0) newStatus = 'partially_paid';

      await tx.bill.update({
        where: { id: payment.bill.id },
        data: {
          amountPaid: newPaid,
          balanceDue: Math.max(0, newBalance),
          status: newStatus as any,
        },
      });
    }

    return { reversed: true, paymentId: payment.id };
  });

  logger.info({ tenantId, paymentId: data.paymentId, by: userId }, 'Payment reversed');
  return result;
}

// --- Bill Cancellation ---

export async function cancelBill(
  tenantId: string,
  userId: string,
  billId: string,
  data: { reason: string },
) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
    include: { payments: { where: { status: 'completed' } } },
  });
  if (!bill) throw AppError.notFound('Bill not found');
  if (bill.status === 'cancelled') {
    throw AppError.badRequest('Bill already cancelled');
  }
  if (bill.status === 'refunded') {
    throw AppError.badRequest('Bill already refunded');
  }

  // If there are completed payments, the caller must refund them first.
  const completedPayments = bill.payments.length;
  if (completedPayments > 0) {
    throw AppError.badRequest(
      `Bill has ${completedPayments} completed payment(s) — refund or reverse them first`,
    );
  }

  const receiptNumber = await generateReceiptNumber(tenantId);

  const result = await prisma.$transaction(async (tx) => {
    const cancelled = await tx.bill.update({
      where: { id: billId },
      data: {
        status: 'cancelled',
        cancelledBy: userId,
        cancellationReason: data.reason,
      },
    });

    // Cancellation receipt — zero amount, just an audit row tied to the bill
    // via a sentinel payment so downstream receipt listings can show it.
    const auditPayment = await tx.payment.create({
      data: {
        tenantId,
        billId,
        patientId: bill.patientId,
        amount: 0,
        paymentMethod: 'other',
        paymentSource: 'frontdesk',
        paymentType: 'regular',
        status: 'reversed',
        paymentDate: new Date(),
        processedBy: userId,
        notes: `Bill cancellation receipt — ${data.reason}`,
      },
    });
    await tx.receipt.create({
      data: {
        tenantId,
        receiptNumber,
        paymentId: auditPayment.id,
        receiptDate: new Date(),
        amount: 0,
      },
    });

    return { cancelled: true, billId: cancelled.id, cancellationReceiptNumber: receiptNumber };
  });

  logger.info({ tenantId, billId, by: userId }, 'Bill cancelled');
  return result;
}

// --- Refund Reject + List + One ---

export async function rejectRefund(
  tenantId: string,
  refundId: string,
  rejectedBy: string,
  reason: string,
) {
  const refund = await prisma.refund.findFirst({
    where: { id: refundId, tenantId, status: 'requested' },
  });
  if (!refund) throw AppError.notFound('Refund not found or not in pending status');

  const updated = await prisma.refund.update({
    where: { id: refundId },
    data: {
      status: 'rejected',
      approvedBy: rejectedBy,
      processedAt: new Date(),
      reason: `${refund.reason}\n[REJECTED by ${rejectedBy}: ${reason}]`,
    },
  });
  logger.info({ tenantId, refundId, by: rejectedBy }, 'Refund rejected');
  return updated;
}

export async function getRefunds(
  tenantId: string,
  query: { status?: string; patientId?: string; billId?: string; page?: number; limit?: number },
) {
  const { skip, take, page, limit } = getPaginationParams(query as any);
  const where: any = { tenantId };
  if (query.status) where.status = query.status;
  if (query.patientId) where.patientId = query.patientId;
  if (query.billId) where.billId = query.billId;

  const [refunds, total] = await Promise.all([
    prisma.refund.findMany({
      where,
      skip,
      take,
      include: {
        bill: { select: { id: true, billNumber: true, totalAmount: true } },
        patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
        payment: { select: { id: true, paymentMethod: true, paymentDate: true } },
        requester: { select: { id: true, firstName: true, lastName: true } },
        approver: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.refund.count({ where }),
  ]);

  return { refunds, total, page, limit };
}

// --- Receipts (list + by-id for PDF) ---

export async function listReceipts(
  tenantId: string,
  query: { patientId?: string; billId?: string; fromDate?: string; toDate?: string; page?: number; limit?: number; search?: string },
) {
  const { skip, take, page, limit } = getPaginationParams(query as any);
  const where: any = { tenantId };
  if (query.fromDate) where.receiptDate = { ...where.receiptDate, gte: new Date(query.fromDate) };
  if (query.toDate) where.receiptDate = { ...where.receiptDate, lte: new Date(query.toDate) };

  // Patient/bill filters require joining via payment
  const paymentFilter: any = {};
  if (query.patientId) paymentFilter.patientId = query.patientId;
  if (query.billId) paymentFilter.billId = query.billId;
  if (Object.keys(paymentFilter).length) where.payment = paymentFilter;

  if (query.search) {
    where.OR = [
      { receiptNumber: { contains: query.search, mode: 'insensitive' } },
      { payment: { bill: { billNumber: { contains: query.search, mode: 'insensitive' } } } },
    ];
  }

  const [receipts, total] = await Promise.all([
    prisma.receipt.findMany({
      where,
      skip,
      take,
      include: {
        payment: {
          include: {
            bill: { select: { id: true, billNumber: true, totalAmount: true } },
            patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
          },
        },
      },
      orderBy: { receiptDate: 'desc' },
    }),
    prisma.receipt.count({ where }),
  ]);

  return { receipts, total, page, limit };
}

export async function getReceiptById(tenantId: string, receiptId: string) {
  const receipt = await prisma.receipt.findFirst({
    where: { id: receiptId, tenantId },
    include: {
      payment: {
        include: {
          bill: {
            include: {
              patient: { select: { id: true, firstName: true, lastName: true, mrn: true, phone: true } },
              billItems: true,
            },
          },
        },
      },
      tenant: { select: { name: true, address: true, city: true, phone: true, email: true, licenseNumber: true } },
    },
  });
  if (!receipt) throw AppError.notFound('Receipt not found');
  return receipt;
}

// --- Day-end snapshot ---

export async function getDayEndReport(tenantId: string, query: { date?: string }) {
  const dateStr = query.date ?? getISTDateStr();
  // Convert IST date to UTC bounds — keep it simple by using the day strings
  const start = new Date(`${dateStr}T00:00:00.000+05:30`);
  const end = new Date(`${dateStr}T23:59:59.999+05:30`);

  const payments = await prisma.payment.findMany({
    where: {
      tenantId,
      paymentDate: { gte: start, lte: end },
    },
    include: {
      bill: { select: { billNumber: true, patient: { select: { firstName: true, lastName: true } } } },
    },
    orderBy: { paymentDate: 'asc' },
  });

  const billsToday = await prisma.bill.findMany({
    where: { tenantId, createdAt: { gte: start, lte: end } },
    select: { id: true, status: true, totalAmount: true, amountPaid: true, balanceDue: true },
  });

  const byStatusBills = { generated: 0, paid: 0, pending: 0, cancelled: 0 };
  let billed = 0;
  for (const b of billsToday) {
    billed += toNumber(b.totalAmount);
    byStatusBills.generated += 1;
    if (b.status === 'paid') byStatusBills.paid += 1;
    else if (b.status === 'cancelled') byStatusBills.cancelled += 1;
    else byStatusBills.pending += 1;
  }

  const byMethod: Record<string, number> = {};
  const byType: Record<string, number> = { regular: 0, advance: 0, refund: 0 };
  let collected = 0;
  let reversed = 0;
  for (const p of payments) {
    const amt = toNumber(p.amount);
    if (p.status === 'completed') {
      collected += amt;
      byMethod[p.paymentMethod] = (byMethod[p.paymentMethod] ?? 0) + amt;
      byType[p.paymentType] = (byType[p.paymentType] ?? 0) + amt;
    } else if (p.status === 'reversed') {
      reversed += amt;
    }
  }

  return {
    date: dateStr,
    collected,
    reversed,
    billed,
    byMethod,
    byType,
    byStatusBills,
    payments: payments.map((p) => ({
      id: p.id,
      billNumber: p.bill?.billNumber,
      patientName: p.bill?.patient
        ? `${p.bill.patient.firstName} ${p.bill.patient.lastName}`
        : null,
      amount: toNumber(p.amount),
      method: p.paymentMethod,
      type: p.paymentType,
      status: p.status,
      paymentDate: p.paymentDate,
      transactionId: p.transactionId,
    })),
  };
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
