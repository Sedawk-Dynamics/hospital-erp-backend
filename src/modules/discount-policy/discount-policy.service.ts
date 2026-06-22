import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { safeInventoryAudit } from '../inventory/inventory.audit';
import type { CreateRuleInput, UpdateConfigInput, UpdateRuleInput } from './discount-policy.validation';

// ============================================================
// Margin-based system-wide discount — service (separate module)
// ============================================================
// Derives the discount a cashier may grant from an item's PROFIT MARGIN, via
// per-tenant margin→max-discount bands. This is a visual refinement: it surfaces
// and (in 'cap' mode) ceilings the discount at the POS but NEVER edits a stored
// medicine price. Kept deliberately apart from stock entry / bill discounts.

export interface DiscountRuleDto {
  id: string;
  label: string;
  minMarginPercent: number;
  maxMarginPercent: number | null;
  maxDiscountPercent: number;
  isActive: boolean;
  sortOrder: number;
}

const dec = (v: unknown): number | null => (v == null ? null : Number(v));

function toRuleDto(r: {
  id: string;
  label: string;
  minMarginPercent: unknown;
  maxMarginPercent: unknown;
  maxDiscountPercent: unknown;
  isActive: boolean;
  sortOrder: number;
}): DiscountRuleDto {
  return {
    id: r.id,
    label: r.label,
    minMarginPercent: dec(r.minMarginPercent) ?? 0,
    maxMarginPercent: dec(r.maxMarginPercent),
    maxDiscountPercent: dec(r.maxDiscountPercent) ?? 0,
    isActive: r.isActive,
    sortOrder: r.sortOrder,
  };
}

// ---- Config (per-tenant singleton) ----

export async function getConfig(tenantId: string) {
  let cfg = await prisma.marginDiscountConfig.findUnique({ where: { tenantId } });
  if (!cfg) {
    cfg = await prisma.marginDiscountConfig.create({ data: { tenantId } });
  }
  return { enabled: cfg.enabled, mode: cfg.mode };
}

export async function updateConfig(tenantId: string, userId: string, data: UpdateConfigInput) {
  const before = await prisma.marginDiscountConfig.findUnique({ where: { tenantId } });
  const cfg = await prisma.marginDiscountConfig.upsert({
    where: { tenantId },
    create: { tenantId, enabled: data.enabled ?? false, mode: data.mode ?? 'cap' },
    update: { ...(data.enabled !== undefined && { enabled: data.enabled }), ...(data.mode && { mode: data.mode }) },
  });
  void safeInventoryAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'margin_discount_config',
    entityId: cfg.id,
    description: `Margin-discount config: enabled=${cfg.enabled}, mode=${cfg.mode}`,
    oldValues: before ? { enabled: before.enabled, mode: before.mode } : null,
    newValues: { enabled: cfg.enabled, mode: cfg.mode },
  });
  return { enabled: cfg.enabled, mode: cfg.mode };
}

// ---- Rules (margin bands) ----

export async function listRules(tenantId: string): Promise<DiscountRuleDto[]> {
  const rows = await prisma.marginDiscountRule.findMany({
    where: { tenantId },
    orderBy: [{ sortOrder: 'asc' }, { minMarginPercent: 'asc' }],
  });
  return rows.map(toRuleDto);
}

export async function createRule(tenantId: string, userId: string, data: CreateRuleInput): Promise<DiscountRuleDto> {
  const row = await prisma.marginDiscountRule.create({
    data: {
      tenantId,
      label: data.label,
      minMarginPercent: data.minMarginPercent,
      maxMarginPercent: data.maxMarginPercent ?? null,
      maxDiscountPercent: data.maxDiscountPercent,
      isActive: data.isActive ?? true,
      sortOrder: data.sortOrder ?? 0,
    },
  });
  void safeInventoryAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'margin_discount_rule',
    entityId: row.id,
    description: `Margin-discount band "${row.label}" created`,
    newValues: toRuleDto(row),
  });
  return toRuleDto(row);
}

export async function updateRule(
  tenantId: string,
  userId: string,
  id: string,
  data: UpdateRuleInput,
): Promise<DiscountRuleDto> {
  const existing = await prisma.marginDiscountRule.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Discount rule not found');

  // Cross-field guard when either bound is being changed.
  const newMin = data.minMarginPercent ?? Number(existing.minMarginPercent);
  const newMax =
    data.maxMarginPercent !== undefined
      ? data.maxMarginPercent
      : existing.maxMarginPercent == null
        ? null
        : Number(existing.maxMarginPercent);
  if (newMax != null && newMax < newMin) {
    throw AppError.badRequest('Upper margin must be greater than or equal to lower margin');
  }

  const row = await prisma.marginDiscountRule.update({
    where: { id },
    data: {
      ...(data.label !== undefined && { label: data.label }),
      ...(data.minMarginPercent !== undefined && { minMarginPercent: data.minMarginPercent }),
      ...(data.maxMarginPercent !== undefined && { maxMarginPercent: data.maxMarginPercent }),
      ...(data.maxDiscountPercent !== undefined && { maxDiscountPercent: data.maxDiscountPercent }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
      ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
    },
  });
  void safeInventoryAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'margin_discount_rule',
    entityId: row.id,
    description: `Margin-discount band "${row.label}" updated`,
    oldValues: toRuleDto(existing),
    newValues: toRuleDto(row),
  });
  return toRuleDto(row);
}

export async function deleteRule(tenantId: string, userId: string, id: string) {
  const existing = await prisma.marginDiscountRule.findFirst({ where: { id, tenantId } });
  if (!existing) throw AppError.notFound('Discount rule not found');
  await prisma.marginDiscountRule.delete({ where: { id } });
  void safeInventoryAudit({
    tenantId,
    userId,
    action: 'delete',
    entityType: 'margin_discount_rule',
    entityId: id,
    description: `Margin-discount band "${existing.label}" deleted`,
    oldValues: toRuleDto(existing),
  });
  return { id, deleted: true };
}

// ---- Evaluation (pure + tenant-aware) ----

/**
 * Pick the band a margin falls into. Rules are pre-ordered (sortOrder, then
 * minMargin); the FIRST active band whose inclusive [min, max] contains the
 * margin wins (max null = open-ended upper bound). Returns null when nothing
 * matches — the cashier then has no margin-derived ceiling.
 */
export function pickRule(rules: DiscountRuleDto[], marginPercent: number): DiscountRuleDto | null {
  for (const r of rules) {
    if (!r.isActive) continue;
    const aboveMin = marginPercent >= r.minMarginPercent;
    const belowMax = r.maxMarginPercent == null || marginPercent <= r.maxMarginPercent;
    if (aboveMin && belowMax) return r;
  }
  return null;
}

/**
 * The policy the POS needs to apply caps locally for every cart line without a
 * round-trip per item: the on/off switch, the mode, and the active bands.
 */
export async function getEffectivePolicy(tenantId: string) {
  const [cfg, rules] = await Promise.all([getConfig(tenantId), listRules(tenantId)]);
  return { enabled: cfg.enabled, mode: cfg.mode, rules: rules.filter((r) => r.isActive) };
}

/** Server-side single-margin evaluation (e.g. for tests or a one-off lookup). */
export async function evaluate(tenantId: string, marginPercent: number) {
  const { enabled, mode, rules } = await getEffectivePolicy(tenantId);
  if (!enabled) return { enabled: false, mode, marginPercent, maxDiscountPercent: null, rule: null };
  const rule = pickRule(rules, marginPercent);
  return {
    enabled: true,
    mode,
    marginPercent,
    maxDiscountPercent: rule ? rule.maxDiscountPercent : null,
    rule,
  };
}
