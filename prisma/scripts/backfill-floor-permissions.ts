/**
 * Backfill `floors` permissions for existing tenants.
 *
 * Context: Hospital -> Floor -> Ward -> Bed restructure (2026-05-04).
 * The `floors` module was added to PERMISSION_MODULES, and `admin` /
 * `nurse_admin` were granted full CRUD on it in role-permissions.ts.
 * Existing tenants in the DB still have the old RolePermission rows,
 * so admins see "Missing permission: floors:create" until this runs.
 *
 * Idempotent. Run with:
 *   npm run db:seed:floor-permissions
 */

import { PrismaClient } from '@prisma/client';
import {
  PERMISSION_ACTIONS,
  getRolePermissions,
} from '../../src/shared/role-permissions';

const prisma = new PrismaClient();

const NEW_MODULE = 'floors';
const ROLES_TO_GRANT = ['admin', 'nurse_admin'] as const;

async function ensureGlobalPermissionRows() {
  const rows = PERMISSION_ACTIONS.map((action) => ({
    module: NEW_MODULE,
    action,
    description: `${action} access to ${NEW_MODULE}`,
  }));

  const result = await prisma.permission.createMany({
    data: rows,
    skipDuplicates: true,
  });
  console.log(`[permissions] inserted ${result.count} new floor:* permission rows`);
}

async function backfillRolePermissions() {
  const allRolePerms = getRolePermissions();
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  console.log(`[tenants] processing ${tenants.length} tenants`);

  const allPerms = await prisma.permission.findMany({
    where: { module: NEW_MODULE },
  });
  const permIdByAction: Record<string, string> = {};
  for (const p of allPerms) permIdByAction[p.action] = p.id;

  let totalLinked = 0;
  for (const tenant of tenants) {
    for (const roleName of ROLES_TO_GRANT) {
      const role = await prisma.role.findFirst({
        where: { tenantId: tenant.id, name: roleName },
      });
      if (!role) continue;

      const desired = allRolePerms[roleName] || [];
      const desiredFloorActions = desired
        .filter((p) => p.module === NEW_MODULE)
        .map((p) => p.action);

      const rows = desiredFloorActions
        .map((action) => permIdByAction[action])
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId }));

      if (rows.length > 0) {
        const result = await prisma.rolePermission.createMany({
          data: rows,
          skipDuplicates: true,
        });
        totalLinked += result.count;
        if (result.count > 0) {
          console.log(
            `[tenant:${tenant.id}] ${tenant.name} — linked ${result.count} floor:* permissions to ${roleName}`,
          );
        }
      }
    }
  }
  console.log(`[done] ${totalLinked} new role-permission rows`);
}

async function main() {
  console.log('=== Floor permission backfill ===');
  await ensureGlobalPermissionRows();
  await backfillRolePermissions();
  console.log('=== complete ===');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
