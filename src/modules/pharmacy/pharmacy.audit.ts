import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { getRequestContext } from '../../config/request-context';

// Best-effort audit for pharmacy stock actions (mirrors inventory.audit.ts).
// Every movement of drug stock — batch receipt, dispense, counter sale,
// return, restock-on-approval, formulary mapping/approval — lands in AuditLog
// so the pharmacy audit-trail report shows a single register across the
// hospital. The acting IP + user-agent (the "Machine") come from the
// per-request context automatically — no service signature changes needed.

export type PharmacyAuditAction = 'create' | 'update' | 'delete' | 'merge' | 'adjust';

export async function safePharmacyAudit(params: {
  tenantId: string;
  /** Acting user. Falls back to the request-context user when omitted. */
  userId?: string;
  action: PharmacyAuditAction;
  entityType:
    | 'drug_batch'
    | 'dispensing_record'
    | 'pharmacy_sale'
    | 'drug_return'
    | 'drug_formulary'
    | 'inward_invoice'
    | 'gst_exception';
  entityId: string;
  description?: string;
  /** Human reason/justification — appended to the description when both given. */
  reason?: string;
  oldValues?: unknown;
  newValues?: unknown;
}) {
  try {
    // The AuditLog.action column is a fixed DB enum (create/read/update/delete).
    // Richer pharmacy verbs (merge/adjust) are stored as 'update' with the real
    // verb preserved in the description so the audit-logs report still reads well.
    const storedAction =
      params.action === 'merge' || params.action === 'adjust' ? 'update' : params.action;
    const ctx = getRequestContext();
    const userId = params.userId || ctx?.userId;
    if (!userId) return; // no actor to attribute (e.g. a system job) — skip.
    const description =
      [params.description, params.reason && `Reason: ${params.reason}`].filter(Boolean).join(' — ') || undefined;
    await prisma.auditLog.create({
      data: {
        tenantId: params.tenantId,
        userId,
        action: storedAction,
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
    logger.warn({ err, ...params }, 'Failed to write pharmacy audit log');
  }
}
