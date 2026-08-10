import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { getRequestContext } from '../config/request-context';

/**
 * Best-effort audit trail.
 *
 * Writes an `AuditLog` row for something a person did. Deliberately swallows its
 * own failures: an audit write must never roll back or abort the work it is
 * describing — a payment that reached the drawer stays recorded even if the log
 * line does not. It is therefore called AFTER the work commits, never inside its
 * transaction.
 *
 * The acting IP and user-agent come from the per-request context automatically,
 * so callers only supply what they know.
 *
 * `AuditAction` is the schema's four verbs. Money events map onto them: raising
 * a bill or taking a payment is a `create`; finalising, discounting, cancelling,
 * reversing or approving is an `update`.
 */
export type AuditActionType = 'create' | 'read' | 'update' | 'delete';

export interface AuditParams {
  tenantId: string;
  /** Acting user. Falls back to the request-context user when omitted. */
  userId?: string;
  action: AuditActionType;
  /**
   * The kind of record, snake_case — `bill`, `payment`, `refund`, `receipt`.
   * The hospital Audit Logs page filters on these exact strings.
   */
  entityType: string;
  entityId: string;
  description?: string;
  /** Human reason/justification — appended to the description when both given. */
  reason?: string;
  oldValues?: unknown;
  newValues?: unknown;
}

export async function writeAudit(params: AuditParams): Promise<void> {
  try {
    const ctx = getRequestContext();
    const userId = params.userId || ctx?.userId;
    if (!userId) return; // no actor to attribute (e.g. a system job) — skip.

    const description =
      [params.description, params.reason && `Reason: ${params.reason}`]
        .filter(Boolean)
        .join(' — ') || undefined;

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
    logger.warn({ err, ...params }, 'Failed to write audit log');
  }
}
