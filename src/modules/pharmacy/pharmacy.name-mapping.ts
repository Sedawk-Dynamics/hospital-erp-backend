import { prisma } from '../../config/database';
import { logger } from '../../config/logger';

/**
 * Learned stock-entry name mappings (`drug_name_mappings` table).
 *
 * When a pharmacist confirms that an incoming vendor/invoice product name maps
 * to a particular formulary drug, we remember it. Next time the same incoming
 * name is entered it auto-resolves to the same drug by default — the pharmacist
 * can still override. Accessed via raw SQL so the feature stays deployable
 * without regenerating the Prisma client (the dev server locks the engine DLL
 * on Windows); the table itself is a first-class model in schema.prisma.
 */

/** Normalise an incoming product name for matching: lower, trim, collapse ws. */
export function normalizeIncomingName(name?: string | null): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Look up saved mappings for a set of incoming names. Returns a Map keyed by the
 * NORMALISED name → the mapped (still-active) formulary drug id.
 */
export async function lookupNameMappings(
  tenantId: string,
  names: string[],
): Promise<Map<string, string>> {
  const norms = Array.from(
    new Set(names.map(normalizeIncomingName).filter((n) => n.length > 0)),
  );
  const out = new Map<string, string>();
  if (norms.length === 0) return out;
  try {
    const rows = await prisma.$queryRaw<
      { incoming_name_norm: string; drug_formulary_id: string }[]
    >`
      SELECT m.incoming_name_norm, m.drug_formulary_id
      FROM drug_name_mappings m
      JOIN drug_formulary d ON d.id = m.drug_formulary_id AND d.is_active = true
      WHERE m.tenant_id = ${tenantId}
        AND m.incoming_name_norm = ANY(${norms}::text[])
    `;
    for (const r of rows) out.set(r.incoming_name_norm, r.drug_formulary_id);
  } catch (err) {
    logger.warn({ err }, 'lookupNameMappings failed; continuing without learned mappings');
  }
  return out;
}

/** Convenience single-name lookup. */
export async function lookupNameMapping(
  tenantId: string,
  name: string,
): Promise<string | null> {
  const map = await lookupNameMappings(tenantId, [name]);
  return map.get(normalizeIncomingName(name)) ?? null;
}

/**
 * Remember that `incomingName` maps to `drugFormularyId` for this tenant.
 * Upserts on (tenant, normalised name) so the most recent confirmed choice wins.
 * Best-effort — never throws into the commit path.
 */
export async function saveNameMapping(
  tenantId: string,
  incomingName: string | null | undefined,
  drugFormularyId: string,
): Promise<void> {
  const norm = normalizeIncomingName(incomingName);
  if (!norm || !drugFormularyId) return;
  try {
    await prisma.$executeRaw`
      INSERT INTO drug_name_mappings
        (id, tenant_id, incoming_name_norm, drug_formulary_id, incoming_name_raw, created_at, updated_at)
      VALUES
        (gen_random_uuid()::text, ${tenantId}, ${norm}, ${drugFormularyId}, ${incomingName ?? null}, now(), now())
      ON CONFLICT (tenant_id, incoming_name_norm)
      DO UPDATE SET
        drug_formulary_id = EXCLUDED.drug_formulary_id,
        incoming_name_raw = EXCLUDED.incoming_name_raw,
        updated_at = now()
    `;
  } catch (err) {
    logger.warn({ err }, 'saveNameMapping failed (non-fatal)');
  }
}
