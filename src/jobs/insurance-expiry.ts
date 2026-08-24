import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { formatDateIST } from '../shared/date.utils';
import { sweepExpiredPoliciesAndPreAuths } from '../modules/insurance/insurance.service';
import { usersWithRoles } from '../shared/notify';

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
 * Daily insurance maintenance:
 *   1. Sweep policies/pre-auths whose validity passed → mark expired.
 *   2. Create in-app notifications for claims/policies/pre-auths approaching
 *      their deadlines (7-day, 3-day, 1-day windows).
 */
export async function runInsuranceExpiryJob() {
  const swept = await sweepExpiredPoliciesAndPreAuths();

  const reminders = [7, 3, 1];

  for (const days of reminders) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + days);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);

    // --- Claims approaching the TPA deadline ---
    const claims = await prisma.insuranceClaim.findMany({
      where: {
        status: { in: ['submitted', 'under_review', 'partially_approved', 'resubmitted'] },
        expiryDate: { gte: start, lte: end },
      },
      include: {
        patient: { select: { firstName: true, lastName: true } },
        tenant: { select: { id: true } },
      },
    });

    for (const c of claims) {
      const userId = c.submittedBy ?? c.reviewedBy;
      if (!userId) continue;
      await prisma.notification
        .create({
          data: {
            tenantId: c.tenantId,
            userId,
            title: `Insurance claim expiring in ${days} day${days > 1 ? 's' : ''}`,
            message: `Claim ${c.claimNumber ?? c.id} for ${c.patient.firstName} ${c.patient.lastName} is due by ${c.expiryDate ? formatDateIST(c.expiryDate) : 'soon'}. Follow up with the TPA.`,
            notificationType: 'alert',
            channel: 'in_app',
            referenceType: 'insurance_claim',
            referenceId: c.id,
          },
        })
        .catch(() => {});
    }

    // --- Policies expiring soon ---
    const policies = await prisma.insurancePolicy.findMany({
      where: { status: 'active', validTo: { gte: start, lte: end } },
      include: { patient: { select: { firstName: true, lastName: true } } },
    });
    for (const p of policies) {
      const insuranceStaff = await getInsuranceRecipients(p.tenantId);
      for (const userId of insuranceStaff) {
        await prisma.notification
          .create({
            data: {
              tenantId: p.tenantId,
              userId,
              title: `Policy expiring in ${days} day${days > 1 ? 's' : ''}`,
              message: `Policy ${p.policyNumber} (${p.patient.firstName} ${p.patient.lastName}) expires on ${formatDateIST(p.validTo)}.`,
              notificationType: 'alert',
              channel: 'in_app',
              referenceType: 'insurance_policy',
              referenceId: p.id,
            },
          })
          .catch(() => {});
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
      await prisma.notification
        .create({
          data: {
            tenantId: pa.tenantId,
            userId,
            title: `Pre-authorization expiring in ${days} day${days > 1 ? 's' : ''}`,
            message: `Pre-auth ${pa.approvalNumber ?? pa.id} for ${pa.patient.firstName} ${pa.patient.lastName} is valid until ${pa.validTo ? formatDateIST(pa.validTo) : 'soon'}.`,
            notificationType: 'alert',
            channel: 'in_app',
            referenceType: 'pre_authorization_request',
            referenceId: pa.id,
          },
        })
        .catch(() => {});
    }

    if (claims.length || policies.length || preAuths.length) {
      logger.info({ days, claims: claims.length, policies: policies.length, preAuths: preAuths.length }, 'Insurance expiry reminders sent');
    }
  }

  return swept;
}
