import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
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
} from './insurance.validation';

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

// ============================================================
// Helpers
// ============================================================

async function generateClaimNumber(tenantId: string): Promise<string> {
  const today = new Date();
  const dateStr =
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, '0') +
    today.getDate().toString().padStart(2, '0');

  const prefix = `CLM-${dateStr}-`;

  const latest = await prisma.insuranceClaim.findFirst({
    where: {
      tenantId,
      claimNumber: { startsWith: prefix },
    },
    orderBy: { claimNumber: 'desc' },
    select: { claimNumber: true },
  });

  let nextNumber = 1;
  if (latest?.claimNumber) {
    const lastNumber = parseInt(latest.claimNumber.split('-').pop() || '0', 10);
    nextNumber = lastNumber + 1;
  }

  const claimNumber = `${prefix}${nextNumber.toString().padStart(4, '0')}`;

  const existing = await prisma.insuranceClaim.findFirst({
    where: { tenantId, claimNumber },
  });

  if (existing) {
    return generateClaimNumber(tenantId);
  }

  return claimNumber;
}

async function generatePreAuthRequestNumber(tenantId: string): Promise<string> {
  const today = new Date();
  const dateStr =
    today.getFullYear().toString() +
    (today.getMonth() + 1).toString().padStart(2, '0') +
    today.getDate().toString().padStart(2, '0');

  const prefix = `PA-${dateStr}-`;

  const latest = await prisma.preAuthorizationRequest.findFirst({
    where: {
      tenantId,
      approvalNumber: { startsWith: prefix },
    },
    orderBy: { approvalNumber: 'desc' },
    select: { approvalNumber: true },
  });

  let nextNumber = 1;
  if (latest?.approvalNumber) {
    const lastNumber = parseInt(latest.approvalNumber.split('-').pop() || '0', 10);
    nextNumber = lastNumber + 1;
  }

  return `${prefix}${nextNumber.toString().padStart(4, '0')}`;
}

// ============================================================
// Insurers
// ============================================================

export async function createInsurer(tenantId: string, data: CreateInsurerInput) {
  const insurer = await prisma.insurer.create({
    data: {
      tenantId,
      name: data.name,
      contactPerson: data.contactPerson,
      phone: data.phone,
      email: data.email,
      address: data.address,
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

  const insurer = await prisma.insurer.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.contactPerson !== undefined && { contactPerson: data.contactPerson }),
      ...(data.phone !== undefined && { phone: data.phone }),
      ...(data.email !== undefined && { email: data.email }),
      ...(data.address !== undefined && { address: data.address }),
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
  const tpa = await prisma.tpaProvider.create({
    data: {
      tenantId,
      name: data.name,
      contactPerson: data.contactPerson,
      phone: data.phone,
      email: data.email,
      address: data.address,
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

  const tpa = await prisma.tpaProvider.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.contactPerson !== undefined && { contactPerson: data.contactPerson }),
      ...(data.phone !== undefined && { phone: data.phone }),
      ...(data.email !== undefined && { email: data.email }),
      ...(data.address !== undefined && { address: data.address }),
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
  // Verify policy exists and belongs to tenant
  const policy = await prisma.insurancePolicy.findFirst({
    where: { id: data.policyId, tenantId },
  });
  if (!policy) {
    throw AppError.notFound('Insurance policy not found');
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
  if (policy.status !== 'active' || policy.validFrom > now || policy.validTo < now) {
    throw AppError.badRequest('Insurance policy is not active for this date');
  }

  // Co-pay / deductible / covered split
  const split = computeResponsibility(
    decNum(data.claimAmount),
    decNum(policy.coPayPercent),
    decNum(policy.deductibleAmount),
    decNum(policy.coverageAmount),
  );

  const claimNumber = await generateClaimNumber(tenantId);
  const expiryDays = data.expiryDays ?? DEFAULT_CLAIM_EXPIRY_DAYS;
  const expiryDate = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000);

  const claim = await prisma.insuranceClaim.create({
    data: {
      tenantId,
      patientId: data.patientId,
      policyId: data.policyId,
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
      submissionDate: now,
      documentsUrl: data.documentsUrl ?? undefined,
      notes: data.notes,
      submittedBy: userId,
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true } },
      bill: { select: { id: true, billNumber: true, totalAmount: true } },
    },
  });

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
  if (query.status) where.status = query.status;

  if (query.fromDate) {
    where.submissionDate = { ...where.submissionDate, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.submissionDate = { ...where.submissionDate, lte: new Date(query.toDate) };
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
          select: { id: true, policyNumber: true },
        },
        bill: {
          select: { id: true, billNumber: true, totalAmount: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.insuranceClaim.count({ where }),
  ]);

  return { claims, total, page, limit };
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
      bill: {
        select: { id: true, billNumber: true, totalAmount: true, status: true },
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
    },
  });

  if (!claim) {
    throw AppError.notFound('Insurance claim not found');
  }

  return claim;
}

export async function updateClaim(tenantId: string, id: string, data: UpdateClaimInput) {
  const existing = await prisma.insuranceClaim.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Insurance claim not found');
  }

  if (existing.status !== 'submitted' && existing.status !== 'resubmitted') {
    throw AppError.badRequest('Can only update claims in submitted or resubmitted status');
  }

  const updateData: any = {};
  if (data.claimAmount !== undefined) updateData.claimAmount = data.claimAmount;
  if (data.notes !== undefined) updateData.rejectionReason = data.notes;
  if (data.documentsUrl !== undefined) updateData.documentsUrl = data.documentsUrl;

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

export async function submitClaim(tenantId: string, id: string) {
  const claim = await prisma.insuranceClaim.findFirst({
    where: { id, tenantId },
  });

  if (!claim) {
    throw AppError.notFound('Insurance claim not found');
  }

  if (claim.status !== 'submitted' && claim.status !== 'resubmitted') {
    throw AppError.badRequest('Claim is not in a submittable status');
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

  if (claim.status !== 'under_review' && claim.status !== 'submitted' && claim.status !== 'resubmitted') {
    throw AppError.badRequest('Claim must be under review or submitted to approve');
  }

  const claimAmount = decNum(claim.claimAmount);
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

  if (
    claim.status !== 'under_review' &&
    claim.status !== 'submitted' &&
    claim.status !== 'resubmitted'
  ) {
    throw AppError.badRequest('Claim must be under review, submitted, or resubmitted to partially approve');
  }

  const claimAmount = decNum(claim.claimAmount);
  if (data.approvedAmount > claimAmount) {
    throw AppError.badRequest('Approved amount cannot exceed claim amount');
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
  const alreadyPaid = decNum(claim.paidAmount);
  const newPaid = round2(alreadyPaid + data.paidAmount);

  if (newPaid > approved + 0.01) {
    throw AppError.badRequest('Total paid cannot exceed approved amount');
  }

  const outstanding = Math.max(0, round2(approved - newPaid));
  const fullySettled = outstanding <= 0.01;

  const updated = await prisma.insuranceClaim.update({
    where: { id },
    data: {
      paidAmount: newPaid,
      outstandingAmount: outstanding,
      settlementDate: fullySettled ? new Date(data.settlementDate ?? new Date()) : claim.settlementDate,
      status: fullySettled ? 'settled' : 'partially_settled',
      notes: data.notes ?? claim.notes,
      reviewedBy: userId,
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true } },
    },
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

  const policy = await prisma.insurancePolicy.findFirst({
    where: { id: original.policyId, tenantId },
  });
  if (!policy) throw AppError.notFound('Insurance policy not found');

  const newAmount = data.claimAmount ?? decNum(original.claimAmount);
  const split = computeResponsibility(
    newAmount,
    decNum(policy.coPayPercent),
    decNum(policy.deductibleAmount),
    decNum(policy.coverageAmount),
  );

  const now = new Date();
  const expiryDays = data.expiryDays ?? DEFAULT_CLAIM_EXPIRY_DAYS;
  const expiryDate = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000);

  // Merge documents
  const mergedDocs = mergeDocuments(original.documentsUrl, data.additionalDocumentsUrl);

  const claimNumber = await generateClaimNumber(tenantId);

  const resubmitted = await prisma.$transaction(async (tx) => {
    // Mark the prior claim as resubmitted (frozen) so it stays visible in history.
    await tx.insuranceClaim.update({
      where: { id: original.id },
      data: { status: 'resubmitted' },
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
        documentsUrl: mergedDocs ?? undefined,
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

  logger.info(
    { tenantId, originalClaimId: original.id, newClaimId: resubmitted.id, claimNumber },
    'Insurance claim resubmitted',
  );
  return resubmitted;
}

function mergeDocuments(existing: Prisma.JsonValue | null, additional: unknown): Prisma.InputJsonValue | null {
  const left = Array.isArray(existing) ? (existing as unknown[]) : existing ? [existing as unknown] : [];
  const right = Array.isArray(additional)
    ? (additional as unknown[])
    : additional !== undefined && additional !== null
      ? [additional]
      : [];
  const merged = [...left, ...right];
  return merged.length ? (merged as Prisma.InputJsonValue) : null;
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
    },
  });

  // Roll back any reservation on the bill (if previously approved).
  await applyBillSplit(tenantId, claim.billId, 0, decNum(claim.claimAmount));

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
  patientPortion: number,
) {
  const bill = await prisma.bill.findFirst({ where: { id: billId, tenantId } });
  if (!bill) return;

  await prisma.bill.update({
    where: { id: billId },
    data: {
      insuranceCoveredAmount: round2(insurancePortion),
      patientPayableAmount: round2(patientPortion),
      balanceDue: round2(Math.max(0, patientPortion - decNum(bill.amountPaid))),
    },
  });
}

export async function splitBill(tenantId: string, billId: string, data: SplitBillInput) {
  const bill = await prisma.bill.findFirst({ where: { id: billId, tenantId } });
  if (!bill) throw AppError.notFound('Bill not found');

  const policy = await prisma.insurancePolicy.findFirst({
    where: { id: data.policyId, tenantId },
    include: { insurer: { select: { id: true, name: true } } },
  });
  if (!policy) throw AppError.notFound('Insurance policy not found');

  const claimAmount = data.claimAmount ?? decNum(bill.totalAmount);
  const split = computeResponsibility(
    claimAmount,
    decNum(policy.coPayPercent),
    decNum(policy.deductibleAmount),
    decNum(policy.coverageAmount),
  );

  await applyBillSplit(tenantId, billId, split.coveredAmount, split.patientResponsibility);

  return {
    billId,
    policy: { id: policy.id, policyNumber: policy.policyNumber, insurer: policy.insurer },
    split,
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

  if (
    claim.status !== 'under_review' &&
    claim.status !== 'submitted' &&
    claim.status !== 'resubmitted'
  ) {
    throw AppError.badRequest('Claim must be under review, submitted, or resubmitted to reject');
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
    documents: claim.documentsUrl ?? [],
    patient: {
      id: claim.patient.id,
      firstName: claim.patient.firstName,
      lastName: claim.patient.lastName,
      phone: (claim.patient as { phone?: string }).phone,
      email: (claim.patient as { email?: string }).email,
    },
    policy: {
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
    },
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
  // Verify policy exists
  const policy = await prisma.insurancePolicy.findFirst({
    where: { id: data.policyId, tenantId },
  });
  if (!policy) {
    throw AppError.notFound('Insurance policy not found');
  }

  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  const preAuth = await prisma.preAuthorizationRequest.create({
    data: {
      tenantId,
      patientId: data.patientId,
      policyId: data.policyId,
      procedureDescription: data.procedureDescription,
      estimatedCost: data.estimatedCost,
      status: 'pending',
      validFrom: data.validFrom ? new Date(data.validFrom) : undefined,
      validTo: data.validTo ? new Date(data.validTo) : undefined,
      notes: data.notes,
      submittedBy: userId,
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true } },
    },
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

export async function approvePreAuth(tenantId: string, id: string, data: ApprovePreAuthInput) {
  const existing = await prisma.preAuthorizationRequest.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Pre-authorization request not found');
  }

  if (existing.status !== 'pending' && existing.status !== 'on_hold') {
    throw AppError.badRequest('Can only approve pending or on-hold pre-authorization requests');
  }

  const approvalNumber = data.approvalNumber || (await generatePreAuthRequestNumber(tenantId));

  const preAuth = await prisma.preAuthorizationRequest.update({
    where: { id },
    data: {
      status: 'approved',
      approvalNumber,
      approvedAmount: data.approvedAmount,
      validFrom: data.validFrom ? new Date(data.validFrom) : existing.validFrom ?? new Date(),
      validTo: data.validTo ? new Date(data.validTo) : existing.validTo ?? undefined,
      holdReason: null,
      notes: data.notes ?? existing.notes,
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true } },
    },
  });

  logger.info({ tenantId, preAuthId: id, approvalNumber }, 'Pre-authorization request approved');
  return preAuth;
}

export async function rejectPreAuth(tenantId: string, id: string, data: RejectPreAuthInput) {
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
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true } },
    },
  });

  logger.info({ tenantId, preAuthId: id }, 'Pre-authorization request denied');
  return preAuth;
}

export async function holdPreAuth(tenantId: string, id: string, data: HoldPreAuthInput) {
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

  logger.info({ tenantId, preAuthId: id }, 'Pre-authorization put on hold');
  return preAuth;
}

export async function releasePreAuthHold(tenantId: string, id: string) {
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

  logger.info({ tenantId, preAuthId: id }, 'Pre-authorization hold released');
  return preAuth;
}

export async function cancelPreAuth(tenantId: string, id: string) {
  const existing = await prisma.preAuthorizationRequest.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Pre-authorization request not found');

  if (existing.status === 'approved' || existing.status === 'denied' || existing.status === 'cancelled') {
    throw AppError.badRequest('Cannot cancel a pre-authorization that is already finalised');
  }

  const preAuth = await prisma.preAuthorizationRequest.update({
    where: { id },
    data: { status: 'cancelled' },
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
      insurer: { select: { id: true, name: true } },
      tpa: { select: { id: true, name: true } },
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
  const now = new Date();
  const cutoff = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

  return prisma.insuranceClaim.findMany({
    where: {
      tenantId,
      status: { in: ['submitted', 'under_review', 'partially_approved', 'resubmitted'] },
      expiryDate: { not: null, gte: now, lte: cutoff },
    },
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

export async function getDashboard(tenantId: string) {
  const now = new Date();
  const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

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
    expiringPreAuths,
    monthClaims,
    aggregates,
    recentClaims,
    recentPreAuths,
  ] = await Promise.all([
    prisma.insuranceClaim.count({ where: { tenantId, status: 'submitted' } }),
    prisma.insuranceClaim.count({ where: { tenantId, status: 'under_review' } }),
    prisma.insuranceClaim.count({ where: { tenantId, status: 'approved' } }),
    prisma.insuranceClaim.count({ where: { tenantId, status: 'partially_approved' } }),
    prisma.insuranceClaim.count({ where: { tenantId, status: 'rejected' } }),
    prisma.insuranceClaim.count({ where: { tenantId, status: 'settled' } }),
    prisma.insuranceClaim.count({ where: { tenantId, status: 'partially_settled' } }),
    prisma.preAuthorizationRequest.count({ where: { tenantId, status: 'pending' } }),
    prisma.preAuthorizationRequest.count({ where: { tenantId, status: 'on_hold' } }),
    prisma.preAuthorizationRequest.count({ where: { tenantId, status: 'approved' } }),
    prisma.insurancePolicy.count({
      where: { tenantId, status: 'active', validTo: { gte: now, lte: sevenDays } },
    }),
    prisma.insuranceClaim.count({
      where: {
        tenantId,
        status: { in: ['submitted', 'under_review', 'partially_approved', 'resubmitted'] },
        expiryDate: { not: null, gte: now, lte: sevenDays },
      },
    }),
    prisma.preAuthorizationRequest.count({
      where: { tenantId, status: { in: ['pending', 'on_hold', 'approved'] }, validTo: { gte: now, lte: sevenDays } },
    }),
    prisma.insuranceClaim.count({ where: { tenantId, createdAt: { gte: startOfMonth } } }),
    prisma.insuranceClaim.aggregate({
      where: { tenantId },
      _sum: {
        claimAmount: true,
        approvedAmount: true,
        paidAmount: true,
        outstandingAmount: true,
      },
    }),
    prisma.insuranceClaim.findMany({
      where: { tenantId },
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

  const totalDecided = approvedClaims + partiallyApprovedClaims + rejectedClaims + settledClaims + partiallySettledClaims;
  const totalApproved = approvedClaims + partiallyApprovedClaims + settledClaims + partiallySettledClaims;
  const approvalRate = totalDecided > 0 ? round2((totalApproved / totalDecided) * 100) : 0;

  return {
    claims: {
      pending: pendingClaims,
      underReview: underReviewClaims,
      approved: approvedClaims,
      partiallyApproved: partiallyApprovedClaims,
      rejected: rejectedClaims,
      settled: settledClaims,
      partiallySettled: partiallySettledClaims,
      totalThisMonth: monthClaims,
      approvalRate,
    },
    preAuth: {
      pending: pendingPreAuths,
      onHold: onHoldPreAuths,
      approved: approvedPreAuths,
    },
    settlement: {
      totalClaimed: decNum(aggregates._sum.claimAmount),
      totalApprovedAmount: decNum(aggregates._sum.approvedAmount),
      totalPaid: decNum(aggregates._sum.paidAmount),
      totalOutstanding: decNum(aggregates._sum.outstandingAmount),
    },
    expiry: {
      policiesIn7Days: expiringPolicies,
      claimsIn7Days: expiringClaims,
      preAuthsIn7Days: expiringPreAuths,
    },
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
  if (filters.fromDate || filters.toDate) {
    where.submissionDate = {};
    if (filters.fromDate) (where.submissionDate as any).gte = new Date(filters.fromDate);
    if (filters.toDate) (where.submissionDate as any).lte = new Date(filters.toDate);
  }
  if (filters.insurerId || filters.tpaId) {
    where.policy = {};
    if (filters.insurerId) (where.policy as any).insurerId = filters.insurerId;
    if (filters.tpaId) (where.policy as any).tpaId = filters.tpaId;
  }
  return where;
}

export async function getClaimsSummaryReport(tenantId: string, filters: ReportFilters) {
  const where = reportWhere(tenantId, filters);

  const groups = await prisma.insuranceClaim.groupBy({
    by: ['status'],
    where,
    _count: true,
    _sum: { claimAmount: true, approvedAmount: true, paidAmount: true },
  });

  const total = await prisma.insuranceClaim.aggregate({
    where,
    _count: true,
    _sum: { claimAmount: true, approvedAmount: true, paidAmount: true, outstandingAmount: true },
  });

  return {
    total: {
      count: total._count,
      claimed: decNum(total._sum.claimAmount),
      approved: decNum(total._sum.approvedAmount),
      paid: decNum(total._sum.paidAmount),
      outstanding: decNum(total._sum.outstandingAmount),
    },
    byStatus: groups.map((g) => ({
      status: g.status,
      count: g._count,
      claimed: decNum(g._sum.claimAmount),
      approved: decNum(g._sum.approvedAmount),
      paid: decNum(g._sum.paidAmount),
    })),
  };
}

export async function getApprovalRateReport(tenantId: string, filters: ReportFilters) {
  const where = reportWhere(tenantId, filters);

  const claims = await prisma.insuranceClaim.findMany({
    where,
    select: {
      status: true,
      claimAmount: true,
      approvedAmount: true,
      policy: { select: { insurer: { select: { id: true, name: true } } } },
    },
  });

  // Roll up by insurer
  const byInsurer = new Map<
    string,
    { id: string; name: string; total: number; approved: number; rejected: number; claimed: number; approvedAmt: number }
  >();
  let total = 0;
  let approved = 0;
  let rejected = 0;
  let claimedAmt = 0;
  let approvedAmt = 0;

  for (const c of claims) {
    const id = c.policy.insurer.id;
    const name = c.policy.insurer.name;
    const row = byInsurer.get(id) ?? {
      id,
      name,
      total: 0,
      approved: 0,
      rejected: 0,
      claimed: 0,
      approvedAmt: 0,
    };
    row.total += 1;
    row.claimed += decNum(c.claimAmount);
    row.approvedAmt += decNum(c.approvedAmount);
    if (
      c.status === 'approved' ||
      c.status === 'partially_approved' ||
      c.status === 'settled' ||
      c.status === 'partially_settled'
    ) {
      row.approved += 1;
      approved += 1;
    }
    if (c.status === 'rejected') {
      row.rejected += 1;
      rejected += 1;
    }
    total += 1;
    claimedAmt += decNum(c.claimAmount);
    approvedAmt += decNum(c.approvedAmount);
    byInsurer.set(id, row);
  }

  return {
    overall: {
      total,
      approved,
      rejected,
      approvalRate: total > 0 ? round2((approved / total) * 100) : 0,
      claimedAmount: round2(claimedAmt),
      approvedAmount: round2(approvedAmt),
    },
    byInsurer: Array.from(byInsurer.values()).map((row) => ({
      insurerId: row.id,
      insurerName: row.name,
      total: row.total,
      approved: row.approved,
      rejected: row.rejected,
      approvalRate: row.total > 0 ? round2((row.approved / row.total) * 100) : 0,
      claimedAmount: round2(row.claimed),
      approvedAmount: round2(row.approvedAmt),
    })),
  };
}

export async function getAgingReport(tenantId: string, filters: ReportFilters) {
  const where: Prisma.InsuranceClaimWhereInput = {
    ...reportWhere(tenantId, filters),
    status: { in: ['submitted', 'under_review', 'approved', 'partially_approved', 'resubmitted', 'partially_settled'] },
  };

  const claims = await prisma.insuranceClaim.findMany({
    where,
    select: {
      id: true,
      claimNumber: true,
      claimAmount: true,
      outstandingAmount: true,
      status: true,
      submissionDate: true,
      policy: { select: { insurer: { select: { id: true, name: true } } } },
      patient: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  const now = Date.now();
  const buckets = {
    '0-30': { count: 0, amount: 0, claims: [] as typeof claims },
    '31-60': { count: 0, amount: 0, claims: [] as typeof claims },
    '61-90': { count: 0, amount: 0, claims: [] as typeof claims },
    '90+': { count: 0, amount: 0, claims: [] as typeof claims },
  };

  for (const c of claims) {
    const ageDays = Math.floor((now - new Date(c.submissionDate).getTime()) / (24 * 60 * 60 * 1000));
    const outstanding = decNum(c.outstandingAmount ?? c.claimAmount);
    let key: keyof typeof buckets;
    if (ageDays <= 30) key = '0-30';
    else if (ageDays <= 60) key = '31-60';
    else if (ageDays <= 90) key = '61-90';
    else key = '90+';
    buckets[key].count += 1;
    buckets[key].amount += outstanding;
    buckets[key].claims.push(c);
  }

  return {
    buckets: Object.entries(buckets).map(([range, b]) => ({
      range,
      count: b.count,
      amount: round2(b.amount),
      claims: b.claims.slice(0, 50).map((c) => ({
        id: c.id,
        claimNumber: c.claimNumber,
        patient: c.patient,
        insurer: c.policy.insurer,
        status: c.status,
        outstandingAmount: decNum(c.outstandingAmount ?? c.claimAmount),
        submissionDate: c.submissionDate,
      })),
    })),
  };
}

export async function getOutstandingReport(tenantId: string, filters: ReportFilters) {
  const where: Prisma.InsuranceClaimWhereInput = {
    ...reportWhere(tenantId, filters),
    status: { in: ['approved', 'partially_approved', 'partially_settled'] },
  };

  const claims = await prisma.insuranceClaim.findMany({
    where,
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      policy: { select: { id: true, policyNumber: true, insurer: { select: { id: true, name: true } } } },
    },
    orderBy: { approvalDate: 'asc' },
  });

  const totalOutstanding = claims.reduce(
    (sum, c) => sum + decNum(c.outstandingAmount ?? c.approvedAmount ?? c.claimAmount),
    0,
  );

  return {
    totalOutstanding: round2(totalOutstanding),
    count: claims.length,
    claims: claims.map((c) => ({
      id: c.id,
      claimNumber: c.claimNumber,
      patient: c.patient,
      insurer: c.policy.insurer,
      policyNumber: c.policy.policyNumber,
      status: c.status,
      claimAmount: decNum(c.claimAmount),
      approvedAmount: decNum(c.approvedAmount),
      paidAmount: decNum(c.paidAmount),
      outstandingAmount: decNum(c.outstandingAmount ?? c.approvedAmount ?? c.claimAmount),
      submissionDate: c.submissionDate,
      approvalDate: c.approvalDate,
    })),
  };
}
