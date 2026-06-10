import { prisma } from '../../config/database';
import { logger } from '../../config/logger';

// Best-effort audit for pharmacy stock actions (mirrors inventory.audit.ts).
// Every movement of drug stock — batch receipt, dispense, counter sale,
// return, restock-on-approval — lands in AuditLog so the inventory
// audit-logs report shows a single register across the hospital.

export type PharmacyAuditAction = 'create' | 'update' | 'delete';

export async function safePharmacyAudit(params: {
  tenantId: string;
  userId: string;
  action: PharmacyAuditAction;
  entityType: 'drug_batch' | 'dispensing_record' | 'pharmacy_sale' | 'drug_return';
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
    logger.warn({ err, ...params }, 'Failed to write pharmacy audit log');
  }
}
