import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { formatDateIST, istDateStr, istDayRange, istDayStart } from '../shared/date.utils';
import { sweepExpiredPoliciesAndPreAuths } from '../modules/insurance/insurance.service';
import { usersWithRoles } from '../shared/notify';
import { fullName } from '../shared/person-name';
import { writeNotificationOnce } from '../modules/communication/notification-writer';
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
 * Five-minute operational clock for IRDAI authorization SLAs and payer query
 * deadlines. Notification writes are idempotent, and failures are isolated so
 * they can never roll back a clinical or financial workflow action.
 */
export async function runInsuranceSlaJob(now = new Date()) {
  const preAuths = await prisma.preAuthorizationRequest.findMany({
    where: {
      status: { in: ['pending', 'on_hold'] },
      OR: [{ alertAt: { lte: now } }, { decisionDueAt: { lte: now } }],
    },
    include: { patient: { select: { firstName: true, lastName: true } } },
  });

  let authorizationAlerts = 0;
  for (const preAuth of preAuths) {
    const breached = Boolean(preAuth.decisionDueAt && preAuth.decisionDueAt <= now);
    const finalDischarge = preAuth.requestType === 'finalDischarge';
    const recipients = new Set(await getInsuranceRecipients(preAuth.tenantId));
    if (preAuth.submittedBy) recipients.add(preAuth.submittedBy);
    const title = breached
      ? `${finalDischarge ? 'Final discharge authorization' : 'Pre-authorization'} SLA breached`
      : `${finalDischarge ? 'Final discharge authorization' : 'Pre-authorization'} SLA warning`;
    const deadline = preAuth.decisionDueAt ? formatDateIST(preAuth.decisionDueAt) : 'the configured deadline';
    const message = `${preAuth.requestNumber} for ${fullName(preAuth.patient)} ${breached ? 'passed' : 'is approaching'} ${deadline}. Follow up with the payer immediately.`;
    for (const userId of recipients) {
      try {
        if (await createNotificationOnce({ tenantId: preAuth.tenantId, userId, title, message, referenceType: 'pre_authorization_request', referenceId: preAuth.id, eventKey: finalDischarge ? 'final_discharge_auth_sla' : 'preauth_sla', reminderStage: breached ? 'breached' : 'warning' })) authorizationAlerts += 1;
      } catch (err) {
        logger.warn({ err, preAuthId: preAuth.id, userId }, 'Insurance SLA notification failed');
      }
    }
    if (breached && !preAuth.escalatedAt) {
      await prisma.preAuthorizationRequest.update({ where: { id: preAuth.id }, data: { escalatedAt: now } });
    }
  }

  const queryHorizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const queries = await prisma.claimQuery.findMany({
    where: { status: 'open', responseDueAt: { not: null, lte: queryHorizon } },
    include: {
      claim: {
        select: {
          claimNumber: true,
          patient: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  let queryAlerts = 0;
  for (const query of queries) {
    const overdue = Boolean(query.responseDueAt && query.responseDueAt <= now);
    const level = overdue ? 2 : 1;
    if (query.escalationLevel >= level) continue;
    const recipients = new Set<string>();
    if (query.raisedBy) recipients.add(query.raisedBy);
    if (overdue) (await getInsuranceRecipients(query.tenantId)).forEach((id) => recipients.add(id));
    const title = overdue ? 'Insurance query response overdue' : 'Insurance query response due within 24 hours';
    const message = `${query.claim.claimNumber ?? query.claimId} for ${fullName(query.claim.patient)}: ${query.subject}. Reply by ${query.responseDueAt ? formatDateIST(query.responseDueAt) : 'the configured deadline'}.`;
    for (const userId of recipients) {
      try {
        if (await createNotificationOnce({ tenantId: query.tenantId, userId, title, message, referenceType: 'claim_query', referenceId: query.id, eventKey: 'claim_query_response', reminderStage: overdue ? 'overdue' : 'due_24h' })) queryAlerts += 1;
      } catch (err) {
        logger.warn({ err, queryId: query.id, userId }, 'Insurance query notification failed');
      }
    }
    await prisma.claimQuery.update({ where: { id: query.id }, data: { escalationLevel: level } });
  }

  if (authorizationAlerts || queryAlerts) {
    logger.info({ authorizationAlerts, queryAlerts }, 'Insurance SLA alerts processed');
  }
  return { authorizationAlerts, queryAlerts };
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
