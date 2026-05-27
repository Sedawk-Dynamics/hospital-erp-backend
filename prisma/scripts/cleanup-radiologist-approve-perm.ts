/**
 * Strip `imaging:approve` from every tenant's `radiologist` role.
 *
 * 2026-05-27 flow change: only `radiology_admin` (and platform admin/super
 * admin) can publish imaging reports now. The clinical radiologist marks
 * the report complete (status=finalized) and admin re-approves to make it
 * visible to the patient.
 *
 * The resync-role-permissions script is additive-only by design so it
 * won't strip stale rows — this one-off does it. Idempotent.
 *
 * Run with: npx tsx prisma/scripts/cleanup-radiologist-approve-perm.ts
 *          (or via `npm run db:seed:cleanup-radiologist-approve`)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== Strip imaging:approve from radiologist roles ===');

  const approvePerm = await prisma.permission.findUnique({
    where: { module_action: { module: 'imaging', action: 'approve' } },
  });
  if (!approvePerm) {
    console.log('No imaging:approve permission row found — nothing to do.');
    return;
  }

  const radiologistRoles = await prisma.role.findMany({
    where: { name: 'radiologist' },
    select: { id: true, tenantId: true },
  });
  console.log(`[radiologist roles] found ${radiologistRoles.length} across all tenants`);

  let removed = 0;
  for (const role of radiologistRoles) {
    const result = await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permissionId: approvePerm.id },
    });
    if (result.count > 0) {
      removed += result.count;
      console.log(`  tenant ${role.tenantId}: removed ${result.count} row(s)`);
    }
  }

  console.log(`=== done — removed ${removed} stale role-permission row(s) ===`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
