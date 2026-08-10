import { writeAudit } from '../../shared/audit';

// Best-effort audit: failure to write must never abort the underlying inventory
// workflow. The acting IP + user-agent (the "Machine") come from the per-request
// context automatically.
//
// The implementation now lives in shared/audit.ts so billing writes the same
// rows the same way. This wrapper keeps the name and the narrower action type
// every inventory and pharmacy caller already passes.

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
  return writeAudit(params);
}
