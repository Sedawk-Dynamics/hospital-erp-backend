/**
 * Backfill / migration script for the consolidated nursing-role design.
 *
 * Originally seeded three nursing roles (`nurse_incharge`, `head_nurse`,
 * `nurse_admin`). The SOW only requires a single managerial role
 * (`nurse_admin`) plus the existing `nurse` role, so this script now:
 *
 *   1. Inserts any missing global `Permission` rows for `nurse_assignments`
 *      and `duty_rosters` × 6 actions (idempotent).
 *   2. For each tenant, ensures the consolidated `nurse_admin` role exists
 *      with the merged permission set.
 *   3. Migrates any existing user assignments from the legacy
 *      `nurse_incharge` / `head_nurse` roles onto `nurse_admin`.
 *   4. Removes the legacy `nurse_incharge` / `head_nurse` Role rows (and
 *      their RolePermission rows) so the role list matches SYSTEM_ROLE_NAMES.
 *
 * Safe to re-run.
 *
 * Usage:
 *   npx ts-node prisma/scripts/backfill-nurse-roles.ts
 */

import { PrismaClient } from '@prisma/client';
import {
  PERMISSION_MODULES,
  PERMISSION_ACTIONS,
  SYSTEM_ROLE_NAMES,
  getRolePermissions,
} from '../../src/shared/role-permissions';

const prisma = new PrismaClient();

const NEW_MODULES = ['nurse_assignments', 'duty_rosters'] as const;
const KEEP_ROLES = ['nurse_admin'] as const;
const LEGACY_ROLES = ['nurse_incharge', 'head_nurse'] as const;

async function seedNewPermissions() {
  const rows = NEW_MODULES.flatMap((mod) =>
    PERMISSION_ACTIONS.map((action) => ({
      module: mod,
      action,
      description: `${action} ${mod.replace(/_/g, ' ')}`,
    })),
  );

  const result = await prisma.permission.createMany({
    data: rows,
    skipDuplicates: true,
  });
  console.log(`[permissions] inserted ${result.count} new rows (modules: ${NEW_MODULES.join(', ')})`);
}

async function backfillTenantRoles() {
  for (const mod of NEW_MODULES) {
    if (!(PERMISSION_MODULES as readonly string[]).includes(mod)) {
      throw new Error(`PERMISSION_MODULES is missing ${mod}`);
    }
  }
  for (const role of KEEP_ROLES) {
    if (!(SYSTEM_ROLE_NAMES as readonly string[]).includes(role)) {
      throw new Error(`SYSTEM_ROLE_NAMES is missing ${role}`);
    }
  }

  const rolePermsDef = getRolePermissions();
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  console.log(`[tenants] processing ${tenants.length} tenants`);

  const allPerms = await prisma.permission.findMany();
  const permMap: Record<string, string> = {};
  for (const p of allPerms) permMap[`${p.module}:${p.action}`] = p.id;

  for (const tenant of tenants) {
    // Ensure nurse_admin exists with the merged permission set.
    let nurseAdmin = await prisma.role.findFirst({
      where: { tenantId: tenant.id, name: 'nurse_admin' },
    });
    if (!nurseAdmin) {
      nurseAdmin = await prisma.role.create({
        data: {
          tenantId: tenant.id,
          name: 'nurse_admin',
          description: 'System role: nurse admin',
          isSystemRole: true,
        },
      });
    }

    const desired = rolePermsDef.nurse_admin || [];
    const desiredPermIds = new Set(
      desired
        .map((p) => permMap[`${p.module}:${p.action}`])
        .filter((id): id is string => Boolean(id)),
    );

    // Insert missing role-permissions.
    const rows = Array.from(desiredPermIds).map((permissionId) => ({
      roleId: nurseAdmin!.id,
      permissionId,
    }));
    if (rows.length > 0) {
      await prisma.rolePermission.createMany({
        data: rows,
        skipDuplicates: true,
      });
    }

    // Migrate any users still on legacy nurse roles onto nurse_admin, then
    // delete the legacy role rows for this tenant.
    for (const legacyName of LEGACY_ROLES) {
      const legacyRole = await prisma.role.findFirst({
        where: { tenantId: tenant.id, name: legacyName },
      });
      if (!legacyRole) continue;

      const userRoles = await prisma.userRole.findMany({
        where: { roleId: legacyRole.id },
        select: { userId: true },
      });
      for (const ur of userRoles) {
        const already = await prisma.userRole.findFirst({
          where: { userId: ur.userId, roleId: nurseAdmin.id },
        });
        if (!already) {
          await prisma.userRole.create({
            data: { userId: ur.userId, roleId: nurseAdmin.id },
          });
        }
      }
      await prisma.userRole.deleteMany({ where: { roleId: legacyRole.id } });
      await prisma.rolePermission.deleteMany({ where: { roleId: legacyRole.id } });
      await prisma.role.delete({ where: { id: legacyRole.id } });
      console.log(
        `[tenant:${tenant.id}] migrated ${userRoles.length} user(s) from ${legacyName} → nurse_admin`,
      );
    }

    console.log(`[tenant:${tenant.id}] ${tenant.name} — nurse_admin synced`);
  }
}

async function main() {
  console.log('=== Nurse-role consolidation backfill ===');
  await seedNewPermissions();
  await backfillTenantRoles();
  console.log('=== done ===');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
