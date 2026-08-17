/**
 * The salt review queue.
 *
 * A molecule no published list names is stored with scheduleCode NULL —
 * UNDECIDED, not over-the-counter. That distinction only pays off if the
 * undecided ones are visible and someone can clear them, which is what this is.
 *
 * They are ranked by how many catalog products contain the molecule, because
 * that is the order in which they matter: warfarin sits in 18 products,
 * rosuvastatin in 1,969.
 *
 * Setting a schedule marks the salt `manual`, which no re-seed will overwrite,
 * and re-classifies every product containing it.
 */

import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { invalidateSaltCache } from './salt-classification.service';
import { classifyDrugMasterItem } from './drug-schedule.service';

export interface SaltListQuery {
  page?: number;
  limit?: number;
  search?: string;
  /** 'undecided' (default) | 'decided' | 'all' */
  status?: 'undecided' | 'decided' | 'all';
  schedule?: string;
  controlled?: boolean;
}

export async function listSalts(query: SaltListQuery) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const status = query.status ?? 'undecided';

  const where: Record<string, unknown> = {};
  if (status === 'undecided') where.scheduleCode = null;
  else if (status === 'decided') where.scheduleCode = { not: null };
  if (query.schedule) where.scheduleCode = query.schedule;
  if (query.controlled !== undefined) {
    where.controlledClass = query.controlled ? { not: null } : null;
  }
  if (query.search) {
    const term = query.search.trim().toLowerCase();
    where.OR = [
      { norm: { contains: term } },
      { name: { contains: term, mode: 'insensitive' } },
      { synonyms: { some: { norm: { contains: term } } } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.salt.findMany({
      where: where as never,
      // Product count is what makes this a work QUEUE rather than a list, so it
      // drives the order.
      orderBy: [{ drugSalts: { _count: 'desc' } }, { name: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        _count: { select: { drugSalts: true } },
        synonyms: { select: { name: true } },
        classes: { include: { class: { select: { name: true, scheduleCode: true } } } },
      },
    }),
    prisma.salt.count({ where: where as never }),
  ]);

  return {
    items: rows.map((s) => ({
      id: s.id,
      name: s.name,
      norm: s.norm,
      scheduleCode: s.scheduleCode,
      controlledClass: s.controlledClass,
      vaultControlled: s.vaultControlled,
      source: s.source,
      scheduleNote: s.scheduleNote,
      reviewedAt: s.reviewedAt,
      productCount: s._count.drugSalts,
      synonyms: s.synonyms.map((x) => x.name),
      classes: s.classes.map((c) => c.class.name),
    })),
    total,
    page,
    limit,
  };
}

/** How much is left to decide, and how many products ride on it. */
export async function saltReviewSummary() {
  const [undecided, decided, manual] = await Promise.all([
    prisma.salt.count({ where: { scheduleCode: null } }),
    prisma.salt.count({ where: { scheduleCode: { not: null } } }),
    prisma.salt.count({ where: { source: 'manual' } }),
  ]);
  const affected: { n: number }[] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(DISTINCT ds.drug_master_id)::int AS n
     FROM drug_salts ds JOIN salts s ON s.id = ds.salt_id
     WHERE s.schedule_code IS NULL`,
  );
  return {
    undecided,
    decided,
    manual,
    productsAffected: Number(affected[0]?.n ?? 0),
  };
}

/**
 * Record a person's decision about a molecule.
 *
 * Marks the salt `manual` so no re-seed can undo it, then re-classifies every
 * product containing it — otherwise the decision would sit in the table without
 * reaching the counter until the next version bump.
 */
export async function decideSalt(
  saltId: string,
  userId: string,
  data: {
    scheduleCode: string | null;
    controlledClass?: string | null;
    vaultControlled?: boolean;
    note?: string | null;
  },
) {
  const salt = await prisma.salt.findUnique({ where: { id: saltId }, select: { id: true, name: true } });
  if (!salt) return null;

  const updated = await prisma.salt.update({
    where: { id: saltId },
    data: {
      scheduleCode: data.scheduleCode,
      ...(data.controlledClass !== undefined ? { controlledClass: data.controlledClass } : {}),
      ...(data.vaultControlled !== undefined ? { vaultControlled: data.vaultControlled } : {}),
      source: 'manual',
      scheduleNote:
        data.note?.trim() ||
        `Set to ${data.scheduleCode ?? 'undecided'} by a platform administrator.`,
      reviewedById: userId,
      reviewedAt: new Date(),
    },
  });

  invalidateSaltCache();

  // Re-classify the products that contain it. Done inline because the queue is
  // worked one molecule at a time and the counts are small — rosuvastatin, the
  // largest, is 1,969 products.
  const links = await prisma.drugSalt.findMany({
    where: { saltId },
    select: { drugMasterId: true },
    distinct: ['drugMasterId'],
  });
  for (const l of links) {
    // eslint-disable-next-line no-await-in-loop
    await classifyDrugMasterItem(l.drugMasterId);
  }

  logger.info(
    { saltId, salt: salt.name, schedule: data.scheduleCode, products: links.length, userId },
    'Salt schedule decided; dependent products re-classified',
  );
  return { salt: updated, reclassified: links.length };
}
