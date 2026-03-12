import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import {
  SYSTEM_ROLE_NAMES as SYSTEM_ROLES,
  PERMISSION_MODULES as MODULES,
  PERMISSION_ACTIONS as ACTIONS,
  getRolePermissions,
} from '../src/shared/role-permissions';

const prisma = new PrismaClient();

async function seed() {
  console.log('🌱 Starting seed...\n');

  // ──────────────────────────────────────────────────
  // 1. Permissions (192) — ESSENTIAL
  //    The authorize middleware queries rolePermission
  //    which references these. Without them, RBAC breaks.
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
  // 2. Tenant — ESSENTIAL
  //    At least one tenant must exist for users to
  //    register and login. All data is tenant-scoped.
  // ──────────────────────────────────────────────────
  console.log('Creating tenant...');
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo-hospital' },
    update: {},
    create: {
      name: 'Demo Hospital',
      slug: 'demo-hospital',
      address: '123 Hospital Street',
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'India',
      phone: '+911234567890',
      email: 'info@demohospital.com',
      isActive: true,
    },
  });
  console.log(`  ✓ Tenant: ${tenant.name} (${tenant.slug})`);

  // ──────────────────────────────────────────────────
  // 3. System Roles (18) — ESSENTIAL
  //    auth.service.ts looks up roles by name during
  //    registration (e.g. "patient" role). Login loads
  //    roles into the JWT payload. Without roles,
  //    registration and RBAC fail.
  // ──────────────────────────────────────────────────
  console.log('Creating roles...');
  const roleMap: Record<string, string> = {};

  for (const roleName of SYSTEM_ROLES) {
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
    roleMap[roleName] = role.id;
  }
  console.log(`  ✓ ${Object.keys(roleMap).length} roles`);

  // ──────────────────────────────────────────────────
  // 4. Role-Permission Mappings — ESSENTIAL
  //    The authorize middleware checks:
  //      rolePermission.findFirst({ where: {
  //        role: { userRoles: { some: { userId } } },
  //        permission: { module, action }
  //      }})
  //    Without these mappings, every authorized request
  //    returns 403.
  // ──────────────────────────────────────────────────
  console.log('Mapping permissions to roles...');
  const rolePermissions = getRolePermissions();
  let mappingCount = 0;

  for (const [roleName, permissions] of Object.entries(rolePermissions)) {
    const roleId = roleMap[roleName];
    if (!roleId) continue;

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
  // 5. Super Admin User — ESSENTIAL
  //    The first user who can login and bootstrap
  //    the entire system (create departments, users,
  //    configure settings, etc). Without this, there
  //    is no way to access the admin panel.
  // ──────────────────────────────────────────────────
  console.log('Creating admin user...');
  const hashedPassword = await bcrypt.hash('Admin@123', 12);

  let adminUser = await prisma.user.findFirst({
    where: { tenantId: tenant.id, email: 'admin@hospital.com' },
  });

  if (!adminUser) {
    adminUser = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: 'admin@hospital.com',
        passwordHash: hashedPassword,
        firstName: 'System',
        lastName: 'Administrator',
        phone: '+1000000000',
        isActive: true,
      },
    });
  }

  // Assign super_admin role
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
  console.log(`  ✓ Admin: ${adminUser.email}`);

  // ──────────────────────────────────────────────────
  // Done!
  // ──────────────────────────────────────────────────
  console.log('\n✅ Seed completed successfully!');
  console.log('─────────────────────────────────');
  console.log(`Tenant:  ${tenant.name} (${tenant.slug})`);
  console.log(`Admin:   admin@hospital.com / Admin@123`);
  console.log(`Roles:   ${SYSTEM_ROLES.length} system roles`);
  console.log(`Perms:   ${Object.keys(permissionMap).length} permissions`);
  console.log('─────────────────────────────────');
  console.log('\nNote: Subscription plans, feature toggles,');
  console.log('and departments can be created via the admin UI.');
}

seed()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
