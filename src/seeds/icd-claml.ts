/**
 * Seed the platform ICD-10 catalogue from the WHO release.
 *
 * The catalogue a doctor searches was 76 hand-curated rows (`icd.data.ts`) —
 * under 1% of ICD-10. Anything outside that starter set simply could not be
 * coded, so diagnoses were recorded as free text and nothing downstream that
 * depends on a code (claims, morbidity returns, the CDSS) could use them.
 * This loads the full WHO ICD-10 2019 release: ~12,300 codes with their block
 * and chapter, and the inclusion terms that make them searchable in the words a
 * clinician actually types.
 *
 * Data: src/seeds/data/icd10-who-2019.json, generated from the WHO ClaML XML by
 * prisma/scripts/parse-icd10-claml.py — see that script for what is kept,
 * what is dropped, and why the fourth-character subdivisions have to be
 * expanded (the raw file has `E11` but not `E11.9`).
 *
 * RELATIONSHIP TO THE CURATED SEED. `icd-codes.ts` still runs and still owns
 * the everyday slang a doctor types but WHO never prints — "flu", "heart
 * attack", "cad", "loose motions". Those rows are NOT overwritten here:
 *
 *   keywords          NOT TOUCHED. `keywords` means "a person said this is what
 *                     people call it", and that is what the ranker treats as a
 *                     strong signal. WHO's inclusion terms are a different
 *                     thing — they say which concepts classify TO a code, not
 *                     what a clinician means when they type the word. Merging
 *                     them in measurably broke search: O85 carries the
 *                     inclusion "fever", so "fever" returned Puerperal sepsis
 *                     above "Fever, unspecified". The inclusions go into
 *                     `searchTokens` instead, where they stay findable but rank
 *                     below a deliberate keyword. Losing "heart attack" off
 *                     I21.9 would have made search worse than before the
 *                     ingestion, so those rows keep exactly what they had.
 *   title/block/chapter  taken from WHO, which is authoritative and keeps one
 *                     vocabulary across all 12,300 rows instead of 76 rows on a
 *                     hand-written one. Safe to restate: `Diagnosis` snapshots
 *                     `icdCode` + `diagnosisName` and has no FK to this table,
 *                     so a recorded diagnosis is never rewritten by a re-seed.
 *   isActive          left alone on existing rows, so a code a super-admin
 *                     deactivated stays deactivated.
 *
 * Codes the curated set has that WHO does not (`R06.02`, `R53.83` and friends
 * are ICD-10-CM, the US clinical modification) are simply not touched.
 *
 * Idempotent and cheap to re-run: it reads the platform catalogue once, writes
 * only rows that actually differ, and no-ops entirely when the release is
 * already in. That is why it runs on every boot rather than behind an
 * "is it empty" guard — a release shipping a newer WHO version lands by itself.
 *
 * Run with `npm run db:seed:icd-full`.
 */

import { PrismaClient } from '@prisma/client';
import ICD10 from './data/icd10-who-2019.json';

/** One code as the parser emits it — short keys, this file ships 2.5 MB. */
interface ClamlCode {
  /** ICD-10 code, e.g. `E11.9`. */
  c: string;
  /** Preferred rubric — the code's title. */
  t: string;
  /** Block title, e.g. "Ischaemic heart diseases". Stored as `category`. */
  b: string | null;
  /** Chapter title, e.g. "Diseases of the circulatory system". */
  ch: string | null;
  /** No sub-codes beneath it — only a leaf is billable on its own. */
  leaf: boolean;
  /** Inclusion terms: the synonyms a clinician searches by. */
  k?: string[];
}

const RELEASE: { version: string; codes: ClamlCode[] } = ICD10 as {
  version: string;
  codes: ClamlCode[];
};

/** Postgres caps a parameterised statement well below one 12,300-row insert. */
const INSERT_CHUNK = 1000;

/**
 * Same shape `icd.service` builds, plus WHO's inclusion terms. This is the only
 * place the two kinds of term meet: searchable together, rankable apart.
 */
function buildSearchTokens(
  code: string,
  title: string,
  keywords: string[],
  synonyms: string[] = [],
): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of [code, title, ...keywords, ...synonyms]) {
    const key = t.toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      terms.push(key);
    }
  }
  return terms.join(' ');
}

export async function seedIcdFromClaml(client?: PrismaClient): Promise<void> {
  const owns = !client;
  const prisma = client ?? new PrismaClient();

  try {
    const existing = await prisma.icdCode.findMany({
      where: { tenantId: null },
      select: {
        id: true,
        code: true,
        title: true,
        category: true,
        chapter: true,
        keywords: true,
        isBillable: true,
        searchTokens: true,
      },
    });
    const byCode = new Map(existing.map((row) => [row.code, row]));

    const inserts: {
      tenantId: null;
      code: string;
      title: string;
      category: string | null;
      chapter: string | null;
      keywords: string[];
      searchTokens: string;
      isBillable: boolean;
      isCustom: boolean;
      isActive: boolean;
    }[] = [];
    const updates: { id: string; data: Record<string, unknown> }[] = [];

    for (const entry of RELEASE.codes) {
      const synonyms = entry.k ?? [];
      const row = byCode.get(entry.c);

      if (!row) {
        inserts.push({
          tenantId: null,
          code: entry.c,
          title: entry.t,
          category: entry.b,
          chapter: entry.ch,
          keywords: [],
          searchTokens: buildSearchTokens(entry.c, entry.t, [], synonyms),
          isBillable: entry.leaf,
          isCustom: false,
          isActive: true,
        });
        continue;
      }

      // `keywords` stays exactly as the curated seed left it.
      const searchTokens = buildSearchTokens(entry.c, entry.t, row.keywords, synonyms);
      const changed =
        row.title !== entry.t ||
        row.category !== entry.b ||
        row.chapter !== entry.ch ||
        row.isBillable !== entry.leaf ||
        row.searchTokens !== searchTokens;

      if (changed) {
        updates.push({
          id: row.id,
          // `isActive` and `keywords` are deliberately absent — a code switched
          // off by hand stays off, and curated slang is never rewritten here.
          data: {
            title: entry.t,
            category: entry.b,
            chapter: entry.ch,
            searchTokens,
            isBillable: entry.leaf,
            isCustom: false,
          },
        });
      }
    }

    if (!inserts.length && !updates.length) {
      console.log(`ICD-10 (${RELEASE.version}) already current — ${existing.length} platform codes.`);
      return;
    }

    for (let i = 0; i < inserts.length; i += INSERT_CHUNK) {
      await prisma.icdCode.createMany({
        data: inserts.slice(i, i + INSERT_CHUNK),
        skipDuplicates: true,
      });
    }
    for (const u of updates) {
      await prisma.icdCode.update({ where: { id: u.id }, data: u.data });
    }

    console.log(
      `ICD-10 (${RELEASE.version}) seeded — ${inserts.length} added, ${updates.length} refreshed, ${RELEASE.codes.length} in the release.`,
    );
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedIcdFromClaml()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
