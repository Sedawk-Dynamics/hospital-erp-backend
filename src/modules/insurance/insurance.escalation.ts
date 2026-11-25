import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { writeAudit } from '../../shared/audit';
import { SYSTEM_ROLE_NAMES } from '../../shared/role-permissions';

/**
 * Gap 294: admin-configured SLA escalation.
 *
 * The SLA job used to escalate every breached request at the instant of the
 * breach, to a hard-coded list of roles. Each hospital now sets, per kind of
 * request, how many hours past its deadline a breached request waits before it
 * is escalated, and which staff role it goes to. A missing row means the
 * default below, which keeps the old behaviour as close as `hours > 0` allows:
 * the hospital administrator hears about it one hour after the breach.
 */

export const ESCALATION_REQUEST_TYPES = ['preauth', 'final_discharge', 'claim_query'] as const;
export type EscalationRequestType = (typeof ESCALATION_REQUEST_TYPES)[number];

export const ESCALATION_LABELS: Record<EscalationRequestType, string> = {
  preauth: 'Pre-authorisation (initial and enhancement)',
  final_discharge: 'Final discharge authorisation',
  claim_query: 'Payer query on a claim',
};

export interface EscalationRule {
  escalateAfterHours: number;
  targetRole: string;
}

export const DEFAULT_ESCALATION: Record<EscalationRequestType, EscalationRule> = {
  preauth: { escalateAfterHours: 1, targetRole: 'admin' },
  final_discharge: { escalateAfterHours: 1, targetRole: 'admin' },
  claim_query: { escalateAfterHours: 1, targetRole: 'admin' },
};

/** Upper bound on the wait: 30 days. Anything longer is not an escalation. */
export const MAX_ESCALATION_HOURS = 720;

/** Not staff: a patient account or the platform operator cannot be paged. */
const NON_STAFF_ROLES = ['patient', 'super_admin'];

/** Which escalation rule governs a pre-authorisation of this request type. */
export function escalationTypeForPreAuth(requestType: string | null | undefined): 'preauth' | 'final_discharge' {
  return requestType === 'finalDischarge' ? 'final_discharge' : 'preauth';
}

/** When a breached item becomes due for escalation. */
export function escalationDueAt(deadline: Date, rule: EscalationRule): Date {
  return new Date(deadline.getTime() + rule.escalateAfterHours * 60 * 60 * 1000);
}

/** The hospital's rules, defaults filled in for any type not yet configured. */
export async function resolveEscalationRules(tenantId: string): Promise<Record<EscalationRequestType, EscalationRule>> {
  const rules: Record<EscalationRequestType, EscalationRule> = {
    preauth: { ...DEFAULT_ESCALATION.preauth },
    final_discharge: { ...DEFAULT_ESCALATION.final_discharge },
    claim_query: { ...DEFAULT_ESCALATION.claim_query },
  };
  const rows = await prisma.insuranceEscalationSetting.findMany({ where: { tenantId } });
  for (const row of rows ?? []) {
    if ((ESCALATION_REQUEST_TYPES as readonly string[]).includes(row.requestType)) {
      rules[row.requestType as EscalationRequestType] = {
        escalateAfterHours: row.escalateAfterHours,
        targetRole: row.targetRole,
      };
    }
  }
  return rules;
}

/** Staff roles this hospital has — the only valid escalation targets. */
async function staffRoles(tenantId: string): Promise<Array<{ name: string; description: string | null }>> {
  const rows = await prisma.role.findMany({
    where: { tenantId, name: { notIn: NON_STAFF_ROLES } },
    select: { name: true, description: true },
    orderBy: { name: 'asc' },
  });
  if (rows?.length) return rows;
  // A tenant without seeded roles still has the system ones.
  return SYSTEM_ROLE_NAMES.filter((name) => !NON_STAFF_ROLES.includes(name)).map((name) => ({ name, description: null }));
}

export async function getEscalationSettings(tenantId: string) {
  const [rows, roles] = await Promise.all([
    prisma.insuranceEscalationSetting.findMany({ where: { tenantId } }),
    staffRoles(tenantId),
  ]);
  const byType = new Map((rows ?? []).map((row) => [row.requestType, row]));
  return {
    settings: ESCALATION_REQUEST_TYPES.map((requestType) => {
      const row = byType.get(requestType);
      return {
        requestType,
        label: ESCALATION_LABELS[requestType],
        escalateAfterHours: row?.escalateAfterHours ?? DEFAULT_ESCALATION[requestType].escalateAfterHours,
        targetRole: row?.targetRole ?? DEFAULT_ESCALATION[requestType].targetRole,
        isDefault: !row,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      };
    }),
    roles,
    maxHours: MAX_ESCALATION_HOURS,
  };
}

export interface EscalationSettingInput {
  requestType: EscalationRequestType;
  escalateAfterHours: number;
  targetRole: string;
}

export async function updateEscalationSettings(tenantId: string, userId: string, items: EscalationSettingInput[]) {
  if (!items.length) throw AppError.badRequest('Nothing to save');
  const seen = new Set<string>();
  for (const item of items) {
    if (!(ESCALATION_REQUEST_TYPES as readonly string[]).includes(item.requestType)) {
      throw AppError.badRequest(`Unknown request type "${item.requestType}"`);
    }
    if (seen.has(item.requestType)) throw AppError.badRequest(`"${item.requestType}" is listed twice`);
    seen.add(item.requestType);
    if (!Number.isInteger(item.escalateAfterHours) || item.escalateAfterHours <= 0 || item.escalateAfterHours > MAX_ESCALATION_HOURS) {
      throw AppError.badRequest(`Escalate-after hours must be a whole number from 1 to ${MAX_ESCALATION_HOURS}`);
    }
  }

  // The role must be a real staff role of THIS hospital — otherwise the
  // escalation would page nobody.
  const roles = new Set((await staffRoles(tenantId)).map((role) => role.name));
  for (const item of items) {
    if (!roles.has(item.targetRole)) {
      throw AppError.badRequest(`"${item.targetRole}" is not a staff role in this hospital`, 'INVALID_ESCALATION_ROLE');
    }
  }

  const before = await resolveEscalationRules(tenantId);
  await prisma.$transaction(async (tx) => {
    for (const item of items) {
      await tx.insuranceEscalationSetting.upsert({
        where: { tenantId_requestType: { tenantId, requestType: item.requestType } },
        create: { tenantId, requestType: item.requestType, escalateAfterHours: item.escalateAfterHours, targetRole: item.targetRole, updatedBy: userId },
        update: { escalateAfterHours: item.escalateAfterHours, targetRole: item.targetRole, updatedBy: userId },
      });
    }
  });

  await writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'insurance_escalation_setting',
    entityId: tenantId,
    description: `Insurance SLA escalation updated: ${items
      .map((item) => `${ESCALATION_LABELS[item.requestType]} → ${item.targetRole} after ${item.escalateAfterHours}h`)
      .join('; ')}`,
    oldValues: Object.fromEntries(items.map((item) => [item.requestType, before[item.requestType]])),
    newValues: Object.fromEntries(items.map((item) => [item.requestType, { escalateAfterHours: item.escalateAfterHours, targetRole: item.targetRole }])),
  });
  logger.info({ tenantId, items }, 'Insurance escalation settings updated');
  return getEscalationSettings(tenantId);
}

// ---------------------------------------------------------------------------
// Closing a stale request
// ---------------------------------------------------------------------------

export const MIN_CLOSE_REASON_LENGTH = 10;

/**
 * Close an overdue pre-authorisation that will never be decided (payer went
 * silent, patient discharged as cash, request superseded…). A reason is
 * mandatory and kept with who/when, and the request leaves the overdue queue.
 * Only an overdue (past decision deadline) pending / on-hold request qualifies:
 * anything else should be decided or cancelled through the normal actions.
 */
export async function closeStalePreAuth(tenantId: string, userId: string, id: string, rawReason: string | null | undefined) {
  const reason = (rawReason ?? '').trim();
  if (reason.length < MIN_CLOSE_REASON_LENGTH) {
    throw AppError.badRequest(`A reason of at least ${MIN_CLOSE_REASON_LENGTH} characters is required to close a request`);
  }
  const existing = await prisma.preAuthorizationRequest.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Pre-authorization request not found');
  if (!['pending', 'on_hold'].includes(existing.status)) {
    throw AppError.badRequest('Only a pending or on-hold request can be closed');
  }
  const now = new Date();
  if (!existing.decisionDueAt || existing.decisionDueAt > now) {
    throw AppError.badRequest('This request is not overdue yet — decide or cancel it instead of closing it as stale');
  }

  const closed = await prisma.$transaction(async (tx) => {
    // Conditional on the status read above: a decision that lands in between
    // wins, and this close fails instead of overwriting it.
    const updated = await tx.preAuthorizationRequest.updateMany({
      where: { id, tenantId, status: { in: ['pending', 'on_hold'] } },
      data: { status: 'cancelled', closedAt: now, closedBy: userId, closeReason: reason },
    });
    if (updated.count !== 1) throw AppError.conflict('The request changed while you were closing it — refresh and try again');
    await tx.insuranceAuditEvent.create({
      data: {
        tenantId,
        actorId: userId,
        insuranceCaseId: existing.insuranceCaseId,
        preAuthId: id,
        eventType: 'preauth.closed_stale',
        fromStatus: existing.status,
        toStatus: 'cancelled',
        details: {
          reason,
          decisionDueAt: existing.decisionDueAt!.toISOString(),
          overdueMinutes: Math.round((now.getTime() - existing.decisionDueAt!.getTime()) / 60_000),
          escalatedAt: existing.escalatedAt?.toISOString() ?? null,
        },
      },
    });
    return tx.preAuthorizationRequest.findFirst({ where: { id, tenantId } });
  });

  await writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'pre_authorization_request',
    entityId: id,
    description: `Closed overdue pre-authorisation ${existing.requestNumber} as stale`,
    reason,
    oldValues: { status: existing.status, decisionDueAt: existing.decisionDueAt },
    newValues: { status: 'cancelled', closedAt: now, closedBy: userId, closeReason: reason },
  });
  logger.info({ tenantId, preAuthId: id }, 'Stale pre-authorization closed');
  return closed;
}

/**
 * Gap 294 (retest): the same "close with reason" for a payer query that will
 * never be answered or resolved. An open query qualifies once its response is
 * overdue; a query we already answered (responseSubmitted) qualifies at any
 * time, because it is only waiting on the payer to resolve it. The query moves
 * to `closed`, leaves the open-query counts and the escalation job, and keeps
 * who/when/why.
 */
export async function closeStaleClaimQuery(
  tenantId: string,
  userId: string,
  queryId: string,
  rawReason: string | null | undefined,
) {
  const reason = (rawReason ?? '').trim();
  if (reason.length < MIN_CLOSE_REASON_LENGTH) {
    throw AppError.badRequest(`A reason of at least ${MIN_CLOSE_REASON_LENGTH} characters is required to close a query`);
  }
  const existing = await prisma.claimQuery.findFirst({
    where: { id: queryId, tenantId },
    include: { claim: { select: { id: true, claimNumber: true, insuranceCaseId: true } } },
  });
  if (!existing) throw AppError.notFound('Claim query not found');
  if (!['open', 'responseSubmitted'].includes(existing.status)) {
    throw AppError.badRequest('Only an open or answered query can be closed');
  }
  const now = new Date();
  if (existing.status === 'open' && (!existing.responseDueAt || existing.responseDueAt > now)) {
    throw AppError.badRequest('This query is not overdue yet — respond to it instead of closing it as stale');
  }

  const closed = await prisma.$transaction(async (tx) => {
    // Conditional on the status read above, so a response or resolution that
    // lands in between wins and this close fails instead of overwriting it.
    const updated = await tx.claimQuery.updateMany({
      where: { id: queryId, tenantId, status: existing.status },
      data: { status: 'closed', closedAt: now, closedBy: userId, closeReason: reason },
    });
    if (updated.count !== 1) throw AppError.conflict('The query changed while you were closing it — refresh and try again');
    // Same as resolving the last query: with nothing left outstanding, a claim
    // that was waiting on queries goes back to review. A claim already past
    // that stage (approved, settled…) is left as it is.
    const remaining = await tx.claimQuery.count({
      where: { claimId: existing.claimId, id: { not: queryId }, status: { in: ['open', 'responseSubmitted'] } },
    });
    const claimRow = await tx.insuranceClaim.findFirst({ where: { id: existing.claimId, tenantId }, select: { status: true } });
    if (!remaining && claimRow && ['query_raised', 'response_submitted'].includes(claimRow.status)) {
      await tx.insuranceClaim.update({ where: { id: existing.claimId }, data: { status: 'under_review' } });
      if (existing.claim?.insuranceCaseId) {
        await tx.insuranceCase.update({ where: { id: existing.claim.insuranceCaseId }, data: { status: 'claimSubmitted' } });
      }
    }
    await tx.insuranceAuditEvent.create({
      data: {
        tenantId,
        actorId: userId,
        insuranceCaseId: existing.claim?.insuranceCaseId ?? null,
        claimId: existing.claimId,
        eventType: 'claim_query.closed_stale',
        fromStatus: existing.status,
        toStatus: 'closed',
        details: {
          queryId,
          subject: existing.subject,
          reason,
          responseDueAt: existing.responseDueAt?.toISOString() ?? null,
          escalatedAt: existing.escalatedAt?.toISOString() ?? null,
        },
      },
    });
    return tx.claimQuery.findFirst({ where: { id: queryId, tenantId } });
  });

  await writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'claim_query',
    entityId: queryId,
    description: `Closed stale payer query "${existing.subject}" on claim ${existing.claim?.claimNumber ?? existing.claimId}`,
    reason,
    oldValues: { status: existing.status, responseDueAt: existing.responseDueAt },
    newValues: { status: 'closed', closedAt: now, closedBy: userId, closeReason: reason },
  });
  logger.info({ tenantId, claimQueryId: queryId }, 'Stale claim query closed');
  return closed;
}
