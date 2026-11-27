import { prisma } from '../../config/database';
import { phoneMatchFilter } from '../../shared/account-holder';
import { isSamePhone } from '../../shared/phone-identity';

// ---------------------------------------------------------------------------
// Which account a patient's phone (or PIN) may open.
//
// One rule, used by every step that is not an email + password sign-in: the
// account, and every per-tenant copy of the same person, must be a patient and
// nothing else. A person with any staff role anywhere, or who owns a hospital,
// signs in with their password (and 2FA) only.
// ---------------------------------------------------------------------------

const ACCOUNT_INCLUDE = {
  tenant: true,
  userRoles: { include: { role: { select: { id: true, name: true } } } },
} as const;

async function findAccount(userId: string) {
  return prisma.user.findUnique({ where: { id: userId }, include: ACCOUNT_INCLUDE });
}

export type PatientAccount = NonNullable<Awaited<ReturnType<typeof findAccount>>>;

type RoleRows = { role: { name: string } }[] | undefined;

export const isPatientOnly = (userRoles: RoleRows): boolean =>
  !!userRoles?.length && userRoles.every((ur) => ur.role.name === 'patient');

const hasStaffRole = (userRoles: RoleRows): boolean => !!userRoles?.some((ur) => ur.role.name !== 'patient');

async function isEligible(user: PatientAccount): Promise<boolean> {
  if (!user.isActive || !user.tenant?.isActive) return false;
  if (!isPatientOnly(user.userRoles)) return false;

  // The same person's rows in other tenants share the email (login, hospital
  // switching and password change all treat them as one identity).
  const copies =
    (await prisma.user.findMany({
      where: { email: { equals: user.email, mode: 'insensitive' } },
      select: {
        id: true,
        isActive: true,
        tenant: { select: { slug: true } },
        userRoles: { select: { role: { select: { name: true } } } },
        doctorProfile: { select: { id: true } },
        staffProfile: { select: { id: true } },
      },
    })) ?? [];
  for (const c of copies) {
    if (hasStaffRole(c.userRoles) || c.doctorProfile || c.staffProfile) return false;
    // A deactivated platform row must not be reachable through a hospital copy.
    if (c.tenant?.slug === '__platform__' && !c.isActive) return false;
  }
  const owner = await prisma.tenantOwner.findFirst({
    where: { userId: { in: [user.id, ...copies.map((c) => c.id)] } },
    select: { id: true },
  });
  return !owner;
}

/** The account if it is active and exclusively a patient's, else null. */
export async function loadPatientAccount(userId: string): Promise<PatientAccount | null> {
  const user = await findAccount(userId);
  return user && (await isEligible(user)) ? user : null;
}

/**
 * The patient account a phone number signs in to, or null:
 *   1. a patient whose own account phone is the number (platform copy first,
 *      then oldest);
 *   2. failing that, the patient account a patient record carrying the number
 *      is linked to (front-desk registrations, accounts older than User.phone).
 * Staff accounts and anything linked to them are skipped, so a number only a
 * staff member uses resolves exactly like a number nobody uses.
 */
export async function resolvePatientAccountByPhone(e164: string): Promise<PatientAccount | null> {
  const filter = phoneMatchFilter(e164);
  const users = (
    (await prisma.user.findMany({
      where: { phone: filter, isActive: true },
      include: ACCOUNT_INCLUDE,
      orderBy: { createdAt: 'asc' },
    })) ?? []
  ).filter((u) => isSamePhone(u.phone, e164));
  const ordered = [
    ...users.filter((u) => u.tenant?.slug === '__platform__'),
    ...users.filter((u) => u.tenant?.slug !== '__platform__'),
  ];
  for (const u of ordered) {
    if (await isEligible(u)) return u;
  }

  const linked = (
    (await prisma.patient.findMany({
      where: { phone: filter, userId: { not: null }, isActive: true },
      select: { userId: true, phone: true },
      orderBy: { createdAt: 'asc' },
    })) ?? []
  ).filter((p) => isSamePhone(p.phone, e164));
  for (const id of new Set(linked.map((p) => p.userId!))) {
    const account = await loadPatientAccount(id);
    if (account) return account;
  }
  return null;
}

/** Active patient records carrying the number that belong to no account yet. */
export async function findOrphanPatients(e164: string) {
  const rows =
    (await prisma.patient.findMany({
      where: { phone: phoneMatchFilter(e164), userId: null, isActive: true },
      select: { id: true, firstName: true, lastName: true, phone: true },
      orderBy: { createdAt: 'asc' },
    })) ?? [];
  return rows.filter((p) => isSamePhone(p.phone, e164));
}

/** The row whose 2FA secret guards this person, or null when 2FA is off. */
export async function twoFactorGuard(
  account: Pick<PatientAccount, 'id' | 'email' | 'is2faEnabled' | 'twoFaSecret'>,
): Promise<{ id: string; twoFaSecret: string | null } | null> {
  const copies =
    (await prisma.user.findMany({
      where: { email: account.email, is2faEnabled: true },
      select: { id: true, twoFaSecret: true, tenant: { select: { slug: true } } },
    })) ?? [];
  return (
    copies.find((c) => c.tenant?.slug === '__platform__') ??
    (account.is2faEnabled ? { id: account.id, twoFaSecret: account.twoFaSecret } : null) ??
    copies[0] ??
    null
  );
}
