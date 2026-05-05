/**
 * Resync every system role's RolePermission rows to match the canonical
 * mapping in src/shared/role-permissions.ts.
 *
 * Why this exists: tenants created before recent permission-module updates
 * (e.g. the floors restructure on 2026-05-04) have stale RolePermission
 * rows. Their `admin` user therefore hits 403 on `/floors`, `/wards`,
 * `/beds/availability`, `/clinical/admissions`, etc. — because the
 * tenant-scoped `admin` role lacks rows that the canonical config lists.
 *
 * This script is idempotent and additive only. It never deletes existing
 * RolePermission rows — only inserts the missing ones — so revoked perms
 * stay revoked.
 *
 * Run with:  npm run db:seed:resync-permissions
 */

import { PrismaClient } from '@prisma/client';
import {
  PERMISSION_MODULES,
  PERMISSION_ACTIONS,
  getRolePermissions,
} from '../../src/shared/role-permissions';

const prisma = new PrismaClient();

async function ensureGlobalPermissionRows() {
  const rows: Array<{ module: string; action: string; description: string }> = [];
  for (const mod of PERMISSION_MODULES) {
    for (const action of PERMISSION_ACTIONS) {
      rows.push({
        module: mod,
        action,
        description: `${action} access to ${mod.replace(/_/g, ' ')}`,
      });
    }
  }
  const result = await prisma.permission.createMany({
    data: rows,
    skipDuplicates: true,
  });
  console.log(`[permissions] inserted ${result.count} missing module:action rows`);
}

async function resync() {
  const desired = getRolePermissions();
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  console.log(`[tenants] processing ${tenants.length}`);

  // Build a fast lookup: module|action -> permission.id
  const perms = await prisma.permission.findMany();
  const permIdBy = new Map<string, string>();
  for (const p of perms) permIdBy.set(`${p.module}|${p.action}`, p.id);

  let totalLinked = 0;

  for (const tenant of tenants) {
    for (const [roleName, defs] of Object.entries(desired)) {
      const role = await prisma.role.findFirst({
        where: { tenantId: tenant.id, name: roleName },
      });
      if (!role) continue;

      const rows = defs
        .map((d) => permIdBy.get(`${d.module}|${d.action}`))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId }));

      if (rows.length === 0) continue;

      const result = await prisma.rolePermission.createMany({
        data: rows,
        skipDuplicates: true,
      });
      if (result.count > 0) {
        totalLinked += result.count;
        console.log(
          `[tenant:${tenant.name}] ${roleName}: +${result.count} new role-permission rows`,
        );
      }
    }
  }

  console.log(`[done] inserted ${totalLinked} role-permission rows total`);
}

async function main() {
  console.log('=== Role-permission resync ===');
  await ensureGlobalPermissionRows();
  await resync();
  console.log('=== complete ===');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
