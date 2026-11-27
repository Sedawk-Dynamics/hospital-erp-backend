import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { formatDateIST, istDateStr, istDayRange, istDayStart } from '../shared/date.utils';
import { sweepExpiredPoliciesAndPreAuths } from '../modules/insurance/insurance.service';
import { usersWithRoles } from '../shared/notify';
import { fullName } from '../shared/person-name';
import { writeNotificationOnce } from '../modules/communication/notification-writer';
import {
  escalationDueAt,
  escalationTypeForPreAuth,
  resolveEscalationRules,
} from '../modules/insurance/insurance.escalation';
import {
  CLAIM_DEADLINE_OPEN_STATUSES,
  claimExpiredBefore,
  describeClaimDeadline,
} from '../modules/insurance/insurance.metrics';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** How far back a first run looks for already-expired open claims. */
const EXPIRED_ALERT_LOOKBACK_DAYS = 30;

// Look up users to notify when policy/pre-auth alerts have no obvious owner.
// Tenant admins + insurance_staff get pinged so the deadline isn't missed.
/**
 * Who chases an expiring policy, claim or pre-auth. Goes through the shared
 * resolver so `admin` reaches the hospital's OWNER too — their account sits on
 * the platform tenant, so the tenant-scoped query this replaces could not see
 * them, and a hospital whose only administrator is its owner was told nothing.
 */
async function getInsuranceRecipients(tenantId: string): Promise<string[]> {
  return usersWithRoles(tenantId, ['admin', 'insurance_staff', 'billing_admin']);
}

/**
 * Gap 295: one row per event + record + user + reminder stage, enforced by the
 * unique dedupe key (notification-writer) — the old read-then-insert let two
 * overlapping runs (server start + the timer) both write. Returns true only
 * when a new row was written.
 */
async function createNotificationOnce(data: {
  tenantId: string;
  userId: string;
  title: string;
  message: string;
  referenceType: string;
  referenceId: string;
  eventKey: string;
  reminderStage: string;
}) {
  const { created } = await writeNotificationOnce({ ...data, notificationType: 'alert', channel: 'in_app' });
  return created;
}

/**
 * The people who work the insurance desk: they get the warning and breach
 * alerts. Escalation beyond them goes to the role the hospital configured.
 */
async function getSlaWorkingTeam(tenantId: string): Promise<string[]> {
  return usersWithRoles(tenantId, ['insurance_staff']);
}

/**
 * Users holding the configured escalation role. When nobody holds it (role
 * emptied after it was configured), fall back to the hospital administrator so
 * the escalation still reaches a person — and say so in the history.
 */
async function escalationRecipients(tenantId: string, targetRole: string): Promise<{ userIds: string[]; fallback: boolean }> {
  const userIds = await usersWithRoles(tenantId, [targetRole]);
  if (userIds.length || targetRole === 'admin') return { userIds, fallback: false };
  return { userIds: await usersWithRoles(tenantId, ['admin']), fallback: true };
}

async function notifyAll(
  userIds: Iterable<string>,
  data: Omit<Parameters<typeof createNotificationOnce>[0], 'userId'>,
  logContext: Record<string, unknown>,
): Promise<number> {
  let created = 0;
  for (const userId of userIds) {
    try {
      if (await createNotificationOnce({ ...data, userId })) created += 1;
    } catch (err) {
      logger.warn({ err, ...logContext, userId }, 'Insurance SLA notification failed');
    }
  }
  return created;
}

/**
 * Five-minute operational clock for IRDAI authorization SLAs and payer query
 * deadlines. Notification writes are idempotent, and failures are isolated so
 * they can never roll back a clinical or financial workflow action.
 *
 * Gap 294: escalation follows each hospital's InsuranceEscalationSetting — a
 * breached request is escalated to the configured role once it has been
 * overdue for the configured number of hours, and every escalation is written
 * to the request's audit history.
 */
export async function runInsuranceSlaJob(now = new Date()) {
  const rulesByTenant = new Map<string, ReturnType<typeof resolveEscalationRules>>();
  const rulesFor = (tenantId: string) => {
    let rules = rulesByTenant.get(tenantId);
    if (!rules) {
      rules = resolveEscalationRules(tenantId);
      rulesByTenant.set(tenantId, rules);
    }
    return rules;
  };

  const preAuths = await prisma.preAuthorizationRequest.findMany({
    where: {
      status: { in: ['pending', 'on_hold'] },
      OR: [{ alertAt: { lte: now } }, { decisionDueAt: { lte: now } }],
    },
    include: { patient: { select: { firstName: true, lastName: true } } },
  });

  let authorizationAlerts = 0;
  let escalations = 0;
  for (const preAuth of preAuths) {
    const breached = Boolean(preAuth.decisionDueAt && preAuth.decisionDueAt <= now);
    const finalDischarge = preAuth.requestType === 'finalDischarge';
    const kind = finalDischarge ? 'Final discharge authorization' : 'Pre-authorization';
    const eventKey = finalDischarge ? 'final_discharge_auth_sla' : 'preauth_sla';
    const deadline = preAuth.decisionDueAt ? formatDateIST(preAuth.decisionDueAt) : 'the configured deadline';
    const patientName = fullName(preAuth.patient);

    // Warning / breach: the owner and the insurance desk.
    const team = new Set(await getSlaWorkingTeam(preAuth.tenantId));
    if (preAuth.submittedBy) team.add(preAuth.submittedBy);
    authorizationAlerts += await notifyAll(team, {
      tenantId: preAuth.tenantId,
      title: `${kind} SLA ${breached ? 'breached' : 'warning'}`,
      message: `${preAuth.requestNumber} for ${patientName} ${breached ? 'passed' : 'is approaching'} ${deadline}. Follow up with the payer immediately.`,
      referenceType: 'pre_authorization_request',
      referenceId: preAuth.id,
      eventKey,
      reminderStage: breached ? 'breached' : 'warning',
    }, { preAuthId: preAuth.id });

    // Escalation: the configured role, once the configured hours have passed.
    if (!breached || !preAuth.decisionDueAt || preAuth.escalatedAt) continue;
    const ruleType = escalationTypeForPreAuth(preAuth.requestType);
    const rule = (await rulesFor(preAuth.tenantId))[ruleType];
    if (escalationDueAt(preAuth.decisionDueAt, rule) > now) continue;

    const { userIds, fallback } = await escalationRecipients(preAuth.tenantId, rule.targetRole);
    authorizationAlerts += await notifyAll(userIds, {
      tenantId: preAuth.tenantId,
      title: `${kind} escalated — overdue ${rule.escalateAfterHours}h+`,
      message: `${preAuth.requestNumber} for ${patientName} passed its deadline (${deadline}) and is still undecided. Escalated to ${rule.targetRole.replace(/_/g, ' ')}.`,
      referenceType: 'pre_authorization_request',
      referenceId: preAuth.id,
      eventKey,
      reminderStage: 'escalated',
    }, { preAuthId: preAuth.id });
    escalations += 1;
    try {
      await prisma.$transaction(async (tx) => {
        const marked = await tx.preAuthorizationRequest.updateMany({
          where: { id: preAuth.id, escalatedAt: null },
          data: { escalatedAt: now, escalatedToRole: rule.targetRole },
        });
        // A concurrent run already escalated it: keep one history entry.
        if (!marked.count) return;
        await tx.insuranceAuditEvent.create({
          data: {
            tenantId: preAuth.tenantId,
            insuranceCaseId: preAuth.insuranceCaseId,
            preAuthId: preAuth.id,
            eventType: 'preauth.sla_escalated',
            fromStatus: preAuth.status,
            toStatus: preAuth.status,
            details: {
              ruleType,
              targetRole: rule.targetRole,
              escalateAfterHours: rule.escalateAfterHours,
              decisionDueAt: preAuth.decisionDueAt!.toISOString(),
              recipients: userIds.length,
              fallbackToAdmin: fallback,
            },
          },
        });
      });
    } catch (err) {
      logger.warn({ err, preAuthId: preAuth.id }, 'Recording pre-auth escalation failed');
    }
  }

  // Queries come into view 24h before they are due, so the owner is warned.
  const queryHorizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const queries = await prisma.claimQuery.findMany({
    where: { status: 'open', responseDueAt: { not: null, lte: queryHorizon } },
    include: {
      claim: {
        select: {
          claimNumber: true,
          insuranceCaseId: true,
          patient: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  // escalationLevel: 1 = due within 24h, 2 = overdue, 3 = escalated to the role.
  let queryAlerts = 0;
  for (const query of queries) {
    if (!query.responseDueAt) continue;
    const rule = (await rulesFor(query.tenantId)).claim_query;
    const overdue = query.responseDueAt <= now;
    const escalate = overdue && escalationDueAt(query.responseDueAt, rule) <= now;
    const level = escalate ? 3 : overdue ? 2 : 1;
    if (query.escalationLevel >= level) continue;
    const reference = `${query.claim.claimNumber ?? query.claimId} for ${fullName(query.claim.patient)}: ${query.subject}`;
    const due = formatDateIST(query.responseDueAt);
    const common = { tenantId: query.tenantId, referenceType: 'claim_query', referenceId: query.id, eventKey: 'claim_query_response' };

    if (level === 3) {
      const { userIds, fallback } = await escalationRecipients(query.tenantId, rule.targetRole);
      queryAlerts += await notifyAll(userIds, {
        ...common,
        title: `Insurance query escalated — overdue ${rule.escalateAfterHours}h+`,
        message: `${reference}. The reply was due ${due} and has not been sent. Escalated to ${rule.targetRole.replace(/_/g, ' ')}.`,
        reminderStage: 'escalated',
      }, { queryId: query.id });
      escalations += 1;
      try {
        await prisma.$transaction(async (tx) => {
          const marked = await tx.claimQuery.updateMany({
            where: { id: query.id, escalationLevel: { lt: 3 } },
            data: { escalationLevel: 3, escalatedAt: now, escalatedToRole: rule.targetRole },
          });
          if (!marked.count) return;
          await tx.insuranceAuditEvent.create({
            data: {
              tenantId: query.tenantId,
              claimId: query.claimId,
              insuranceCaseId: query.claim.insuranceCaseId,
              eventType: 'claim_query.sla_escalated',
              details: {
                queryId: query.id,
                targetRole: rule.targetRole,
                escalateAfterHours: rule.escalateAfterHours,
                responseDueAt: query.responseDueAt!.toISOString(),
                recipients: userIds.length,
                fallbackToAdmin: fallback,
              },
            },
          });
        });
      } catch (err) {
        logger.warn({ err, queryId: query.id }, 'Recording claim query escalation failed');
      }
      continue;
    }

    const recipients = new Set<string>();
    if (query.raisedBy) recipients.add(query.raisedBy);
    if (overdue) (await getSlaWorkingTeam(query.tenantId)).forEach((id) => recipients.add(id));
    queryAlerts += await notifyAll(recipients, {
      ...common,
      title: overdue ? 'Insurance query response overdue' : 'Insurance query response due within 24 hours',
      message: `${reference}. Reply by ${due}.`,
      reminderStage: overdue ? 'overdue' : 'due_24h',
    }, { queryId: query.id });
    await prisma.claimQuery.update({ where: { id: query.id }, data: { escalationLevel: level } });
  }

  if (authorizationAlerts || queryAlerts || escalations) {
    logger.info({ authorizationAlerts, queryAlerts, escalations }, 'Insurance SLA alerts processed');
  }
  return { authorizationAlerts, queryAlerts, escalations };
}

/**
 * Daily insurance maintenance:
 *   1. Sweep policies/pre-auths whose validity passed → mark expired.
 *   2. Create in-app notifications for claims/policies/pre-auths approaching
 *      their deadlines (7-day, 3-day, 1-day windows), plus ONE "expired" alert
 *      per claim once its TPA deadline has passed.
 *
 * The job also runs on every server start, so each write goes through
 * createNotificationOnce — one row per event + record + user + reminder stage
 * (gap 295). Days are IST calendar days and claim wording comes from the same
 * rule the dashboard counts with (gap 296).
 */
export async function runInsuranceExpiryJob(now = new Date()) {
  const swept = await sweepExpiredPoliciesAndPreAuths();

  const reminders = [7, 3, 1];
  const today = istDateStr(now);

  for (const days of reminders) {
    const { start, end } = istDayRange(istDateStr(new Date(istDayStart(today).getTime() + days * DAY_MS + HOUR_MS)));

    // --- Claims approaching the TPA deadline ---
    const claims = await prisma.insuranceClaim.findMany({
      where: {
        status: { in: [...CLAIM_DEADLINE_OPEN_STATUSES] },
        expiryDate: { gte: start, lte: end },
      },
      include: {
        patient: { select: { firstName: true, lastName: true } },
      },
    });

    for (const c of claims) {
      const userId = c.submittedBy ?? c.reviewedBy;
      if (!userId || !c.expiryDate) continue;
      const { title, message } = describeClaimDeadline(c as typeof c & { expiryDate: Date }, fullName(c.patient), now);
      await createNotificationOnce({
        tenantId: c.tenantId,
        userId,
        title,
        message,
        referenceType: 'insurance_claim',
        referenceId: c.id,
        eventKey: 'claim_deadline',
        reminderStage: `${days}d`,
      }).catch((err) => logger.warn({ err, claimId: c.id }, 'Claim expiry reminder failed'));
    }

    // --- Policies expiring soon ---
    const policies = await prisma.insurancePolicy.findMany({
      where: { status: 'active', validTo: { gte: start, lte: end } },
      include: { patient: { select: { firstName: true, lastName: true } } },
    });
    for (const p of policies) {
      const insuranceStaff = await getInsuranceRecipients(p.tenantId);
      for (const userId of insuranceStaff) {
        await createNotificationOnce({
          tenantId: p.tenantId,
          userId,
          title: `Policy expiring in ${days} day${days > 1 ? 's' : ''}`,
          message: `Policy ${p.policyNumber} (${fullName(p.patient)}) expires on ${formatDateIST(p.validTo)}.`,
          referenceType: 'insurance_policy',
          referenceId: p.id,
          eventKey: 'policy_expiry',
          reminderStage: `${days}d`,
        }).catch((err) => logger.warn({ err, policyId: p.id }, 'Policy expiry reminder failed'));
      }
    }

    // --- Pre-auths expiring soon ---
    const preAuths = await prisma.preAuthorizationRequest.findMany({
      where: { status: { in: ['approved', 'pending', 'on_hold'] }, validTo: { gte: start, lte: end } },
      include: { patient: { select: { firstName: true, lastName: true } } },
    });
    for (const pa of preAuths) {
      const userId = pa.submittedBy ?? (await getInsuranceRecipients(pa.tenantId))[0];
      if (!userId) continue;
      await createNotificationOnce({
        tenantId: pa.tenantId,
        userId,
        title: `Pre-authorization expiring in ${days} day${days > 1 ? 's' : ''}`,
        message: `Pre-auth ${pa.approvalNumber ?? pa.id} for ${fullName(pa.patient)} is valid until ${pa.validTo ? formatDateIST(pa.validTo) : 'soon'}.`,
        referenceType: 'pre_authorization_request',
        referenceId: pa.id,
        eventKey: 'preauth_expiry',
        reminderStage: `${days}d`,
      }).catch((err) => logger.warn({ err, preAuthId: pa.id }, 'Pre-auth expiry reminder failed'));
    }

    if (claims.length || policies.length || preAuths.length) {
      logger.info({ days, claims: claims.length, policies: policies.length, preAuths: preAuths.length }, 'Insurance expiry reminders sent');
    }
  }

  // --- Claims whose deadline has passed: one "expired" alert each (gap 296).
  // After this no "expiring" reminder can fire — the windows above only look
  // forward. The look-back stops a first run from paging staff about claims
  // that lapsed long ago.
  const expiredBefore = claimExpiredBefore(now);
  const expiredClaims = await prisma.insuranceClaim.findMany({
    where: {
      status: { in: [...CLAIM_DEADLINE_OPEN_STATUSES] },
      expiryDate: { lt: expiredBefore, gte: new Date(expiredBefore.getTime() - EXPIRED_ALERT_LOOKBACK_DAYS * DAY_MS) },
    },
    include: { patient: { select: { firstName: true, lastName: true } } },
  });
  let expiredAlerts = 0;
  for (const c of expiredClaims) {
    const userId = c.submittedBy ?? c.reviewedBy;
    if (!userId || !c.expiryDate) continue;
    const { title, message } = describeClaimDeadline(c as typeof c & { expiryDate: Date }, fullName(c.patient), now);
    try {
      if (await createNotificationOnce({ tenantId: c.tenantId, userId, title, message, referenceType: 'insurance_claim', referenceId: c.id, eventKey: 'claim_deadline', reminderStage: 'expired' })) {
        expiredAlerts += 1;
      }
    } catch (err) {
      logger.warn({ err, claimId: c.id }, 'Claim expired alert failed');
    }
  }
  if (expiredAlerts) logger.info({ expiredAlerts }, 'Insurance claim expired alerts sent');

  return swept;
}
