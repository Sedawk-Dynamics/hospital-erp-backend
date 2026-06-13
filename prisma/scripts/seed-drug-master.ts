import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { parseDrugCsv } from '../../src/modules/drug-master/drug-master.dataset';
import { refreshDrugMasterFromRows } from '../../src/modules/drug-master/drug-master.refresh';
import { OPEN_DATASET_RICH_URL } from '../../src/modules/drug-master/drug-master.providers';

/**
 * Seeds / enriches the platform-wide DrugMaster catalog from the richer Indian
 * medicine dataset (adds salt_composition, description/uses, side_effects,
 * drug_interactions on top of brand/composition/manufacturer/MRP).
 *
 *   npm run db:seed:drug-master            # bulk-insert if empty; else ENRICH
 *   npm run db:seed:drug-master -- --force # wipe + reseed
 *
 * Empty DB → fast bulk insert. Populated DB → link-preserving upsert (enrich)
 * via the refresh engine, so existing ids + hospital drugMasterId links stay.
 */

const prisma = new PrismaClient();

const DATA_DIR = path.join(__dirname, 'data');
const CSV_PATH = path.join(DATA_DIR, 'updated_indian_medicine_data.csv');
const BATCH_SIZE = 5000;
const FORCE = process.argv.includes('--force');

async function loadCsv(): Promise<string> {
  if (fs.existsSync(CSV_PATH)) {
    console.log(`Reading cached CSV: ${CSV_PATH}`);
    return fs.readFileSync(CSV_PATH, 'utf-8');
  }
  console.log(`Downloading richer dataset from ${OPEN_DATASET_RICH_URL} ...`);
  const res = await fetch(OPEN_DATASET_RICH_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CSV_PATH, text, 'utf-8');
  console.log(`Cached CSV → ${CSV_PATH} (${(text.length / 1e6).toFixed(1)} MB)`);
  return text;
}

async function main() {
  const existing = await prisma.drugMaster.count();

  if (FORCE && existing > 0) {
    console.log(`--force: clearing import links + ${existing} DrugMaster rows ...`);
    await prisma.drugFormulary.updateMany({
      where: { drugMasterId: { not: null } },
      data: { drugMasterId: null },
    });
    await prisma.drugMaster.deleteMany({});
  }

  const text = await loadCsv();
  const parsed = parseDrugCsv(text);
  console.log(`Parsed ${parsed.length} rows from the richer dataset.`);

  const count = await prisma.drugMaster.count();
  if (count > 0) {
    // Populated → enrich in place (preserves ids + hospital links).
    console.log(`Catalog has ${count} rows — enriching with rich detail (preserves links) ...`);
    const summary = await refreshDrugMasterFromRows(parsed);
    console.log(`Done. ${JSON.stringify(summary)}`);
    return;
  }

  // Empty → fast bulk insert.
  let inserted = 0;
  for (let i = 0; i < parsed.length; i += BATCH_SIZE) {
    const chunk = parsed.slice(i, i + BATCH_SIZE);
    await prisma.drugMaster.createMany({
      data: chunk.map((d) => ({
        name: d.name,
        genericName: d.genericName,
        manufacturer: d.manufacturer,
        type: d.type,
        dosageForm: d.dosageForm as any,
        packSizeLabel: d.packSizeLabel,
        packSize: d.packSize ?? undefined,
        mrp: d.mrp != null ? new Prisma.Decimal(d.mrp) : null,
        isDiscontinued: d.isDiscontinued,
        saltComposition: d.saltComposition,
        description: d.description,
        sideEffects: d.sideEffects,
        drugInteractions: (d.drugInteractions ?? undefined) as any,
        searchTokens: d.searchTokens,
        isPublished: true,
      })),
    });
    inserted += chunk.length;
    process.stdout.write(`\rInserted ${inserted} ...`);
  }
  process.stdout.write('\n');
  console.log(`Done. DrugMaster total: ${await prisma.drugMaster.count()}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
