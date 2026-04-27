/**
 * Backfill script for the nurse-hierarchy RBAC additions.
 *
 * Two-phase backfill:
 *   1. Insert any missing global `Permission` rows for the two new modules
 *      (`nurse_assignments`, `duty_rosters`) × 6 actions.
 *   2. For each existing tenant, re-run `bootstrapRolesAndPermissions` which
 *      idempotently inserts the three new roles (`nurse_incharge`, `head_nurse`,
 *      `nurse_admin`) and their `RolePermission` rows.
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
const NEW_ROLES = ['nurse_incharge', 'head_nurse', 'nurse_admin'] as const;

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
  // Sanity-check our role-permissions source still lists the new modules/roles.
  for (const mod of NEW_MODULES) {
    if (!(PERMISSION_MODULES as readonly string[]).includes(mod)) {
      throw new Error(`PERMISSION_MODULES is missing ${mod}`);
    }
  }
  for (const role of NEW_ROLES) {
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
    for (const roleName of NEW_ROLES) {
      let role = await prisma.role.findFirst({
        where: { tenantId: tenant.id, name: roleName },
      });
      if (!role) {
        role = await prisma.role.create({
          data: {
            tenantId: tenant.id,
            name: roleName,
            description: `System role: ${roleName.replace(/_/g, ' ')}`,
            isSystemRole: true,
          },
        });
      }

      const desired = rolePermsDef[roleName] || [];
      const rolePermRows = desired
        .map((p) => {
          const pid = permMap[`${p.module}:${p.action}`];
          return pid ? { roleId: role!.id, permissionId: pid } : null;
        })
        .filter((r): r is { roleId: string; permissionId: string } => r !== null);

      if (rolePermRows.length > 0) {
        await prisma.rolePermission.createMany({
          data: rolePermRows,
          skipDuplicates: true,
        });
      }
    }
    console.log(`[tenant:${tenant.id}] ${tenant.name} — nurse hierarchy roles seeded`);
  }
}

async function main() {
  console.log('=== Nurse-hierarchy RBAC backfill ===');
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
