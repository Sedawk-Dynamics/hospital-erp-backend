import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import type { UpdateDefaultCommissionInput, SetHospitalCommissionInput } from './commission.validation';

export class CommissionService {
  /**
   * Get the default commission setting (singleton record).
   */
  async getDefaultCommission() {
    const setting = await prisma.commissionSetting.findFirst();
    return setting;
  }

  /**
   * Upsert the default commission setting.
   * If no record exists, create one with id 'default-commission'.
   * Otherwise update the first record found.
   */
  async updateDefaultCommission(data: UpdateDefaultCommissionInput, updatedBy: string) {
    const existing = await prisma.commissionSetting.findFirst();

    if (existing) {
      const updated = await prisma.commissionSetting.update({
        where: { id: existing.id },
        data: {
          defaultPercent: data.defaultPercent,
          ...(data.minPercent !== undefined && { minPercent: data.minPercent }),
          ...(data.maxPercent !== undefined && { maxPercent: data.maxPercent }),
          updatedBy,
        },
      });
      logger.info(`Default commission updated by ${updatedBy}`);
      return updated;
    }

    const created = await prisma.commissionSetting.create({
      data: {
        id: 'default-commission',
        defaultPercent: data.defaultPercent,
        minPercent: data.minPercent ?? 0,
        maxPercent: data.maxPercent ?? 50,
        updatedBy,
      },
    });
    logger.info(`Default commission created by ${updatedBy}`);
    return created;
  }

  /**
   * Get the effective commission percent for a tenant.
   * Returns the tenant-specific override if it exists, otherwise the default.
   * If no default exists either, returns 0.
   */
  async getCommissionForTenant(tenantId: string): Promise<number> {
    const hospitalCommission = await prisma.hospitalCommission.findUnique({
      where: { tenantId },
    });

    if (hospitalCommission) {
      return Number(hospitalCommission.commissionPercent);
    }

    const defaultSetting = await prisma.commissionSetting.findFirst();
    if (defaultSetting) {
      return Number(defaultSetting.defaultPercent);
    }

    return 0;
  }

  /**
   * Set or update a hospital-specific commission override.
   */
  async setHospitalCommission(tenantId: string, data: SetHospitalCommissionInput, updatedBy: string) {
    // Verify tenant exists
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw AppError.notFound('Tenant not found');
    }

    const commission = await prisma.hospitalCommission.upsert({
      where: { tenantId },
      create: {
        tenantId,
        commissionPercent: data.commissionPercent,
        notes: data.notes,
        updatedBy,
      },
      update: {
        commissionPercent: data.commissionPercent,
        notes: data.notes,
        updatedBy,
      },
    });

    logger.info(`Hospital commission set for tenant ${tenantId} by ${updatedBy}`);
    return commission;
  }

  /**
   * Delete a hospital-specific commission override (reverts to default).
   */
  async deleteHospitalCommission(tenantId: string) {
    const existing = await prisma.hospitalCommission.findUnique({
      where: { tenantId },
    });

    if (!existing) {
      throw AppError.notFound('Hospital commission override not found');
    }

    await prisma.hospitalCommission.delete({
      where: { tenantId },
    });

    logger.info(`Hospital commission deleted for tenant ${tenantId}`);
  }

  /**
   * List all tenants (active) with their commission overrides,
   * plus the default commission setting.
   */
  async listAllCommissions() {
    const [defaultSetting, hospitals] = await Promise.all([
      prisma.commissionSetting.findFirst(),
      prisma.tenant.findMany({
        where: { isActive: true, slug: { not: '__platform__' } },
        select: {
          id: true,
          name: true,
          slug: true,
          hospitalCode: true,
          bankVerified: true,
          linkedAccountId: true,
          hospitalCommission: true,
        },
        orderBy: { name: 'asc' },
      }),
    ]);

    return {
      defaultPercent: defaultSetting ? Number(defaultSetting.defaultPercent) : 0,
      hospitals,
    };
  }
}

export const commissionService = new CommissionService();
