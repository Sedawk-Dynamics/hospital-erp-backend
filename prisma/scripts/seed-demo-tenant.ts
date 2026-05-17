/**
 * Create a demo hospital tenant so downstream per-tenant seeds (lab tests,
 * nurse users, etc.) have something to attach to on a fresh DB.
 *
 * Mirrors tenantsService.create + bootstrapRolesAndPermissions so this can
 * run without booting the API. Idempotent — re-running is a no-op.
 *
 * Usage:
 *   npx tsx prisma/scripts/seed-demo-tenant.ts
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import {
  SYSTEM_ROLE_NAMES,
  getRolePermissions,
} from '../../src/shared/role-permissions';

const prisma = new PrismaClient();

const DEMO_SLUG = 'demo-hospital';
const DEMO_NAME = 'Demo Hospital';
const DEMO_EMAIL = 'demo@hospital.com';

const DEFAULT_FEATURE_TOGGLES = [
  { featureKey: 'appointments', isEnabled: true, config: {} },
  { featureKey: 'lab', isEnabled: true, config: {} },
  { featureKey: 'pharmacy', isEnabled: true, config: {} },
  { featureKey: 'billing', isEnabled: true, config: {} },
  { featureKey: 'inventory', isEnabled: true, config: {} },
  { featureKey: 'ip_management', isEnabled: true, config: {} },
  { featureKey: 'ot_management', isEnabled: false, config: {} },
  { featureKey: 'blood_bank', isEnabled: false, config: {} },
  { featureKey: 'imaging', isEnabled: false, config: {} },
  { featureKey: 'insurance', isEnabled: false, config: {} },
  { featureKey: 'hr', isEnabled: false, config: {} },
  { featureKey: 'compliance', isEnabled: false, config: {} },
];

async function ensureTenant() {
  const existing = await prisma.tenant.findUnique({ where: { slug: DEMO_SLUG } });
  if (existing) {
    console.log(`  ✓ tenant already exists: ${existing.slug}`);
    return existing;
  }

  const tenant = await prisma.tenant.create({
    data: {
      name: DEMO_NAME,
      slug: DEMO_SLUG,
      email: DEMO_EMAIL,
      city: 'Bengaluru',
      state: 'Karnataka',
      country: 'India',
      isActive: true,
      featureToggles: { create: DEFAULT_FEATURE_TOGGLES },
    },
  });
  console.log(`  ✓ created tenant: ${tenant.slug}`);
  return tenant;
}

async function bootstrapRolesAndPermissions(tenantId: string) {
  const allPermissions = await prisma.permission.findMany();
  const permissionMap: Record<string, string> = {};
  for (const p of allPermissions) {
    permissionMap[`${p.module}:${p.action}`] = p.id;
  }

  const rolePermsDef = getRolePermissions();
  let rolesCreated = 0;
  let mappingsCreated = 0;

  for (const roleName of SYSTEM_ROLE_NAMES) {
    if (roleName === 'super_admin') continue;

    let role = await prisma.role.findFirst({
      where: { tenantId, name: roleName },
    });

    if (!role) {
      role = await prisma.role.create({
        data: {
          tenantId,
          name: roleName,
          description: `System role: ${roleName.replace(/_/g, ' ')}`,
          isSystemRole: true,
        },
      });
      rolesCreated++;
    }

    const perms = rolePermsDef[roleName] || [];
    const rolePermData = perms
      .map((p) => {
        const id = permissionMap[`${p.module}:${p.action}`];
        return id ? { roleId: role!.id, permissionId: id } : null;
      })
      .filter((d): d is { roleId: string; permissionId: string } => d !== null);

    if (rolePermData.length > 0) {
      const result = await prisma.rolePermission.createMany({
        data: rolePermData,
        skipDuplicates: true,
      });
      mappingsCreated += result.count;
    }
  }

  console.log(
    `  ✓ ${rolesCreated} roles created, ${mappingsCreated} role-permission mappings inserted`,
  );
}

async function ensureAdminUser(tenantId: string) {
  const email = 'admin@hospital.com';
  let user = await prisma.user.findFirst({
    where: { email, tenantId },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        tenantId,
        email,
        passwordHash: await bcrypt.hash('Admin@123', 12),
        firstName: 'Demo',
        lastName: 'Admin',
        phone: '+919999999999',
        isActive: true,
      },
    });
    console.log(`  ✓ created tenant admin user: ${email}`);
  } else {
    console.log(`  ✓ tenant admin user already exists: ${email}`);
  }

  const adminRole = await prisma.role.findFirst({
    where: { tenantId, name: 'admin' },
  });
  if (!adminRole) return;

  const existing = await prisma.userRole.findFirst({
    where: { userId: user.id, roleId: adminRole.id },
  });
  if (!existing) {
    await prisma.userRole.create({
      data: { userId: user.id, roleId: adminRole.id },
    });
    console.log(`  ✓ granted admin role to ${email}`);
  }
}

async function main() {
  console.log('🌱 Seeding demo hospital tenant...\n');
  const tenant = await ensureTenant();
  await bootstrapRolesAndPermissions(tenant.id);
  await ensureAdminUser(tenant.id);
  console.log('\n✅ Demo tenant ready.');
  console.log('─────────────────────────────────');
  console.log(`Tenant:        ${DEMO_NAME} (${DEMO_SLUG})`);
  console.log(`Tenant Admin:  admin@hospital.com / Admin@123  (on tenant ${DEMO_SLUG})`);
  console.log('─────────────────────────────────');
}

main()
  .catch((err) => {
    console.error('❌ Demo tenant seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
