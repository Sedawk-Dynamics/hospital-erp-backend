/**
 * The vendor drug catalogue, checked against the release it was built from.
 *
 * Proves the import did what it says without trusting its own summary:
 *
 *   - the release is recorded complete, and every product in the bundle is in
 *     drug_master under its Product ID — no more, no fewer, per kind;
 *   - nothing of the old open dataset is left, and no hospital formulary row
 *     points at a catalogue row that is gone or is a leftover of it;
 *   - sampled products carry exactly the fields the normaliser derives from
 *     their bundle line, and every monograph reference resolves to the SAME
 *     text the bundle holds at that index. An off-by-one in the text map would
 *     put one medicine's leaflet under another and still read perfectly
 *     plausibly — which is why this compares hashes rather than eyeballing;
 *   - the passes that follow an import ran: compositions linked to the salt
 *     master, every row classified at the current classifier version.
 *
 *   npm run db:check-drug-catalog      (database only — no server needed)
 */
import { PrismaClient } from '@prisma/client';
import {
  CATALOG_DIR,
  readLines,
  readManifest,
  textHash,
  type ManifestPart,
} from '../../src/modules/drug-master/drug-catalog.release';
import {
  normalizeVendorRow,
  renderTemplate,
  TEMPLATE_PLACEHOLDER,
  type CatalogKind,
  type CatalogProduct,
} from '../../src/modules/drug-master/drug-catalog.normalize';
import { CLASSIFIER_VERSION } from '../../src/modules/drug-master/drug-schedule.classifier';

const p = new PrismaClient();
// A prime, so the sample does not fall into step with any ordering in the file.
const SAMPLE_EVERY = 997;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ck(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`);
  if (ok) pass += 1;
  else {
    fail += 1;
    failures.push(`${name}${detail ? ' - ' + detail : ''}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);
const num = (v: unknown) => Number(v ?? 0);

interface Sample {
  kind: CatalogKind;
  product: CatalogProduct;
  refs: Record<string, number>;
}

async function sampleLines(kind: CatalogKind, part: ManifestPart): Promise<Sample[]> {
  const out: Sample[] = [];
  let i = 0;
  for await (const raw of readLines(CATALOG_DIR, part.files)) {
    if (i++ % SAMPLE_EVERY !== 0) continue;
    const line = raw as unknown[];
    const rec: Record<string, string | null> = {};
    const refs: Record<string, number> = {};
    part.columns.forEach((c, j) => {
      const v = line[j];
      if (c.startsWith('@')) {
        if (typeof v === 'number') refs[c.slice(1)] = v;
      } else rec[c] = v == null ? null : String(v);
    });
    const product = normalizeVendorRow(kind, rec);
    if (product) out.push({ kind, product, refs });
  }
  return out;
}

async function main() {
  const m = readManifest();
  if (!m) {
    ck('a release is bundled with this build', false, `no manifest in ${CATALOG_DIR}`);
    return;
  }

  section(`Release ${m.release}`);
  const rel = await p.drugCatalogRelease.findUnique({ where: { release: m.release } });
  ck('the release is recorded complete', rel?.status === 'complete', `status=${rel?.status ?? 'missing'}`);

  const stamped = await p.drugMaster.groupBy({
    by: ['type'],
    where: { sourceRelease: m.release },
    _count: { _all: true },
  });
  const count = (t: string) => stamped.find((s) => s.type === t)?._count._all ?? 0;
  ck(
    'every drug in the bundle is in the catalogue, once',
    count('drug') === m.drugs.count,
    `${count('drug')} rows, bundle has ${m.drugs.count}`,
  );
  if (m.otc) {
    ck(
      'every OTC product in the bundle is in the catalogue, once',
      count('otc') === m.otc.count,
      `${count('otc')} rows, bundle has ${m.otc.count}`,
    );
  }
  const legacy = await p.drugMaster.count({ where: { sourceId: null, createdById: null } });
  ck('nothing of the old open dataset is left', legacy === 0, `${legacy} rows with no Product ID and no author`);

  section('Hospital formularies');
  const [dangling] = await p.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n
    FROM drug_formulary f
    LEFT JOIN drug_master m ON m.id = f.drug_master_id
    WHERE f.drug_master_id IS NOT NULL
      AND (m.id IS NULL OR (m.source_id IS NULL AND m.created_by_id IS NULL))`;
  ck('no formulary row points at a missing or legacy catalogue row', num(dangling.n) === 0, `${num(dangling.n)} rows`);
  const linked = await p.drugFormulary.count({ where: { drugMaster: { sourceId: { not: null } } } });
  console.log(`  ${linked} formulary rows are linked to the vendor catalogue`);
  if (rel?.report) {
    const r = rel.report as { tiers?: Record<string, number>; unlinked?: unknown[]; carried?: unknown[] };
    console.log(`  matched by: ${JSON.stringify(r.tiers ?? {})}`);
    console.log(`  identity carried across: ${r.carried?.length ?? 0} product(s); left unlinked: ${r.unlinked?.length ?? 0}`);
  }
  const staleFormulary = await p.drugFormulary.count({
    where: {
      OR: [{ scheduleSource: null }, { scheduleSource: { not: 'manual' } }],
      AND: [{ OR: [{ classifierVersion: null }, { classifierVersion: { not: CLASSIFIER_VERSION } }] }],
    },
  });
  ck('every formulary row has re-inherited its schedule', staleFormulary === 0, `${staleFormulary} pending`);

  section(`Sampled products (every ${SAMPLE_EVERY}th line) against their bundle lines`);
  const samples = [
    ...(await sampleLines('drug', m.drugs)),
    ...(m.otc ? await sampleLines('otc', m.otc) : []),
  ];
  const wanted = new Set(samples.flatMap((s) => Object.values(s.refs)));
  const bundleHash = new Map<number, string>();
  let idx = 0;
  for await (const raw of readLines(CATALOG_DIR, m.texts.files)) {
    if (wanted.has(idx)) bundleHash.set(idx, textHash((raw as [string, string])[1]));
    idx += 1;
  }

  const rows = await p.drugMaster.findMany({
    where: { sourceId: { in: samples.map((s) => s.product.sourceId!) } },
    select: {
      sourceId: true, name: true, type: true, genericName: true, manufacturer: true, packSizeLabel: true,
      packSize: true, mrp: true, dosageForm: true, rxRequired: true, therapeuticClass: true,
      productCategory: true, monograph: true,
    },
  });
  const bySource = new Map(rows.map((r) => [r.sourceId!, r]));
  const textIds = rows.flatMap((r) => Object.values((r.monograph ?? {}) as Record<string, number>));
  const texts = await p.drugText.findMany({ where: { id: { in: textIds } }, select: { id: true, hash: true, body: true } });
  const textById = new Map(texts.map((t) => [t.id, t]));

  const fieldMismatch: string[] = [];
  const textMismatch: string[] = [];
  let refsChecked = 0;
  for (const s of samples) {
    const row = bySource.get(s.product.sourceId!);
    if (!row) {
      fieldMismatch.push(`${s.product.sourceId} missing`);
      continue;
    }
    const e = s.product;
    const pairs: Array<[string, unknown, unknown]> = [
      ['name', row.name, e.name],
      ['type', row.type, e.type],
      ['genericName', row.genericName, e.genericName],
      ['manufacturer', row.manufacturer, e.manufacturer],
      ['packSizeLabel', row.packSizeLabel, e.packSizeLabel],
      ['packSize', row.packSize, e.packSize],
      ['mrp', row.mrp == null ? null : Number(row.mrp), e.mrp],
      ['dosageForm', row.dosageForm, e.dosageForm],
      ['rxRequired', row.rxRequired, e.rxRequired],
      ['therapeuticClass', row.therapeuticClass, e.therapeuticClass],
      ['productCategory', row.productCategory, e.productCategory],
    ];
    for (const [field, got, want] of pairs) {
      if ((got ?? null) !== (want ?? null)) fieldMismatch.push(`${e.sourceId}.${field}: ${String(got)} ≠ ${String(want)}`);
    }
    const mono = (row.monograph ?? {}) as Record<string, number>;
    const keys = (o: Record<string, unknown>) => Object.keys(o).sort().join(',');
    if (keys(mono) !== keys(s.refs)) textMismatch.push(`${e.sourceId}: sections ${keys(mono)} ≠ ${keys(s.refs)}`);
    for (const [key, bundleIndex] of Object.entries(s.refs)) {
      refsChecked += 1;
      const t = textById.get(mono[key]);
      if (!t || t.hash !== bundleHash.get(bundleIndex)) {
        textMismatch.push(`${e.sourceId}.${key}: text ${mono[key]} is not bundle text ${bundleIndex}`);
      } else if (t.body.includes(TEMPLATE_PLACEHOLDER) && !renderTemplate(t.body, row.name).includes(row.name)) {
        textMismatch.push(`${e.sourceId}.${key}: renders without the product's name`);
      }
    }
  }
  ck(
    `${samples.length} sampled products match their lines field for field`,
    fieldMismatch.length === 0,
    fieldMismatch.slice(0, 5).join('; '),
  );
  ck(
    `${refsChecked} monograph references resolve to the text the bundle holds at that index`,
    textMismatch.length === 0,
    textMismatch.slice(0, 5).join('; '),
  );

  section('After the import');
  const unclassified = await p.drugMaster.count({
    where: { OR: [{ classifierVersion: null }, { classifierVersion: { not: CLASSIFIER_VERSION } }] },
  });
  ck('every catalogue row is classified at the current version', unclassified === 0, `${unclassified} pending`);
  const [unlinkedSalts] = await p.$queryRaw<{ n: bigint; total: bigint }[]>`
    SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM drug_salts s WHERE s.drug_master_id = m.id)) AS n,
           count(*) AS total
    FROM drug_master m
    WHERE m.type = 'drug' AND m.salt_composition IS NOT NULL`;
  const share = num(unlinkedSalts.n) / Math.max(1, num(unlinkedSalts.total));
  ck(
    'drug compositions are linked to the salt master',
    share < 0.01,
    `${num(unlinkedSalts.n)} of ${num(unlinkedSalts.total)} drugs have no salt link`,
  );

  section('Search');
  const dolo = await p.drugMaster.findMany({
    where: { isPublished: true, isDiscontinued: false, name: { startsWith: 'Dolo 650', mode: 'insensitive' } },
    select: { name: true, sourceId: true, mrp: true },
    take: 5,
  });
  ck(
    '"Dolo 650" is in the catalogue, from the vendor release',
    dolo.length > 0 && dolo.every((d) => d.sourceId),
    dolo.map((d) => `${d.name} ₹${d.mrp}`).join(', '),
  );
}

main()
  .catch((e) => {
    console.error(e);
    fail += 1;
  })
  .finally(async () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log(failures.map((f) => `  - ${f}`).join('\n'));
    await p.$disconnect();
    process.exit(fail ? 1 : 0);
  });
