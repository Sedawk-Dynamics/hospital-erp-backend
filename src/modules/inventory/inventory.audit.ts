import { prisma } from '../../config/database';
import { logger } from '../../config/logger';

// Best-effort audit: failure to write must never abort the underlying inventory
// workflow. We deliberately log to console and move on.

export type InvAuditAction = 'create' | 'update' | 'delete';

export async function safeInventoryAudit(params: {
  tenantId: string;
  userId: string;
  action: InvAuditAction;
  entityType: string;
  entityId: string;
  description?: string;
  oldValues?: unknown;
  newValues?: unknown;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        description: params.description,
        oldValues: (params.oldValues as object | null) ?? undefined,
        newValues: (params.newValues as object | null) ?? undefined,
      },
    });
  } catch (err) {
    logger.warn({ err, ...params }, 'Failed to write inventory audit log');
  }
}
