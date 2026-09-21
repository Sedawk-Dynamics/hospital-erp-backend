import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getISTDateStr } from '../../shared/date.utils';
import { normalizeCounterpartyGstin } from '../../shared/gst';
import { getPaginationParams } from '../../shared/pagination';
import type {
  ContractInput,
  CreateInsuranceCaseInput,
  RecordEligibilityInput,
  SettlementInput,
} from './insurance.workflow.validation';

const CASE_INCLUDE = {
  patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true, abhaNumber: true, deceasedAt: true } },
  admission: { select: { id: true, admissionDate: true, dischargeDate: true, status: true, billingCategory: true } },
  visit: { select: { id: true, visitType: true, visitDate: true, doctorId: true } },
  insurer: { select: { id: true, name: true, gstin: true } },
  tpa: { select: { id: true, name: true } },
  corporatePayer: { select: { id: true, name: true, gstin: true } },
  governmentSchemePayer: { select: { id: true, name: true, schemeCode: true } },
  policies: {
    include: { policy: { include: { insurer: { select: { id: true, name: true } }, tpa: { select: { id: true, name: true } } } } },
    orderBy: { sequence: 'asc' as const },
  },
  eligibilityChecks: { orderBy: { checkedAt: 'desc' as const }, take: 5 },
  preAuthRequests: { orderBy: { createdAt: 'desc' as const } },
  claims: { orderBy: { sequence: 'asc' as const } },
  auditEvents: { orderBy: { occurredAt: 'desc' as const }, take: 100 },
} satisfies Prisma.InsuranceCaseInclude;

const CLAIM_WORKFLOW_INCLUDE = {
  patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true, email: true, abhaNumber: true } },
  policy: { include: { insurer: true, tpa: true } },
  insuranceCase: { include: { insurer: true, tpa: true, corporatePayer: true, governmentSchemePayer: true, policies: { include: { policy: true }, orderBy: { sequence: 'asc' as const } } } },
  preAuth: true,
  bill: { include: { billItems: true } },
  documents: { orderBy: [{ name: 'asc' as const }, { version: 'desc' as const }] },
  checklistItems: { orderBy: { createdAt: 'asc' as const } },
  queries: { orderBy: { raisedAt: 'desc' as const } },
  settlements: { orderBy: { settlementDate: 'desc' as const } },
  writeOffs: { orderBy: { createdAt: 'desc' as const } },
  adjustments: { orderBy: { effectiveDate: 'desc' as const } },
  auditEvents: { orderBy: { occurredAt: 'desc' as const } },
} satisfies Prisma.InsuranceClaimInclude;

const CASE_TRANSITIONS: Record<string, string[]> = {
  open: ['eligibilityPending', 'eligible', 'preAuthPending', 'admitted', 'cancelled'],
  eligibilityPending: ['eligible', 'cancelled'],
  eligible: ['preAuthPending', 'authorized', 'admitted', 'cancelled'],
  preAuthPending: ['authorized', 'cancelled'],
  authorized: ['admitted', 'treatment', 'cancelled'],
  admitted: ['treatment', 'dischargeAuthorizationPending', 'discharged'],
  treatment: ['dischargeAuthorizationPending', 'discharged'],
  dischargeAuthorizationPending: ['discharged', 'authorized'],
  discharged: ['claimSubmitted', 'closed'],
  claimSubmitted: ['queryPending', 'approved', 'settled', 'closed'],
  queryPending: ['claimSubmitted', 'approved', 'closed'],
  approved: ['settled', 'closed'],
  settled: ['closed'],
  closed: [],
  cancelled: [],
};

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function money(value: Prisma.Decimal | number | string | null | undefined): number {
  return Number(value ?? 0);
}

async function audit(data: {
  tenantId: string;
  actorId?: string;
  insuranceCaseId?: string | null;
  claimId?: string | null;
  preAuthId?: string | null;
  eventType: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  details?: unknown;
}, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  await tx.insuranceAuditEvent.create({
    data: {
      tenantId: data.tenantId,
      actorId: data.actorId,
      insuranceCaseId: data.insuranceCaseId,
      claimId: data.claimId,
      preAuthId: data.preAuthId,
      eventType: data.eventType,
      fromStatus: data.fromStatus,
      toStatus: data.toStatus,
      details: data.details === undefined ? undefined : asJson(data.details),
    },
  });
}

async function nextCaseNumber(tenantId: string): Promise<string> {
  const prefix = `PAY-${getISTDateStr()}-`;
  const latest = await prisma.insuranceCase.findFirst({
    where: { tenantId, caseNumber: { startsWith: prefix } },
    orderBy: { caseNumber: 'desc' },
    select: { caseNumber: true },
  });
  const next = Number(latest?.caseNumber.split('-').pop() ?? 0) + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

async function nextPreAuthNumber(tenantId: string): Promise<string> {
  const prefix = `PA-${getISTDateStr()}-`;
  const latest = await prisma.preAuthorizationRequest.findFirst({
    where: { tenantId, requestNumber: { startsWith: prefix } },
    orderBy: { requestNumber: 'desc' },
    select: { requestNumber: true },
  });
  const next = Number(latest?.requestNumber.split('-').pop() ?? 0) + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

async function requireCase(tenantId: string, id: string) {
  const item = await prisma.insuranceCase.findFirst({ where: { id, tenantId } });
  if (!item) throw AppError.notFound('Insurance / payer case not found');
  return item;
}

async function requireClaim(tenantId: string, id: string) {
  const claim = await prisma.insuranceClaim.findFirst({ where: { id, tenantId } });
  if (!claim) throw AppError.notFound('Insurance claim not found');
  return claim;
}

async function verifyPayer(tenantId: string, payerType: string, payerId: string) {
  const where = { id: payerId, tenantId, isActive: true };
  const payer = payerType === 'insurer'
    ? await prisma.insurer.findFirst({ where })
    : payerType === 'tpa'
      ? await prisma.tpaProvider.findFirst({ where })
      : payerType === 'corporate'
        ? await prisma.corporatePayer.findFirst({ where })
        : await prisma.governmentSchemePayer.findFirst({ where });
  if (!payer) throw AppError.badRequest(`Selected ${payerType} payer is not active for this hospital`);
}

// ---------------------------------------------------------------------------
// Payer masters
// ---------------------------------------------------------------------------

export async function createCorporatePayer(tenantId: string, data: any) {
  let gst: { gstin: string | null; stateCode: string | null };
  try {
    gst = normalizeCounterpartyGstin(data.gstin);
  } catch (error) {
    throw AppError.badRequest((error as Error).message);
  }
  return prisma.corporatePayer.create({ data: { tenantId, ...data, ...gst } });
}

export async function listCorporatePayers(tenantId: string, query: any) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: Prisma.CorporatePayerWhereInput = { tenantId };
  if (query.isActive !== undefined) where.isActive = query.isActive;
  if (query.search) where.OR = [{ name: { contains: query.search, mode: 'insensitive' } }, { code: { contains: query.search, mode: 'insensitive' } }];
  const [items, total] = await Promise.all([
    prisma.corporatePayer.findMany({ where, skip, take, orderBy: { name: 'asc' } }),
    prisma.corporatePayer.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function createGovernmentScheme(tenantId: string, data: any) {
  return prisma.governmentSchemePayer.create({ data: { tenantId, ...data } });
}

export async function listGovernmentSchemes(tenantId: string, query: any) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: Prisma.GovernmentSchemePayerWhereInput = { tenantId };
  if (query.isActive !== undefined) where.isActive = query.isActive;
  if (query.search) where.OR = [{ name: { contains: query.search, mode: 'insensitive' } }, { schemeCode: { contains: query.search, mode: 'insensitive' } }];
  const [items, total] = await Promise.all([
    prisma.governmentSchemePayer.findMany({ where, skip, take, orderBy: { name: 'asc' } }),
    prisma.governmentSchemePayer.count({ where }),
  ]);
  return { items, total, page, limit };
}

// ---------------------------------------------------------------------------
// Payer cases and eligibility
// ---------------------------------------------------------------------------

export async function createInsuranceCase(tenantId: string, userId: string, data: CreateInsuranceCaseInput) {
  const patient = await prisma.patient.findFirst({ where: { id: data.patientId, tenantId } });
  if (!patient) throw AppError.notFound('Patient not found');
  if (data.admissionId) {
    const admission = await prisma.admission.findFirst({ where: { id: data.admissionId, tenantId, patientId: data.patientId } });
    if (!admission) throw AppError.badRequest('Admission does not belong to this patient');
  }
  if (data.visitId) {
    const visit = await prisma.visit.findFirst({ where: { id: data.visitId, tenantId, patientId: data.patientId } });
    if (!visit) throw AppError.badRequest('Visit does not belong to this patient');
  }
  await verifyPayer(tenantId, data.paymentResponsibleType, data.paymentResponsibleId);
  if (data.claimAdministratorType && data.claimAdministratorId) {
    await verifyPayer(tenantId, data.claimAdministratorType, data.claimAdministratorId);
  }

  const uniquePolicyIds = [...new Set(data.policyIds)];
  const policies = uniquePolicyIds.length
    ? await prisma.insurancePolicy.findMany({ where: { id: { in: uniquePolicyIds }, tenantId, patientId: data.patientId } })
    : [];
  if (policies.length !== uniquePolicyIds.length) throw AppError.badRequest('Every selected policy must belong to this patient and hospital');
  if (data.caseType === 'insurance' && data.insurerId && policies.some((policy) => policy.insurerId !== data.insurerId)) {
    throw AppError.badRequest('All policies in the case must belong to the selected insurer');
  }

  const now = new Date();
  const deceased = Boolean(patient.deceasedAt) || data.priority === 'deceased';
  const created = await prisma.$transaction(async (tx) => {
    const insuranceCase = await tx.insuranceCase.create({
      data: {
        tenantId,
        caseNumber: await nextCaseNumber(tenantId),
        patientId: data.patientId,
        admissionId: data.admissionId,
        visitId: data.visitId,
        caseType: data.caseType,
        settlementMode: data.settlementMode,
        insurerId: data.insurerId,
        tpaId: data.tpaId,
        corporatePayerId: data.corporatePayerId,
        governmentSchemePayerId: data.governmentSchemePayerId,
        paymentResponsibleType: data.paymentResponsibleType,
        paymentResponsibleId: data.paymentResponsibleId,
        claimAdministratorType: data.claimAdministratorType,
        claimAdministratorId: data.claimAdministratorId,
        memberId: data.memberId,
        employeeId: data.employeeId,
        abhaNumber: data.abhaNumber ?? patient.abhaNumber,
        priority: deceased ? 'deceased' : data.priority,
        deceasedProtocol: deceased,
        emergencyIntimationDueAt: data.emergency ? new Date(now.getTime() + 24 * 60 * 60 * 1000) : undefined,
        notes: data.notes,
        createdBy: userId,
        status: uniquePolicyIds.length ? 'eligibilityPending' : 'open',
        policies: uniquePolicyIds.length ? { create: uniquePolicyIds.map((policyId, index) => ({ policyId, sequence: index + 1 })) } : undefined,
      },
    });
    await audit({ tenantId, actorId: userId, insuranceCaseId: insuranceCase.id, eventType: 'case.created', toStatus: insuranceCase.status, details: { caseType: data.caseType, settlementMode: data.settlementMode, policyCount: uniquePolicyIds.length } }, tx);
    return insuranceCase;
  });
  logger.info({ tenantId, insuranceCaseId: created.id }, 'Insurance / payer case created');
  return getInsuranceCase(tenantId, created.id);
}

export async function listInsuranceCases(tenantId: string, query: any) {
  const { skip, take, page, limit } = getPaginationParams(query);
  const where: Prisma.InsuranceCaseWhereInput = { tenantId };
  for (const key of ['patientId', 'admissionId', 'caseType', 'settlementMode', 'status', 'priority'] as const) {
    if (query[key]) (where as any)[key] = query[key];
  }
  if (query.search) {
    where.OR = [
      { caseNumber: { contains: query.search, mode: 'insensitive' } },
      { memberId: { contains: query.search, mode: 'insensitive' } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }
  const [items, total] = await Promise.all([
    prisma.insuranceCase.findMany({ where, skip, take, include: CASE_INCLUDE, orderBy: { createdAt: 'desc' } }),
    prisma.insuranceCase.count({ where }),
  ]);
  return { items, total, page, limit };
}

export async function getInsuranceCase(tenantId: string, id: string) {
  const result = await prisma.insuranceCase.findFirst({ where: { id, tenantId }, include: CASE_INCLUDE });
  if (!result) throw AppError.notFound('Insurance / payer case not found');
  return result;
}

export async function updateInsuranceCaseStatus(tenantId: string, userId: string, id: string, status: string, notes?: string) {
  const existing = await requireCase(tenantId, id);
  if (!CASE_TRANSITIONS[existing.status]?.includes(status)) {
    throw AppError.badRequest(`Case cannot move from ${existing.status} to ${status}`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.insuranceCase.update({ where: { id }, data: { status: status as any, notes: notes ?? existing.notes } });
    await audit({ tenantId, actorId: userId, insuranceCaseId: id, eventType: 'case.status_changed', fromStatus: existing.status, toStatus: status, details: notes ? { notes } : undefined }, tx);
  });
  return getInsuranceCase(tenantId, id);
}

export async function addCasePolicy(tenantId: string, userId: string, id: string, data: any) {
  const insuranceCase = await requireCase(tenantId, id);
  const policy = await prisma.insurancePolicy.findFirst({ where: { id: data.policyId, tenantId, patientId: insuranceCase.patientId } });
  if (!policy) throw AppError.badRequest('Policy does not belong to the case patient');
  const item = await prisma.insuranceCasePolicy.create({ data: { insuranceCaseId: id, ...data } });
  await audit({ tenantId, actorId: userId, insuranceCaseId: id, eventType: 'case.policy_added', details: { policyId: data.policyId, sequence: data.sequence } });
  return item;
}

export async function recordEligibility(tenantId: string, userId: string, id: string, data: RecordEligibilityInput) {
  const insuranceCase = await requireCase(tenantId, id);
  if (data.policyId) {
    const linked = await prisma.insuranceCasePolicy.findFirst({ where: { insuranceCaseId: id, policyId: data.policyId } });
    if (!linked) throw AppError.badRequest('Policy is not linked to this payer case');
  }
  return prisma.$transaction(async (tx) => {
    const result = await tx.policyEligibilityCheck.create({
      data: {
        tenantId,
        patientId: insuranceCase.patientId,
        insuranceCaseId: id,
        policyId: data.policyId,
        isEligible: data.isEligible,
        coverageAvailable: data.coverageAvailable,
        coPayPercent: data.coPayPercent,
        deductibleAmount: data.deductibleAmount,
        roomRentLimit: data.roomRentLimit,
        waitingPeriodMet: data.waitingPeriodMet,
        exclusions: data.exclusions ? asJson(data.exclusions) : undefined,
        source: data.source,
        reference: data.reference,
        rawResponse: data.rawResponse === undefined ? undefined : asJson(data.rawResponse),
        validUntil: data.validUntil,
      },
    });
    const snapshot = { isEligible: data.isEligible, checkedAt: result.checkedAt, coverageAvailable: data.coverageAvailable, coPayPercent: data.coPayPercent, deductibleAmount: data.deductibleAmount, roomRentLimit: data.roomRentLimit, waitingPeriodMet: data.waitingPeriodMet, exclusions: data.exclusions, source: data.source, reference: data.reference };
    await tx.insuranceCase.update({ where: { id }, data: { status: data.isEligible ? 'eligible' : 'eligibilityPending', eligibilitySnapshot: asJson(snapshot) } });
    await audit({ tenantId, actorId: userId, insuranceCaseId: id, eventType: 'eligibility.checked', fromStatus: insuranceCase.status, toStatus: data.isEligible ? 'eligible' : 'eligibilityPending', details: snapshot }, tx);
    return result;
  });
}

export async function recordEmergencyIntimation(tenantId: string, userId: string, id: string, data: any) {
  const existing = await requireCase(tenantId, id);
  const now = new Date();
  const updated = await prisma.insuranceCase.update({ where: { id }, data: { emergencyIntimatedAt: now, notes: data.notes ?? existing.notes } });
  await audit({ tenantId, actorId: userId, insuranceCaseId: id, eventType: 'emergency.intimated', details: { reference: data.reference, dueAt: existing.emergencyIntimationDueAt, late: Boolean(existing.emergencyIntimationDueAt && now > existing.emergencyIntimationDueAt) } });
  return updated;
}

export async function recordPhysicalRelease(tenantId: string, userId: string, id: string, data: any) {
  const existing = await requireCase(tenantId, id);
  const now = new Date();
  const updated = await prisma.insuranceCase.update({
    where: { id },
    data: { physicalReleaseAt: now, releaseUndertaking: data.undertaking, deceasedProtocol: data.deceased || existing.deceasedProtocol, priority: data.deceased ? 'deceased' : existing.priority },
  });
  await audit({ tenantId, actorId: userId, insuranceCaseId: id, eventType: data.deceased ? 'deceased.immediate_release' : 'patient.physical_release', details: { undertaking: data.undertaking, payerSettlementPending: !['settled', 'closed'].includes(existing.status) } });
  return updated;
}

// ---------------------------------------------------------------------------
// Contracts, tariffs and payer-specific requirements
// ---------------------------------------------------------------------------

async function contractNestedData(data: ContractInput) {
  return {
    serviceRates: { create: data.serviceRates.map((item) => ({ ...item })) },
    packageRates: { create: data.packageRates.map((item) => ({ ...item, inclusions: item.inclusions === undefined ? undefined : asJson(item.inclusions), exclusions: item.exclusions === undefined ? undefined : asJson(item.exclusions) })) },
    documentRequirements: { create: data.documentRequirements },
    nonPayableRules: { create: data.nonPayableRules },
  };
}

export async function createContract(tenantId: string, data: ContractInput) {
  await verifyPayer(tenantId, data.payerType, data.payerId);
  const { serviceRates, packageRates, documentRequirements, nonPayableRules, terms, ...base } = data;
  return prisma.payerContract.create({
    data: { tenantId, ...base, terms: terms === undefined ? undefined : asJson(terms), ...(await contractNestedData(data)) },
    include: { serviceRates: true, packageRates: true, documentRequirements: true, nonPayableRules: true },
  });
}

export async function updateContract(tenantId: string, id: string, data: ContractInput) {
  const existing = await prisma.payerContract.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Payer contract not found');
  await verifyPayer(tenantId, data.payerType, data.payerId);
  const { serviceRates, packageRates, documentRequirements, nonPayableRules, terms, ...base } = data;
  await prisma.$transaction(async (tx) => {
    await Promise.all([
      tx.payerServiceRate.deleteMany({ where: { contractId: id } }),
      tx.payerPackageRate.deleteMany({ where: { contractId: id } }),
      tx.payerDocumentRequirement.deleteMany({ where: { contractId: id } }),
      tx.nonPayableItemRule.deleteMany({ where: { contractId: id } }),
    ]);
    await tx.payerContract.update({
      where: { id },
      data: {
        ...base,
        terms: terms === undefined ? undefined : asJson(terms),
        serviceRates: { create: serviceRates },
        packageRates: { create: packageRates.map((item) => ({ ...item, inclusions: item.inclusions === undefined ? undefined : asJson(item.inclusions), exclusions: item.exclusions === undefined ? undefined : asJson(item.exclusions) })) },
        documentRequirements: { create: documentRequirements },
        nonPayableRules: { create: nonPayableRules },
      },
    });
  });
  return getContract(tenantId, id);
}

export async function listContracts(tenantId: string, query: any) {
  const where: Prisma.PayerContractWhereInput = { tenantId };
  if (query.payerType) where.payerType = query.payerType;
  if (query.payerId) where.payerId = query.payerId;
  if (query.activeOn) where.AND = [{ validFrom: { lte: query.activeOn } }, { validTo: { gte: query.activeOn } }, { isActive: true }];
  return prisma.payerContract.findMany({ where, include: { serviceRates: true, packageRates: true, documentRequirements: { orderBy: { sortOrder: 'asc' } }, nonPayableRules: true }, orderBy: { validFrom: 'desc' } });
}

export async function getContract(tenantId: string, id: string) {
  const result = await prisma.payerContract.findFirst({ where: { id, tenantId }, include: { serviceRates: true, packageRates: true, documentRequirements: { orderBy: { sortOrder: 'asc' } }, nonPayableRules: true } });
  if (!result) throw AppError.notFound('Payer contract not found');
  return result;
}

// ---------------------------------------------------------------------------
// SLA-aware pre-authorisation chain
// ---------------------------------------------------------------------------

export async function createEnhancement(tenantId: string, userId: string, parentId: string, data: any) {
  const parent = await prisma.preAuthorizationRequest.findFirst({ where: { id: parentId, tenantId } });
  if (!parent) throw AppError.notFound('Pre-authorization request not found');
  if (!parent.insuranceCaseId) throw AppError.badRequest('Enhancement requires a linked insurance / payer case');
  const now = new Date();
  const created = await prisma.$transaction(async (tx) => {
    const enhancement = await tx.preAuthorizationRequest.create({
      data: {
        tenantId,
        patientId: parent.patientId,
        policyId: parent.policyId,
        insuranceCaseId: parent.insuranceCaseId,
        requestNumber: await nextPreAuthNumber(tenantId),
        requestType: 'enhancement',
        parentRequestId: parent.id,
        admissionId: parent.admissionId,
        visitId: parent.visitId,
        doctorId: parent.doctorId,
        diagnosisCode: data.diagnosisCode ?? parent.diagnosisCode,
        procedureCode: data.procedureCode ?? parent.procedureCode,
        procedureDescription: data.procedureDescription,
        estimatedCost: data.estimatedCost,
        status: 'pending',
        submissionChannel: data.submissionChannel,
        submissionReference: data.submissionReference,
        submittedAt: now,
        alertAt: new Date(now.getTime() + 45 * 60 * 1000),
        decisionDueAt: new Date(now.getTime() + 60 * 60 * 1000),
        notes: data.notes,
        submittedBy: userId,
      },
    });
    await tx.insuranceCase.update({ where: { id: parent.insuranceCaseId! }, data: { status: 'preAuthPending' } });
    await audit({ tenantId, actorId: userId, insuranceCaseId: parent.insuranceCaseId!, preAuthId: enhancement.id, eventType: 'preauth.enhancement_submitted', toStatus: 'pending', details: { parentRequestId: parent.id, decisionDueAt: enhancement.decisionDueAt } }, tx);
    return enhancement;
  });
  return created;
}

export async function requestFinalAuthorization(tenantId: string, userId: string, caseId: string, data: any) {
  const insuranceCase = await prisma.insuranceCase.findFirst({ where: { id: caseId, tenantId }, include: { policies: { orderBy: { sequence: 'asc' } } } });
  if (!insuranceCase) throw AppError.notFound('Insurance / payer case not found');
  if (data.claimId) await requireClaim(tenantId, data.claimId);
  const now = new Date();
  const created = await prisma.$transaction(async (tx) => {
    const preAuth = await tx.preAuthorizationRequest.create({
      data: {
        tenantId,
        patientId: insuranceCase.patientId,
        policyId: insuranceCase.policies[0]?.policyId,
        insuranceCaseId: caseId,
        requestNumber: await nextPreAuthNumber(tenantId),
        requestType: 'finalDischarge',
        admissionId: insuranceCase.admissionId,
        visitId: insuranceCase.visitId,
        procedureDescription: data.procedureDescription,
        estimatedCost: data.finalAmount,
        status: 'pending',
        submissionChannel: data.submissionChannel,
        submissionReference: data.submissionReference,
        submittedAt: now,
        alertAt: new Date(now.getTime() + 150 * 60 * 1000),
        decisionDueAt: new Date(now.getTime() + 180 * 60 * 1000),
        notes: data.notes,
        submittedBy: userId,
      },
    });
    await tx.insuranceCase.update({ where: { id: caseId }, data: { status: 'dischargeAuthorizationPending' } });
    if (data.claimId) await tx.insuranceClaim.update({ where: { id: data.claimId }, data: { preAuthId: preAuth.id, finalAuthorizationRequestedAt: now, finalAuthorizationDueAt: preAuth.decisionDueAt } });
    await audit({ tenantId, actorId: userId, insuranceCaseId: caseId, claimId: data.claimId, preAuthId: preAuth.id, eventType: 'final_authorization.requested', toStatus: 'pending', details: { decisionDueAt: preAuth.decisionDueAt, finalAmount: data.finalAmount } }, tx);
    return preAuth;
  });
  return created;
}

export async function getSlaQueue(tenantId: string) {
  const now = new Date();
  const requests = await prisma.preAuthorizationRequest.findMany({
    where: { tenantId, status: { in: ['pending', 'on_hold'] }, decisionDueAt: { not: null } },
    include: { patient: { select: { id: true, mrn: true, firstName: true, lastName: true } }, insuranceCase: { select: { id: true, caseNumber: true, priority: true } } },
    orderBy: { decisionDueAt: 'asc' },
  });
  return requests.map((item) => ({
    ...item,
    breached: Boolean(item.decisionDueAt && item.decisionDueAt <= now),
    alert: Boolean(item.alertAt && item.alertAt <= now),
    remainingMinutes: item.decisionDueAt ? Math.ceil((item.decisionDueAt.getTime() - now.getTime()) / 60_000) : null,
  }));
}

// ---------------------------------------------------------------------------
// Claim documents, checklist, queries and dossier
// ---------------------------------------------------------------------------

async function activeRequirementsForClaim(tenantId: string, claimId: string) {
  const claim = await prisma.insuranceClaim.findFirst({ where: { id: claimId, tenantId }, include: { insuranceCase: true, policy: true } });
  if (!claim) throw AppError.notFound('Insurance claim not found');
  const payerType = claim.insuranceCase?.paymentResponsibleType ?? 'insurer';
  const payerId = claim.insuranceCase?.paymentResponsibleId ?? claim.policy?.insurerId;
  if (!payerId) return [];
  const today = new Date();
  const contract = await prisma.payerContract.findFirst({
    where: { tenantId, payerType, payerId, isActive: true, validFrom: { lte: today }, validTo: { gte: today } },
    include: { documentRequirements: { where: { OR: [{ appliesTo: null }, { appliesTo: claim.settlementMode }] }, orderBy: { sortOrder: 'asc' } } },
    orderBy: { validFrom: 'desc' },
  });
  return contract?.documentRequirements ?? [];
}

export async function syncClaimChecklist(tenantId: string, claimId: string) {
  await requireClaim(tenantId, claimId);
  const requirements = await activeRequirementsForClaim(tenantId, claimId);
  const defaults = requirements.length ? requirements : [
    { code: 'FINAL_BILL', name: 'Final itemised bill', isRequired: true },
    { code: 'DISCHARGE_SUMMARY', name: 'Discharge summary', isRequired: true },
    { code: 'CLAIM_FORM', name: 'Signed claim form', isRequired: true },
  ];
  await prisma.$transaction(defaults.map((item) => prisma.claimChecklistItem.upsert({
    where: { claimId_requirementCode: { claimId, requirementCode: item.code } },
    create: { claimId, requirementCode: item.code, label: item.name, isRequired: item.isRequired },
    update: { label: item.name, isRequired: item.isRequired },
  })));
  return getClaimChecklist(tenantId, claimId);
}

export async function getClaimChecklist(tenantId: string, claimId: string) {
  await requireClaim(tenantId, claimId);
  const items = await prisma.claimChecklistItem.findMany({ where: { claimId }, orderBy: { createdAt: 'asc' } });
  const required = items.filter((item) => item.isRequired);
  return { items, complete: required.every((item) => item.isComplete), missing: required.filter((item) => !item.isComplete).map((item) => item.label) };
}

export async function addClaimDocument(tenantId: string, userId: string, claimId: string, data: any) {
  await requireClaim(tenantId, claimId);
  const latest = await prisma.claimDocument.findFirst({ where: { claimId, name: data.name }, orderBy: { version: 'desc' }, select: { version: true } });
  return prisma.$transaction(async (tx) => {
    const document = await tx.claimDocument.create({ data: { tenantId, claimId, ...data, version: (latest?.version ?? 0) + 1, uploadedBy: userId } });
    if (data.code) {
      await tx.claimChecklistItem.updateMany({ where: { claimId, requirementCode: data.code }, data: { isComplete: true, documentId: document.id } });
    }
    await audit({ tenantId, actorId: userId, claimId, eventType: 'claim.document_uploaded', details: { documentId: document.id, code: data.code, name: data.name, version: document.version } }, tx);
    return document;
  });
}

export async function verifyClaimDocument(tenantId: string, userId: string, documentId: string, data: any) {
  const existing = await prisma.claimDocument.findFirst({ where: { id: documentId, tenantId } });
  if (!existing) throw AppError.notFound('Claim document not found');
  return prisma.$transaction(async (tx) => {
    const document = await tx.claimDocument.update({ where: { id: documentId }, data: { status: data.status, rejectionReason: data.rejectionReason, verifiedBy: userId, verifiedAt: new Date() } });
    if (existing.code) await tx.claimChecklistItem.updateMany({ where: { claimId: existing.claimId, requirementCode: existing.code }, data: { isComplete: data.status === 'verified', documentId: data.status === 'verified' ? documentId : null, notes: data.rejectionReason } });
    await audit({ tenantId, actorId: userId, claimId: existing.claimId, eventType: `claim.document_${data.status}`, details: { documentId, reason: data.rejectionReason } }, tx);
    return document;
  });
}

export async function raiseClaimQuery(tenantId: string, userId: string, claimId: string, data: any) {
  const claim = await requireClaim(tenantId, claimId);
  const due = data.responseDueAt ?? new Date(Date.now() + (data.responseHours ?? 24) * 60 * 60 * 1000);
  return prisma.$transaction(async (tx) => {
    const query = await tx.claimQuery.create({ data: { tenantId, claimId, queryReference: data.queryReference, subject: data.subject, queryText: data.queryText, responseDueAt: due, raisedBy: userId } });
    await tx.insuranceClaim.update({ where: { id: claimId }, data: { status: 'query_raised' } });
    if (claim.insuranceCaseId) await tx.insuranceCase.update({ where: { id: claim.insuranceCaseId }, data: { status: 'queryPending' } });
    await audit({ tenantId, actorId: userId, claimId, insuranceCaseId: claim.insuranceCaseId, eventType: 'claim.query_raised', fromStatus: claim.status, toStatus: 'query_raised', details: { queryId: query.id, responseDueAt: due } }, tx);
    return query;
  });
}

export async function respondClaimQuery(tenantId: string, userId: string, queryId: string, responseText: string) {
  const existing = await prisma.claimQuery.findFirst({ where: { id: queryId, tenantId }, include: { claim: true } });
  if (!existing) throw AppError.notFound('Claim query not found');
  if (existing.status !== 'open') throw AppError.badRequest('Only an open query can be answered');
  return prisma.$transaction(async (tx) => {
    const query = await tx.claimQuery.update({ where: { id: queryId }, data: { status: 'responseSubmitted', responseText, respondedAt: new Date(), respondedBy: userId } });
    await tx.insuranceClaim.update({ where: { id: existing.claimId }, data: { status: 'response_submitted' } });
    await audit({ tenantId, actorId: userId, claimId: existing.claimId, insuranceCaseId: existing.claim.insuranceCaseId, eventType: 'claim.query_response_submitted', fromStatus: existing.claim.status, toStatus: 'response_submitted', details: { queryId } }, tx);
    return query;
  });
}

export async function resolveClaimQuery(tenantId: string, userId: string, queryId: string) {
  const existing = await prisma.claimQuery.findFirst({ where: { id: queryId, tenantId }, include: { claim: true } });
  if (!existing) throw AppError.notFound('Claim query not found');
  return prisma.$transaction(async (tx) => {
    const query = await tx.claimQuery.update({ where: { id: queryId }, data: { status: 'resolved', resolvedAt: new Date() } });
    const remaining = await tx.claimQuery.count({ where: { claimId: existing.claimId, id: { not: queryId }, status: { in: ['open', 'responseSubmitted'] } } });
    if (!remaining) {
      await tx.insuranceClaim.update({ where: { id: existing.claimId }, data: { status: 'under_review' } });
      if (existing.claim.insuranceCaseId) await tx.insuranceCase.update({ where: { id: existing.claim.insuranceCaseId }, data: { status: 'claimSubmitted' } });
    }
    await audit({ tenantId, actorId: userId, claimId: existing.claimId, insuranceCaseId: existing.claim.insuranceCaseId, eventType: 'claim.query_resolved', details: { queryId } }, tx);
    return query;
  });
}

export async function getClaimDossier(tenantId: string, claimId: string) {
  const claim = await prisma.insuranceClaim.findFirst({ where: { id: claimId, tenantId }, include: CLAIM_WORKFLOW_INCLUDE });
  if (!claim) throw AppError.notFound('Insurance claim not found');
  const checklist = await getClaimChecklist(tenantId, claimId);
  return {
    generatedAt: new Date(),
    formatVersion: '1.0',
    claim,
    checklist,
    financialSummary: {
      claimAmount: money(claim.claimAmount), approvedAmount: money(claim.approvedAmount),
      grossPaidAmount: claim.settlements.reduce((sum, item) => sum + money(item.grossPaidAmount), 0),
      netBankReceipts: claim.settlements.reduce((sum, item) => sum + money(item.netPaidAmount), 0),
      tdsReceivable: claim.settlements.reduce((sum, item) => sum + money(item.tdsAmount), 0),
      disallowed: claim.settlements.reduce((sum, item) => sum + money(item.disallowedAmount), 0),
      writtenOff: claim.writeOffs.filter((item) => item.status === 'approved').reduce((sum, item) => sum + money(item.amount), 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Settlement, TDS receivable, write-off and immutable adjustments
// ---------------------------------------------------------------------------

async function recordSettlementWithClient(tx: Prisma.TransactionClient, tenantId: string, userId: string, claimId: string, data: SettlementInput) {
  const claim = await tx.insuranceClaim.findFirst({ where: { id: claimId, tenantId } });
  if (!claim) throw AppError.notFound('Insurance claim not found');
  if (!['approved', 'partially_approved', 'partially_settled', 'settled'].includes(claim.status)) throw AppError.badRequest('Claim must be approved before settlement');
  const settlement = await tx.claimSettlement.create({ data: { tenantId, claimId, ...data, recordedBy: userId } });
  const totals = await tx.claimSettlement.aggregate({ where: { claimId }, _sum: { grossPaidAmount: true, tdsAmount: true, disallowedAmount: true } });
  const grossPaid = money(totals._sum.grossPaidAmount);
  const approved = money(claim.approvedAmount ?? data.grossApprovedAmount);
  const outstanding = Math.max(0, approved - grossPaid);
  const status = outstanding <= 0.009 ? 'settled' : 'partially_settled';
  await tx.insuranceClaim.update({ where: { id: claimId }, data: { paidAmount: grossPaid, tdsReceivableAmount: money(totals._sum.tdsAmount), disallowedAmount: money(totals._sum.disallowedAmount), outstandingAmount: outstanding, settlementDate: data.settlementDate, status } });
  if (claim.insuranceCaseId && status === 'settled') await tx.insuranceCase.update({ where: { id: claim.insuranceCaseId }, data: { status: 'settled' } });
  await audit({ tenantId, actorId: userId, claimId, insuranceCaseId: claim.insuranceCaseId, eventType: 'claim.settlement_recorded', fromStatus: claim.status, toStatus: status, details: { settlementId: settlement.id, grossPaid: data.grossPaidAmount, netPaid: data.netPaidAmount, tdsReceivable: data.tdsAmount, disallowed: data.disallowedAmount } }, tx);
  return settlement;
}

export async function recordSettlement(tenantId: string, userId: string, claimId: string, data: SettlementInput) {
  return prisma.$transaction((tx) => recordSettlementWithClient(tx, tenantId, userId, claimId, data));
}

export async function recordBulkSettlements(tenantId: string, userId: string, settlements: Array<SettlementInput & { claimId: string }>) {
  return prisma.$transaction(async (tx) => {
    const results = [];
    for (const { claimId, ...data } of settlements) results.push(await recordSettlementWithClient(tx, tenantId, userId, claimId, data as SettlementInput));
    return results;
  });
}

export async function requestWriteOff(tenantId: string, userId: string, claimId: string, data: any) {
  const claim = await requireClaim(tenantId, claimId);
  if (data.amount > money(claim.outstandingAmount ?? claim.approvedAmount ?? claim.claimAmount)) throw AppError.badRequest('Write-off cannot exceed claim outstanding');
  return prisma.claimWriteOff.create({ data: { tenantId, claimId, amount: data.amount, reason: data.reason, requestedBy: userId } });
}

export async function decideWriteOff(tenantId: string, userId: string, writeOffId: string, data: any) {
  const existing = await prisma.claimWriteOff.findFirst({ where: { id: writeOffId, tenantId }, include: { claim: true } });
  if (!existing) throw AppError.notFound('Claim write-off request not found');
  if (existing.status !== 'pending') throw AppError.badRequest('Write-off request has already been decided');
  return prisma.$transaction(async (tx) => {
    const result = await tx.claimWriteOff.update({ where: { id: writeOffId }, data: { status: data.decision, decisionNote: data.decisionNote, decidedBy: userId, decidedAt: new Date() } });
    if (data.decision === 'approved') {
      const aggregate = await tx.claimWriteOff.aggregate({ where: { claimId: existing.claimId, status: 'approved' }, _sum: { amount: true } });
      const total = money(aggregate._sum.amount);
      const outstanding = Math.max(0, money(existing.claim.outstandingAmount) - money(existing.amount));
      await tx.insuranceClaim.update({ where: { id: existing.claimId }, data: { writtenOffAmount: total, outstandingAmount: outstanding, status: outstanding <= 0.009 ? 'settled' : existing.claim.status } });
    }
    await audit({ tenantId, actorId: userId, claimId: existing.claimId, insuranceCaseId: existing.claim.insuranceCaseId, eventType: `claim.writeoff_${data.decision}`, details: { writeOffId, amount: money(existing.amount), note: data.decisionNote } }, tx);
    return result;
  });
}

export async function createAdjustment(tenantId: string, userId: string, claimId: string, data: any) {
  const claim = await requireClaim(tenantId, claimId);
  if (claim.status !== 'settled' && claim.status !== 'partially_settled') throw AppError.badRequest('Adjustments are available only after settlement has started');
  const adjustment = await prisma.claimAdjustment.create({ data: { tenantId, claimId, ...data, recordedBy: userId } });
  await audit({ tenantId, actorId: userId, claimId, insuranceCaseId: claim.insuranceCaseId, eventType: 'claim.adjustment_recorded', details: { adjustmentId: adjustment.id, type: data.adjustmentType, amount: data.amount, reference: data.reference } });
  return adjustment;
}

export async function findBankMatches(tenantId: string, bankReference: string) {
  return prisma.claimSettlement.findMany({ where: { tenantId, bankReference: { contains: bankReference, mode: 'insensitive' } }, include: { claim: { select: { id: true, claimNumber: true, patient: { select: { mrn: true, firstName: true, lastName: true } } } } }, orderBy: { settlementDate: 'desc' } });
}

// ---------------------------------------------------------------------------
// Exchange outbox, patient-safe status and analytics
// ---------------------------------------------------------------------------

export async function queueExchange(tenantId: string, userId: string, data: any) {
  if (data.claimId) await requireClaim(tenantId, data.claimId);
  if (data.preAuthId) {
    const preAuth = await prisma.preAuthorizationRequest.findFirst({ where: { id: data.preAuthId, tenantId } });
    if (!preAuth) throw AppError.notFound('Pre-authorization request not found');
  }
  const transactionId = data.transactionId ?? `NHCX-${getISTDateStr()}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const payload = data.channel === 'nhcx' && (data.payload as any)?.resourceType !== 'Bundle'
    ? { resourceType: 'Bundle', type: 'collection', identifier: { system: 'https://nrces.in/ndhm/fhir/r4/NHCX', value: transactionId }, timestamp: new Date().toISOString(), entry: [{ resource: data.payload }] }
    : data.payload;
  const exchange = await prisma.insuranceExchange.create({ data: { tenantId, claimId: data.claimId, preAuthId: data.preAuthId, channel: data.channel, messageType: data.messageType, transactionId, requestPayload: asJson(payload) } });
  await audit({ tenantId, actorId: userId, claimId: data.claimId, preAuthId: data.preAuthId, eventType: 'exchange.queued', details: { exchangeId: exchange.id, channel: data.channel, messageType: data.messageType, transactionId } });
  return exchange;
}

export async function getPatientCaseStatus(tenantId: string, id: string) {
  const item = await prisma.insuranceCase.findFirst({
    where: { id, tenantId },
    select: {
      id: true, caseNumber: true, status: true, settlementMode: true, priority: true, createdAt: true, updatedAt: true,
      patient: { select: { firstName: true, lastName: true, mrn: true } },
      claims: { select: { id: true, claimNumber: true, status: true, submissionDate: true, approvalDate: true, settlementDate: true }, orderBy: { sequence: 'asc' } },
      preAuthRequests: { select: { id: true, requestNumber: true, requestType: true, status: true, createdAt: true, decidedAt: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!item) throw AppError.notFound('Insurance / payer case not found');
  return item;
}

export async function getWorkflowAnalytics(tenantId: string, filters: any) {
  const dateWhere = filters.fromDate || filters.toDate ? { gte: filters.fromDate, lte: filters.toDate } : undefined;
  const caseWhere: Prisma.InsuranceCaseWhereInput = { tenantId, ...(dateWhere ? { createdAt: dateWhere } : {}) };
  if (filters.payerType && filters.payerId) Object.assign(caseWhere, { paymentResponsibleType: filters.payerType, paymentResponsibleId: filters.payerId });
  const cases = await prisma.insuranceCase.findMany({ where: caseWhere, include: { preAuthRequests: true, claims: { include: { queries: true, settlements: true } } } });
  const preAuths = cases.flatMap((item) => item.preAuthRequests);
  const claims = cases.flatMap((item) => item.claims);
  const decided = preAuths.filter((item) => item.submittedAt && item.decidedAt);
  const preAuthTatMinutes = decided.map((item) => (item.decidedAt!.getTime() - item.submittedAt!.getTime()) / 60_000);
  const denials = claims.filter((item) => item.status === 'rejected' || item.status === 'partially_approved');
  const queryItems = claims.flatMap((item) => item.queries);
  const settlementItems = claims.flatMap((item) => item.settlements);
  return {
    cases: { total: cases.length, open: cases.filter((item) => !['closed', 'cancelled'].includes(item.status)).length, cashless: cases.filter((item) => item.settlementMode === 'cashless').length, reimbursement: cases.filter((item) => item.settlementMode === 'reimbursement').length },
    sla: { preAuthDecisions: decided.length, averageDecisionMinutes: preAuthTatMinutes.length ? Math.round(preAuthTatMinutes.reduce((sum, value) => sum + value, 0) / preAuthTatMinutes.length) : 0, breached: decided.filter((item) => item.decisionDueAt && item.decidedAt! > item.decisionDueAt).length, currentlyOverdue: preAuths.filter((item) => ['pending', 'on_hold'].includes(item.status) && item.decisionDueAt && item.decisionDueAt < new Date()).length },
    claims: { total: claims.length, deniedOrPartial: denials.length, denialRate: claims.length ? Number(((denials.length / claims.length) * 100).toFixed(2)) : 0, queriesOpen: queryItems.filter((item) => item.status === 'open').length },
    leakage: { patientShare: claims.reduce((sum, item) => sum + money(item.patientShare), 0), disallowed: settlementItems.reduce((sum, item) => sum + money(item.disallowedAmount), 0), tdsReceivable: settlementItems.reduce((sum, item) => sum + money(item.tdsAmount), 0), insurerDelayLiability: claims.reduce((sum, item) => sum + money(item.delayLiabilityAmount), 0) },
  };
}

export async function markPatientCasesDeceased(tenantId: string, patientId: string, actorId: string, deceasedAt: Date) {
  const cases = await prisma.insuranceCase.findMany({ where: { tenantId, patientId, status: { notIn: ['closed', 'cancelled'] } }, select: { id: true } });
  if (!cases.length) return { count: 0 };
  await prisma.$transaction(async (tx) => {
    await tx.insuranceCase.updateMany({ where: { id: { in: cases.map((item) => item.id) } }, data: { priority: 'deceased', deceasedProtocol: true, physicalReleaseAt: deceasedAt, releaseUndertaking: 'Immediate mortal remains release under deceased-patient protocol' } });
    for (const item of cases) await audit({ tenantId, actorId, insuranceCaseId: item.id, eventType: 'deceased.protocol_activated', details: { deceasedAt, physicalReleaseNotBlockedByPayer: true } }, tx);
  });
  return { count: cases.length };
}
