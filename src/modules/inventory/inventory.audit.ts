import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { getRequestContext } from '../../config/request-context';

// Best-effort audit: failure to write must never abort the underlying inventory
// workflow. We deliberately log to console and move on. The acting IP +
// user-agent (the "Machine") come from the per-request context automatically.

export type InvAuditAction = 'create' | 'update' | 'delete';

export async function safeInventoryAudit(params: {
  tenantId: string;
  /** Acting user. Falls back to the request-context user when omitted. */
  userId?: string;
  action: InvAuditAction;
  entityType: string;
  entityId: string;
  description?: string;
  /** Human reason/justification — appended to the description when both given. */
  reason?: string;
  oldValues?: unknown;
  newValues?: unknown;
}) {
  try {
    const ctx = getRequestContext();
    const userId = params.userId || ctx?.userId;
    if (!userId) return; // no actor to attribute (e.g. a system job) — skip.
    const description =
      [params.description, params.reason && `Reason: ${params.reason}`].filter(Boolean).join(' — ') || undefined;
    await prisma.auditLog.create({
      data: {
        tenantId: params.tenantId,
        userId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        description,
        oldValues: (params.oldValues as object | null) ?? undefined,
        newValues: (params.newValues as object | null) ?? undefined,
        ipAddress: ctx?.ipAddress,
        userAgent: ctx?.userAgent,
      },
    });
  } catch (err) {
    logger.warn({ err, ...params }, 'Failed to write inventory audit log');
  }
}
