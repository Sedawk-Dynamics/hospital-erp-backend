import type { Prisma, PrismaClient } from '@prisma/client';
import {
  DRUG_GST_CLASSIFIER_VERSION,
  inferCatalogDrugGst,
} from '../modules/drug-master/drug-gst.classifier';

const BATCH = 5_000;

type Patch = {
  hsnCode?: string;
  gstRate?: number;
  gstTreatment?: string | null;
  gstTreatmentSource?: string | null;
  gstClassifierVersion: number;
};

function keyOf(patch: Patch): string {
  return JSON.stringify(patch);
}

/**
 * Classify only new/changed vendor rows, and fill only blank tax fields. Manual
 * codes/rates/treatments are never overwritten. OTC products are marked as
 * considered but deliberately left blank because their HSN cannot be inferred
 * from a marketing category.
 */
async function classifyMaster(db: PrismaClient): Promise<number> {
  let changed = 0;
  while (true) {
    const rows = await db.drugMaster.findMany({
      where: {
        sourceId: { not: null },
        OR: [
          { gstClassifierVersion: null },
          { gstClassifierVersion: { not: DRUG_GST_CLASSIFIER_VERSION } },
        ],
      },
      select: {
        id: true,
        name: true,
        genericName: true,
        saltComposition: true,
        type: true,
        hsnCode: true,
        gstRate: true,
        gstTreatment: true,
        gstTreatmentSource: true,
      },
      take: BATCH,
      orderBy: { id: 'asc' },
    });
    if (!rows.length) break;

    const groups = new Map<string, { patch: Patch; ids: string[] }>();
    for (const row of rows) {
      const inferred = inferCatalogDrugGst(row);
      const patch: Patch = { gstClassifierVersion: DRUG_GST_CLASSIFIER_VERSION };
      if (inferred) {
        if (!row.hsnCode) patch.hsnCode = inferred.hsnCode;
        if (row.gstRate == null) patch.gstRate = inferred.gstRate;
        if (inferred.gstTreatment && (!row.gstTreatment || row.gstTreatmentSource === 'notification')) {
          patch.gstTreatment = inferred.gstTreatment;
          patch.gstTreatmentSource = 'notification';
        } else if (!inferred.gstTreatment && row.gstTreatmentSource === 'notification') {
          patch.gstTreatment = null;
          patch.gstTreatmentSource = null;
        }
      }
      const key = keyOf(patch);
      const group = groups.get(key) ?? { patch, ids: [] };
      group.ids.push(row.id);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      const result = await db.drugMaster.updateMany({
        where: { id: { in: group.ids } },
        data: group.patch as Prisma.DrugMasterUpdateManyMutationInput,
      });
      changed += result.count;
    }
  }
  return changed;
}

/** Existing tenant rows pre-date the catalogue classifier. Keep the earlier
 * backfill's conservative boundary: medicines only, never retail products or
 * generic inventory. */
async function classifyFormularies(db: PrismaClient): Promise<number> {
  let changed = 0;
  while (true) {
    const rows = await db.drugFormulary.findMany({
      where: {
        category: 'drug',
        isActive: true,
        OR: [
          { gstClassifierVersion: null },
          { gstClassifierVersion: { not: DRUG_GST_CLASSIFIER_VERSION } },
        ],
      },
      select: {
        id: true,
        drugName: true,
        genericName: true,
        composition: true,
        hsnCode: true,
        taxPercent: true,
        gstTreatment: true,
        gstTreatmentSource: true,
      },
      take: BATCH,
      orderBy: { id: 'asc' },
    });
    if (!rows.length) break;

    const groups = new Map<string, { patch: Patch; ids: string[] }>();
    for (const row of rows) {
      const inferred = inferCatalogDrugGst({
        type: 'drug',
        name: row.drugName,
        genericName: row.genericName,
        saltComposition: row.composition,
      });
      const patch: Patch = { gstClassifierVersion: DRUG_GST_CLASSIFIER_VERSION };
      if (inferred) {
        if (!row.hsnCode) patch.hsnCode = inferred.hsnCode;
        if (row.taxPercent == null) patch.gstRate = inferred.gstRate;
        if (inferred.gstTreatment && (!row.gstTreatment || row.gstTreatmentSource === 'notification')) {
          patch.gstTreatment = inferred.gstTreatment;
          patch.gstTreatmentSource = 'notification';
        } else if (!inferred.gstTreatment && row.gstTreatmentSource === 'notification') {
          patch.gstTreatment = null;
          patch.gstTreatmentSource = null;
        }
      }
      const key = keyOf(patch);
      const group = groups.get(key) ?? { patch, ids: [] };
      group.ids.push(row.id);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      const { gstRate, ...patch } = group.patch;
      const data: Prisma.DrugFormularyUpdateManyMutationInput = {
        ...patch,
        ...(gstRate !== undefined ? { taxPercent: gstRate } : {}),
      };
      const result = await db.drugFormulary.updateMany({ where: { id: { in: group.ids } }, data });
      changed += result.count;
    }
  }
  return changed;
}

export async function seedDrugGstClassification(db: PrismaClient): Promise<void> {
  const master = await classifyMaster(db);
  const formulary = await classifyFormularies(db);
  if (master || formulary) {
    console.log(`Drug GST classification: ${master} catalogue row(s), ${formulary} formulary row(s)`);
  }
}
