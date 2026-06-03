/**
 * Pharmacy 2-role consolidation backfill.
 *
 * Pharmacy now has exactly TWO roles — `pharmacist` (operational counter:
 * dispense + patient returns) and `pharmacy_admin` (full management). The legacy
 * `pharmacy_technician` role is removed. For each tenant this script:
 *
 *   1. Ensures `pharmacist` + `pharmacy_admin` roles exist.
 *   2. Migrates any `pharmacy_technician` users → `pharmacist`, then deletes the
 *      `pharmacy_technician` role (+ its RolePermission rows).
 *   3. Syncs each role's permissions to EXACTLY the desired set — this PRUNES
 *      the now-removed `pharmacy:approve` from `pharmacist` and ADDS the new
 *      inventory/reports perms to `pharmacy_admin`.
 *
 * Safe to re-run.
 *   npm run db:seed:pharmacy-roles
 */

import { PrismaClient } from '@prisma/client';
import { getRolePermissions } from '../../src/shared/role-permissions';

const prisma = new PrismaClient();

const KEEP_ROLES = ['pharmacist', 'pharmacy_admin'] as const;
const LEGACY_ROLE = 'pharmacy_technician';

async function main() {
  console.log('=== Pharmacy 2-role consolidation backfill ===');
  const rolePermsDef = getRolePermissions();

  const allPerms = await prisma.permission.findMany();
  const permMap: Record<string, string> = {};
  for (const p of allPerms) permMap[`${p.module}:${p.action}`] = p.id;

  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  console.log(`[tenants] processing ${tenants.length}`);

  for (const tenant of tenants) {
    // 1. Ensure the two roles exist.
    const roleByName: Record<string, string> = {};
    for (const name of KEEP_ROLES) {
      let role = await prisma.role.findFirst({ where: { tenantId: tenant.id, name } });
      if (!role) {
        role = await prisma.role.create({
          data: {
            tenantId: tenant.id,
            name,
            description: `System role: ${name.replace(/_/g, ' ')}`,
            isSystemRole: true,
          },
        });
      }
      roleByName[name] = role.id;
    }

    // 2. Migrate pharmacy_technician users → pharmacist, then drop the role.
    const legacy = await prisma.role.findFirst({
      where: { tenantId: tenant.id, name: LEGACY_ROLE },
    });
    if (legacy) {
      const userRoles = await prisma.userRole.findMany({
        where: { roleId: legacy.id },
        select: { userId: true },
      });
      for (const ur of userRoles) {
        const already = await prisma.userRole.findFirst({
          where: { userId: ur.userId, roleId: roleByName['pharmacist'] },
        });
        if (!already) {
          await prisma.userRole.create({
            data: { userId: ur.userId, roleId: roleByName['pharmacist'] },
          });
        }
      }
      await prisma.userRole.deleteMany({ where: { roleId: legacy.id } });
      await prisma.rolePermission.deleteMany({ where: { roleId: legacy.id } });
      await prisma.role.delete({ where: { id: legacy.id } });
      console.log(
        `[tenant:${tenant.id}] migrated ${userRoles.length} user(s) from ${LEGACY_ROLE} → pharmacist`,
      );
    }

    // 3. Sync each kept role's permissions to EXACTLY the desired set.
    for (const name of KEEP_ROLES) {
      const roleId = roleByName[name];
      const desiredIds = new Set(
        (rolePermsDef[name] ?? [])
          .map((p) => permMap[`${p.module}:${p.action}`])
          .filter((id): id is string => Boolean(id)),
      );
      const current = await prisma.rolePermission.findMany({
        where: { roleId },
        select: { permissionId: true },
      });
      const currentIds = new Set(current.map((c) => c.permissionId));

      const toAdd = [...desiredIds].filter((id) => !currentIds.has(id));
      const toRemove = [...currentIds].filter((id) => !desiredIds.has(id));

      if (toAdd.length) {
        await prisma.rolePermission.createMany({
          data: toAdd.map((permissionId) => ({ roleId, permissionId })),
          skipDuplicates: true,
        });
      }
      if (toRemove.length) {
        await prisma.rolePermission.deleteMany({
          where: { roleId, permissionId: { in: toRemove } },
        });
      }
      console.log(`[tenant:${tenant.id}] ${name}: +${toAdd.length} / -${toRemove.length} perms`);
    }
  }

  console.log('=== done ===');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
