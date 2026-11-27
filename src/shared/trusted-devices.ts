import { prisma } from '../config/database';
import { logger } from '../config/logger';

export type DeviceRevokeReason =
  | 'removed'
  | 'replaced'
  | 'phone_changed'
  | 'password_changed'
  | 'deactivated'
  | 'not_eligible';

/**
 * Sign out a patient's trusted devices (PIN sign-in). Used wherever the account
 * behind them changes hands: phone change, password change, deactivation.
 */
export async function revokeTrustedDevices(userIds: string[], reason: DeviceRevokeReason): Promise<number> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  const res = await prisma.patientTrustedDevice.updateMany({
    where: { userId: { in: ids }, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  const count = res?.count ?? 0;
  if (count) logger.info({ userIds: ids, reason, count }, 'Patient trusted devices revoked');
  return count;
}

/** The same, for every per-tenant copy of the person with this email. */
export async function revokeTrustedDevicesByEmail(email: string, reason: DeviceRevokeReason): Promise<number> {
  const rows = (await prisma.user.findMany({ where: { email }, select: { id: true } })) ?? [];
  return revokeTrustedDevices(
    rows.map((r) => r.id),
    reason,
  );
}
