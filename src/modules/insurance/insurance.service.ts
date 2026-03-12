import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
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
  CreatePreAuthInput,
  UpdatePreAuthInput,
  ApprovePreAuthInput,
  RejectPreAuthInput,
} from './insurance.validation';

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

  const claimNumber = await generateClaimNumber(tenantId);

  const claim = await prisma.insuranceClaim.create({
    data: {
      tenantId,
      patientId: data.patientId,
      policyId: data.policyId,
      billId: data.billId,
      claimNumber,
      claimAmount: data.claimAmount,
      status: 'submitted',
      submissionDate: new Date(),
      documentsUrl: data.documentsUrl ?? undefined,
      submittedBy: userId,
    },
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
  });

  logger.info({ tenantId, claimId: claim.id, claimNumber }, 'Insurance claim created');
  return claim;
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

  if (claim.status !== 'under_review' && claim.status !== 'submitted') {
    throw AppError.badRequest('Claim must be under review or submitted to approve');
  }

  const updated = await prisma.insuranceClaim.update({
    where: { id },
    data: {
      status: 'approved',
      approvedAmount: data.approvedAmount,
      approvalDate: new Date(),
      reviewedBy: userId,
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

  logger.info(
    { tenantId, claimId: id, approvedAmount: data.approvedAmount },
    'Insurance claim approved',
  );
  return updated;
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

  if (claim.status !== 'under_review' && claim.status !== 'submitted') {
    throw AppError.badRequest('Claim must be under review or submitted to reject');
  }

  const updated = await prisma.insuranceClaim.update({
    where: { id },
    data: {
      status: 'rejected',
      rejectionReason: data.rejectionReason,
      reviewedBy: userId,
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

  logger.info({ tenantId, claimId: id }, 'Insurance claim rejected');
  return updated;
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
      notes: data.notes,
      submittedBy: userId,
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

  if (existing.status !== 'pending') {
    throw AppError.badRequest('Can only approve pending pre-authorization requests');
  }

  const approvalNumber =
    data.approvalNumber || (await generatePreAuthRequestNumber(tenantId));

  const preAuth = await prisma.preAuthorizationRequest.update({
    where: { id },
    data: {
      status: 'approved',
      approvalNumber,
      validFrom: data.validFrom ? new Date(data.validFrom) : new Date(),
      validTo: data.validTo ? new Date(data.validTo) : undefined,
      notes: data.notes ?? existing.notes,
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

  if (existing.status !== 'pending') {
    throw AppError.badRequest('Can only deny pending pre-authorization requests');
  }

  const preAuth = await prisma.preAuthorizationRequest.update({
    where: { id },
    data: {
      status: 'denied',
      notes: data.notes,
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

  logger.info({ tenantId, preAuthId: id }, 'Pre-authorization request denied');
  return preAuth;
}
