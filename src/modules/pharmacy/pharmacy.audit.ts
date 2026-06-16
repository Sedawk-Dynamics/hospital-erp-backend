import { prisma } from '../../config/database';
import { logger } from '../../config/logger';

// Best-effort audit for pharmacy stock actions (mirrors inventory.audit.ts).
// Every movement of drug stock — batch receipt, dispense, counter sale,
// return, restock-on-approval — lands in AuditLog so the inventory
// audit-logs report shows a single register across the hospital.

export type PharmacyAuditAction = 'create' | 'update' | 'delete' | 'merge' | 'adjust';

export async function safePharmacyAudit(params: {
  tenantId: string;
  userId: string;
  action: PharmacyAuditAction;
  entityType:
    | 'drug_batch'
    | 'dispensing_record'
    | 'pharmacy_sale'
    | 'drug_return'
    | 'drug_formulary';
  entityId: string;
  description?: string;
  oldValues?: unknown;
  newValues?: unknown;
}) {
  try {
    // The AuditLog.action column is a fixed DB enum (create/read/update/delete).
    // Richer pharmacy verbs (merge/adjust) are stored as 'update' with the real
    // verb preserved in the description so the audit-logs report still reads well.
    const storedAction =
      params.action === 'merge' || params.action === 'adjust' ? 'update' : params.action;
    await prisma.auditLog.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        action: storedAction,
        entityType: params.entityType,
        entityId: params.entityId,
        description: params.description,
        oldValues: (params.oldValues as object | null) ?? undefined,
        newValues: (params.newValues as object | null) ?? undefined,
      },
    });
  } catch (err) {
    logger.warn({ err, ...params }, 'Failed to write pharmacy audit log');
  }
}
