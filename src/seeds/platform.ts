import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import {
  PERMISSION_MODULES as MODULES,
  PERMISSION_ACTIONS as ACTIONS,
  getRolePermissions,
} from '../shared/role-permissions';

let prisma!: PrismaClient;

/**
 * Platform-level roles:
 * - super_admin: seeded only, tenant/platform owner, no sign-up
 * - admin: self-registered hospital admins who sign up, buy plans, create hospitals
 */
const PLATFORM_ROLES = ['super_admin', 'admin'] as const;

async function seed() {
  console.log('🌱 Starting seed...\n');

  // ──────────────────────────────────────────────────
  // 1. Platform Tenant
  //    super admin == tenant. This is the super admin's
  //    own space. Hospitals are separate tenants created
  //    through the UI.
  // ──────────────────────────────────────────────────
  console.log('Creating platform tenant...');
  const platformTenant = await prisma.tenant.upsert({
    where: { slug: '__platform__' },
    update: {},
    create: {
      name: 'Platform',
      slug: '__platform__',
      email: 'platform@hospital-erp.com',
      isActive: true,
    },
  });
  console.log(`  ✓ Platform tenant: ${platformTenant.slug}`);

  // ──────────────────────────────────────────────────
  // 2. Permissions
  //    All module:action combinations. Shared across
  //    the entire system — referenced by role-permission
  //    mappings in every tenant.
  // ──────────────────────────────────────────────────
  console.log('Creating permissions...');
  const permissionMap: Record<string, string> = {};

  for (const mod of MODULES) {
    for (const action of ACTIONS) {
      const key = `${mod}:${action}`;
      const perm = await prisma.permission.upsert({
        where: { module_action: { module: mod, action } },
        update: {},
        create: {
          module: mod,
          action,
          description: `${action} access to ${mod.replace(/_/g, ' ')}`,
        },
      });
      permissionMap[key] = perm.id;
    }
  }
  console.log(`  ✓ ${Object.keys(permissionMap).length} permissions`);

  // ──────────────────────────────────────────────────
  // 3. Platform Roles (super_admin + admin)
  //    super_admin: seeded platform owner, no sign-up
  //    admin: self-registered hospital admins
  //    Hospital-specific roles (doctor, nurse, etc.) are
  //    bootstrapped per-hospital when created via the API.
  // ──────────────────────────────────────────────────
  console.log('Creating platform roles...');
  const roleMap: Record<string, string> = {};

  for (const roleName of PLATFORM_ROLES) {
    let role = await prisma.role.findFirst({
      where: { tenantId: platformTenant.id, name: roleName },
    });
    if (!role) {
      role = await prisma.role.create({
        data: {
          tenantId: platformTenant.id,
          name: roleName,
          description: `Platform role: ${roleName.replace(/_/g, ' ')}`,
          isSystemRole: true,
        },
      });
    }
    roleMap[roleName] = role.id;
  }
  console.log(`  ✓ ${Object.keys(roleMap).length} platform roles`);

  // ──────────────────────────────────────────────────
  // 4. Role-Permission Mappings (platform roles only)
  //    super_admin gets all permissions.
  //    admin gets all permissions (scoped to their hospitals).
  // ──────────────────────────────────────────────────
  console.log('Mapping permissions to platform roles...');
  const allRolePermissions = getRolePermissions();
  let mappingCount = 0;

  for (const roleName of PLATFORM_ROLES) {
    const roleId = roleMap[roleName];
    const permissions = allRolePermissions[roleName];
    if (!roleId || !permissions) continue;

    for (const { module: mod, action } of permissions) {
      const permKey = `${mod}:${action}`;
      const permissionId = permissionMap[permKey];
      if (!permissionId) continue;

      const existing = await prisma.rolePermission.findFirst({
        where: { roleId, permissionId },
      });
      if (!existing) {
        await prisma.rolePermission.create({
          data: { roleId, permissionId },
        });
      }
      mappingCount++;
    }
  }
  console.log(`  ✓ ${mappingCount} role-permission mappings`);

  // ──────────────────────────────────────────────────
  // 5. Super Admin User
  //    The platform owner. Independent of any hospital.
  // ──────────────────────────────────────────────────
  console.log('Creating super admin user...');
  const hashedPassword = await bcrypt.hash('Admin@123', 12);

  let adminUser = await prisma.user.findFirst({
    where: { email: 'admin@hospital.com', tenant: { slug: '__platform__' } },
  });

  if (!adminUser) {
    adminUser = await prisma.user.create({
      data: {
        tenantId: platformTenant.id,
        email: 'admin@hospital.com',
        passwordHash: hashedPassword,
        firstName: 'Super',
        lastName: 'Admin',
        phone: '+1000000000',
        isActive: true,
      },
    });
  }

  const superAdminRoleId = roleMap['super_admin'];
  if (superAdminRoleId) {
    const existing = await prisma.userRole.findFirst({
      where: { userId: adminUser.id, roleId: superAdminRoleId },
    });
    if (!existing) {
      await prisma.userRole.create({
        data: { userId: adminUser.id, roleId: superAdminRoleId },
      });
    }
  }
  console.log(`  ✓ Super Admin: ${adminUser.email}`);

  // ──────────────────────────────────────────────────
  // 6. Default Commission Setting
  //    Platform commission applied to online payments
  // ──────────────────────────────────────────────────
  console.log('Creating default commission setting...');
  await prisma.commissionSetting.upsert({
    where: { id: 'default-commission' },
    update: {},
    create: {
      id: 'default-commission',
      defaultPercent: 5.00,
      minPercent: 0,
      maxPercent: 50,
    },
  });
  console.log('  ✓ Default commission: 5%');

  // ──────────────────────────────────────────────────
  // 7. Default Subscription Plans
  //    Demo plan (free, used for trials) + paid plans.
  // ──────────────────────────────────────────────────
  console.log('Creating subscription plans...');

  const planData = [
    {
      name: 'Demo',
      description: 'Free demo plan with limited features for trial users',
      priceMonthly: null,
      priceYearly: null,
      maxUsers: 5,
      maxHospitals: 1,
      features: {
        appointments: true, billing: true, lab: false, pharmacy: false,
        inventory: false, imaging: false, ip_management: false,
        blood_bank: false, insurance: false, hr: false, compliance: false,
        reports: true, multi_hospital: false,
      },
      isActive: false,
    },
    {
      name: 'Basic',
      description: 'For small clinics and single-doctor practices',
      priceMonthly: 999,
      priceYearly: 9990,
      maxUsers: 10,
      maxHospitals: 1,
      features: {
        appointments: true, billing: true, lab: true, pharmacy: true,
        inventory: true, imaging: false, ip_management: false,
        blood_bank: false, insurance: false, hr: false, compliance: false,
        reports: true, multi_hospital: false,
      },
      isActive: false,
    },
    {
      name: 'Professional',
      description: 'For growing hospitals with multiple departments',
      priceMonthly: 2499,
      priceYearly: 24990,
      maxUsers: 50,
      maxHospitals: 3,
      features: {
        appointments: true, billing: true, lab: true, pharmacy: true,
        inventory: true, imaging: true, ip_management: true,
        blood_bank: false, insurance: true, hr: true, compliance: false,
        reports: true, multi_hospital: true,
      },
      isActive: false,
    },
    {
      name: 'Enterprise',
      description: 'Complete solution for hospital chains',
      priceMonthly: null,
      priceYearly: null,
      maxUsers: null,
      maxHospitals: null,
      features: {
        appointments: true, billing: true, lab: true, pharmacy: true,
        inventory: true, imaging: true, ip_management: true,
        blood_bank: true, insurance: true, hr: true, compliance: true,
        reports: true, multi_hospital: true,
      },
      isActive: false,
    },
  ];

  for (const plan of planData) {
    await prisma.subscriptionPlan.upsert({
      where: { name: plan.name },
      update: {},
      create: plan as any,
    });
  }
  console.log(`  ✓ ${planData.length} subscription plans`);

  // ──────────────────────────────────────────────────
  // Done!
  // ──────────────────────────────────────────────────
  console.log('\n✅ Seed completed!');
  console.log('─────────────────────────────────');
  console.log(`Super Admin:  admin@hospital.com / Admin@123`);
  console.log(`Platform:     ${PLATFORM_ROLES.length} roles, ${mappingCount} permission mappings`);
  console.log(`System:       ${Object.keys(permissionMap).length} permissions`);
  console.log(`Plans:        Demo, Basic, Professional, Enterprise`);
  console.log('─────────────────────────────────');
}

export async function seedPlatform(client?: PrismaClient): Promise<void> {
  const owns = !client;
  prisma = client ?? new PrismaClient();
  try {
    await seed();
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedPlatform()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('❌ Seed failed:', e);
      process.exit(1);
    });
}
