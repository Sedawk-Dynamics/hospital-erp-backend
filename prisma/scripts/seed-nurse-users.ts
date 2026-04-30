/**
 * Seed a test user for the consolidated `nurse_admin` role.
 *
 * Idempotent. For every non-platform tenant, ensures a user exists for:
 *   - nurse_admin@hospital.com  (Nurse Admin / Nursing Administrator)
 *
 * Password: Nurse@123
 *
 * Prerequisite: `backfill-nurse-roles.ts` must have been run so the role row
 * exists on each tenant.
 *
 * Usage:
 *   npx tsx prisma/scripts/seed-nurse-users.ts
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const NURSE_USERS = [
  {
    roleName: 'nurse_admin',
    email: 'nurse_admin@hospital.com',
    firstName: 'Nurse',
    lastName: 'Admin',
    phone: '+910000000303',
  },
] as const;

const DEFAULT_PASSWORD = 'Nurse@123';

async function main() {
  console.log('=== Nurse role: seeding test users ===');

  const tenants = await prisma.tenant.findMany({
    where: { slug: { not: '__platform__' } },
    select: { id: true, slug: true, name: true },
  });

  if (tenants.length === 0) {
    console.log('No non-platform tenants found. Create a hospital first, then re-run.');
    return;
  }

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);

  for (const tenant of tenants) {
    console.log(`\n[tenant] ${tenant.name} (${tenant.slug})`);

    for (const def of NURSE_USERS) {
      const role = await prisma.role.findFirst({
        where: { tenantId: tenant.id, name: def.roleName },
      });

      if (!role) {
        console.warn(
          `  ! role ${def.roleName} missing on this tenant — run backfill-nurse-roles.ts first`,
        );
        continue;
      }

      let user = await prisma.user.findFirst({
        where: { tenantId: tenant.id, email: def.email },
      });

      if (!user) {
        user = await prisma.user.create({
          data: {
            tenantId: tenant.id,
            email: def.email,
            passwordHash,
            firstName: def.firstName,
            lastName: def.lastName,
            phone: def.phone,
            isActive: true,
          },
        });
        console.log(`  + created user ${def.email}`);
      } else {
        console.log(`  = user ${def.email} already exists`);
      }

      const userRole = await prisma.userRole.findFirst({
        where: { userId: user.id, roleId: role.id },
      });

      if (!userRole) {
        await prisma.userRole.create({
          data: { userId: user.id, roleId: role.id },
        });
        console.log(`    + linked role ${def.roleName}`);
      } else {
        console.log(`    = role ${def.roleName} already linked`);
      }
    }
  }

  console.log('\n=== done ===');
  console.log('Login: nurse_admin@hospital.com / Nurse@123');
  console.log('Tip: select the hospital tenant on the clinic-selection screen.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
