import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { normalizeCounterpartyGstin } from '../../shared/gst';
import { getPaginationParams } from '../../shared/pagination';
import { getISTDateStr, istDayStart, istDayEnd } from '../../shared/date.utils';
import { Prisma } from '@prisma/client';
import type {
  CreateInsurerInput,
  UpdateInsurerInput,
  CreateTPAInput,
  UpdateTPAInput,
  CreatePolicyInput,
  UpdatePolicyInput,
  CreateClaimInput,
  UpdateClaimInput,
  ApproveClaimInput,
  RejectClaimInput,
  PartialApproveClaimInput,
  SettleClaimInput,
  ResubmitClaimInput,
  CancelClaimInput,
  CreatePreAuthInput,
  UpdatePreAuthInput,
  ApprovePreAuthInput,
  RejectPreAuthInput,
  HoldPreAuthInput,
  SplitBillInput,
  CreateTpaLogInput,
} from './insurance.validation';
import { notifyPatientInsuranceMilestone } from './insurance.notifications';
import { recordSettlement as recordWorkflowSettlement } from './insurance.workflow.service';
import { computePatientPaid } from '../billing/bill-payment-ledger';
import {
  CLAIM_RECEIVABLE_STATUSES,
  CLAIM_AWAITING_DECISION_STATUSES,
  CLAIM_VOID_STATUSES,
  CLAIM_PAYER_SELECT,
  INSURANCE_METRIC_DEFINITIONS,
  PAYER_MISSING,
  claimAwaitingDecision,
  claimDeadlineWhere,
  claimOutstanding,
  computeApprovalRate,
  computeAmountApprovalRate,
  computeClaimTotals,
  groupByPayer,
  isVoidClaim,
  resolveClaimPayer,
} from './insurance.metrics';

// ============================================================
// Defaults
// ============================================================

const DEFAULT_CLAIM_EXPIRY_DAYS = 30;

function dec(value: number | string | null | undefined): Prisma.Decimal {
  if (value === null || value === undefined) return new Prisma.Decimal(0);
  return new Prisma.Decimal(value);
}

function decNum(value: Prisma.Decimal | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  return Number(value.toString());
}

export function calculateDelayLiability(decisionDueAt: Date | null, decidedAt: Date, dailyRoomRate: number) {
  const lateMinutes = decisionDueAt
    ? Math.max(0, (decidedAt.getTime() - decisionDueAt.getTime()) / 60_000)
    : 0;
  return {
    lateMinutes,
    amount: Number(((dailyRoomRate * lateMinutes) / (24 * 60)).toFixed(2)),
  };
}

// ============================================================
// Helpers
// ============================================================

async function generateClaimNumber(_tenantId: string): Promise<string> {
  // The day is the hospital's own calendar day. `new Date().getFullYear()` and
  // friends read the HOST's timezone, so a server running in UTC stamped
  // yesterday's date on every claim raised before 05:30 IST.
  const prefix = `CLM-${getISTDateStr()}-`;

  // Read the day's highest number ACROSS ALL TENANTS, because that is the scope
  // `InsuranceClaim.claimNumber`'s unique index has. Reading it per tenant
  // handed a second hospital a number a first already held and the insert
  // failed. Same bug and same fix as the receipt number and
  // `shared/bill-number.ts`; reproduced with two real tenants by
  // `npm run db:check-claim-lifecycle`.
  //
  // Ordering by the string is numeric ordering because the sequence is padded
  // to a fixed width.
  const latest = await prisma.insuranceClaim.findFirst({
    where: { claimNumber: { startsWith: prefix } },
    orderBy: { claimNumber: 'desc' },
    select: { claimNumber: true },
  });

  const lastNumber = latest?.claimNumber
    ? parseInt(latest.claimNumber.split('-').pop() || '0', 10) || 0
    : 0;

  // No re-check against the number just computed: it came from the maximum, so
  // it cannot already exist. The check that used to sit here was scoped to one
  // tenant, could therefore never fire, and would have recursed for ever if it
  // had — it recomputed the same number from the same rows.
  return `${prefix}${String(lastNumber + 1).padStart(4, '0')}`;
}

async function generatePreAuthRequestNumber(tenantId: string): Promise<string> {
  const prefix = `PA-${getISTDateStr()}-`;

  const latest = await prisma.preAuthorizationRequest.findFirst({
    where: {
      tenantId,
      requestNumber: { startsWith: prefix },
    },
    orderBy: { requestNumber: 'desc' },
    select: { requestNumber: true },
  });

  let nextNumber = 1;
  if (latest?.requestNumber) {
    const lastNumber = parseInt(latest.requestNumber.split('-').pop() || '0', 10);
    nextNumber = lastNumber + 1;
  }

  return `${prefix}${nextNumber.toString().padStart(4, '0')}`;
}

// ============================================================
// Insurers
// ============================================================

/**
 * A payer's GSTIN, checked and turned into a state code.
 *
 * Refused rather than clamped: a wrong GSTIN on an insurer means every invoice
 * raised against them is defective, and finding that out at filing time is far
 * more expensive than a rejected form field.
 */
function gstinOf(raw: string | null | undefined): { gstin: string | null; stateCode: string | null } {
  try {
    return normalizeCounterpartyGstin(raw);
  } catch (err) {
    throw AppError.badRequest((err as Error).message);
  }
}

/**
 * Name as compared for duplicates: case, spacing and punctuation ignored, so
 * "M5 Insurer A", "m5  insurer-a" and "M5 INSURER A." are the same payer.
 */
export function normalizePayerName(name: string | null | undefined): string {
  return (name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Gap 293: one hospital ended up with "M5 Insurer A" three times, splitting its
 * claims and reports across three records. Refuse a second payer with the same
 * normalised name, or the same GSTIN, within the hospital, and name the record
 * that already exists so the user can pick it (or reactivate it) instead.
 */
async function assertUniquePayer(
  kind: 'insurer' | 'tpa',
  tenantId: string,
  candidate: { name?: string | null; gstin?: string | null },
  excludeId?: string,
): Promise<void> {
  const name = candidate.name !== undefined && candidate.name !== null ? normalizePayerName(candidate.name) : null;
  const gstin = candidate.gstin ? candidate.gstin.toUpperCase() : null;
  if (!name && !gstin) return;
  const select = { id: true, name: true, gstin: true, isActive: true } as const;
  const where = { tenantId, ...(excludeId ? { id: { not: excludeId } } : {}) };
  const rows =
    kind === 'insurer'
      ? await prisma.insurer.findMany({ where, select })
      : await prisma.tpaProvider.findMany({ where, select });
  const label = kind === 'insurer' ? 'An insurer' : 'A TPA';
  for (const row of rows ?? []) {
    const inactive = row.isActive ? '' : ' (inactive — reactivate it instead)';
    if (name && normalizePayerName(row.name) === name) {
      throw AppError.conflict(
        `${label} named "${row.name}" already exists${inactive}. Use the existing record instead of adding a duplicate.`,
        'DUPLICATE_PAYER',
        { existingId: row.id, existingName: row.name, field: 'name' },
      );
    }
    if (gstin && row.gstin && row.gstin.toUpperCase() === gstin) {
      throw AppError.conflict(
        `${label} with GSTIN ${gstin} already exists: "${row.name}"${inactive}.`,
        'DUPLICATE_PAYER',
        { existingId: row.id, existingName: row.name, field: 'gstin' },
      );
    }
  }
}

export async function createInsurer(tenantId: string, data: CreateInsurerInput) {
  // A payer with a GSTIN is a REGISTERED recipient, which is what turns a
  // hospital bill into a B2B invoice — GSTR-1 Table 4 rather than the B2C
  // summary, and IGST rather than CGST+SGST when they are in another state.
  // Without this field none of that could ever happen: A-4 was structurally
  // empty and `recipientGstin` on a bill had twenty readers and no writer.
  const gst = gstinOf(data.gstin);
  await assertUniquePayer('insurer', tenantId, { name: data.name, gstin: gst.gstin });

  const insurer = await prisma.insurer.create({
    data: {
      tenantId,
      name: data.name,
      contactPerson: data.contactPerson,
      phone: data.phone,
      email: data.email,
      address: data.address,
      gstin: gst.gstin,
      stateCode: gst.stateCode,
      isActive: data.isActive ?? true,
    },
  });

  logger.info({ tenantId, insurerId: insurer.id }, 'Insurer created');
  return insurer;
}

export async function getInsurers(tenantId: string, query: any) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.isActive !== undefined) where.isActive = query.isActive;

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { contactPerson: { contains: query.search, mode: 'insensitive' } },
      { email: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [insurers, total] = await Promise.all([
    prisma.insurer.findMany({
      where,
      skip,
      take,
      orderBy: { name: 'asc' },
    }),
    prisma.insurer.count({ where }),
  ]);

  return { insurers, total, page, limit };
}

export async function getInsurerById(tenantId: string, id: string) {
  const insurer = await prisma.insurer.findFirst({
    where: { id, tenantId },
    include: {
      insurancePolicies: {
        take: 10,
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!insurer) {
    throw AppError.notFound('Insurer not found');
  }

  return insurer;
}

export async function updateInsurer(tenantId: string, id: string, data: UpdateInsurerInput) {
  const existing = await prisma.insurer.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Insurer not found');
  }

  await assertUniquePayer(
    'insurer',
    tenantId,
    { name: data.name, gstin: data.gstin !== undefined ? gstinOf(data.gstin).gstin : undefined },
    id,
  );

  const insurer = await prisma.insurer.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.contactPerson !== undefined && { contactPerson: data.contactPerson }),
      ...(data.phone !== undefined && { phone: data.phone }),
      ...(data.email !== undefined && { email: data.email }),
      ...(data.address !== undefined && { address: data.address }),
      // The state always comes out of the GSTIN, so they move together or not
      // at all.
      ...(data.gstin !== undefined && gstinOf(data.gstin)),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    },
  });

  logger.info({ tenantId, insurerId: id }, 'Insurer updated');
  return insurer;
}

export async function deleteInsurer(tenantId: string, id: string) {
  const existing = await prisma.insurer.findFirst({
    where: { id, tenantId },
    include: { insurancePolicies: { take: 1 } },
  });

  if (!existing) {
    throw AppError.notFound('Insurer not found');
  }

  if (existing.insurancePolicies.length > 0) {
    throw AppError.badRequest('Cannot delete insurer with associated policies. Deactivate instead.');
  }

  await prisma.insurer.delete({ where: { id } });

  logger.info({ tenantId, insurerId: id }, 'Insurer deleted');
}

// ============================================================
// TPA Providers
// ============================================================

export async function createTPA(tenantId: string, data: CreateTPAInput) {
  // Same reasoning as an insurer: a TPA with a GSTIN is a registered recipient,
  // and one registered in another state is the case that makes IGST real.
  const gst = gstinOf(data.gstin);
  await assertUniquePayer('tpa', tenantId, { name: data.name, gstin: gst.gstin });
  const tpa = await prisma.tpaProvider.create({
    data: {
      tenantId,
      name: data.name,
      contactPerson: data.contactPerson,
      phone: data.phone,
      email: data.email,
      address: data.address,
      gstin: gst.gstin,
      stateCode: gst.stateCode,
      isActive: data.isActive ?? true,
    },
  });

  logger.info({ tenantId, tpaId: tpa.id }, 'TPA provider created');
  return tpa;
}

export async function getTPAs(tenantId: string, query: any) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.isActive !== undefined) where.isActive = query.isActive;

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { contactPerson: { contains: query.search, mode: 'insensitive' } },
      { email: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [tpas, total] = await Promise.all([
    prisma.tpaProvider.findMany({
      where,
      skip,
      take,
      orderBy: { name: 'asc' },
    }),
    prisma.tpaProvider.count({ where }),
  ]);

  return { tpas, total, page, limit };
}

export async function getTPAById(tenantId: string, id: string) {
  const tpa = await prisma.tpaProvider.findFirst({
    where: { id, tenantId },
    include: {
      insurancePolicies: {
        take: 10,
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!tpa) {
    throw AppError.notFound('TPA provider not found');
  }

  return tpa;
}

export async function updateTPA(tenantId: string, id: string, data: UpdateTPAInput) {
  const existing = await prisma.tpaProvider.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('TPA provider not found');
  }

  await assertUniquePayer(
    'tpa',
    tenantId,
    { name: data.name, gstin: data.gstin !== undefined ? gstinOf(data.gstin).gstin : undefined },
    id,
  );

  const tpa = await prisma.tpaProvider.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.contactPerson !== undefined && { contactPerson: data.contactPerson }),
      ...(data.phone !== undefined && { phone: data.phone }),
      ...(data.email !== undefined && { email: data.email }),
      ...(data.address !== undefined && { address: data.address }),
      ...(data.gstin !== undefined && gstinOf(data.gstin)),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    },
  });

  logger.info({ tenantId, tpaId: id }, 'TPA provider updated');
  return tpa;
}

export async function deleteTPA(tenantId: string, id: string) {
  const existing = await prisma.tpaProvider.findFirst({
    where: { id, tenantId },
    include: { insurancePolicies: { take: 1 } },
  });

  if (!existing) {
    throw AppError.notFound('TPA provider not found');
  }

  if (existing.insurancePolicies.length > 0) {
    throw AppError.badRequest(
      'Cannot delete TPA provider with associated policies. Deactivate instead.',
    );
  }

  await prisma.tpaProvider.delete({ where: { id } });

  logger.info({ tenantId, tpaId: id }, 'TPA provider deleted');
}

// ============================================================
// Insurance Policies
// ============================================================

export async function createPolicy(tenantId: string, data: CreatePolicyInput) {
  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Verify insurer exists
  const insurer = await prisma.insurer.findFirst({
    where: { id: data.insurerId, tenantId },
  });
  if (!insurer) {
    throw AppError.notFound('Insurer not found');
  }

  // Verify TPA if provided
  if (data.tpaId) {
    const tpa = await prisma.tpaProvider.findFirst({
      where: { id: data.tpaId, tenantId },
    });
    if (!tpa) {
      throw AppError.notFound('TPA provider not found');
    }
  }

  const policy = await prisma.insurancePolicy.create({
    data: {
      tenantId,
      patientId: data.patientId,
      insurerId: data.insurerId,
      tpaId: data.tpaId,
      policyNumber: data.policyNumber,
      groupNumber: data.groupNumber,
      planName: data.planName,
      coverageAmount: data.coverageAmount,
      coPayPercent: data.coPayPercent ?? 0,
      deductibleAmount: data.deductibleAmount ?? 0,
      exclusions: data.exclusions,
      validFrom: new Date(data.validFrom),
      validTo: new Date(data.validTo),
      status: (data.status ?? 'active') as any,
    },
    include: {
      patient: {
        select: { id: true, firstName: true, lastName: true },
      },
      insurer: {
        select: { id: true, name: true },
      },
      tpa: {
        select: { id: true, name: true },
      },
    },
  });

  logger.info({ tenantId, policyId: policy.id }, 'Insurance policy created');
  return policy;
}

export async function getPolicies(tenantId: string, query: any) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.insurerId) where.insurerId = query.insurerId;
  if (query.status) where.status = query.status;

  if (query.search) {
    where.OR = [
      { policyNumber: { contains: query.search, mode: 'insensitive' } },
      { planName: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [policies, total] = await Promise.all([
    prisma.insurancePolicy.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, firstName: true, lastName: true },
        },
        insurer: {
          select: { id: true, name: true },
        },
        tpa: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.insurancePolicy.count({ where }),
  ]);

  return { policies, total, page, limit };
}

export async function getPolicyById(tenantId: string, id: string) {
  const policy = await prisma.insurancePolicy.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: { id: true, firstName: true, lastName: true, phone: true, email: true },
      },
      insurer: {
        select: { id: true, name: true, contactPerson: true, phone: true, email: true },
      },
      tpa: {
        select: { id: true, name: true, contactPerson: true, phone: true, email: true },
      },
      insuranceClaims: {
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
      preAuthRequests: {
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
    },
  });

  if (!policy) {
    throw AppError.notFound('Insurance policy not found');
  }

  return policy;
}

export async function updatePolicy(tenantId: string, id: string, data: UpdatePolicyInput) {
  const existing = await prisma.insurancePolicy.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Insurance policy not found');
  }

  // Verify references if changed
  if (data.patientId && data.patientId !== existing.patientId) {
    const patient = await prisma.patient.findFirst({
      where: { id: data.patientId, tenantId },
    });
    if (!patient) throw AppError.notFound('Patient not found');
  }

  if (data.insurerId && data.insurerId !== existing.insurerId) {
    const insurer = await prisma.insurer.findFirst({
      where: { id: data.insurerId, tenantId },
    });
    if (!insurer) throw AppError.notFound('Insurer not found');
  }

  if (data.tpaId && data.tpaId !== existing.tpaId) {
    const tpa = await prisma.tpaProvider.findFirst({
      where: { id: data.tpaId, tenantId },
    });
    if (!tpa) throw AppError.notFound('TPA provider not found');
  }

  const updateData: any = {};
  if (data.patientId !== undefined) updateData.patientId = data.patientId;
  if (data.insurerId !== undefined) updateData.insurerId = data.insurerId;
  if (data.tpaId !== undefined) updateData.tpaId = data.tpaId;
  if (data.policyNumber !== undefined) updateData.policyNumber = data.policyNumber;
  if (data.groupNumber !== undefined) updateData.groupNumber = data.groupNumber;
  if (data.planName !== undefined) updateData.planName = data.planName;
  if (data.coverageAmount !== undefined) updateData.coverageAmount = data.coverageAmount;
  if (data.coPayPercent !== undefined) updateData.coPayPercent = data.coPayPercent;
  if (data.deductibleAmount !== undefined) updateData.deductibleAmount = data.deductibleAmount;
  if (data.exclusions !== undefined) updateData.exclusions = data.exclusions;
  if (data.validFrom !== undefined) updateData.validFrom = new Date(data.validFrom);
  if (data.validTo !== undefined) updateData.validTo = new Date(data.validTo);
  if (data.status !== undefined) updateData.status = data.status;

  const policy = await prisma.insurancePolicy.update({
    where: { id },
    data: updateData,
    include: {
      patient: {
        select: { id: true, firstName: true, lastName: true },
      },
      insurer: {
        select: { id: true, name: true },
      },
      tpa: {
        select: { id: true, name: true },
      },
    },
  });

  logger.info({ tenantId, policyId: id }, 'Insurance policy updated');
  return policy;
}

export async function verifyPolicy(tenantId: string, id: string) {
  const policy = await prisma.insurancePolicy.findFirst({
    where: { id, tenantId },
    include: {
      insurer: { select: { id: true, name: true, isActive: true } },
    },
  });

  if (!policy) {
    throw AppError.notFound('Insurance policy not found');
  }

  const now = new Date();
  const isValid =
    policy.status === 'active' &&
    policy.validFrom <= now &&
    policy.validTo >= now &&
    policy.insurer.isActive;

  return {
    policyId: policy.id,
    policyNumber: policy.policyNumber,
    isValid,
    status: policy.status,
    validFrom: policy.validFrom,
    validTo: policy.validTo,
    insurerName: policy.insurer.name,
    insurerActive: policy.insurer.isActive,
    coverageAmount: policy.coverageAmount,
    coPayPercent: policy.coPayPercent,
    deductibleAmount: policy.deductibleAmount,
  };
}

// ============================================================
// Insurance Claims
// ============================================================

export async function createClaim(tenantId: string, userId: string, data: CreateClaimInput) {
  const insuranceCase = data.insuranceCaseId
    ? await prisma.insuranceCase.findFirst({
        where: { id: data.insuranceCaseId, tenantId, patientId: data.patientId },
        include: { policies: { orderBy: { sequence: 'asc' } } },
      })
    : null;
  if (data.insuranceCaseId && !insuranceCase) {
    throw AppError.notFound('Insurance / payer case not found for this patient');
  }

  const policyId = data.policyId ?? insuranceCase?.policies[0]?.policyId;
  const policy = policyId
    ? await prisma.insurancePolicy.findFirst({ where: { id: policyId, tenantId, patientId: data.patientId } })
    : null;
  if (policyId && !policy) throw AppError.notFound('Insurance policy not found for this patient');
  if (!policy && !insuranceCase) throw AppError.badRequest('A policy or insurance / payer case is required');
  if (insuranceCase && policyId) {
    const linked = insuranceCase.policies.some((item) => item.policyId === policyId);
    if (!linked) throw AppError.badRequest('Selected policy is not linked to this payer case');
  }

  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Verify bill exists
  const bill = await prisma.bill.findFirst({
    where: { id: data.billId, tenantId },
  });
  if (!bill) {
    throw AppError.notFound('Bill not found');
  }

  // Policy validity
  const now = new Date();
  if (policy && (policy.status !== 'active' || policy.validFrom > now || policy.validTo < now)) {
    throw AppError.badRequest('Insurance policy is not active for this date');
  }

  if (data.preAuthId) {
    const preAuth = await prisma.preAuthorizationRequest.findFirst({
      where: { id: data.preAuthId, tenantId, patientId: data.patientId },
    });
    if (!preAuth || (insuranceCase && preAuth.insuranceCaseId !== insuranceCase.id)) {
      throw AppError.badRequest('Pre-authorization is not linked to this patient and payer case');
    }
  }

  // Co-pay / deductible / covered split
  const split = computeResponsibility(
    decNum(data.claimAmount),
    decNum(policy?.coPayPercent),
    decNum(policy?.deductibleAmount),
    decNum(policy?.coverageAmount),
  );

  const claimNumber = await generateClaimNumber(tenantId);
  let expiryDays = data.expiryDays ?? DEFAULT_CLAIM_EXPIRY_DAYS;
  if (!data.expiryDays && insuranceCase) {
    const contract = await prisma.payerContract.findFirst({
      where: {
        tenantId,
        payerType: insuranceCase.paymentResponsibleType,
        payerId: insuranceCase.paymentResponsibleId,
        isActive: true,
        validFrom: { lte: now },
        validTo: { gte: now },
      },
      orderBy: { validFrom: 'desc' },
    });
    if (contract) expiryDays = contract.submissionWindowDays;
  }
  const expiryDate = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000);

  const sequence = data.sequence ?? (insuranceCase
    ? (await prisma.insuranceClaim.count({ where: { insuranceCaseId: insuranceCase.id } })) + 1
    : 1);

  const claim = await prisma.insuranceClaim.create({
    data: {
      tenantId,
      patientId: data.patientId,
      policyId,
      insuranceCaseId: insuranceCase?.id,
      preAuthId: data.preAuthId,
      billId: data.billId,
      claimNumber,
      claimAmount: data.claimAmount,
      copayAmount: split.copayAmount,
      deductibleAmount: split.deductibleAmount,
      coveredAmount: split.coveredAmount,
      patientShare: split.patientResponsibility,
      outstandingAmount: data.claimAmount,
      expiryDate,
      status: 'submitted',
      tier: data.tier,
      sequence,
      settlementMode: data.settlementMode ?? insuranceCase?.settlementMode ?? 'cashless',
      submissionChannel: data.submissionChannel,
      payerClaimReference: data.payerClaimReference,
      submissionReference: data.submissionReference,
      nhcxTransactionId: data.nhcxTransactionId,
      submissionDate: now,
      notes: data.notes,
      submittedBy: userId,
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true } },
      bill: { select: { id: true, billNumber: true, totalAmount: true } },
    },
  });

  if (insuranceCase) {
    await prisma.insuranceCase.update({ where: { id: insuranceCase.id }, data: { status: 'claimSubmitted' } });
  }
  logger.info({ tenantId, claimId: claim.id, claimNumber }, 'Insurance claim created');
  return claim;
}

// ============================================================
// Co-pay / Deductible / Coverage calc
// ============================================================

export interface ResponsibilityBreakdown {
  claimAmount: number;
  coPayPercent: number;
  deductibleAmount: number;
  coverageLimit: number;
  coveredAmount: number;
  copayAmount: number;
  patientResponsibility: number;
  // Convenience aliases used by the service writes:
  insurancePortion: number;
}

export function computeResponsibility(
  claimAmount: number,
  coPayPercent: number,
  deductibleAmount: number,
  coverageLimit: number,
): ResponsibilityBreakdown {
  const amount = Math.max(0, claimAmount);
  const ded = Math.min(Math.max(0, deductibleAmount), amount);
  const afterDed = amount - ded;
  const copay = afterDed * (Math.min(Math.max(0, coPayPercent), 100) / 100);
  let covered = afterDed - copay;
  if (coverageLimit > 0) covered = Math.min(covered, coverageLimit);
  covered = Math.max(0, covered);
  const patientResponsibility = Math.max(0, amount - covered);
  return {
    claimAmount: round2(amount),
    coPayPercent: round2(coPayPercent),
    deductibleAmount: round2(ded),
    coverageLimit: round2(coverageLimit),
    coveredAmount: round2(covered),
    copayAmount: round2(copay),
    patientResponsibility: round2(patientResponsibility),
    insurancePortion: round2(covered),
  };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export async function calcResponsibility(tenantId: string, policyId: string, billId: string) {
  const [policy, bill] = await Promise.all([
    prisma.insurancePolicy.findFirst({
      where: { id: policyId, tenantId },
      include: { insurer: { select: { id: true, name: true } } },
    }),
    prisma.bill.findFirst({
      where: { id: billId, tenantId },
      select: {
        id: true,
        billNumber: true,
        totalAmount: true,
        insuranceCoveredAmount: true,
        patientPayableAmount: true,
        amountPaid: true,
      },
    }),
  ]);

  if (!policy) throw AppError.notFound('Insurance policy not found');
  if (!bill) throw AppError.notFound('Bill not found');

  const split = computeResponsibility(
    decNum(bill.totalAmount),
    decNum(policy.coPayPercent),
    decNum(policy.deductibleAmount),
    decNum(policy.coverageAmount),
  );

  return {
    policy: {
      id: policy.id,
      policyNumber: policy.policyNumber,
      planName: policy.planName,
      insurer: policy.insurer,
      coverageAmount: decNum(policy.coverageAmount),
      coPayPercent: decNum(policy.coPayPercent),
      deductibleAmount: decNum(policy.deductibleAmount),
    },
    bill: {
      id: bill.id,
      billNumber: bill.billNumber,
      totalAmount: decNum(bill.totalAmount),
    },
    split,
  };
}

export async function getClaims(tenantId: string, query: any) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.policyId) where.policyId = query.policyId;
  if (query.insuranceCaseId) where.insuranceCaseId = query.insuranceCaseId;
  if (query.status) where.status = query.status;
  // Gap 296: the dashboard's deadline counts link here; same clause, same rows.
  // ANDed so a status filter on top narrows rather than replaces it.
  if (query.expiry === 'expired' || query.expiry === 'expiring') {
    where.AND = [claimDeadlineWhere(query.expiry, query.expiringWithinDays ?? 7)];
  } else if (query.expiringWithinDays) {
    where.AND = [claimDeadlineWhere('expiring', query.expiringWithinDays)];
  }

  // IST day bounds, end date inclusive (gap 359, Hospital Reports).
  if (query.fromDate) {
    where.submissionDate = { ...where.submissionDate, gte: istDayStart(query.fromDate) };
  }
  if (query.toDate) {
    where.submissionDate = { ...where.submissionDate, lte: istDayEnd(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { claimNumber: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [claims, total] = await Promise.all([
    prisma.insuranceClaim.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, firstName: true, lastName: true },
        },
        policy: {
          select: { id: true, policyNumber: true, insurer: { select: { id: true, name: true } } },
        },
        insuranceCase: {
          select: {
            id: true, caseNumber: true, status: true,
            insurer: { select: { id: true, name: true } },
            tpa: { select: { id: true, name: true } },
            corporatePayer: { select: { id: true, name: true } },
            governmentSchemePayer: { select: { id: true, name: true } },
          },
        },
        bill: {
          select: { id: true, billNumber: true, totalAmount: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.insuranceClaim.count({ where }),
  ]);

  return { claims: claims.map(withLiveOutstanding), total, page, limit };
}

/**
 * Gap 291: rows cancelled or superseded before cancel zeroed the column still
 * store their old outstanding (one showed ₹2,00,001). Read-time correction — a
 * void or rejected claim never owes anything, whatever the column says.
 */
function withLiveOutstanding<T extends { status: string; outstandingAmount: Prisma.Decimal | null }>(claim: T): T {
  if (isVoidClaim(claim.status) || claim.status === 'rejected') {
    return { ...claim, outstandingAmount: new Prisma.Decimal(0) };
  }
  return claim;
}

export async function getClaimById(tenantId: string, id: string) {
  const claim = await prisma.insuranceClaim.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: { id: true, firstName: true, lastName: true, phone: true, email: true },
      },
      policy: {
        select: {
          id: true,
          policyNumber: true,
          planName: true,
          coverageAmount: true,
          insurer: { select: { id: true, name: true } },
        },
      },
      insuranceCase: {
        select: {
          id: true,
          caseNumber: true,
          status: true,
          insurer: { select: { id: true, name: true } },
          tpa: { select: { id: true, name: true } },
          corporatePayer: { select: { id: true, name: true } },
          governmentSchemePayer: { select: { id: true, name: true } },
        },
      },
      preAuth: true,
      bill: {
        // The TPA desk must be able to review the source bill, not only the
        // claimed total. Keep this nested under the tenant-scoped claim so a
        // claim ID can never be used to read another hospital's bill.
        select: {
          id: true,
          billNumber: true,
          billDate: true,
          status: true,
          subtotal: true,
          discountAmount: true,
          taxAmount: true,
          totalAmount: true,
          insuranceCoveredAmount: true,
          patientPayableAmount: true,
          amountPaid: true,
          balanceDue: true,
          taxableValue: true,
          cgstAmount: true,
          sgstAmount: true,
          igstAmount: true,
          cessAmount: true,
          roundOff: true,
          gstDocumentType: true,
          invoiceNumber: true,
          billOfSupplyNumber: true,
          billItems: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              description: true,
              category: true,
              quantity: true,
              unitPrice: true,
              discountPercent: true,
              discountAmount: true,
              taxPercent: true,
              taxAmount: true,
              totalAmount: true,
              hsnSacCode: true,
              gstTreatment: true,
              taxableValue: true,
              cgstAmount: true,
              sgstAmount: true,
              igstAmount: true,
              cessAmount: true,
              isReimbursable: true,
              tpaCategory: true,
              createdAt: true,
            },
          },
          payments: {
            orderBy: { paymentDate: 'asc' },
            select: {
              id: true,
              paymentDate: true,
              amount: true,
              paymentMethod: true,
              paymentSource: true,
              paymentType: true,
              status: true,
              transactionId: true,
              notes: true,
            },
          },
        },
      },
      submitter: {
        select: { id: true, firstName: true, lastName: true },
      },
      reviewer: {
        select: { id: true, firstName: true, lastName: true },
      },
      tpaCommunicationLogs: {
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
      queries: { orderBy: { raisedAt: 'desc' } },
      settlements: { orderBy: { settlementDate: 'desc' } },
      writeOffs: { orderBy: { createdAt: 'desc' } },
      adjustments: { orderBy: { effectiveDate: 'desc' } },
      auditEvents: { orderBy: { occurredAt: 'desc' }, take: 100 },
    },
  });

  if (!claim) {
    throw AppError.notFound('Insurance claim not found');
  }

  const patientPaidAmount = claim.bill
    ? round2(Math.max(0, await computePatientPaid(prisma, claim.bill.id)))
    : 0;

  return {
    ...withLiveOutstanding(claim),
    bill: claim.bill ? { ...claim.bill, patientPaidAmount } : claim.bill,
  };
}

export async function updateClaim(tenantId: string, id: string, data: UpdateClaimInput) {
  const existing = await prisma.insuranceClaim.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Insurance claim not found');
  }

  if (existing.status !== 'submitted') {
    throw AppError.badRequest('Can only update a claim before it enters review');
  }

  const updateData: any = {};
  if (data.claimAmount !== undefined) updateData.claimAmount = data.claimAmount;
  if (data.notes !== undefined) updateData.rejectionReason = data.notes;

  const claim = await prisma.insuranceClaim.update({
    where: { id },
    data: updateData,
    include: {
      patient: {
        select: { id: true, firstName: true, lastName: true },
      },
      policy: {
        select: { id: true, policyNumber: true },
      },
    },
  });

  logger.info({ tenantId, claimId: id }, 'Insurance claim updated');
  return claim;
}

/**
 * Re-sync a claim's amount + co-pay/deductible/coverage split from its policy as
 * the underlying bill grows (used by the auto-TPA link for IP admissions, so the
 * running claim tracks charges). Only touches PRE-processing claims (submitted)
 * — once the TPA/insurance team picks it up (under_review+) it is
 * left untouched.
 */
export async function resyncClaimAmount(tenantId: string, claimId: string, newClaimAmount: number) {
  const claim = await prisma.insuranceClaim.findFirst({
    where: { id: claimId, tenantId },
    include: { policy: true, bill: { select: { status: true } } },
  });
  if (!claim) return null;
  if (claim.status !== 'submitted') return claim;
  // A finalized bill is stable. This also preserves any exact TPA/patient
  // allocation entered by the insurance desk after finalization.
  if (claim.bill.status !== 'draft') return claim;
  if (!claim.policy) return claim;

  const split = computeResponsibility(
    Math.max(0, newClaimAmount),
    decNum(claim.policy.coPayPercent),
    decNum(claim.policy.deductibleAmount),
    decNum(claim.policy.coverageAmount),
  );
  const updated = await prisma.insuranceClaim.update({
    where: { id: claimId },
    data: {
      claimAmount: split.claimAmount,
      copayAmount: split.copayAmount,
      deductibleAmount: split.deductibleAmount,
      coveredAmount: split.coveredAmount,
      patientShare: split.patientResponsibility,
      outstandingAmount: split.claimAmount,
    },
  });
  return updated;
}

export async function submitClaim(tenantId: string, id: string, userId?: string) {
  const claim = await prisma.insuranceClaim.findFirst({
    where: { id, tenantId },
    include: {
      bill: { select: { status: true } },
    },
  });

  if (!claim) {
    throw AppError.notFound('Insurance claim not found');
  }

  if (claim.status !== 'submitted') {
    throw AppError.badRequest('Claim is not in a submittable status');
  }

  // The issued hospital bill is the single progression gate. Once finalized,
  // the claim can move into payer review.
  if (!['pending', 'partially_paid', 'paid'].includes(claim.bill.status)) {
    throw AppError.badRequest('Finalize the hospital bill before proceeding with this TPA claim');
  }

  const updated = await prisma.insuranceClaim.update({
    where: { id },
    data: {
      status: 'under_review',
      submissionDate: new Date(),
    },
    include: {
      patient: {
        select: { id: true, firstName: true, lastName: true },
      },
      policy: {
        select: { id: true, policyNumber: true },
      },
    },
  });

  await recordTpaCommunication({
    tenantId,
    claimId: id,
    userId,
    direction: 'outbound',
    subject: `${claimRef(claim.claimNumber)} submitted for review`,
    content: `Claim of ${decNum(claim.claimAmount).toFixed(2)} sent to the insurer for review.`,
  });

  logger.info({ tenantId, claimId: id }, 'Insurance claim submitted for review');
  return updated;
}

export async function approveClaim(
  tenantId: string,
  id: string,
  userId: string,
  data: ApproveClaimInput,
) {
  const claim = await prisma.insuranceClaim.findFirst({
    where: { id, tenantId },
  });

  if (!claim) {
    throw AppError.notFound('Insurance claim not found');
  }

  if (claim.status !== 'under_review') {
    throw AppError.badRequest('Claim must be under review to approve');
  }

  const claimAmount = decNum(claim.claimAmount);
  const coveredExpected = decNum(claim.coveredAmount);
  if (data.approvedAmount > coveredExpected) {
    throw AppError.badRequest(
      `Approved amount cannot exceed the covered amount (${coveredExpected.toFixed(2)}); the deductible and co-pay remain the patient's responsibility`,
    );
  }
  const approvedAmount = data.approvedAmount;
  const patientShare = Math.max(0, round2(claimAmount - approvedAmount));

  const updated = await prisma.insuranceClaim.update({
    where: { id },
    data: {
      status: 'approved',
      approvedAmount,
      coveredAmount: approvedAmount,
      patientShare,
      outstandingAmount: approvedAmount,
      approvalDate: new Date(),
      reviewedBy: userId,
      notes: data.notes ?? claim.notes,
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true } },
    },
  });

  // Reflect on the bill: insurance side covers approvedAmount, patient covers the rest.
  await applyBillSplit(tenantId, claim.billId, approvedAmount, patientShare);

  await recordTpaCommunication({
    tenantId,
    claimId: id,
    userId,
    direction: 'inbound',
    subject: `${claimRef(claim.claimNumber)} approved`,
    content: `Approved ${approvedAmount.toFixed(2)} of ${claimAmount.toFixed(2)}. Patient share ${patientShare.toFixed(2)}.`,
  });

  await notifyPatientInsuranceMilestone({
    tenantId,
    patientId: claim.patientId,
    title: 'Insurance claim approved',
    message: `Your payer approved ${approvedAmount.toFixed(2)}. Your current estimated share is ${patientShare.toFixed(2)}.`,
    referenceType: 'insurance_claim',
    referenceId: id,
  });

  logger.info(
    { tenantId, claimId: id, approvedAmount: data.approvedAmount },
    'Insurance claim approved',
  );
  return updated;
}

// ============================================================
// Partial approval / Settlement / Resubmission / Cancel
// ============================================================

export async function partialApproveClaim(
  tenantId: string,
  id: string,
  userId: string,
  data: PartialApproveClaimInput,
) {
  const claim = await prisma.insuranceClaim.findFirst({ where: { id, tenantId } });
  if (!claim) throw AppError.notFound('Insurance claim not found');

  if (claim.status !== 'under_review') {
    throw AppError.badRequest('Claim must be under review to partially approve');
  }

  const claimAmount = decNum(claim.claimAmount);
  // Same ceiling as a full approval: the payer's sanction can never exceed the
  // covered amount, so the patient always keeps the deductible + co-pay.
  const coveredExpected = decNum(claim.coveredAmount);
  if (data.approvedAmount > coveredExpected) {
    throw AppError.badRequest(
      `Approved amount cannot exceed the covered amount (${coveredExpected.toFixed(2)}); the deductible and co-pay remain the patient's responsibility`,
    );
  }

  const approvedAmount = data.approvedAmount;
  const patientShare = Math.max(0, round2(claimAmount - approvedAmount));

  const updated = await prisma.insuranceClaim.update({
    where: { id },
    data: {
      status: 'partially_approved',
      approvedAmount,
      coveredAmount: approvedAmount,
      patientShare,
      outstandingAmount: approvedAmount,
      approvalDate: new Date(),
      rejectionReason: data.rejectionReason ?? null,
      notes: data.notes ?? claim.notes,
      reviewedBy: userId,
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true } },
    },
  });

  await applyBillSplit(tenantId, claim.billId, approvedAmount, patientShare);

  await recordTpaCommunication({
    tenantId,
    claimId: id,
    userId,
    direction: 'inbound',
    subject: `${claimRef(claim.claimNumber)} partially approved`,
    content:
      `Approved ${approvedAmount.toFixed(2)} of ${claimAmount.toFixed(2)}. ` +
      `Patient share ${patientShare.toFixed(2)}.` +
      (data.rejectionReason ? ` Insurer's reason: ${data.rejectionReason}` : ''),
  });

  await notifyPatientInsuranceMilestone({
    tenantId,
    patientId: claim.patientId,
    title: 'Insurance claim partially approved',
    message: `Your payer approved ${approvedAmount.toFixed(2)} of ${claimAmount.toFixed(2)}. Your current estimated share is ${patientShare.toFixed(2)}.`,
    referenceType: 'insurance_claim',
    referenceId: id,
    alert: true,
  });

  logger.info({ tenantId, claimId: id, approvedAmount }, 'Insurance claim partially approved');
  return updated;
}

export async function settleClaim(
  tenantId: string,
  id: string,
  userId: string,
  data: SettleClaimInput,
) {
  const claim = await prisma.insuranceClaim.findFirst({ where: { id, tenantId } });
  if (!claim) throw AppError.notFound('Insurance claim not found');

  if (claim.status !== 'approved' && claim.status !== 'partially_approved' && claim.status !== 'partially_settled') {
    throw AppError.badRequest('Only approved or partially approved claims can be settled');
  }

  const approved = decNum(claim.approvedAmount ?? claim.claimAmount);
  await recordWorkflowSettlement(tenantId, userId, id, {
    grossApprovedAmount: approved,
    grossPaidAmount: data.paidAmount,
    tdsAmount: 0,
    disallowedAmount: 0,
    netPaidAmount: data.paidAmount,
    settlementDate: new Date(data.settlementDate ?? new Date()),
    notes: data.notes,
  });

  const updated = await prisma.insuranceClaim.findFirst({
    where: { id, tenantId },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true } },
    },
  });
  if (!updated) throw AppError.notFound('Insurance claim not found');

  const newPaid = decNum(updated.paidAmount);
  const outstanding = decNum(updated.outstandingAmount);
  const fullySettled = updated.status === 'settled';

  await recordTpaCommunication({
    tenantId,
    claimId: id,
    userId,
    direction: 'inbound',
    subject: `${claimRef(claim.claimNumber)} ${fullySettled ? 'settled' : 'part-settled'}`,
    content:
      `Received ${data.paidAmount.toFixed(2)}. Paid to date ${newPaid.toFixed(2)} ` +
      `of ${approved.toFixed(2)} approved; outstanding ${outstanding.toFixed(2)}.`,
  });

  logger.info({ tenantId, claimId: id, paid: data.paidAmount, status: updated.status }, 'Insurance claim settled (partial or full)');
  return updated;
}

export async function resubmitClaim(
  tenantId: string,
  id: string,
  userId: string,
  data: ResubmitClaimInput,
) {
  const original = await prisma.insuranceClaim.findFirst({ where: { id, tenantId } });
  if (!original) throw AppError.notFound('Insurance claim not found');

  if (original.status !== 'rejected' && original.status !== 'partially_approved') {
    throw AppError.badRequest('Only rejected or partially-approved claims can be resubmitted');
  }

  const policy = original.policyId
    ? await prisma.insurancePolicy.findFirst({ where: { id: original.policyId, tenantId } })
    : null;

  const newAmount = data.claimAmount ?? decNum(original.claimAmount);
  const split = computeResponsibility(
    newAmount,
    decNum(policy?.coPayPercent),
    decNum(policy?.deductibleAmount),
    decNum(policy?.coverageAmount),
  );

  const now = new Date();
  const expiryDays = data.expiryDays ?? DEFAULT_CLAIM_EXPIRY_DAYS;
  const expiryDate = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000);

  const claimNumber = await generateClaimNumber(tenantId);

  const resubmitted = await prisma.$transaction(async (tx) => {
    // Mark the prior claim as resubmitted (frozen) so it stays visible in history.
    // Its replacement carries the money from here on, so the frozen original
    // must not keep an outstanding of its own (gap 291: double counting).
    await tx.insuranceClaim.update({
      where: { id: original.id },
      data: { status: 'resubmitted', outstandingAmount: 0 },
    });

    return tx.insuranceClaim.create({
      data: {
        tenantId,
        patientId: original.patientId,
        policyId: original.policyId,
        billId: original.billId,
        claimNumber,
        claimAmount: newAmount,
        copayAmount: split.copayAmount,
        deductibleAmount: split.deductibleAmount,
        coveredAmount: split.coveredAmount,
        patientShare: split.patientResponsibility,
        outstandingAmount: newAmount,
        expiryDate,
        status: 'submitted',
        submissionDate: now,
        notes: data.notes,
        previousClaimId: original.id,
        resubmissionCount: (original.resubmissionCount ?? 0) + 1,
        submittedBy: userId,
      },
      include: {
        patient: { select: { id: true, firstName: true, lastName: true } },
        policy: { select: { id: true, policyNumber: true } },
        bill: { select: { id: true, billNumber: true, totalAmount: true } },
        previousClaim: { select: { id: true, claimNumber: true, status: true } },
      },
    });
  });

  // Logged against the NEW claim: that is the conversation that continues.
  await recordTpaCommunication({
    tenantId,
    claimId: resubmitted.id,
    userId,
    direction: 'outbound',
    subject: `Claim resubmitted as ${claimNumber}`,
    content: `Replaces ${original.claimNumber ?? 'the previous claim'}.`,
  });

  logger.info(
    { tenantId, originalClaimId: original.id, newClaimId: resubmitted.id, claimNumber },
    'Insurance claim resubmitted',
  );
  return resubmitted;
}

export async function cancelClaim(
  tenantId: string,
  id: string,
  userId: string,
  data: CancelClaimInput,
) {
  const claim = await prisma.insuranceClaim.findFirst({ where: { id, tenantId } });
  if (!claim) throw AppError.notFound('Insurance claim not found');

  if (claim.status === 'settled' || claim.status === 'cancelled') {
    throw AppError.badRequest('Settled or cancelled claims cannot be cancelled again');
  }

  const updated = await prisma.insuranceClaim.update({
    where: { id },
    data: {
      status: 'cancelled',
      rejectionReason: data.reason,
      reviewedBy: userId,
      // Gap 291: a cancelled claim owes nothing. Totals also ignore cancelled
      // claims at read time (insurance.metrics), which corrects older rows.
      outstandingAmount: 0,
    },
  });

  // Roll back any reservation on the bill (if previously approved).
  await applyBillSplit(tenantId, claim.billId, 0, decNum(claim.claimAmount));

  await recordTpaCommunication({
    tenantId,
    claimId: id,
    userId,
    direction: 'outbound',
    subject: `${claimRef(claim.claimNumber)} cancelled`,
    content: `Reason: ${data.reason}`,
  });

  logger.info({ tenantId, claimId: id }, 'Insurance claim cancelled');
  return updated;
}

// ============================================================
// Bill split helper
// ============================================================

export async function applyBillSplit(
  tenantId: string,
  billId: string,
  insurancePortion: number,
  claimPatientPortion: number,
) {
  return prisma.$transaction(async (tx) => {
    const bill = await tx.bill.findFirst({ where: { id: billId, tenantId } });
    if (!bill) return null;

    // Claim responsibility only covers the amount submitted to insurance. The
    // bill can also contain explicitly patient-only lines, so the bill-level
    // patient share must always be the full bill total minus the payer share.
    const billTotal = round2(Math.max(0, decNum(bill.totalAmount)));
    const normalizedInsurance = round2(Math.min(Math.max(0, insurancePortion), billTotal));
    const normalizedPatient = round2(Math.max(0, billTotal - normalizedInsurance));
    // `bill.amountPaid` includes both patient collections and TPA settlements.
    // A payer remittance must never reduce what the front desk still needs to
    // collect from the patient, so derive this balance from the patient ledger.
    const patientPaid = round2(Math.max(0, await computePatientPaid(tx, billId)));
    const balanceDue = round2(Math.max(0, normalizedPatient - patientPaid));

    await tx.bill.update({
      where: { id: billId },
      data: {
        insuranceCoveredAmount: normalizedInsurance,
        patientPayableAmount: normalizedPatient,
        balanceDue,
      },
    });

    return {
      insurancePortion: normalizedInsurance,
      patientPortion: normalizedPatient,
      claimPatientPortion: round2(Math.max(0, claimPatientPortion)),
      balanceDue,
    };
  });
}

export async function splitBill(tenantId: string, billId: string, data: SplitBillInput) {
  const bill = await prisma.bill.findFirst({ where: { id: billId, tenantId } });
  if (!bill) throw AppError.notFound('Bill not found');

  const isManual = data.insuranceAmount !== undefined || data.patientAmount !== undefined;
  if (isManual) {
    if (data.insuranceAmount === undefined || data.patientAmount === undefined || !data.claimId) {
      throw AppError.badRequest('TPA amount, patient amount and claim ID are required for a manual split');
    }
    if (!['pending', 'partially_paid', 'paid'].includes(bill.status)) {
      throw AppError.badRequest('Finalize the hospital bill before setting the TPA / patient split');
    }

    const claim = await prisma.insuranceClaim.findFirst({
      where: { id: data.claimId, tenantId, billId },
    });
    if (!claim) throw AppError.notFound('Insurance claim not found for this bill');
    if (!['submitted', 'under_review', 'query_raised', 'response_submitted', 'resubmitted'].includes(claim.status)) {
      throw AppError.badRequest('TPA / patient share cannot be changed after a payer decision is recorded');
    }

    const billTotal = round2(Math.max(0, decNum(bill.totalAmount)));
    const insuranceAmount = round2(data.insuranceAmount);
    const requestedPatientAmount = round2(data.patientAmount);
    if (insuranceAmount <= 0) {
      throw AppError.badRequest('TPA amount must be greater than zero; reject the claim if the payer covers nothing');
    }
    if (insuranceAmount > billTotal || requestedPatientAmount > billTotal) {
      throw AppError.badRequest('TPA and patient amounts cannot exceed the bill total');
    }
    if (Math.abs(round2(insuranceAmount + requestedPatientAmount) - billTotal) > 0.01) {
      throw AppError.badRequest(`TPA and patient amounts must total ${billTotal.toFixed(2)}`);
    }

    // Derive the stored patient value from the bill total after validating both
    // operator-entered values. This guarantees an exact two-decimal split.
    const patientAmount = round2(billTotal - insuranceAmount);
    const billSplit = await prisma.$transaction(async (tx) => {
      const patientPaid = round2(Math.max(0, await computePatientPaid(tx, billId)));
      const balanceDue = round2(Math.max(0, patientAmount - patientPaid));

      await tx.bill.update({
        where: { id: billId },
        data: {
          insuranceCoveredAmount: insuranceAmount,
          patientPayableAmount: patientAmount,
          balanceDue,
        },
      });
      await tx.insuranceClaim.update({
        where: { id: claim.id },
        data: {
          claimAmount: insuranceAmount,
          coveredAmount: insuranceAmount,
          patientShare: patientAmount,
          outstandingAmount: insuranceAmount,
        },
      });

      return {
        insurancePortion: insuranceAmount,
        patientPortion: patientAmount,
        claimPatientPortion: patientAmount,
        balanceDue,
      };
    });

    logger.info(
      { tenantId, billId, claimId: claim.id, insuranceAmount, patientAmount, balanceDue: billSplit.balanceDue },
      'Manual TPA / patient bill split applied',
    );
    return {
      billId,
      claimId: claim.id,
      policy: null,
      split: {
        claimAmount: insuranceAmount,
        coPayPercent: 0,
        deductibleAmount: decNum(claim.deductibleAmount),
        coverageLimit: 0,
        coveredAmount: insuranceAmount,
        copayAmount: decNum(claim.copayAmount),
        patientResponsibility: patientAmount,
        insurancePortion: insuranceAmount,
      },
      billSplit,
    };
  }

  if (!data.policyId) {
    throw AppError.badRequest('Policy ID is required to calculate the split');
  }

  const policy = await prisma.insurancePolicy.findFirst({
    where: { id: data.policyId, tenantId, patientId: bill.patientId },
    include: { insurer: { select: { id: true, name: true } } },
  });
  if (!policy) throw AppError.notFound('Insurance policy not found for this patient');

  const claimAmount = Math.min(data.claimAmount ?? decNum(bill.totalAmount), decNum(bill.totalAmount));
  const split = computeResponsibility(
    claimAmount,
    decNum(policy.coPayPercent),
    decNum(policy.deductibleAmount),
    decNum(policy.coverageAmount),
  );

  const billSplit = await applyBillSplit(tenantId, billId, split.coveredAmount, split.patientResponsibility);
  if (!billSplit) throw AppError.notFound('Bill not found');

  return {
    billId,
    policy: { id: policy.id, policyNumber: policy.policyNumber, insurer: policy.insurer },
    split,
    billSplit,
  };
}

export async function rejectClaim(
  tenantId: string,
  id: string,
  userId: string,
  data: RejectClaimInput,
) {
  const claim = await prisma.insuranceClaim.findFirst({
    where: { id, tenantId },
  });

  if (!claim) {
    throw AppError.notFound('Insurance claim not found');
  }

  if (claim.status !== 'under_review') {
    throw AppError.badRequest('Claim must be under review to reject');
  }

  const updated = await prisma.insuranceClaim.update({
    where: { id },
    data: {
      status: 'rejected',
      rejectionReason: data.rejectionReason,
      coveredAmount: 0,
      outstandingAmount: 0,
      patientShare: decNum(claim.claimAmount),
      reviewedBy: userId,
      notes: data.notes ?? claim.notes,
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true } },
    },
  });

  // Patient now owes the entire bill since the claim was rejected.
  await applyBillSplit(tenantId, claim.billId, 0, decNum(claim.claimAmount));

  await recordTpaCommunication({
    tenantId,
    claimId: id,
    userId,
    direction: 'inbound',
    subject: `${claimRef(claim.claimNumber)} rejected`,
    content: `Insurer's reason: ${data.rejectionReason}`,
  });

  await notifyPatientInsuranceMilestone({
    tenantId,
    patientId: claim.patientId,
    title: 'Insurance claim rejected',
    message: `The payer rejected the claim. Reason: ${data.rejectionReason}`,
    referenceType: 'insurance_claim',
    referenceId: id,
    alert: true,
  });

  logger.info({ tenantId, claimId: id }, 'Insurance claim rejected');
  return updated;
}

// ============================================================
// Claim export for TPA submission
// ============================================================

export async function exportClaimForTpa(tenantId: string, id: string) {
  const claim = await prisma.insuranceClaim.findFirst({
    where: { id, tenantId },
    include: {
      patient: true,
      policy: {
        include: {
          insurer: true,
          tpa: true,
        },
      },
      bill: {
        include: { billItems: true },
      },
      tpaCommunicationLogs: { orderBy: { createdAt: 'desc' } },
    },
  });

  if (!claim) throw AppError.notFound('Insurance claim not found');

  return {
    claimNumber: claim.claimNumber,
    claimAmount: decNum(claim.claimAmount),
    approvedAmount: decNum(claim.approvedAmount),
    copayAmount: decNum(claim.copayAmount),
    deductibleAmount: decNum(claim.deductibleAmount),
    coveredAmount: decNum(claim.coveredAmount),
    patientShare: decNum(claim.patientShare),
    paidAmount: decNum(claim.paidAmount),
    outstandingAmount: decNum(claim.outstandingAmount),
    status: claim.status,
    submissionDate: claim.submissionDate,
    expiryDate: claim.expiryDate,
    patient: {
      id: claim.patient.id,
      firstName: claim.patient.firstName,
      lastName: claim.patient.lastName,
      phone: (claim.patient as { phone?: string }).phone,
      email: (claim.patient as { email?: string }).email,
    },
    policy: claim.policy ? {
      policyNumber: claim.policy.policyNumber,
      groupNumber: claim.policy.groupNumber,
      planName: claim.policy.planName,
      coverageAmount: decNum(claim.policy.coverageAmount),
      coPayPercent: decNum(claim.policy.coPayPercent),
      deductibleAmount: decNum(claim.policy.deductibleAmount),
      validFrom: claim.policy.validFrom,
      validTo: claim.policy.validTo,
      insurer: {
        id: claim.policy.insurer.id,
        name: claim.policy.insurer.name,
        contactPerson: claim.policy.insurer.contactPerson,
        email: claim.policy.insurer.email,
        phone: claim.policy.insurer.phone,
      },
      tpa: claim.policy.tpa
        ? {
            id: claim.policy.tpa.id,
            name: claim.policy.tpa.name,
            contactPerson: claim.policy.tpa.contactPerson,
            email: claim.policy.tpa.email,
            phone: claim.policy.tpa.phone,
          }
        : null,
    } : null,
    bill: {
      billNumber: claim.bill.billNumber,
      billDate: claim.bill.billDate,
      totalAmount: decNum(claim.bill.totalAmount),
      items: claim.bill.billItems.map((it) => ({
        description: it.description,
        category: it.category,
        quantity: it.quantity,
        unitPrice: decNum(it.unitPrice),
        totalAmount: decNum(it.totalAmount),
      })),
    },
    communications: claim.tpaCommunicationLogs.map((l) => ({
      id: l.id,
      direction: l.direction,
      type: l.communicationType,
      subject: l.subject,
      content: l.content,
      createdAt: l.createdAt,
    })),
  };
}

// ============================================================
// Pre-Authorization Requests
// ============================================================

export async function createPreAuth(tenantId: string, userId: string, data: CreatePreAuthInput) {
  const insuranceCase = data.insuranceCaseId
    ? await prisma.insuranceCase.findFirst({
        where: { id: data.insuranceCaseId, tenantId, patientId: data.patientId },
        include: { policies: { orderBy: { sequence: 'asc' } } },
      })
    : null;
  if (data.insuranceCaseId && !insuranceCase) throw AppError.notFound('Insurance / payer case not found');
  const policyId = data.policyId ?? insuranceCase?.policies[0]?.policyId;
  const policy = policyId
    ? await prisma.insurancePolicy.findFirst({ where: { id: policyId, tenantId, patientId: data.patientId } })
    : null;
  if (policyId && !policy) throw AppError.notFound('Insurance policy not found for this patient');

  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const now = new Date();
  const preAuth = await prisma.preAuthorizationRequest.create({
    data: {
      tenantId,
      patientId: data.patientId,
      policyId,
      insuranceCaseId: insuranceCase?.id,
      requestNumber: await generatePreAuthRequestNumber(tenantId),
      requestType: 'initial',
      admissionId: data.admissionId ?? insuranceCase?.admissionId,
      visitId: data.visitId ?? insuranceCase?.visitId,
      doctorId: data.doctorId,
      diagnosisCode: data.diagnosisCode,
      procedureCode: data.procedureCode,
      procedureDescription: data.procedureDescription,
      estimatedCost: data.estimatedCost,
      status: 'pending',
      validFrom: data.validFrom ? new Date(data.validFrom) : undefined,
      validTo: data.validTo ? new Date(data.validTo) : undefined,
      notes: data.notes,
      submittedBy: userId,
      submissionChannel: data.submissionChannel,
      submissionReference: data.submissionReference,
      submittedAt: now,
      alertAt: new Date(now.getTime() + 45 * 60 * 1000),
      decisionDueAt: new Date(now.getTime() + 60 * 60 * 1000),
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true } },
    },
  });

  if (insuranceCase) {
    await prisma.insuranceCase.update({ where: { id: insuranceCase.id }, data: { status: 'preAuthPending' } });
    await prisma.insuranceAuditEvent.create({
      data: {
        tenantId,
        actorId: userId,
        insuranceCaseId: insuranceCase.id,
        preAuthId: preAuth.id,
        eventType: 'preauth.initial_submitted',
        toStatus: 'pending',
        details: { requestNumber: preAuth.requestNumber, decisionDueAt: preAuth.decisionDueAt },
      },
    });
  }

  await recordTpaCommunication({
    tenantId,
    preAuthId: preAuth.id,
    userId,
    direction: 'outbound',
    subject: 'Pre-authorization requested',
    content:
      `${data.procedureDescription}` +
      (data.estimatedCost ? ` — estimated ${Number(data.estimatedCost).toFixed(2)}` : ''),
  });

  logger.info({ tenantId, preAuthId: preAuth.id }, 'Pre-authorization request created');
  return preAuth;
}

export async function getPreAuths(tenantId: string, query: any) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;
  if (query.policyId) where.policyId = query.policyId;
  if (query.status) where.status = query.status;

  if (query.search) {
    where.OR = [
      { procedureDescription: { contains: query.search, mode: 'insensitive' } },
      { requestNumber: { contains: query.search, mode: 'insensitive' } },
      { payerPreAuthReference: { contains: query.search, mode: 'insensitive' } },
      { approvalNumber: { contains: query.search, mode: 'insensitive' } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [preAuths, total] = await Promise.all([
    prisma.preAuthorizationRequest.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, firstName: true, lastName: true },
        },
        policy: {
          select: { id: true, policyNumber: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.preAuthorizationRequest.count({ where }),
  ]);

  return { preAuths, total, page, limit };
}

export async function getPreAuthById(tenantId: string, id: string) {
  const preAuth = await prisma.preAuthorizationRequest.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: { id: true, firstName: true, lastName: true, phone: true, email: true },
      },
      policy: {
        select: {
          id: true,
          policyNumber: true,
          planName: true,
          coverageAmount: true,
          insurer: { select: { id: true, name: true } },
          tpa: { select: { id: true, name: true } },
        },
      },
      submitter: {
        select: { id: true, firstName: true, lastName: true },
      },
    },
  });

  if (!preAuth) {
    throw AppError.notFound('Pre-authorization request not found');
  }

  return preAuth;
}

export async function updatePreAuth(tenantId: string, id: string, data: UpdatePreAuthInput) {
  const existing = await prisma.preAuthorizationRequest.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Pre-authorization request not found');
  }

  if (existing.status !== 'pending') {
    throw AppError.badRequest('Can only update pending pre-authorization requests');
  }

  const updateData: any = {};
  if (data.procedureDescription !== undefined)
    updateData.procedureDescription = data.procedureDescription;
  if (data.estimatedCost !== undefined) updateData.estimatedCost = data.estimatedCost;
  if (data.notes !== undefined) updateData.notes = data.notes;

  const preAuth = await prisma.preAuthorizationRequest.update({
    where: { id },
    data: updateData,
    include: {
      patient: {
        select: { id: true, firstName: true, lastName: true },
      },
      policy: {
        select: { id: true, policyNumber: true },
      },
    },
  });

  logger.info({ tenantId, preAuthId: id }, 'Pre-authorization request updated');
  return preAuth;
}

export async function approvePreAuth(tenantId: string, id: string, data: ApprovePreAuthInput, userId?: string) {
  const existing = await prisma.preAuthorizationRequest.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Pre-authorization request not found');
  }

  if (existing.status !== 'pending' && existing.status !== 'on_hold') {
    throw AppError.badRequest('Can only approve pending or on-hold pre-authorization requests');
  }

  // `requestNumber` is our internal identifier. A payer reference is stored
  // only when the insurer/administrator actually supplies one; it must never
  // be fabricated by the hospital application.
  const payerReference = data.approvalNumber?.trim() || null;
  const decidedAt = new Date();

  const preAuth = await prisma.preAuthorizationRequest.update({
    where: { id },
    data: {
      status: 'approved',
      approvalNumber: payerReference,
      payerPreAuthReference: payerReference,
      approvedAmount: data.approvedAmount,
      validFrom: data.validFrom ? new Date(data.validFrom) : existing.validFrom ?? new Date(),
      validTo: data.validTo ? new Date(data.validTo) : existing.validTo ?? undefined,
      holdReason: null,
      notes: data.notes ?? existing.notes,
      decidedAt,
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true } },
    },
  });

  if (existing.insuranceCaseId) {
    await prisma.$transaction(async (tx) => {
      await tx.insuranceCase.update({ where: { id: existing.insuranceCaseId! }, data: { status: 'authorized' } });
      if (existing.requestType === 'finalDischarge') {
        const linkedClaims = await tx.insuranceClaim.findMany({
          where: { tenantId, preAuthId: id },
          include: { bill: { include: { billItems: { where: { category: 'room' } } } } },
        });
        for (const claim of linkedClaims) {
          const dailyRoomRate = claim.bill.billItems.reduce((highest, item) => Math.max(highest, Number(item.unitPrice)), 0);
          const liability = calculateDelayLiability(existing.decisionDueAt, decidedAt, dailyRoomRate);
          const delayLiabilityAmount = liability.amount;
          await tx.insuranceClaim.update({
            where: { id: claim.id },
            data: { finalAuthorizationReceivedAt: decidedAt, delayLiabilityAmount },
          });
          if (delayLiabilityAmount > 0) {
            await tx.insuranceAuditEvent.create({
              data: {
                tenantId,
                actorId: userId,
                insuranceCaseId: existing.insuranceCaseId,
                claimId: claim.id,
                preAuthId: id,
                eventType: 'final_authorization.delay_liability_calculated',
                details: { decisionDueAt: existing.decisionDueAt, decidedAt, lateMinutes: liability.lateMinutes, dailyRoomRate, delayLiabilityAmount },
              },
            });
          }
        }
      }
      await tx.insuranceAuditEvent.create({
        data: {
          tenantId,
          actorId: userId,
          insuranceCaseId: existing.insuranceCaseId,
          preAuthId: id,
          eventType: existing.requestType === 'finalDischarge' ? 'final_authorization.approved' : 'preauth.approved',
          fromStatus: existing.status,
          toStatus: 'approved',
          details: { payerPreAuthReference: payerReference, approvedAmount: data.approvedAmount },
        },
      });
    });
  }

  await recordTpaCommunication({
    tenantId,
    preAuthId: id,
    userId,
    direction: 'inbound',
    subject: `Pre-authorization approved (${payerReference ?? existing.requestNumber})`,
    content:
      `${existing.procedureDescription} approved` +
      (data.approvedAmount ? ` for ${Number(data.approvedAmount).toFixed(2)}` : '') + '.',
  });

  await notifyPatientInsuranceMilestone({
    tenantId,
    patientId: existing.patientId,
    title: existing.requestType === 'finalDischarge' ? 'Discharge authorization approved' : 'Pre-authorization approved',
    message: `${existing.procedureDescription} was approved${data.approvedAmount ? ` for ${Number(data.approvedAmount).toFixed(2)}` : ''}.`,
    referenceType: 'pre_authorization_request',
    referenceId: id,
  });

  logger.info({ tenantId, preAuthId: id, payerReference }, 'Pre-authorization request approved');
  return preAuth;
}

export async function rejectPreAuth(tenantId: string, id: string, data: RejectPreAuthInput, userId?: string) {
  const existing = await prisma.preAuthorizationRequest.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Pre-authorization request not found');
  }

  if (existing.status !== 'pending' && existing.status !== 'on_hold') {
    throw AppError.badRequest('Can only deny pending or on-hold pre-authorization requests');
  }

  const preAuth = await prisma.preAuthorizationRequest.update({
    where: { id },
    data: {
      status: 'denied',
      notes: data.notes,
      holdReason: null,
      decidedAt: new Date(),
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true } },
    },
  });

  if (existing.insuranceCaseId) {
    await prisma.insuranceAuditEvent.create({
      data: {
        tenantId,
        actorId: userId,
        insuranceCaseId: existing.insuranceCaseId,
        preAuthId: id,
        eventType: existing.requestType === 'finalDischarge' ? 'final_authorization.denied' : 'preauth.denied',
        fromStatus: existing.status,
        toStatus: 'denied',
        details: { reason: data.notes },
      },
    });
  }

  await recordTpaCommunication({
    tenantId,
    preAuthId: id,
    userId,
    direction: 'inbound',
    subject: 'Pre-authorization denied',
    content: `${existing.procedureDescription} denied.` + (data.notes ? ` ${data.notes}` : ''),
  });

  await notifyPatientInsuranceMilestone({
    tenantId,
    patientId: existing.patientId,
    title: existing.requestType === 'finalDischarge' ? 'Discharge authorization denied' : 'Pre-authorization denied',
    message: `${existing.procedureDescription} was denied.${data.notes ? ` ${data.notes}` : ''}`,
    referenceType: 'pre_authorization_request',
    referenceId: id,
    alert: true,
  });

  logger.info({ tenantId, preAuthId: id }, 'Pre-authorization request denied');
  return preAuth;
}

export async function holdPreAuth(tenantId: string, id: string, data: HoldPreAuthInput, userId?: string) {
  const existing = await prisma.preAuthorizationRequest.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Pre-authorization request not found');

  if (existing.status !== 'pending') {
    throw AppError.badRequest('Only pending pre-authorization requests can be put on hold');
  }

  const preAuth = await prisma.preAuthorizationRequest.update({
    where: { id },
    data: { status: 'on_hold', holdReason: data.reason },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true } },
    },
  });

  // Inbound: a hold is the insurer coming back with a query.
  await recordTpaCommunication({
    tenantId,
    preAuthId: id,
    userId,
    direction: 'inbound',
    subject: 'Pre-authorization put on hold',
    content: `Query raised: ${data.reason}`,
  });

  logger.info({ tenantId, preAuthId: id }, 'Pre-authorization put on hold');
  return preAuth;
}

export async function releasePreAuthHold(tenantId: string, id: string, userId?: string) {
  const existing = await prisma.preAuthorizationRequest.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Pre-authorization request not found');

  if (existing.status !== 'on_hold') {
    throw AppError.badRequest('Only on-hold pre-authorization requests can be released');
  }

  const preAuth = await prisma.preAuthorizationRequest.update({
    where: { id },
    data: { status: 'pending', holdReason: null },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true } },
    },
  });

  await recordTpaCommunication({
    tenantId,
    preAuthId: id,
    userId,
    direction: 'outbound',
    subject: 'Pre-authorization hold released',
    content:
      'Query answered; the request is back with the insurer.' +
      (existing.holdReason ? ` Hold was: ${existing.holdReason}` : ''),
  });

  logger.info({ tenantId, preAuthId: id }, 'Pre-authorization hold released');
  return preAuth;
}

export async function cancelPreAuth(tenantId: string, id: string, userId?: string) {
  const existing = await prisma.preAuthorizationRequest.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Pre-authorization request not found');

  if (existing.status === 'approved' || existing.status === 'denied' || existing.status === 'cancelled') {
    throw AppError.badRequest('Cannot cancel a pre-authorization that is already finalised');
  }

  const preAuth = await prisma.preAuthorizationRequest.update({
    where: { id },
    data: { status: 'cancelled' },
  });

  await recordTpaCommunication({
    tenantId,
    preAuthId: id,
    userId,
    direction: 'outbound',
    subject: 'Pre-authorization cancelled',
    content: `${existing.procedureDescription} withdrawn by the hospital.`,
  });

  logger.info({ tenantId, preAuthId: id }, 'Pre-authorization cancelled');
  return preAuth;
}

// ============================================================
// Patient-scoped helpers
// ============================================================

export async function getPoliciesByPatient(tenantId: string, patientId: string) {
  const patient = await prisma.patient.findFirst({ where: { id: patientId, tenantId } });
  if (!patient) throw AppError.notFound('Patient not found');

  return prisma.insurancePolicy.findMany({
    where: { tenantId, patientId },
    include: {
      insurer: { select: { id: true, name: true } },
      tpa: { select: { id: true, name: true } },
    },
    orderBy: [{ status: 'asc' }, { validTo: 'desc' }],
  });
}

/**
 * The patient's active, currently-valid insurance policy — preferring one that
 * has a TPA attached (so a "transfer to TPA" can route it), then the latest
 * validity. Returns null when the patient has no usable policy.
 */
export async function findActivePolicyForPatient(tenantId: string, patientId: string) {
  const now = new Date();
  const policies = await prisma.insurancePolicy.findMany({
    where: { tenantId, patientId, status: 'active', validFrom: { lte: now }, validTo: { gte: now } },
    include: {
      // The payer's tax identity travels with the policy: it decides whether a
      // bill against it is a B2B invoice, and which state the supply is in.
      insurer: { select: { id: true, name: true, gstin: true, stateCode: true } },
      tpa: { select: { id: true, name: true, gstin: true, stateCode: true } },
    },
    orderBy: { validTo: 'desc' },
  });
  if (policies.length === 0) return null;
  // Prefer a policy with a TPA; otherwise the most-recently-valid one.
  return policies.find((p) => p.tpaId) ?? policies[0];
}

// ============================================================
// Expiry / sweeping
// ============================================================

export async function getExpiringClaims(tenantId: string, withinDays = 7) {
  // Same IST-day rule as the dashboard and the reminder job (gap 296).
  return prisma.insuranceClaim.findMany({
    where: { tenantId, ...claimDeadlineWhere('expiring', withinDays) },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true, insurer: { select: { id: true, name: true } } } },
    },
    orderBy: { expiryDate: 'asc' },
  });
}

export async function getExpiringPolicies(tenantId: string, withinDays = 30) {
  const now = new Date();
  const cutoff = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

  return prisma.insurancePolicy.findMany({
    where: {
      tenantId,
      status: 'active',
      validTo: { gte: now, lte: cutoff },
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      insurer: { select: { id: true, name: true } },
    },
    orderBy: { validTo: 'asc' },
  });
}

export async function sweepExpiredPoliciesAndPreAuths() {
  const now = new Date();

  const policies = await prisma.insurancePolicy.updateMany({
    where: { status: 'active', validTo: { lt: now } },
    data: { status: 'expired' },
  });

  const preAuths = await prisma.preAuthorizationRequest.updateMany({
    where: { status: { in: ['pending', 'on_hold', 'approved'] }, validTo: { lt: now } },
    data: { status: 'expired' },
  });

  if (policies.count || preAuths.count) {
    logger.info({ policiesExpired: policies.count, preAuthsExpired: preAuths.count }, 'Insurance sweep');
  }

  return { policiesExpired: policies.count, preAuthsExpired: preAuths.count };
}

// ============================================================
// Dashboard
// ============================================================

/**
 * Gap 290: the dashboard takes the same date-range / insurer / TPA filters as
 * Reports and passes them through the same `reportWhere` + metric helpers, so
 * for the same filters the two screens show the same approval rates and
 * outstanding. The filters scope the CLAIM figures (status counts, approval,
 * money, recent claims); the pre-auth and deadline panels stay "as of now",
 * because their links open lists that are not date-filtered.
 */
export async function getDashboard(tenantId: string, filters: ReportFilters = {}) {
  const claimWhere = reportWhere(tenantId, filters);
  const now = new Date();
  const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  // Gap 296: one IST-day rule for "expiring" and "expired" (claimDeadlineWhere),
  // shared with the reminder job, the notification wording and the claims list.

  const [
    pendingClaims,
    underReviewClaims,
    approvedClaims,
    partiallyApprovedClaims,
    rejectedClaims,
    settledClaims,
    partiallySettledClaims,
    pendingPreAuths,
    onHoldPreAuths,
    approvedPreAuths,
    expiringPolicies,
    expiringClaims,
    expiredClaims,
    expiringPreAuths,
    monthClaims,
    moneyRows,
    recentClaims,
    recentPreAuths,
  ] = await Promise.all([
    prisma.insuranceClaim.count({ where: { ...claimWhere, status: 'submitted' } }),
    prisma.insuranceClaim.count({ where: { ...claimWhere, status: 'under_review' } }),
    prisma.insuranceClaim.count({ where: { ...claimWhere, status: 'approved' } }),
    prisma.insuranceClaim.count({ where: { ...claimWhere, status: 'partially_approved' } }),
    prisma.insuranceClaim.count({ where: { ...claimWhere, status: 'rejected' } }),
    prisma.insuranceClaim.count({ where: { ...claimWhere, status: 'settled' } }),
    prisma.insuranceClaim.count({ where: { ...claimWhere, status: 'partially_settled' } }),
    prisma.preAuthorizationRequest.count({ where: { tenantId, status: 'pending' } }),
    prisma.preAuthorizationRequest.count({ where: { tenantId, status: 'on_hold' } }),
    prisma.preAuthorizationRequest.count({ where: { tenantId, status: 'approved' } }),
    prisma.insurancePolicy.count({
      where: { tenantId, status: 'active', validTo: { gte: now, lte: sevenDays } },
    }),
    // Gap 296: the same clause the claims list's ?expiry= filter uses.
    prisma.insuranceClaim.count({ where: { tenantId, ...claimDeadlineWhere('expiring', 7, now) } }),
    prisma.insuranceClaim.count({ where: { tenantId, ...claimDeadlineWhere('expired', 7, now) } }),
    prisma.preAuthorizationRequest.count({
      where: { tenantId, status: { in: ['pending', 'on_hold', 'approved'] }, validTo: { gte: now, lte: sevenDays } },
    }),
    prisma.insuranceClaim.count({ where: { ...claimWhere, createdAt: { gte: startOfMonth } } }),
    // Gap 290/291: the money figures are computed per claim by the same helper
    // the reports use, over live claims only — not summed from the stored
    // outstanding column, which still carries stale values on old rows.
    prisma.insuranceClaim.findMany({
      // Same claim set as the Approval-rate report for the same filters.
      where: { ...claimWhere, status: { notIn: [...CLAIM_VOID_STATUSES] } },
      select: { status: true, claimAmount: true, approvedAmount: true, paidAmount: true, writtenOffAmount: true },
    }),
    prisma.insuranceClaim.findMany({
      where: claimWhere,
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true } },
        policy: { select: { id: true, policyNumber: true, insurer: { select: { id: true, name: true } } } },
      },
    }),
    prisma.preAuthorizationRequest.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true } },
        policy: { select: { id: true, policyNumber: true, insurer: { select: { id: true, name: true } } } },
      },
    }),
  ]);

  const rate = computeApprovalRate(moneyRows.map((c) => c.status));
  const amountRate = computeAmountApprovalRate(moneyRows);
  const totals = computeClaimTotals(moneyRows);

  return {
    filters: {
      fromDate: filters.fromDate ?? null,
      toDate: filters.toDate ?? null,
      insurerId: filters.insurerId ?? null,
      tpaId: filters.tpaId ?? null,
    },
    claims: {
      pending: pendingClaims,
      underReview: underReviewClaims,
      approved: approvedClaims,
      partiallyApproved: partiallyApprovedClaims,
      rejected: rejectedClaims,
      settled: settledClaims,
      partiallySettled: partiallySettledClaims,
      totalThisMonth: monthClaims,
      approvalRate: rate.approvalRate,
      decided: rate.decided,
      approvedOrPartial: rate.approved,
      // Gap 290: by amount — numerator and denominator both returned.
      amountApprovalRate: amountRate.amountApprovalRate,
      decidedApprovedAmount: amountRate.decidedApprovedAmount,
      decidedClaimedAmount: amountRate.decidedClaimedAmount,
    },
    preAuth: {
      pending: pendingPreAuths,
      onHold: onHoldPreAuths,
      approved: approvedPreAuths,
    },
    settlement: {
      totalClaimed: totals.claimed,
      totalApprovedAmount: totals.approved,
      totalPaid: totals.paid,
      totalWrittenOff: totals.writtenOff,
      totalOutstanding: totals.outstanding,
      awaitingDecision: totals.awaitingDecision,
    },
    expiry: {
      policiesIn7Days: expiringPolicies,
      claimsIn7Days: expiringClaims,
      claimsExpired: expiredClaims,
      preAuthsIn7Days: expiringPreAuths,
    },
    definitions: INSURANCE_METRIC_DEFINITIONS,
    recentClaims,
    recentPreAuths,
  };
}

// ============================================================
// Reports
// ============================================================

interface ReportFilters {
  fromDate?: string;
  toDate?: string;
  insurerId?: string;
  tpaId?: string;
}

function reportWhere(tenantId: string, filters: ReportFilters): Prisma.InsuranceClaimWhereInput {
  const where: Prisma.InsuranceClaimWhereInput = { tenantId };
  // Whole IST days, end date inclusive — `new Date('2026-11-13')` is 05:30 IST
  // and cut off the last day of the range.
  if (filters.fromDate || filters.toDate) {
    where.submissionDate = {
      ...(filters.fromDate ? { gte: istDayStart(filters.fromDate) } : {}),
      ...(filters.toDate ? { lte: istDayEnd(filters.toDate) } : {}),
    };
  }
  // Gap 292: the payer is read from the payer case first, then the policy, so
  // a claim filed through a case with no policy is still found by its payer.
  const and: Prisma.InsuranceClaimWhereInput[] = [];
  if (filters.insurerId) {
    and.push({ OR: [{ insuranceCase: { insurerId: filters.insurerId } }, { policy: { insurerId: filters.insurerId } }] });
  }
  if (filters.tpaId) {
    and.push({ OR: [{ insuranceCase: { tpaId: filters.tpaId } }, { policy: { tpaId: filters.tpaId } }] });
  }
  if (and.length) where.AND = and;
  return where;
}

/** Fields every report reads to compute money and resolve the payer. */
const REPORT_CLAIM_SELECT = {
  id: true,
  claimNumber: true,
  status: true,
  claimAmount: true,
  approvedAmount: true,
  paidAmount: true,
  writtenOffAmount: true,
  submissionDate: true,
  approvalDate: true,
  patient: { select: { id: true, firstName: true, lastName: true } },
  ...CLAIM_PAYER_SELECT,
} satisfies Prisma.InsuranceClaimSelect;

export async function getClaimsSummaryReport(tenantId: string, filters: ReportFilters) {
  const claims = await prisma.insuranceClaim.findMany({
    where: reportWhere(tenantId, filters),
    select: REPORT_CLAIM_SELECT,
  });

  const byStatus = new Map<string, { status: string; count: number; claimed: number; approved: number; paid: number }>();
  for (const c of claims) {
    const row = byStatus.get(c.status) ?? { status: c.status, count: 0, claimed: 0, approved: 0, paid: 0 };
    row.count += 1;
    row.claimed = round2(row.claimed + decNum(c.claimAmount));
    row.approved = round2(row.approved + decNum(c.approvedAmount));
    row.paid = round2(row.paid + decNum(c.paidAmount));
    byStatus.set(c.status, row);
  }
  const totals = computeClaimTotals(claims);

  return {
    total: totals,
    // Cancelled and superseded claims are listed so they can be seen, but
    // flagged: they are not in the totals above (gap 291).
    byStatus: Array.from(byStatus.values()).map((r) => ({
      ...r,
      excludedFromTotals: (CLAIM_VOID_STATUSES as readonly string[]).includes(r.status),
    })),
    definitions: INSURANCE_METRIC_DEFINITIONS,
  };
}

export async function getApprovalRateReport(tenantId: string, filters: ReportFilters) {
  const claims = await prisma.insuranceClaim.findMany({
    where: { ...reportWhere(tenantId, filters), status: { notIn: [...CLAIM_VOID_STATUSES] } },
    select: REPORT_CLAIM_SELECT,
  });

  // Gap 290: same calculation as the dashboard (computeApprovalRate), and
  // claims with no payer are grouped rather than silently dropped (gap 292).
  const byPayer = new Map<string, { id: string | null; name: string; rows: typeof claims }>();
  for (const c of claims) {
    const payer = resolveClaimPayer(c);
    const key = payer?.id ?? '__missing__';
    const g = byPayer.get(key) ?? { id: payer?.id ?? null, name: payer?.name ?? PAYER_MISSING.name, rows: [] };
    g.rows.push(c);
    byPayer.set(key, g);
  }

  const summarise = (rows: typeof claims) => {
    const rate = computeApprovalRate(rows.map((r) => r.status));
    const amountRate = computeAmountApprovalRate(rows);
    const totals = computeClaimTotals(rows);
    return {
      total: rows.length,
      decided: rate.decided,
      approved: rate.approved,
      rejected: rate.rejected,
      awaitingDecision: rate.awaitingDecision,
      approvalRate: rate.approvalRate,
      // Gap 290: approval by amount over the same decided claims.
      amountApprovalRate: amountRate.amountApprovalRate,
      decidedApprovedAmount: amountRate.decidedApprovedAmount,
      decidedClaimedAmount: amountRate.decidedClaimedAmount,
      claimedAmount: totals.claimed,
      approvedAmount: totals.approved,
    };
  };

  return {
    overall: summarise(claims),
    byInsurer: Array.from(byPayer.values())
      .sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : b.rows.length - a.rows.length))
      .map((g) => ({ insurerId: g.id, insurerName: g.name, ...summarise(g.rows) })),
    definitions: INSURANCE_METRIC_DEFINITIONS,
  };
}

type AgingBucketKey = '0-30' | '31-60' | '61-90' | '90+';

export async function getAgingReport(tenantId: string, filters: ReportFilters) {
  // Live claims still waiting on the payer: for a decision, or for money.
  // Cancelled, rejected, settled and superseded claims never age (gap 291).
  const claims = await prisma.insuranceClaim.findMany({
    where: {
      ...reportWhere(tenantId, filters),
      status: { in: [...CLAIM_AWAITING_DECISION_STATUSES, ...CLAIM_RECEIVABLE_STATUSES] },
    },
    select: REPORT_CLAIM_SELECT,
  });

  type Row = (typeof claims)[number] & { outstanding: number; awaiting: number; amount: number };
  const emptyBucket = () => ({ count: 0, amount: 0, outstanding: 0, awaitingDecision: 0, claims: [] as Row[] });
  const buckets: Record<AgingBucketKey, ReturnType<typeof emptyBucket>> = {
    '0-30': emptyBucket(),
    '31-60': emptyBucket(),
    '61-90': emptyBucket(),
    '90+': emptyBucket(),
  };
  const rows: Row[] = [];
  const now = Date.now();

  for (const c of claims) {
    const outstanding = claimOutstanding(c);
    const awaiting = claimAwaitingDecision(c);
    const amount = round2(outstanding + awaiting);
    // An approved claim fully covered by payments or write-offs owes nothing.
    if (amount <= 0) continue;
    const row: Row = { ...c, outstanding, awaiting, amount };
    rows.push(row);
    const ageDays = Math.floor((now - new Date(c.submissionDate).getTime()) / (24 * 60 * 60 * 1000));
    const key: AgingBucketKey = ageDays <= 30 ? '0-30' : ageDays <= 60 ? '31-60' : ageDays <= 90 ? '61-90' : '90+';
    const b = buckets[key];
    b.count += 1;
    b.amount = round2(b.amount + amount);
    b.outstanding = round2(b.outstanding + outstanding);
    b.awaitingDecision = round2(b.awaitingDecision + awaiting);
    b.claims.push(row);
  }

  return {
    total: {
      count: rows.length,
      amount: round2(rows.reduce((sum, r) => sum + r.amount, 0)),
      outstanding: round2(rows.reduce((sum, r) => sum + r.outstanding, 0)),
      awaitingDecision: round2(rows.reduce((sum, r) => sum + r.awaiting, 0)),
    },
    byPayer: groupByPayer(rows, (r) => r.amount),
    buckets: Object.entries(buckets).map(([range, b]) => ({
      range,
      count: b.count,
      amount: b.amount,
      outstanding: b.outstanding,
      awaitingDecision: b.awaitingDecision,
      claims: b.claims.slice(0, 50).map((c) => ({
        id: c.id,
        claimNumber: c.claimNumber,
        patient: c.patient,
        insurer: resolveClaimPayer(c),
        status: c.status,
        outstandingAmount: c.amount,
        submissionDate: c.submissionDate,
      })),
    })),
    definitions: INSURANCE_METRIC_DEFINITIONS,
  };
}

export async function getOutstandingReport(tenantId: string, filters: ReportFilters) {
  const claims = await prisma.insuranceClaim.findMany({
    where: { ...reportWhere(tenantId, filters), status: { in: [...CLAIM_RECEIVABLE_STATUSES] } },
    select: REPORT_CLAIM_SELECT,
    orderBy: { approvalDate: 'asc' },
  });

  // Same per-claim rule as the dashboard's Outstanding (gap 290).
  const rows = claims
    .map((c) => ({ ...c, outstanding: claimOutstanding(c) }))
    .filter((r) => r.outstanding > 0);
  const totalOutstanding = round2(rows.reduce((sum, r) => sum + r.outstanding, 0));

  return {
    totalOutstanding,
    count: rows.length,
    byPayer: groupByPayer(rows, (r) => r.outstanding),
    claims: rows.map((c) => ({
      id: c.id,
      claimNumber: c.claimNumber,
      patient: c.patient,
      insurer: resolveClaimPayer(c),
      policyNumber: c.policy?.policyNumber ?? null,
      status: c.status,
      claimAmount: decNum(c.claimAmount),
      approvedAmount: decNum(c.approvedAmount),
      paidAmount: decNum(c.paidAmount),
      writtenOffAmount: decNum(c.writtenOffAmount),
      outstandingAmount: c.outstanding,
      submissionDate: c.submissionDate,
      approvalDate: c.approvalDate,
    })),
    definitions: INSURANCE_METRIC_DEFINITIONS,
  };
}

// ============================================================
// TPA Communication Logs
// ============================================================

/** What the list and the claim/pre-auth panels need to render one entry. */
const tpaLogInclude = {
  claim: { select: { id: true, claimNumber: true, status: true } },
  preAuth: { select: { id: true, procedureDescription: true, status: true } },
  tpa: { select: { id: true, name: true } },
  communicator: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.TpaCommunicationLogInclude;

/**
 * Record an interaction with a TPA or insurer.
 *
 * Whichever of claim / pre-auth / TPA the caller names is checked against the
 * caller's own tenant before it is stored: these ids arrive from the client,
 * and an unchecked one would file this hospital's log against another's claim.
 *
 * When the caller names a claim or pre-auth but no TPA, the TPA is taken from
 * the policy behind it, so a log lands under the right provider without the
 * user having to restate it. A policy that names no TPA leaves it null — the
 * hospital is dealing with the insurer directly.
 */
export async function createTpaLog(tenantId: string, userId: string, data: CreateTpaLogInput) {
  let resolvedTpaId: string | null = data.tpaId ?? null;

  if (data.tpaId) {
    const tpa = await prisma.tpaProvider.findFirst({
      where: { id: data.tpaId, tenantId },
      select: { id: true },
    });
    if (!tpa) throw AppError.notFound('TPA provider not found');
  }

  if (data.claimId) {
    const claim = await prisma.insuranceClaim.findFirst({
      where: { id: data.claimId, tenantId },
      select: { id: true, policy: { select: { tpaId: true } } },
    });
    if (!claim) throw AppError.notFound('Insurance claim not found');
    resolvedTpaId = resolvedTpaId ?? claim.policy?.tpaId ?? null;
  }

  if (data.preAuthId) {
    const preAuth = await prisma.preAuthorizationRequest.findFirst({
      where: { id: data.preAuthId, tenantId },
      select: { id: true, policy: { select: { tpaId: true } } },
    });
    if (!preAuth) throw AppError.notFound('Pre-authorization request not found');
    resolvedTpaId = resolvedTpaId ?? preAuth.policy?.tpaId ?? null;
  }

  const log = await prisma.tpaCommunicationLog.create({
    data: {
      tenantId,
      claimId: data.claimId ?? null,
      preAuthId: data.preAuthId ?? null,
      tpaId: resolvedTpaId,
      communicationType: data.communicationType,
      direction: data.direction,
      subject: data.subject,
      content: data.content ?? null,
      isSystem: false,
      communicatedBy: userId,
    },
    include: tpaLogInclude,
  });

  logger.info(
    { tenantId, logId: log.id, claimId: data.claimId, preAuthId: data.preAuthId },
    'TPA communication logged',
  );
  return log;
}

export async function getTpaLogs(tenantId: string, query: any) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.claimId) where.claimId = query.claimId;
  if (query.preAuthId) where.preAuthId = query.preAuthId;
  if (query.tpaId) where.tpaId = query.tpaId;
  if (query.direction) where.direction = query.direction;
  if (query.communicationType) where.communicationType = query.communicationType;
  if (query.isSystem !== undefined) where.isSystem = query.isSystem;

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { subject: { contains: query.search, mode: 'insensitive' } },
      { content: { contains: query.search, mode: 'insensitive' } },
      { claim: { claimNumber: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [logs, total] = await Promise.all([
    prisma.tpaCommunicationLog.findMany({
      where,
      skip,
      take,
      include: tpaLogInclude,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.tpaCommunicationLog.count({ where }),
  ]);

  return { logs, total, page, limit };
}

/**
 * "Claim CLM-20260901-0001", or plain "Claim" before a number is issued —
 * `claimNumber` is nullable, and interpolating it raw yields "Claim  approved"
 * with a hole where the number should be.
 */
function claimRef(claimNumber: string | null | undefined): string {
  return claimNumber ? `Claim ${claimNumber}` : 'Claim';
}

/** What the lifecycle hands the recorder when a claim or pre-auth moves. */
interface RecordTpaCommunicationParams {
  tenantId: string;
  claimId?: string | null;
  preAuthId?: string | null;
  /** Who performed the action. Null for a scheduled job. */
  userId?: string | null;
  direction: 'inbound' | 'outbound';
  subject: string;
  content?: string | null;
}

/**
 * Record a lifecycle step against the TPA log, best effort.
 *
 * Deliberately outside the caller's transaction and deliberately unable to
 * throw: an audit note that fails must never roll back the claim approval it
 * was describing. Same contract as `notifyUsers` — it reports whether it wrote
 * and swallows the reason if it did not.
 *
 * `portal` is the recorded type because these entries describe what the
 * hospital did through its own system rather than a call or a letter, and
 * `isSystem` marks them so nobody reads one as a colleague's note.
 */
export async function recordTpaCommunication(
  params: RecordTpaCommunicationParams,
): Promise<boolean> {
  try {
    let tpaId: string | null = null;

    if (params.claimId) {
      const claim = await prisma.insuranceClaim.findFirst({
        where: { id: params.claimId, tenantId: params.tenantId },
        select: { policy: { select: { tpaId: true } } },
      });
      tpaId = claim?.policy?.tpaId ?? null;
    } else if (params.preAuthId) {
      const preAuth = await prisma.preAuthorizationRequest.findFirst({
        where: { id: params.preAuthId, tenantId: params.tenantId },
        select: { policy: { select: { tpaId: true } } },
      });
      tpaId = preAuth?.policy?.tpaId ?? null;
    }

    await prisma.tpaCommunicationLog.create({
      data: {
        tenantId: params.tenantId,
        claimId: params.claimId ?? null,
        preAuthId: params.preAuthId ?? null,
        tpaId,
        communicationType: 'portal',
        direction: params.direction,
        // subject is VarChar(255); an over-long one would fail the insert and,
        // because this recorder swallows its errors, lose the entry in silence.
        subject: params.subject.slice(0, 255),
        content: params.content ?? null,
        isSystem: true,
        communicatedBy: params.userId ?? null,
      },
    });
    return true;
  } catch (err) {
    logger.warn(
      { err, claimId: params.claimId, preAuthId: params.preAuthId },
      'TPA communication log write failed — the action itself is unaffected',
    );
    return false;
  }
}
