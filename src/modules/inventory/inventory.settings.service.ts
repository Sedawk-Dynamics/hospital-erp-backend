import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { safeInventoryAudit } from './inventory.audit';
import type { UpdateInventorySettingsInput } from './inventory.validation';

// ============================================================
// Inventory Settings — per-tenant module configuration singleton.
//
// Drives configurable reorder thresholds, the expiry-alert window, the
// auto-flag / prevent-expired-use guards, and which roles receive low-stock /
// expiry notifications. Created lazily with defaults on first read so every
// tenant always has a row to edit.
// ============================================================

export interface InventorySettingsShape {
  id: string;
  tenantId: string;
  defaultLowStockThreshold: number;
  expiryAlertMonths: number;
  lowStockAlertEnabled: boolean;
  expiryAlertEnabled: boolean;
  autoFlagExpired: boolean;
  preventExpiredUse: boolean;
  reorderNotifyEnabled: boolean;
  alertRecipientRoles: string[];
  lastAlertRunAt: Date | null;
}

const DEFAULTS = {
  defaultLowStockThreshold: 10,
  expiryAlertMonths: 3,
  lowStockAlertEnabled: true,
  expiryAlertEnabled: true,
  autoFlagExpired: false,
  preventExpiredUse: true,
  reorderNotifyEnabled: true,
  alertRecipientRoles: [] as string[],
};

/**
 * Fetch the tenant's inventory settings, creating the row with defaults on
 * first access. Always returns a usable object.
 */
export async function getInventorySettings(tenantId: string) {
  const existing = await prisma.inventorySetting.findUnique({ where: { tenantId } });
  if (existing) return existing;

  // upsert avoids a race when two callers create concurrently.
  return prisma.inventorySetting.upsert({
    where: { tenantId },
    create: { tenantId },
    update: {},
  });
}

/**
 * Settings read that never throws — used on hot stock-write paths where a
 * config-table hiccup must not block the operation. Falls back to defaults.
 */
export async function getInventorySettingsSafe(tenantId: string): Promise<InventorySettingsShape> {
  try {
    return (await getInventorySettings(tenantId)) as InventorySettingsShape;
  } catch (err) {
    logger.warn({ err, tenantId }, 'Falling back to default inventory settings');
    return { id: 'default', tenantId, lastAlertRunAt: null, ...DEFAULTS };
  }
}

export async function updateInventorySettings(
  tenantId: string,
  userId: string,
  data: UpdateInventorySettingsInput,
) {
  const current = await getInventorySettings(tenantId);

  // Normalise role slugs to snake_case lowercase to match Role.name storage.
  const normalizedRoles = data.alertRecipientRoles
    ? Array.from(
        new Set(
          data.alertRecipientRoles
            .map((r) => r.trim().toLowerCase().replace(/[\s-]+/g, '_'))
            .filter(Boolean),
        ),
      )
    : undefined;

  const updateData: Record<string, unknown> = {};
  if (data.defaultLowStockThreshold !== undefined) updateData.defaultLowStockThreshold = data.defaultLowStockThreshold;
  if (data.expiryAlertMonths !== undefined) updateData.expiryAlertMonths = data.expiryAlertMonths;
  if (data.lowStockAlertEnabled !== undefined) updateData.lowStockAlertEnabled = data.lowStockAlertEnabled;
  if (data.expiryAlertEnabled !== undefined) updateData.expiryAlertEnabled = data.expiryAlertEnabled;
  if (data.autoFlagExpired !== undefined) updateData.autoFlagExpired = data.autoFlagExpired;
  if (data.preventExpiredUse !== undefined) updateData.preventExpiredUse = data.preventExpiredUse;
  if (data.reorderNotifyEnabled !== undefined) updateData.reorderNotifyEnabled = data.reorderNotifyEnabled;
  if (normalizedRoles !== undefined) updateData.alertRecipientRoles = normalizedRoles;

  const updated = await prisma.inventorySetting.update({
    where: { tenantId },
    data: updateData,
  });

  logger.info({ tenantId, userId }, 'Inventory settings updated');

  void safeInventoryAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'inventory_setting',
    entityId: updated.id,
    description: 'Inventory module settings updated',
    oldValues: {
      defaultLowStockThreshold: current.defaultLowStockThreshold,
      expiryAlertMonths: current.expiryAlertMonths,
      lowStockAlertEnabled: current.lowStockAlertEnabled,
      expiryAlertEnabled: current.expiryAlertEnabled,
      autoFlagExpired: current.autoFlagExpired,
      preventExpiredUse: current.preventExpiredUse,
      reorderNotifyEnabled: current.reorderNotifyEnabled,
      alertRecipientRoles: current.alertRecipientRoles,
    },
    newValues: updateData,
  });

  return updated;
}
