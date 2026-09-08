// ---------------------------------------------------------------------------
// The GST slab master — the rates the law recognises, and the dates each was.
//
// Seeded on every boot rather than only in a migration. `prisma db push` is how
// a fresh database gets its schema here, and it creates the table EMPTY: the
// migration's INSERT only runs when the migration folder is replayed, which on
// this project it is not. So a freshly pushed database had the slab table and
// no slabs.
//
// That matters more than an empty reference table usually would, because
// `isLegalSlabRate` returns TRUE on an empty list by design — a check that
// cannot be made must not start refusing every bill in the hospital. An unseeded
// master therefore makes the whole rate gate silently inert, which is the worst
// of the three possible states: the gate exists, it reports nothing, and
// everybody assumes it is working.
//
// Idempotent: upserts on (ratePercent, effectiveFrom), which is the unique key.
// A platform that has edited a slab's label or note keeps its edit; a slab it
// deleted comes back, which is correct — the list is what Parliament enacted,
// not a preference.
// ---------------------------------------------------------------------------

import type { PrismaClient } from '@prisma/client';

/**
 * The two windows.
 *
 * The 56th GST Council retired 12% and 28% and introduced 40% with effect from
 * 22 September 2025. A bill raised in June 2025 at 12% was correct and must
 * stay correct, so the old rates are not deleted — they are closed with an end
 * date, and every check is made as at the document's own date.
 */
const SLABS: Array<{
  ratePercent: number;
  label: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string;
}> = [
  { ratePercent: 0, label: 'Nil', effectiveFrom: '2017-07-01', effectiveTo: '2025-09-21', note: 'Pre-GST 2.0 slab' },
  { ratePercent: 5, label: '5%', effectiveFrom: '2017-07-01', effectiveTo: '2025-09-21', note: 'Pre-GST 2.0 slab' },
  { ratePercent: 12, label: '12%', effectiveFrom: '2017-07-01', effectiveTo: '2025-09-21', note: 'Retired by the 56th GST Council, effective 22 Sep 2025' },
  { ratePercent: 18, label: '18%', effectiveFrom: '2017-07-01', effectiveTo: '2025-09-21', note: 'Pre-GST 2.0 slab' },
  { ratePercent: 28, label: '28%', effectiveFrom: '2017-07-01', effectiveTo: '2025-09-21', note: 'Retired by the 56th GST Council, effective 22 Sep 2025' },
  { ratePercent: 0, label: 'Nil', effectiveFrom: '2025-09-22', effectiveTo: null, note: 'GST 2.0' },
  { ratePercent: 5, label: '5%', effectiveFrom: '2025-09-22', effectiveTo: null, note: 'GST 2.0 — most medicines and medical devices' },
  { ratePercent: 18, label: '18%', effectiveFrom: '2025-09-22', effectiveTo: null, note: 'GST 2.0 — nutraceuticals, cosmetic procedures, most non-medical services' },
  { ratePercent: 40, label: '40%', effectiveFrom: '2025-09-22', effectiveTo: null, note: 'GST 2.0 — luxury and sin goods; not used by a hospital' },
];

const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

export async function seedGstSlabs(db: PrismaClient): Promise<void> {
  for (const slab of SLABS) {
    await db.gstSlab.upsert({
      where: {
        ratePercent_effectiveFrom: {
          ratePercent: slab.ratePercent,
          effectiveFrom: day(slab.effectiveFrom),
        },
      },
      create: {
        ratePercent: slab.ratePercent,
        label: slab.label,
        effectiveFrom: day(slab.effectiveFrom),
        effectiveTo: slab.effectiveTo ? day(slab.effectiveTo) : null,
        note: slab.note,
      },
      // Only the window is enforced on an existing row. The label and the note
      // are presentation, and a platform that has reworded them meant to.
      update: {
        effectiveTo: slab.effectiveTo ? day(slab.effectiveTo) : null,
        isActive: true,
      },
    });
  }
}

/**
 * The category fallback every supply kind resolves to when nothing more
 * specific has been mapped.
 *
 * Same reasoning as the slabs: `db push` creates the table empty, and an empty
 * table makes step 7 of the resolution chain unreachable again — which is the
 * state it was in for the whole of this project until now.
 *
 * Everything clinical is exempt, because healthcare is exempt in India and tax
 * is the exception. Goods are the one place a default of exempt would be wrong:
 * a medicine with no HSN is an unfinished setup, not an exempt supply, so it
 * defaults to 5% and the engine flags it for resolution.
 */
const CATEGORY_DEFAULTS: Array<{
  supplyKind: string;
  ratePercent: number;
  treatment: string;
  description: string;
}> = [
  { supplyKind: 'consultation', ratePercent: 0, treatment: 'exempt', description: 'Doctor consultation / OPD visit — healthcare service' },
  { supplyKind: 'lab', ratePercent: 0, treatment: 'exempt', description: 'Laboratory and diagnostic services' },
  { supplyKind: 'imaging', ratePercent: 0, treatment: 'exempt', description: 'Diagnostic imaging — X-ray, CT, MRI, ECG' },
  { supplyKind: 'procedure', ratePercent: 0, treatment: 'exempt', description: 'Therapeutic procedures and surgery' },
  { supplyKind: 'nursing', ratePercent: 0, treatment: 'exempt', description: 'Nursing and inpatient treatment charges' },
  { supplyKind: 'room', ratePercent: 0, treatment: 'exempt', description: 'Accommodation — the room rule decides the rate' },
  { supplyKind: 'registration', ratePercent: 0, treatment: 'exempt', description: 'Registration fee — the hospital setting decides the rate' },
  { supplyKind: 'medicine', ratePercent: 5, treatment: 'taxable', description: 'Medicines with no HSN mapped yet — flagged for resolution' },
  { supplyKind: 'consumable', ratePercent: 5, treatment: 'taxable', description: 'Consumables with no HSN mapped yet — flagged for resolution' },
  { supplyKind: 'other', ratePercent: 0, treatment: 'exempt', description: 'Anything not otherwise classified' },
];

export async function seedGstCategoryDefaults(db: PrismaClient): Promise<void> {
  for (const d of CATEGORY_DEFAULTS) {
    await db.gstCategoryDefault.upsert({
      where: { supplyKind: d.supplyKind },
      create: d,
      // An existing row is left alone apart from being reactivated: the rate
      // and the treatment are exactly what a hospital's auditor may have moved,
      // and a boot must not undo that.
      update: { isActive: true },
    });
  }
}
